/* ============================================================
   training support — バックエンド（Cloudflare Worker）
   ・AI相談の中継（APIキーは端末に置かない。ここだけが Anthropic を呼ぶ）
   ・決済：Web は Stripe Checkout、iOS は RevenueCat（App内課金）
   ・プランと月の回数は KV（ENTITLEMENTS）にサーバー側で持つ
   ・www/ の静的配信もここで行う（GitHub Pages のままでも動く）
   ============================================================ */
import Anthropic from "@anthropic-ai/sdk";
import Stripe from "stripe";

export interface Env {
  ENTITLEMENTS: KVNamespace;
  ASSETS?: Fetcher;
  ANTHROPIC_API_KEY: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  REVENUECAT_WEBHOOK_AUTH?: string;
  REVENUECAT_API_KEY?: string;
  FIREBASE_PROJECT_ID?: string;
  AI_MODEL?: string;
  AI_EFFORT?: string;
  AI_MAX_TOKENS?: string;
  APP_URL?: string;
  ALLOWED_ORIGINS?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_MAX?: string;
  STRIPE_PRICE_TRAINER?: string;
}

type PlanId = "free" | "pro" | "max" | "trainer";
const PLAN_ORDER: PlanId[] = ["free", "pro", "max", "trainer"];
/* AI相談の月の上限（-1 は無制限）。index.html の PLANS と揃える */
const AI_LIMIT: Record<PlanId, number> = { free: 3, pro: 20, max: -1, trainer: -1 };

interface Entitlement {
  plan: PlanId;
  source: "stripe" | "revenuecat" | "manual" | "none";
  status?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  periodEnd?: number;          // ms。これを過ぎたら free 扱い
  updatedAt: number;
}

const AI_SYSTEM =
  "あなたは経験豊富なパーソナルトレーナーです。日本語で、短く具体的に答えてください。" +
  "相手の記録（種目・重量・回数・体重）が渡されたら必ずそれを根拠にして話します。" +
  "重量や回数は必ず数字で提案します。医療の診断はしません。" +
  "痛みや体調不良が出ている場合は、無理をせず医療機関に相談するよう伝えてください。" +
  "内部の思考やシステム用のタグは出力しないでください。";

/* ---------- 小物 ---------- */
function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}
function bad(msg: string, status = 400): Response { return json({ error: msg }, status); }

function corsHeaders(env: Env, req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes("*") || allowed.includes(origin) || /^capacitor:\/\/|^ionic:\/\//.test(origin);
  return {
    "access-control-allow-origin": ok ? (origin || "*") : "null",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-device-key",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

function monthKey(): string {
  const d = new Date();
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}
function higherPlan(a: PlanId, b: PlanId): PlanId {
  return PLAN_ORDER.indexOf(a) >= PLAN_ORDER.indexOf(b) ? a : b;
}
function asPlan(v: unknown): PlanId | null {
  return typeof v === "string" && (PLAN_ORDER as string[]).includes(v) ? (v as PlanId) : null;
}

/* ---------- 本人確認 ----------
   ・基本は端末が作った長いランダム鍵（X-Device-Key）。これが合言葉になる
   ・Firebase でサインインしていれば ID トークンを優先し、uid を本人として扱う */
async function identify(req: Request, env: Env): Promise<{ id: string; deviceId: string | null; uid: string | null } | null> {
  const dk = (req.headers.get("x-device-key") || "").trim();
  const deviceId = /^[a-f0-9]{32,128}$/i.test(dk) ? "dev:" + dk.toLowerCase() : null;
  let uid: string | null = null;
  const auth = req.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ") && env.FIREBASE_PROJECT_ID) {
    uid = await verifyFirebaseToken(auth.slice(7).trim(), env.FIREBASE_PROJECT_ID);
  }
  const id = uid ? "uid:" + uid : deviceId;
  if (!id) return null;
  return { id, deviceId, uid };
}

let jwkCache: { keys: JsonWebKey[]; until: number } | null = null;
async function verifyFirebaseToken(token: string, projectId: string): Promise<string | null> {
  try {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return null;
    const dec = (x: string) => JSON.parse(new TextDecoder().decode(b64url(x)));
    const header = dec(h), payload = dec(p);
    if (header.alg !== "RS256") return null;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now || payload.aud !== projectId ||
        payload.iss !== "https://securetoken.google.com/" + projectId || !payload.sub) return null;
    if (!jwkCache || jwkCache.until < Date.now()) {
      const r = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
      const d = await r.json() as { keys: JsonWebKey[] };
      jwkCache = { keys: d.keys, until: Date.now() + 6 * 3600 * 1000 };
    }
    const jwk = jwkCache.keys.find(k => (k as { kid?: string }).kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(s), new TextEncoder().encode(h + "." + p));
    return ok ? String(payload.sub) : null;
  } catch { return null; }
}
function b64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}

