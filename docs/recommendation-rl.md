# Recommendation & Dwell-time RL

Flaxia の Arcade は TikTok/Shorts 風の縦スクロール全画面フィードです。本ドキュメントは
ユーザープロファイリングと、滞在時間 (dwell time) 最大化のための強化学習 (RL) 方針を説明します。

## 概要

3 層構成で、`収集 → 推論 → 学習` のループを回します。

| 層 | 役割 | 実装 |
|---|---|---|
| 収集 | すべての閲覧（スキップ含む）とエンゲージメントを記録 | `arcade_events` + `user_profiles` |
| 推論 | エッジでパーソナライズ表示を決める | `functions/api/[[route]].ts` の `/api/games` |
| 学習 | データセットから方策を学習（外部実行） | HuggingFace データセット + 外部トレーニング |

トレーニングは Flaxia のインフラでは実行しません。Workers はステートレスなエッジであり、
深層 RL の学習には不向きです。そのため、**オンラインの軽量コンテキスチュアル・バンディット**で
配信し、**オフライン RL 用データセット**を HuggingFace に公開して外部で学習します。

## 1. プロファイリング

### 生イベント (`arcade_events`)
`src/components/ArcadePage.ts` は、表示されたすべてのゲームについてイベントを
`POST /api/games/events` へバッチ送信します（`sessionId` 付き）。

- `view` — 表示。**2 秒未満のスキップも `did_skip=1` として記録**（負例）。
- `fresh` / `reply` / `fullscreen` / `share` — ポジティブなエンゲージメント。

### マテリアライズ済みプロファイル (`user_profiles`)
`interest_vec`（重み付き平均の 1024 次元ベクトル）を DB に保存し、
`loadOrComputeInterestVector()` が 5 分 TTL でキャッシュします。お気に入り (fresh) と
高滞在 (dwell>5s) のプレイから重み付きで導出されます。

## 2. 推論: コンテキスチュアル・バンディット (LinUCB)

`functions/lib/linucb.ts` に実装。`/api/games?recommended=true` で既存ヒューリスティックと
ブレンドされます。

- 各候補の 1024 次元埋め込みを **決定的ランダム射影** で 64 次元に圧縮（JL）。
- ユーザーごとの状態 `A⁻¹`（64×64）, `b`, `t` を `bandit_state` に保存し、
  Sherman-Morrison でオンライン更新。
- スコア = `θᵀx + α·sqrt(xᵀA⁻¹x)`（期待報酬 + 探索ボーナス）。
- 最終スコア = `λ·ヒューリスティック + (1−λ)·バンディット正規化スコア`。

### 設定 (KV)
`arcade:bandit:config` (JSON) で動作を制御します。**デフォルトは無効**です。

```json
{ "enabled": true, "alpha": 0.6, "dim": 64, "seed": 20260701, "lambda": 0.6 }
```

- `enabled` — バンディットを有効化。
- `alpha` — 探索強度（大きいほど探索重視）。
- `lambda` — ヒューリスティックへの重み（1 で完全に無効化と同等）。
- `dim` — 投影次元（8〜256）。
- `seed` — 射影行列の決定シード（**変更すると過去の学習状態が無効化**されます）。

設定例:
```bash
npx wrangler kv key put --binding=CACHE 'arcade:bandit:config' '{"enabled":true,"alpha":0.6,"dim":64,"lambda":0.6,"seed":20260701}'
```

### 報酬
`/api/games/events` が `eventReward()` で報酬を計算し `bandit_state` を更新します。

| イベント | 報酬 |
|---|---|
| view (dwell) | `min(dwell_ms/30000, 1)`（スキップはほぼ 0） |
| fresh / reply | 1.0 |
| share | 0.8 |
| fullscreen | 0.6 |

## 3. HuggingFace データセット

`scheduled` ハンドラ（`functions/queue-worker.ts`）が毎日 04:00 UTC に
`functions/lib/dataset-export.ts` の `runDatasetExport()` を実行します
（`wrangler.toml.worker` の `[triggers] crons`）。

### プライバシー
- `user_id` / `session_id` / `post_id` は **回転ソルト付き SHA-256** で匿名化。
- 本文・メール・bio 等の PII は一切含めません。
- ソルトは KV (`arcade:dataset:salt`) に保存され、ローテーション可能。

### スキーマ
各行 = セッション内で表示された 1 ゲーム（スキップ含む）。

```
user_id, session_id, post_id, game_type, position, event_type,
dwell_ms, did_skip, is_fullscreen, swipe_velocity, hour, created_at,
post_embedding (1024-d), label (reward)
```

### アップロード (fail-graceful)
- 成果物 (JSONL) は常に R2 (`flaxia-exports`) に書き込み。
- `HF_TOKEN` secret と `HF_REPO` var が設定されている場合のみ HuggingFace へアップロード。
- 設定がない場合はログを出してスキップ（チェックポイントは進む）。

設定:
```bash
npx wrangler secret put HF_TOKEN --config wrangler.toml.worker
# wrangler.toml.worker の [vars] に HF_REPO を追加
```

チェックポイントは KV (`arcade:dataset:checkpoint`) に保存され、再開可能です。

## 4. 外部トレーニング手順

1. 公開データセットを取得:
   ```python
   from datasets import load_dataset
   ds = load_dataset("youruser/flaxia-arcade-dwell")
   ```
2. **方策 1 (LinUCB 再学習)** — `post_embedding` を特徴量に、
   `label` を報酬としたオフライン回帰でパラメータを再計算し、
   `arcade:bandit:config` と KV の状態初期化に利用。
3. **方策 2 (深層 RL)** — フィード上のセッションを系列とみなし、
   累積滞在を最大化する方策（例: 系列レコメンダー、学習済み方策のロールアウト）を学習。
4. 学習済みパラメータを KV/D1 にデプロイして配信へ反映。

## 実運用上の注意

- バンディットは**デフォルト無効**。`arcade:bandit:config` で段階的に有効化。
- `seed` 変更は射影行列を変えるため学習状態をリセットしてください。
- 大量の `bandit_state` 書き込みを避けるため、報酬更新はイベントバッチごとに
  1 回の読み書きにまとめています。
