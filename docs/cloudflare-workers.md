# Cloudflare Workers 無料版 調査メモ

本アプリは **Cloudflare Workers の無料版（Pages は不使用）** 上で動作する。
ここでは、開発・運用で前提となる無料版の特性と、本アプリでの採用方針をまとめる。

## 1. 静的アセット配信（Static Assets）

- Workers は `assets` 設定でフロントエンド（HTML/CSS/JS）を配信できる。**Pages は不要**。
- **静的アセットへのリクエストは無料・無制限**。保存コストもなし。
- `not_found_handling: "single-page-application"` で SPA 的な配信が可能。
- 制限: **無料版は 1 Worker あたり静的ファイル 20,000 件まで**（本アプリは数ファイルなので問題なし）。
- `compatibility_date` を `2025-04-01` 以降にすると、ナビゲーション要求で Worker を起動せずにアセットを返すため、課金対象の呼び出しを削減できる。

## 2. Durable Objects（シグナリングに利用）

- Durable Objects は **無料版でも利用可能**。ただし **SQLite-backed クラスのみ**。
- そのため `wrangler.jsonc` の migrations では `new_classes` ではなく
  **`new_sqlite_classes`** を使う必要がある（これを誤ると無料版でデプロイできない）。
- WebRTC のシグナリング（接続情報の交換）に最適。ルームごとに `idFromName(roomId)` で 1 インスタンスを割り当てる。

### WebSocket Hibernation API

- WebSocket 接続中は通常 Duration 課金が発生するが、**Hibernation API**（`ctx.acceptWebSocket()` /
  `webSocketMessage` / `webSocketClose` ハンドラ）を使うと、アイドル時に Durable Object が
  メモリから退避され、Duration 課金を回避できる。クライアントの接続は維持される。
- 受信 WebSocket メッセージは **20:1 の比率**でリクエスト課金される（100万受信 ≒ 5万リクエスト換算）。
- 本アプリはシグナリング（SDP/ICE 交換）のみで通信量が少なく、映像は P2P 直結のため、無料枠で十分。

## 3. 無料版の主な制限

- **1 日あたり 100,000 リクエスト**。
- 1 Worker isolate のメモリは最大 128 MB。
- 静的アセットは 1 Worker あたり 20,000 ファイルまで。

## 4. 本アプリのアーキテクチャ方針

- **映像/音声はサーバーを経由しない**（WebRTC の P2P 直結）。Worker は接続情報の中継のみ。
  → 無料版でも帯域コストが発生しない。
- **NAT 越えは Google 公開 STUN のみ**（`stun:stun.l.google.com:19302` 等）。TURN は使わない。
  → 多くの環境でつながるが、厳しい NAT 環境（一部のモバイル回線など）では接続できない場合がある。
- メッシュ型 P2P のため、参加人数が増えると各クライアントの帯域負荷が増す。**最大4人**を想定。

## 参考リンク

- [Static Assets · Cloudflare Workers docs](https://developers.cloudflare.com/workers/static-assets/)
- [Single Page Application (SPA) · Cloudflare Workers docs](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- [Pricing · Cloudflare Workers docs](https://developers.cloudflare.com/workers/platform/pricing/)
- [Pricing · Cloudflare Durable Objects docs](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Use WebSockets · Cloudflare Durable Objects docs](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