/* ---------- 権利（プラン）の読み書き ---------- */
async function getEntitlement(env: Env, id: string): Promise<Entitlement> {
  const e = await env.ENTITLEMENTS.get<Entitlement>("ent:" + id, "json");
  if (!e) return { plan: "free", source: "none", updatedAt: 0 };
  if (e.periodEnd && e.periodEnd + 3 * 86400 * 1000 < Date.now()) {   // 猶予3日
    return { ...e, plan: "free", status: "expired" };
  }
  return e;
}
async function setEntitlement(env: Env, id: string, e: Entitlement): Promise<void> {
  await env.ENTITLEMENTS.put("ent:" + id, JSON.stringify(e));
}
async function getUsage(env: Env, id: string): Promise<number> {
  const v = await env.ENTITLEMENTS.get("usage:" + id + ":" + monthKey());
  return v ? parseInt(v, 10) || 0 : 0;
}
async function addUsage(env: Env, id: string): Promise<number> {
  const n = (await getUsage(env, id)) + 1;
  await env.ENTITLEMENTS.put("usage:" + id + ":" + monthKey(), String(n), { expirationTtl: 45 * 86400 });
  return n;
}
async function meResponse(env: Env, id: string): Promise<Record<string, unknown>> {
  const e = await getEntitlement(env, id);
  const used = await getUsage(env, id);
  const limit = AI_LIMIT[e.plan];
  return {
    identity: id,
    plan: e.plan,
    source: e.source,
    status: e.status || null,
    periodEnd: e.periodEnd || null,
    manageable: e.source === "stripe" && !!e.stripeCustomerId,
    ai: { limit, used, left: limit < 0 ? -1 : Math.max(0, limit - used) },
  };
}

/* ---------- Stripe ---------- */
function stripeClient(env: Env): Stripe | null {
  if (!env.STRIPE_SECRET_KEY) return null;
  return new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
}
function priceFor(env: Env, plan: PlanId): string | null {
  return plan === "pro" ? env.STRIPE_PRICE_PRO || null
       : plan === "max" ? env.STRIPE_PRICE_MAX || null
       : plan === "trainer" ? env.STRIPE_PRICE_TRAINER || null : null;
}
function planForPrice(env: Env, priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_PRO) return "pro";
  if (priceId === env.STRIPE_PRICE_MAX) return "max";
  if (priceId === env.STRIPE_PRICE_TRAINER) return "trainer";
  return null;
}
async function applyStripeSubscription(env: Env, sub: Stripe.Subscription, identityHint?: string | null): Promise<void> {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const identity = identityHint || sub.metadata?.identity || (await env.ENTITLEMENTS.get("cust:" + customerId));
  if (!identity) return;
  const item = sub.items.data[0];
  const plan = planForPrice(env, item?.price?.id) || "free";
  const active = sub.status === "active" || sub.status === "trialing" || sub.status === "past_due";
  const periodEnd = item?.current_period_end ? item.current_period_end * 1000 : undefined;
  await setEntitlement(env, identity, {
    plan: active ? plan : "free",
    source: "stripe",
    status: sub.status,
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub.id,
    periodEnd: active ? periodEnd : Date.now(),
    updatedAt: Date.now(),
  });
  await env.ENTITLEMENTS.put("cust:" + customerId, identity);
}

