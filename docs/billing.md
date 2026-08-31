# Billing & Subscriptions

Flaxia uses **Stripe** for subscription management and marketplace payments.

---

## Plans

### Plan Flaxia (Free) — 最安値で最高の体験

- SNSとして普通の機能
- 公式提供スタンプ
- ユーザー定義スタンプ（5個まで）
- E2EEなダイナミックメッセージ、グループチャット、サーバーチャット
- 通常品質な通話
- Arcade（Shortsのようなゲームプレイ）

### Plan Flaxia+ (¥150/mo) — そのカフェインをスタンプに

- Flaxiaの全ての機能
- ユーザー定義スタンプを無制限に
- ユーザー定義スタンプにgifとmp4を許可
- アイコンにgifとmp4を許可
- 自己紹介にgifとmp4を許可
- 通話品質の改善

### Plan Flaxia++ (¥500/mo) — 飛行機にはハンバーガーではなく面白いゲームを!

- Flaxia+の全ての機能
- Flaxiaの好きなゲーム、画像、動画、音楽を機内モードで…そして、ローカルで楽しむ！
- より高度な通話品質

### Plan Flaxia# (¥1,000/mo) — Flaxiaの全てを

- Plan Flaxia++の全ての機能
- Flaxiaレポジトリのブランチ（`feature/...`, `experimental`, `ui-adds/...`）などをピックし、自由に適用して使用可能

---

## Flax-market

FlaxiaのArcade、音楽、動画が対象のマーケットプレイス。

- **価格帯**: ¥100〜¥50,000
- **対象**: Plan Flaxia++未加入ユーザー
- **機能**: 投稿されたローカルコンテンツ（ゲーム、音楽、動画）を購入してダウンロード可能
- **対象外**: Plan Flaxia++ / Flaxia#加入者は無料でアクセス可能

---

## API Endpoints

### Subscription

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/billing/checkout` | Stripe Checkout セッション作成 |
| `GET` | `/api/billing/plan` | ユーザーの現在プラン取得 |
| `POST` | `/api/billing/webhook` | Stripe Webhook 受信 |

### Marketplace

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/market/checkout` | マーケット購入用 Checkout セッション作成 |

---

## Database Tables

### `subscriptions`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT | PK |
| user_id | TEXT | FK → users(id) |
| stripe_subscription_id | TEXT | UNIQUE |
| stripe_customer_id | TEXT | |
| plan_id | TEXT | `flaxia_plus`, `flaxia_plus_plus`, `flaxia_sharp` |
| status | TEXT | `active`, `canceled`, `past_due`, `incomplete`, `trialing` |
| current_period_start | TEXT | ISO 8601 |
| current_period_end | TEXT | ISO 8601 |
| created_at | TEXT | ISO 8601 |
| updated_at | TEXT | ISO 8601 |

### `transactions`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT | PK |
| user_id | TEXT | FK → users(id) |
| post_id | TEXT | FK → posts(id) (marketplace only) |
| stripe_session_id | TEXT | UNIQUE |
| stripe_payment_intent_id | TEXT | |
| type | TEXT | `subscription` or `marketplace` |
| plan_id | TEXT | (subscription only) |
| amount | INTEGER | Amount in JPY |
| currency | TEXT | Default: `jpy` |
| status | TEXT | `pending`, `completed`, `failed`, `refunded` |
| metadata | TEXT | JSON (optional) |
| created_at | TEXT | ISO 8601 |

---

## Webhook Events

| Event | Action |
|-------|--------|
| `checkout.session.completed` | Marketplace: 取引完了 / Subscription: subscriptions テーブル作成 |
| `customer.subscription.updated` | ステータス・請求期間の更新 |
| `customer.subscription.deleted` | ステータスを `canceled` に変更 |
| `invoice.payment_succeeded` | 請求期間の更新 |
| `invoice.payment_failed` | ステータスを `past_due` に変更 |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe API シークレットキー |
| `STRIPE_WEBHOOK_SECRET` | Stripe Webhook 署名シークレット |
| `BASE_URL` | 成功/キャンセル URL のベース |
