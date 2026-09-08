# セットアップ手順（決済・AI・iOS配信）

コードは全部入っている。残りは「鍵を発行して貼る」「Apple/Stripe の管理画面で登録する」だけ。
上から順にやれば動く。所要はだいたい Web で 30 分、iOS は Apple の審査待ちを除いて 1〜2 時間。

```
index.html          ← アプリ本体（Web / iOS 共通）
privacy.html        ← プライバシーポリシー（App Store で URL 必須）
terms.html          ← 利用規約
worker/             ← サーバー（Cloudflare Worker）。AI中継・Stripe・RevenueCat・プラン管理
ios/                ← Xcode プロジェクト（Capacitor）
scripts/build-www.mjs ← index.html などを www/ に集める（iOS と Worker はここを見る）
```

仕組みを一言で：
**プランと AI の回数はサーバー（KV）が持ち、端末はランダムな鍵（X-Device-Key）で本人確認する。**
Web はカード（Stripe Checkout）、iOS は App 内課金（RevenueCat）。どちらの結果も同じ KV に入る。

---

## 1. サーバー（Cloudflare Worker）を立てる — 必須

AI も決済もこれが無いと動かない。Cloudflare は無料枠で足りる。

```bash
cd worker
npm install
npx wrangler login                      # ブラウザが開く
npx wrangler kv namespace create ENTITLEMENTS
#   → 出てきた id を wrangler.toml の [[kv_namespaces]] id に貼る

npx wrangler secret put ANTHROPIC_API_KEY   # Claude コンソール → API Keys で作ったキー
cd .. && npm run worker:deploy              # www/ を作って Worker をデプロイ
```

デプロイ後に出る URL（`https://trainingnotebook.<アカウント>.workers.dev`）が
**アプリの配信 URL 兼 API の URL**。ここを開けば AI相談がもう動く。

- 確認：`https://.../api/health` を開いて `"ai":true` なら OK
- GitHub Pages で配り続けたいなら、`index.html` の `BACKEND_URL` に上の URL を入れる（iOS アプリでも必須）
- モデルは `wrangler.toml` の `AI_MODEL`。既定は `claude-opus-5`。
  1 回の相談はだいたい ¥3〜5。コンソールの ¥3,000 で 600〜1,000 回くらい。
  安くしたいなら `claude-sonnet-5`（半額以下）。変えたら `npm run worker:deploy`

### GitHub からの自動デプロイ（任意）
リポジトリ → Settings → Secrets and variables → Actions に
`CLOUDFLARE_API_TOKEN`（Workers 編集 + KV 編集の権限）と `CLOUDFLARE_ACCOUNT_ID` を入れると、
main への push で `.github/workflows/deploy-worker.yml` が勝手にデプロイする。

---

## 2. Web のカード決済（Stripe）

1. https://dashboard.stripe.com でアカウント作成 → 開発者 → API キーの **シークレットキー**（まずは `sk_test_...` で）
2. 商品と価格を自動作成：
   ```bash
   cd worker
   STRIPE_SECRET_KEY=sk_test_... npm run stripe:setup
   ```
   出力された `STRIPE_PRICE_PRO / MAX / TRAINER` を `wrangler.toml` の `[vars]` に貼る
3. 鍵を Worker に入れる：
   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY
   ```
4. Webhook を登録：Stripe → 開発者 → Webhook → エンドポイント追加
   - URL：`https://<WorkerのURL>/api/webhooks/stripe`
   - イベント：`checkout.session.completed`、`customer.subscription.created / updated / deleted / paused / resumed`
   - 署名シークレット `whsec_...` を `npx wrangler secret put STRIPE_WEBHOOK_SECRET`
5. `wrangler.toml` の `APP_URL` に、アプリを配っている URL（決済後に戻る先）を入れて `npm run worker:deploy`
6. カスタマーポータル（解約・カード変更）を有効化：Stripe → 設定 → Billing → カスタマーポータル → 有効化

テストカード `4242 4242 4242 4242` で「プロにする」→ 戻ってきたら設定 → プランが「プロ」になれば完成。
本番は `sk_live_` のキーで 2〜4 をもう一度（Webhook も本番用に作り直す）。

---

## 3. iOS アプリ（App Store）

### 3-1. 必要なもの
- Mac + Xcode（最新）
- Apple Developer Program（年 ¥15,800 前後）：https://developer.apple.com/programs/
- RevenueCat アカウント（無料）：https://app.revenuecat.com