async function handleCheckout(req: Request, env: Env, id: string): Promise<Response> {
  const stripe = stripeClient(env);
  if (!stripe) return bad("stripe-not-configured", 503);
  const body = await req.json().catch(() => ({})) as { plan?: string };
  const plan = asPlan(body.plan);
  if (!plan || plan === "free") return bad("bad-plan");
  const price = priceFor(env, plan);
  if (!price) return bad("price-not-configured:" + plan, 503);
  const appUrl = (env.APP_URL || new URL(req.url).origin).replace(/\/$/, "");
  const cur = await getEntitlement(env, id);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: id,
    customer: cur.stripeCustomerId || undefined,
    allow_promotion_codes: true,
    locale: "ja",
    success_url: appUrl + "/?checkout=success&session_id={CHECKOUT_SESSION_ID}",
    cancel_url: appUrl + "/?checkout=cancel",
    metadata: { identity: id, plan },
    subscription_data: { metadata: { identity: id, plan } },
  });
  return json({ url: session.url });
}
async function handleCheckoutConfirm(req: Request, env: Env, id: string): Promise<Response> {
  const stripe = stripeClient(env);
  if (!stripe) return bad("stripe-not-configured", 503);
  const sid = new URL(req.url).searchParams.get("session_id") || "";
  if (!sid) return bad("no-session");
  const s = await stripe.checkout.sessions.retrieve(sid, { expand: ["subscription"] });
  if (s.client_reference_id !== id) return bad("not-yours", 403);
  if (s.payment_status !== "paid" && s.status !== "complete") return json({ pending: true, ...(await meResponse(env, id)) });
  const sub = s.subscription;
  if (sub && typeof sub !== "string") await applyStripeSubscription(env, sub, id);
  return json(await meResponse(env, id));
}
async function handlePortal(req: Request, env: Env, id: string): Promise<Response> {
  const stripe = stripeClient(env);
  if (!stripe) return bad("stripe-not-configured", 503);
  const e = await getEntitlement(env, id);
  if (!e.stripeCustomerId) return bad("no-customer", 404);
  const appUrl = (env.APP_URL || new URL(req.url).origin).replace(/\/$/, "");
  const p = await stripe.billingPortal.sessions.create({ customer: e.stripeCustomerId, return_url: appUrl + "/" });
  return json({ url: p.url });
}
async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  const stripe = stripeClient(env);
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) return bad("stripe-not-configured", 503);
  const sig = req.headers.get("stripe-signature") || "";
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, env.STRIPE_WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider());
  } catch (e) {
    return bad("bad-signature", 400);
  }
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object;
      if (s.mode === "subscription" && s.subscription) {
        const sub = await stripe.subscriptions.retrieve(typeof s.subscription === "string" ? s.subscription : s.subscription.id);
        await applyStripeSubscription(env, sub, s.client_reference_id);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      await applyStripeSubscription(env, event.data.object);
      break;
    default:
      break;
  }
  return json({ received: true });
}

/* ---------- RevenueCat（iOS App内課金） ----------
   ・RevenueCat の Entitlement ID を "pro" / "max" / "trainer" にしておく
   ・Webhook と、アプリからの「照合」の両方で KV を更新する */
function planFromEntitlementIds(ids: string[]): PlanId {
  let p: PlanId = "free";
  ids.forEach(x => { const q = asPlan(x); if (q) p = higherPlan(p, q); });
  return p;
}
async function handleRevenueCatWebhook(req: Request, env: Env): Promise<Response> {
  if (!env.REVENUECAT_WEBHOOK_AUTH) return bad("revenuecat-not-configured", 503);
  if ((req.headers.get("authorization") || "") !== env.REVENUECAT_WEBHOOK_AUTH) return bad("unauthorized", 401);
  const body = await req.json().catch(() => null) as { event?: Record<string, unknown> } | null;
  const ev = body?.event;
  if (!ev) return bad("no-event");
  const ids = [ev.app_user_id, ev.original_app_user_id].filter((x): x is string => typeof x === "string" && /^(dev|uid):/.test(x));
  if (!ids.length) return json({ ignored: true });
  const type = String(ev.type || "");
  const ended = ["EXPIRATION", "CANCELLATION"].includes(type) && !(type === "CANCELLATION" && Number(ev.expiration_at_ms || 0) > Date.now());
  const plan = ended ? "free" : planFromEntitlementIds(Array.isArray(ev.entitlement_ids) ? ev.entitlement_ids as string[] : []);
  for (const id of new Set(ids)) {
    await setEntitlement(env, id, {
      plan, source: "revenuecat", status: type.toLowerCase(),
      periodEnd: typeof ev.expiration_at_ms === "number" ? ev.expiration_at_ms : undefined,
      updatedAt: Date.now(),
    });
  }
  return json({ received: true });
}
/* アプリ側で購入・復元した直後に呼ぶ。RevenueCat の台帳を正として KV を更新する */
async function handleRevenueCatRefresh(env: Env, id: string): Promise<Response> {
  const key = env.REVENUECAT_API_KEY;
  if (!key) return bad("revenuecat-not-configured", 503);
  const r = await fetch("https://api.revenuecat.com/v1/subscribers/" + encodeURIComponent(id), {
    headers: { authorization: "Bearer " + key, "x-platform": "ios" },
  });
  if (!r.ok) return bad("revenuecat-http-" + r.status, 502);
  const d = await r.json() as { subscriber?: { entitlements?: Record<string, { expires_date: string | null }> } };
  const ents = d.subscriber?.entitlements || {};
  const now = Date.now();
  const active = Object.keys(ents).filter(k => { const x = ents[k].expires_date; return !x || Date.parse(x) > now; });
  let periodEnd: number | undefined;
  active.forEach(k => { const x = ents[k].expires_date; if (x) periodEnd = Math.max(periodEnd || 0, Date.parse(x)); });
  const cur = await getEntitlement(env, id);
  const plan = planFromEntitlementIds(active);
  if (plan !== "free" || cur.source === "revenuecat" || cur.source === "none") {
    await setEntitlement(env, id, { plan, source: plan === "free" ? "none" : "revenuecat", status: "synced", periodEnd, updatedAt: now });
  }
  return json(await meResponse(env, id));
}

