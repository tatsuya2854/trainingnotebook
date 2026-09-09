# セットアップ手順（決済・AI・iOS配信）

コードは全部入っている。残りは「鍵を発行して貼る」「Apple/Stripe の管理画面で登録する」だけ。
上から順にやれば動く。所要はだいたい Web で 30 分、iOS は Apple の審査待ちを除いて 1〜2 時間。

```
index.html          ← アプリ本体（Web / iOS 共通）
privacy.html        ← プライバシーポリシー（App Store で URL 必須）
terms.html          ← 利用規約
worker/src/index.ts ← サーバー（Cloudflare Worker）。AI中継・Stripe・RevenueCat・プラン管理
wrangler.toml       ← Worker の設定（モデル・価格 ID など）
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
**ビルド設定は初期値のままで動く**（ルートディレクトリ `/`・ビルドコマンド無し・デプロイコマンド `npx wrangler deploy`）。
`wrangler.toml` がリポジトリ直下にあり、`www/` の生成と KV の作成は wrangler が自動でやる。

やることは **AI の鍵を入れる**だけ：Worker → 設定 → **変数とシークレット**（「ビルド」の中ではなく、上の方にある Worker 本体の欄）→ 追加
→ タイプ「**シークレット**」→ 名前 `ANTHROPIC_API_KEY` → 値に Claude コンソール → API Keys で作ったキー → デプロイ。

push するたびに自動でビルドされる。本番は `main` ブランチ（プロダクション ブランチの設定）。
Worker の URL（`https://trainingnotebook.<アカウント>.workers.dev`）を開けば、AI相談と 📷 これ何？ が動く。
`/api/health` で `"ai":true` なら OK。

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
  安くしたいなら `wrangler.toml` の `AI_MODEL` を `claude-sonnet-5` に（半額以下）
- 1-A のときの Stripe / RevenueCat の鍵は、ANTHROPIC_API_KEY と同じ「変数とシークレット」にシークレットとして追加。
  価格 ID（`STRIPE_PRICE_*`）と `APP_URL` は `wrangler.toml` の `[vars]` に書いて push

### 手元の Mac からデプロイしたいとき（任意）
```bash
npm install && npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy        # www/ 生成 → KV 作成 → デプロイ
```

---

## 2. Web のカード決済（Stripe）

**やることは Stripe の鍵を 1 つ貼るだけ。** 商品・価格・Webhook・解約画面は Worker が初回に自動で作る。

1. https://dashboard.stripe.com でアカウント作成（本人確認と口座登録は Stripe 側の案内どおりに）
2. 開発者 → API キー → **シークレットキー** をコピー（まずはテスト用 `sk_test_...`。本番は `sk_live_...`）
3. Cloudflare → Worker → 設定 → **変数とシークレット** → 追加 → シークレット `STRIPE_SECRET_KEY` → 値に貼る → デプロイ
4. `https://<WorkerのURL>/api/health` を開いて `"stripe":true` になれば開通

アプリの設定 → プラン → 「プロにする」でカード入力画面（Stripe Checkout）が開く。
テストキーのときはテストカード `4242 4242 4242 4242`（有効期限は未来の任意、CVC 任意）で通る。
戻ってきたらプランが「プロ」になり、「お支払いを管理」から解約・カード変更ができる。

本番に切り替えるときは 2〜4 を `sk_live_` で繰り返すだけ（Webhook も本番用に自動で作り直される）。
手動で設定したい場合は `wrangler.toml` の `STRIPE_PRICE_*` と Secrets の `STRIPE_WEBHOOK_SECRET` が優先される。

---

## 3. iOS アプリ（App Store）

### 3-1. 必要なもの
- Apple Developer Program（年 ¥15,800 前後・本人名義で登録）：https://developer.apple.com/programs/
- RevenueCat アカウント（無料）：https://app.revenuecat.com
- **Mac は無くてもいい。** GitHub の Mac でビルドして TestFlight に送るワークフローが入っている（3-2-B）

### 3-2-A. Mac がある場合（Xcode）
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

### 3-2-B. Mac が無い場合（GitHub でビルド → TestFlight）
1. App Store Connect（https://appstoreconnect.apple.com）→ マイ App → 「+」→ 新規 App
   - プラットフォーム iOS、名前「training support」、バンドル ID `jp.trainingnotebook.app`（Identifiers で先に登録）、SKU は任意
2. App Store Connect → **ユーザとアクセス → 統合 → App Store Connect API** → キーを生成（役割 **Admin**）
   → `Issuer ID`・`キー ID` をメモし、`.p8` ファイルをダウンロード（1 回しかできない）
3. Apple Developer → Membership details → **Team ID**（10 桁）をメモ
4. GitHub → Settings → Secrets and variables → Actions に 4 つ：

   | Secret 名 | 値 |
   |---|---|
   | `APPLE_TEAM_ID` | 3 の Team ID |
   | `ASC_KEY_ID` | 2 のキー ID |
   | `ASC_ISSUER_ID` | 2 の Issuer ID |
   | `ASC_KEY_P8` | `.p8` ファイルの中身をテキストでそのまま |

5. GitHub → Actions → **iOS TestFlight** → Run workflow（main に push したときも自動で走る）
6. 20 分ほどで App Store Connect → TestFlight にビルドが並ぶ。iPhone に TestFlight アプリを入れて、自分をテスターに追加すればインストールできる

証明書・プロビジョニングプロファイルは Xcode のクラウド署名が自動で作る。手作業は無い。

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
- App Store Connect でプライバシーポリシー URL に `https://trainingnotebook.toropicanafanta.workers.dev/privacy.html`、利用規約は同 `/terms.html`
- 「App のプライバシー」は「データを収集しない」or「識別子（端末ID）・利用状況」を正直に
- TestFlight で自分の iPhone に入れて確認 → App Store Connect でそのビルドを選んで審査へ提出
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
| 「決済はまだ準備中」 | Worker のシークレット `STRIPE_SECRET_KEY`。`/api/health` の `stripe` が `error:` ならその文言を確認 |
| 支払ったのにフリーのまま | Stripe ダッシュボード → 開発者 → Webhook に Worker の URL が自動登録されているか。戻り URL に `?checkout=success` が付いているか |
| iOS で「準備ができていません」 | `RC_CONFIG.iosApiKey` |
| iOS TestFlight のビルドが失敗 | Actions のログ末尾と `xcodebuild-logs` の成果物。App Store Connect に App（バンドル ID）が作ってあるか、API キーの役割が Admin か |
| iOS で「商品が登録されていません」 | App Store Connect の製品 ID と RevenueCat の Offering |
| Cloudflare のビルドが失敗する | 設定 → ビルド → ビルド構成が初期値（ルート `/`・ビルドコマンド無し・`npx wrangler deploy`）か。ログの赤い行を確認 |
| ローカルで試したい | `cp .dev.vars.example .dev.vars` に鍵を書いて `npm run dev` → `http://localhost:8787` |
