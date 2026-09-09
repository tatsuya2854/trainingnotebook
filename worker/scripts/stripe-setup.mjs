/* Stripe に商品と価格（月額）を作り、wrangler.toml に入れる price ID を出力する。
   使い方：
     STRIPE_SECRET_KEY=sk_test_... npm run stripe:setup
   2回目以降は既存の同名商品を再利用する（重複して作らない）。 */
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error("STRIPE_SECRET_KEY を環境変数に入れてください"); process.exit(1); }
const stripe = new Stripe(key);

const PLANS = [
  { id: "pro",     name: "training support プロ",      amount: 600,  desc: "AI相談 月20回" },
  { id: "max",     name: "training support マックス",   amount: 1280, desc: "AI相談 無制限" },
  { id: "trainer", name: "training support トレーナー", amount: 3980, desc: "クライアント無制限・AI相談 無制限" },
];

const out = {};
for (const p of PLANS) {
  const found = await stripe.products.search({ query: `name:'${p.name}' AND active:'true'` });
  let product = found.data[0];
  if (!product) {
    product = await stripe.products.create({ name: p.name, description: p.desc, metadata: { plan: p.id } });
    console.log("商品を作成:", p.name, product.id);
  } else {
    console.log("既存の商品を使用:", p.name, product.id);
  }
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 10 });
  let price = prices.data.find(x => x.currency === "jpy" && x.recurring?.interval === "month" && x.unit_amount === p.amount);
  if (!price) {
    price = await stripe.prices.create({
      product: product.id, currency: "jpy", unit_amount: p.amount,
      recurring: { interval: "month" }, metadata: { plan: p.id },
    });
    console.log("価格を作成:", p.amount + "円/月", price.id);
  }
  out[p.id] = price.id;
}

console.log("\n--- wrangler.toml の [vars] に貼る ---");
console.log(`STRIPE_PRICE_PRO = "${out.pro}"`);
console.log(`STRIPE_PRICE_MAX = "${out.max}"`);
console.log(`STRIPE_PRICE_TRAINER = "${out.trainer}"`);
console.log("\n次に Stripe ダッシュボード → 開発者 → Webhook で、Worker の /api/webhooks/stripe を登録し、");
console.log("イベント checkout.session.completed と customer.subscription.* を選び、署名シークレット(whsec_...)を");
console.log("  npx wrangler secret put STRIPE_WEBHOOK_SECRET");
console.log("で入れてください。");