/* ---------- AI相談 ---------- */
async function handleAI(req: Request, env: Env, id: string): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) return bad("ai-not-configured", 503);
  const body = await req.json().catch(() => null) as { messages?: Array<{ role: string; content: string }> } | null;
  const msgs = (body?.messages || []).filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12).map(m => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, 6000) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return bad("no-message");
  /* 交互になっていない部分を詰める（同じ役が続くと API がエラーを返す） */
  const merged: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.content; else merged.push({ ...m });
  }
  if (merged[0].role !== "user") merged.shift();

  const e = await getEntitlement(env, id);
  const limit = AI_LIMIT[e.plan];
  const used = await getUsage(env, id);
  if (limit >= 0 && used >= limit) return json({ error: "quota", plan: e.plan, ai: { limit, used, left: 0 } }, 402);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.AI_MODEL || "claude-opus-5";
  const effort = (env.AI_EFFORT || "medium") as "low" | "medium" | "high" | "xhigh" | "max";
  const maxTokens = parseInt(env.AI_MAX_TOKENS || "2000", 10) || 2000;
  try {
    const res = await client.beta.messages.create({
      model,
      max_tokens: maxTokens,
      system: AI_SYSTEM,
      messages: merged,
      output_config: { effort },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (res.stop_reason === "refusal") {
      return json({ text: "その相談には答えられませんでした。別の聞き方で試してください。", refused: true,
                    ai: { limit, used, left: limit < 0 ? -1 : Math.max(0, limit - used) } });
    }
    const text = res.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    const n = await addUsage(env, id);
    return json({ text, model: res.model, usage: res.usage, ai: { limit, used: n, left: limit < 0 ? -1 : Math.max(0, limit - n) } });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return bad("ai-rate-limited", 429);
    if (err instanceof Anthropic.AuthenticationError) return bad("ai-bad-key", 503);
    if (err instanceof Anthropic.APIError) return bad("ai-api-" + err.status, 502);
    return bad("ai-failed", 502);
  }
}

/* ---------- 端末鍵 → アカウントの引き継ぎ ---------- */
async function handleLink(env: Env, who: { id: string; deviceId: string | null; uid: string | null }): Promise<Response> {
  if (!who.uid || !who.deviceId || who.id === who.deviceId) return json(await meResponse(env, who.id));
  const dev = await getEntitlement(env, who.deviceId);
  const acc = await getEntitlement(env, who.id);
  if (dev.plan !== "free" && PLAN_ORDER.indexOf(dev.plan) > PLAN_ORDER.indexOf(acc.plan)) {
    await setEntitlement(env, who.id, { ...dev, updatedAt: Date.now() });
    if (dev.stripeCustomerId) await env.ENTITLEMENTS.put("cust:" + dev.stripeCustomerId, who.id);
  }
  return json(await meResponse(env, who.id));
}

/* ---------- 入口 ---------- */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (!path.startsWith("/api/")) {
      if (env.ASSETS) return env.ASSETS.fetch(req);
      return new Response("training support API", { status: 200 });
    }
    const cors = corsHeaders(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const withCors = (r: Response) => { Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v)); return r; };

    try {
      if (path === "/api/health") return withCors(json({ ok: true, ai: !!env.ANTHROPIC_API_KEY, stripe: !!env.STRIPE_SECRET_KEY, revenuecat: !!env.REVENUECAT_API_KEY, model: env.AI_MODEL || "claude-opus-5" }));
      if (path === "/api/webhooks/stripe" && req.method === "POST") return withCors(await handleStripeWebhook(req, env));
      if (path === "/api/webhooks/revenuecat" && req.method === "POST") return withCors(await handleRevenueCatWebhook(req, env));

      const who = await identify(req, env);
      if (!who) return withCors(bad("no-identity", 401));
      const id = who.id;

      if (path === "/api/me" && req.method === "GET") return withCors(json(await meResponse(env, id)));
      if (path === "/api/ai" && req.method === "POST") return withCors(await handleAI(req, env, id));
      if (path === "/api/checkout" && req.method === "POST") return withCors(await handleCheckout(req, env, id));
      if (path === "/api/checkout/confirm" && req.method === "GET") return withCors(await handleCheckoutConfirm(req, env, id));
      if (path === "/api/portal" && req.method === "POST") return withCors(await handlePortal(req, env, id));
      if (path === "/api/rc/refresh" && req.method === "POST") return withCors(await handleRevenueCatRefresh(env, id));
      if (path === "/api/link" && req.method === "POST") return withCors(await handleLink(env, who));
      return withCors(bad("not-found", 404));
    } catch (e) {
      console.error(e);
      return withCors(bad("internal", 500));
    }
  },
} satisfies ExportedHandler<Env>;