### 3-2. Xcode で開く
```bash
npm install
npm run ios:sync      # index.html → www/ → ios/ に反映（index.html を直すたびに実行）
npm run ios:open      # Xcode が開く
```
Xcode で：
- Signing & Capabilities → Team に自分の Apple Developer アカウント
- Bundle Identifier は `jp.trainingnotebook.app`（変えるなら `capacitor.config.json` と App Store Connect も揃える）
- **+ Capability → In-App Purchase** を追加
- アイコン・起動画面は入れてある（`ios/App/App/Assets.xcassets`）

実機で Run できれば OK。

### 3-3. App 内課金（Apple の規約で iOS 内はこれ一択。Stripe リンクを出すと審査で落ちる）
App Store Connect（https://appstoreconnect.apple.com）→ アプリを作成 → 「App 内課金」→ サブスクリプショングループを 1 つ作り、3 つ登録：

| 製品 ID（変えない） | 名前 | 価格 |
|---|---|---|
| `ts_pro_monthly` | プロ | ¥600 / 月 |
| `ts_max_monthly` | マックス | ¥1,280 / 月 |
| `ts_trainer_monthly` | トレーナー | ¥3,980 / 月 |

（製品 ID を変えたいときは `index.html` の `RC_PRODUCTS` も揃える）

RevenueCat：
1. Project 作成 → Apps → iOS を追加（Bundle ID を入れ、App Store Connect の **App-Specific Shared Secret** と In-App Purchase Key を登録）
2. Products に上の 3 つの製品 ID を取り込む
3. **Entitlements** を作る。識別子はそれぞれ `pro` / `max` / `trainer`（サーバーがこの名前で判定する）。各 Entitlement に対応する製品を付ける
4. Offerings → default に 3 つの Package を追加
5. API Keys → **Public app-specific key（`appl_...`）** を `index.html` の `RC_CONFIG.iosApiKey` に貼る
6. API Keys → **Secret key（`sk_...`）** を Worker に：`npx wrangler secret put REVENUECAT_API_KEY`
7. Integrations → Webhooks → URL `https://<WorkerのURL>/api/webhooks/revenuecat`、Authorization header に好きな合言葉。
   同じ文字列を `npx wrangler secret put REVENUECAT_WEBHOOK_AUTH`

`npm run ios:sync` し直して、Sandbox テスターで購入 → 設定 → プランが変われば完成。

### 3-4. 審査に出す
- App Store Connect でプライバシーポリシー URL に `https://<配信URL>/privacy.html`、利用規約は `terms.html`
- 「App のプライバシー」は「データを収集しない」or「識別子（端末ID）・利用状況」を正直に
- Xcode → Product → Archive → Distribute → App Store Connect → TestFlight で自分の iPhone に入れて確認 → 審査へ
- 審査メモに「AI相談は Claude API 経由。課金は StoreKit（RevenueCat）。復元ボタンはプラン画面にあります」と書いておくと通りやすい

---

## 4. Firebase 同期をつなぐとき（任意・後回しで OK）
`index.html` の `CLOUD_CONFIG` に Firebase の設定を入れて `enabled: true`。
`wrangler.toml` の `FIREBASE_PROJECT_ID` にプロジェクト ID を入れると、
サインイン時に端末鍵で買ったプランがアカウントに紐づく（`/api/link`）。

---

## 困ったとき
| 症状 | 見るところ |
|---|---|
| AI が「未設定」 | `index.html` の `BACKEND_URL`。同じ Worker から配信しているなら空で OK |
| AI が「API キーが入っていません」 | `npx wrangler secret put ANTHROPIC_API_KEY` |
| 「決済はまだ準備中」 | `STRIPE_SECRET_KEY` と `STRIPE_PRICE_*` |
| 支払ったのにフリーのまま | Stripe の Webhook URL と `STRIPE_WEBHOOK_SECRET`。戻り URL に `?checkout=success` が付いているか |
| iOS で「準備ができていません」 | `RC_CONFIG.iosApiKey` と、Xcode の In-App Purchase Capability |
| iOS で「商品が登録されていません」 | App Store Connect の製品 ID と RevenueCat の Offering |
| ローカルで試したい | `cp worker/.dev.vars.example worker/.dev.vars` に鍵を書いて `npm run worker:dev` → `http://localhost:8787` |
