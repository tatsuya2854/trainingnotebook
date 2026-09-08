/* デプロイ前の準備。Cloudflare の Git 連携（Workers Builds）でも GitHub Actions でも手元でも、これ1本。
   1) ../www を作る（index.html などを集める。Worker はここを静的配信する）
   2) wrangler.toml の KV id が仮のままなら、KV 名前空間を探して（無ければ作って）差し込む
   必要な環境変数：CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID（Workers Builds と Actions は自動で入る。手元は wrangler login でも可） */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, "..");
const repoDir = resolve(workerDir, "..");
const PLACEHOLDER = "REPLACE_WITH_KV_NAMESPACE_ID";

/* 1) www/ */
execSync("node scripts/build-www.mjs", { cwd: repoDir, stdio: "inherit" });

/* 2) KV id */
const tomlPath = resolve(workerDir, "wrangler.toml");
let toml = readFileSync(tomlPath, "utf8");
if (!toml.includes(PLACEHOLDER)) {
  console.log("KV id は設定済み");
} else {
  const run = (cmd) => execSync(cmd, { cwd: workerDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let id = (process.env.KV_NAMESPACE_ID || "").trim();   // ビルド変数で直接渡すこともできる
  if (id) console.log("KV id を環境変数から使用:", id);
  if (!id) try {
    const out = run("npx wrangler kv namespace list");
    const start = out.indexOf("[");
    const arr = start >= 0 ? JSON.parse(out.slice(start)) : [];
    const hit = arr.find((x) => /ENTITLEMENTS$/.test(x.title || ""));
    if (hit) { id = hit.id; console.log("既存の KV を使用:", hit.title, id); }
  } catch (e) {
    console.log("KV の一覧を取れませんでした（未ログインなら wrangler login か、CLOUDFLARE_API_TOKEN を入れてください）");
  }
  if (!id) {
    try {
      const out = run("npx wrangler kv namespace create ENTITLEMENTS");
      const m = out.match(/[a-f0-9]{32}/);
      if (m) { id = m[0]; console.log("KV を作成:", id); }
    } catch (e) {
      console.log("KV を作成できませんでした:", String(e.stderr || e.message).trim().split("\n").pop());
    }
  }
  if (id) {
    toml = toml.replace(PLACEHOLDER, id);
    writeFileSync(tomlPath, toml);
    console.log("wrangler.toml に KV id を書き込みました");
  } else {
    console.log("KV id が未解決のままです。デプロイは失敗します。");
    process.exitCode = 1;
  }
}
