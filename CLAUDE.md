# CLAUDE.md — エージェント向けガイド

このリポジトリで作業する Claude / エージェント向けの指針。**日本語で運用すること。**

## このプロジェクトについて

VADER CALL — ダースベーダー風テーマのシンプルなビデオチャット。
**Cloudflare Workers 無料版**（Pages 不使用）で動作。PC・タブレット・スマホ対応。

- 映像/音声は **WebRTC メッシュ P2P**（サーバー非経由、最大4人想定）
- シグナリングは **Durable Object（SQLite-backed）+ WebSocket Hibernation API**
- フロントは **バニラ HTML/CSS/JS（ビルド不要）**

設計の詳細は `docs/architecture.md`、無料版 Workers の制約は `docs/cloudflare-workers.md` を参照。

## 運用ルール

- **やりとり・ドキュメント・コミットログ・コメントはすべて日本語**で記述する。
- PR はユーザーの明示的な指示があるまで作成しない。
- UI テーマは「ダースベーダー風（黒基調 + シスレッド `#e30613` + 赤いグロー）」を維持する。
- **スクロール不要**の全画面レイアウトを崩さない（`overflow:hidden` / `100dvh`）。

## ディレクトリ構成

```
src/index.js          Worker の fetch + SignalingRoom（Durable Object）
public/index.html     ロビー画面 / 通話画面
public/styles.css     ダースベーダーテーマ・レスポンシブ・ノンスクロール
public/app.js         WebRTC メッシュ + シグナリングクライアント
docs/                 設計・調査ドキュメント
wrangler.jsonc        Worker 設定（assets / DO binding / migrations）
```

## よく使うコマンド

```bash
npm install           # 依存（wrangler）導入
npm run dev           # ローカル開発（wrangler dev → http://localhost:8787）
npm run deploy        # 手動デプロイ（wrangler deploy）
```

## 重要な注意点

- **無料版では Durable Object は SQLite-backed 必須**。`wrangler.jsonc` の migrations は
  必ず `new_sqlite_classes` を使う（`new_classes` は無料版で不可）。
- デプロイは原則 **GitHub への push による自動デプロイ**（Cloudflare Workers Builds 連携）。
- 映像はサーバーを経由しないため、Worker 側は SDP/ICE の中継のみ。通信量を増やさない設計を保つ。
- カメラ/マイクは HTTPS または localhost でのみ動作する。

## 動作確認の手順

1. `npm run dev` で起動。
2. `http://localhost:8787` を 2 つ以上のタブ/ウィンドウで開く。
3. 同じ合言葉（ルームID）で入室し、双方の映像/音声が表示されることを確認。
4. 3〜4 タブでメッシュ接続、マイク/カメラ ON-OFF、退室の動作を確認。
