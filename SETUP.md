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
デプロイの入口は 2 つ。**どちらか 1 つでいい**（両方あっても壊れはしない）。

### 1-A. Cloudflare の Git 連携で自動デプロイ（おすすめ・GitHub に鍵を置かない）
Cloudflare ダッシュボード → Workers & Pages → Create → 「Import a repository」でこのリポジトリを選ぶ。
すでに繋いであるなら Worker → **設定 → ビルド** を開いて、次の 3 つを合わせる：

| 項目 | 値 |
|---|---|
| ルートディレクトリ | `worker` |
| ビルドコマンド | `npm run build` |
| デプロイコマンド | `npx wrangler deploy` |

`npm run build` が `www/` の生成と **KV 名前空間の作成・id の差し込み**まで自動でやる。手作業は無し。
本番ブランチは `main`（ブランチ設定で `claude/workout-app-payments-ai-qvs947` を本番にしても動く）。

次に **AI の鍵を Worker に入れる**：Worker → 設定 → **変数とシークレット**（「ビルド」の中ではなく、上の方にある Worker 本体の欄）→ 追加
→ タイプ「**シークレット**」→ 名前 `ANTHROPIC_API_KEY` → 値に Claude コンソール → API Keys で作ったキー → デプロイ。

ビルドを「再試行」して成功したら、Worker の URL（`https://trainingnotebook.<アカウント>.workers.dev`）を開く。
これが**アプリの配信 URL 兼 API の URL**。AI相談と 📷 これ何？ がもう動く。`/api/health` で `"ai":true` なら OK。

### 1-B. GitHub Actions から自動デプロイ（1-A を使わない場合）
GitHub のリポジトリ → **Settings → Secrets and variables → Actions** に 3 つ入れて、Actions → Deploy Worker → Run workflow：

| Secret 名 | 値 |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare の Workers & Pages 画面右側の Account ID |
| `CLOUDFLARE_API_TOKEN` | My Profile → API Tokens → Create Token → テンプレート「Edit Cloudflare Workers」 |
| `ANTHROPIC_API_KEY` | Claude コンソール → API Keys で作ったキー（`sk-ant-...`） |

Stripe や RevenueCat の鍵も同じ画面の Secrets に入れれば次のデプロイで同期される
（`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `REVENUECAT_API_KEY` / `REVENUECAT_WEBHOOK_AUTH`）。
価格 ID や戻り先 URL は Variables（`STRIPE_PRICE_PRO` / `STRIPE_PRICE_MAX` / `STRIPE_PRICE_TRAINER` / `APP_URL`）。

### 共通メモ
- GitHub Pages で配り続けたいなら、`index.html` の `BACKEND_URL` に Worker の URL を入れる（iOS アプリでも必須）
- **📷 これ何？**（マシンの写真から名前・使い方を判定）も同じ Worker の `/api/vision` で動く。
  上限は AI相談と別枠でフリー月10回・プロ月60回・マックス以上は無制限（`worker/src/index.ts` の `VISION_LIMIT`）。
  写真1枚あたり ¥3〜5。
- モデルは既定で `claude-opus-5`。1 回の相談はだいたい ¥3〜5。コンソールの ¥3,000 で 600〜1,000 回くらい。
  安くしたいなら `worker/wrangler.toml` の `AI_MODEL` を `claude-sonnet-5` に（半額以下）
- 1-A のときの Stripe / RevenueCat の鍵は、ANTHROPIC_API_KEY と同じ「変数とシークレット」にシークレットとして追加。
  価格 ID（`STRIPE_PRICE_*`）と `APP_URL` は `worker/wrangler.toml` の `[vars]` に書いて push

### 手元の Mac からデプロイしたいとき（任意）
```bash
cd worker && npm install && npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy        # www/ 生成 → KV 作成 → デプロイ
```

---

## 2. Web のカード決済（Stripe）

1. https://dashboard.stripe.com でアカウント作成 → 開発者 → API キーの **シークレットキー**（まずは `sk_test_...` で）
2. 商品と価格を自動作成：
   ```bash
   cd worker
   STRIPE_SECRET_KEY=sk_test_... npm run stripe:setup
   ```
   出力された `STRIPE_PRICE_PRO / MAX / TRAINER` を `worker/wrangler.toml` の `[vars]` に書いて push（GitHub Actions 派なら Variables でも可）
3. 鍵を Worker の「変数とシークレット」に `STRIPE_SECRET_KEY`（シークレット）として入れる（GitHub Actions 派なら Secrets）
4. Webhook を登録：Stripe → 開発者 → Webhook → エンドポイント追加
   - URL：`https://<WorkerのURL>/api/webhooks/stripe`
   - イベント：`checkout.session.completed`、`customer.subscription.created / updated / deleted / paused / resumed`
   - 署名シークレット `whsec_...` を同じく `STRIPE_WEBHOOK_SECRET` として入れる
5. `worker/wrangler.toml` の `APP_URL` に、アプリを配っている URL（決済後に戻る先）を書いて push（自動でデプロイされる）
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
6. API Keys → **Secret key（`sk_...`）** を Worker のシークレット `REVENUECAT_API_KEY` として入れる
7. Integrations → Webhooks → URL `https://<WorkerのURL>/api/webhooks/revenuecat`、Authorization header に好きな合言葉。
   同じ文字列を Worker のシークレット `REVENUECAT_WEBHOOK_AUTH` として入れる

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
| AI が「API キーが入っていません」 | Worker の「変数とシークレット」に `ANTHROPIC_API_KEY` を入れる |
| 「決済はまだ準備中」 | `STRIPE_SECRET_KEY` と `STRIPE_PRICE_*` |
| 支払ったのにフリーのまま | Stripe の Webhook URL と `STRIPE_WEBHOOK_SECRET`。戻り URL に `?checkout=success` が付いているか |
| iOS で「準備ができていません」 | `RC_CONFIG.iosApiKey` と、Xcode の In-App Purchase Capability |
| iOS で「商品が登録されていません」 | App Store Connect の製品 ID と RevenueCat の Offering |
| Cloudflare のビルドが失敗する | ルートディレクトリが `worker`、ビルドコマンドが `npm run build` になっているか |
| ビルドログに「KV id が未解決」 | ダッシュボード → ストレージとデータベース → KV → 作成（名前は何でも可）→ その ID を「ビルド」の変数 `KV_NAMESPACE_ID` に入れて再試行 |
| ローカルで試したい | `cp worker/.dev.vars.example worker/.dev.vars` に鍵を書いて `npm run worker:dev` → `http://localhost:8787` |
