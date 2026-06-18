# VADER CALL ⚔

ダースベーダー風テーマの、シンプルなビデオチャットアプリ。
**Cloudflare Workers 無料版**（Pages 不使用）で動作し、PC・タブレット・スマホに対応。

- 合言葉（ルームID）を入力するだけで通話に参加（最大4人）
- 映像/音声はブラウザ間の **WebRTC P2P 直結**（サーバーを経由しない）
- 黒 × シスレッドのダースベーダー風 UI、全画面・スクロール不要

## 技術構成

| レイヤー | 採用技術 |
| --- | --- |
| フロントエンド | バニラ HTML / CSS / JavaScript（ビルド不要） |
| 配信 | Cloudflare Workers Static Assets（無料・無制限） |
| シグナリング | Durable Object（SQLite-backed）+ WebSocket Hibernation API |
| 映像/音声 | WebRTC メッシュ（STUN のみ・TURN なし） |

詳細は [`docs/architecture.md`](docs/architecture.md) と
[`docs/cloudflare-workers.md`](docs/cloudflare-workers.md) を参照。

## ローカル開発

```bash
npm install
npm run dev        # wrangler dev（http://localhost:8787）
```

動作確認は、`http://localhost:8787` を **2 つ以上のブラウザタブ/ウィンドウ**で開き、
同じ合言葉を入力して入室する（localhost ではカメラ/マイクが許可される）。

> カメラ/マイクは HTTPS または localhost でのみ利用可能。本番 Workers ドメインは HTTPS。

## デプロイ

GitHub と Cloudflare Workers が連携済みのため、**指定ブランチへ push すると自動デプロイ**される
（Cloudflare の Workers Builds）。手動でデプロイする場合:

```bash
npm run deploy     # wrangler deploy
```

## 使い方

1. アプリを開く。
2. 名前と合言葉（ルームID）を入力して「入室する」。
3. 通話したい相手に同じ合言葉を伝える。相手が同じ合言葉で入室するとつながる。
4. 下部のボタンでマイク / カメラの ON-OFF、退室を操作。

## 制約

- **STUN のみ**のため、一部の厳しい NAT 環境では接続できない場合がある。
- メッシュ型 P2P のため、推奨は最大4人。
- 認証なし（合言葉を知っていれば入室可能）。
