# アーキテクチャ設計

VADER CALL は、Cloudflare Workers 無料版で動く **WebRTC メッシュ型ビデオチャット**。
1 つの Worker が「静的フロントエンド配信」と「シグナリング用 Durable Object」を兼ねる。

## 全体構成

```
   ブラウザA ─┐                         ┌─ ブラウザB
              │   WebSocket (/ws)         │
              ├──────────────┐  ┌────────┤
              │              ▼  ▼         │
              │        ┌───────────────┐  │
              │        │ Cloudflare     │  │
              │        │ Worker         │  │
              │        │  ├ 静的配信     │  │
              │        │  └ Durable     │  │
              │        │    Object      │  │
              │        │  (SignalingRoom)│ │
              │        └───────────────┘  │
              │                            │
              └━━━━━━━━ WebRTC P2P ━━━━━━━━┘
                   （映像/音声は直接やり取り）
```

- **シグナリング（SDP / ICE 交換）**: WebSocket 経由で Durable Object が中継。
- **映像/音声**: ブラウザ間の WebRTC で **P2P 直結**（Worker は経由しない）。
- **メッシュ構成**: 各参加者が他の全参加者と PeerConnection を張る（4人なら各自 3 接続）。

## コンポーネント

| ファイル | 役割 |
| --- | --- |
| `src/index.js` | Worker の `fetch`（`/ws` を DO へ委譲、他は静的配信）と `SignalingRoom`（DO） |
| `public/index.html` | ロビー画面・通話画面のマークアップ |
| `public/styles.css` | ダースベーダーテーマ／全画面ノンスクロール／レスポンシブ |
| `public/app.js` | WebRTC メッシュ + シグナリングクライアント |

## シグナリングプロトコル

クライアントは次の URL で WebSocket 接続する:

```
/ws?room=<ルームID>&peer=<peerId>&name=<表示名>
```

Durable Object（`SignalingRoom`）はルームごとに 1 インスタンス（`idFromName(room)`）。
すべてのメッセージは JSON。`to` フィールドがあるものは宛先ピアへ中継され、`from`（送信元 peerId）が付与される。

### メッセージ一覧

| type | 方向 | 内容 |
| --- | --- | --- |
| `peers` | DO → 新規ピア | 既存ピア一覧 `[{peerId, name}]`（接続直後に受信） |
| `peer-joined` | DO → 既存ピア | 新規参加 `{peerId, name}` |
| `peer-left` | DO → 全ピア | 退室/切断 `{peerId}` |
| `offer` | ピア → ピア（DO 中継） | `{to, sdp}` → 受信側に `{from, sdp}` |
| `answer` | ピア → ピア（DO 中継） | `{to, sdp}` → 受信側に `{from, sdp}` |
| `ice-candidate` | ピア → ピア（DO 中継） | `{to, candidate}` → 受信側に `{from, candidate}` |

### 接続フロー（衝突回避）

新規参加者が常に **offer を出す側（initiator）** になることで、glare（同時 offer 衝突）を避ける。

1. 新規ピアが接続 → DO から `peers`（既存ピア一覧）を受信。
2. 新規ピアは既存ピア全員へ `offer` を送る。
3. 既存ピアは `peer-joined` を受信して待機 → 届いた `offer` に `answer` を返す。
4. 双方が `ice-candidate` を中継し合い、P2P 接続が確立。
5. `remoteDescription` 設定前に届いた ICE 候補はクライアント側でキューに溜め、設定後に流し込む。

## クライアント状態管理（app.js）

- `peers: Map<peerId, { pc, name, candidateQueue }>` で各接続を管理。
- `localStream` を全 PeerConnection に `addTrack`。
- リモートの `track` イベントでビデオタイルを動的追加、`peer-left`/接続失敗でタイル削除。
- グリッドは参加人数（最大4）に応じて `count-N` クラスでレイアウト切替（スクロールしない）。

## 制約・既知の限界

- **STUN のみ**のため、対称型 NAT など一部環境では接続できない場合がある（TURN 未使用）。
- メッシュ型のため帯域負荷が人数に応じて増える。**推奨は最大4人**。
- 認証なし。ルームID（合言葉）を知っていれば誰でも入室できる。
