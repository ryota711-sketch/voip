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

クライアントは次の URL で WebSocket 接続する（**peerId はサーバーが発行**するため URL には含めない）:

```
/ws?room=<ルームID>&name=<表示名>
```

Durable Object（`SignalingRoom`）はルームごとに 1 インスタンス（`idFromName(room)`）。
すべてのメッセージは JSON。`to` フィールドがあるものは宛先ピアへ中継され、`from`（送信元 peerId）が
**サーバー側で上書き付与**される（送信元のなりすまし防止）。

### メッセージ一覧

| type | 方向 | 内容 |
| --- | --- | --- |
| `welcome` | DO → 新規ピア | 自身の `peerId`（サーバー発行）と既存ピア一覧 `peers: [{peerId, name}]` |
| `room-full` | DO → 新規ピア | 満室通知 `{max}`。直後に WebSocket をクローズ（コード 1013） |
| `peer-joined` | DO → 既存ピア | 新規参加 `{peerId, name}` |
| `peer-left` | DO → 全ピア | 退室/切断 `{peerId}` |
| `offer` | ピア → ピア（DO 中継） | `{to, sdp}` → 受信側に `{from, sdp}` |
| `answer` | ピア → ピア（DO 中継） | `{to, sdp}` → 受信側に `{from, sdp}` |
| `ice-candidate` | ピア → ピア（DO 中継） | `{to, candidate}` → 受信側に `{from, candidate}` |

### 接続フロー（衝突回避）

新規参加者が常に **offer を出す側（initiator）** になることで、glare（同時 offer 衝突）を避ける。

1. 新規ピアが接続 → DO から `welcome`（自身の peerId + 既存ピア一覧）を受信。
2. 新規ピアは既存ピア全員へ `offer` を送る。
3. 既存ピアは `peer-joined` を受信して待機 → 届いた `offer` に `answer` を返す。
4. 双方が `ice-candidate` を中継し合い、P2P 接続が確立。
5. `remoteDescription` 設定前に届いた ICE 候補はクライアント側でキューに溜め、設定後に流し込む。

## クライアント状態管理（app.js）

- `peers: Map<peerId, { pc, name, candidateQueue }>` で各接続を管理。
- `localStream` を全 PeerConnection に `addTrack`。
- リモートの `track` イベントでビデオタイルを動的追加、`peer-left`/接続失敗でタイル削除。
- グリッドは参加人数（最大4）に応じて `count-N` クラスでレイアウト切替（スクロールしない）。

## セキュリティ対策

- **peerId はサーバー発行**（`crypto.randomUUID()`）。クライアントによるなりすまし・重複を防止。
- **送信元 `from` はサーバーが上書き**。中継メッセージで送信元を詐称できない。
- **Origin 検証**: `/ws` は同一オリジンからの接続のみ許可（CSWSH 対策）。
- **人数上限**: 1 ルーム最大 `MAX_PEERS`（既定 4 人）。超過時は `room-full` を返して切断。
- **メッセージサイズ制限**: 中継メッセージは `MAX_MESSAGE_CHARS`（既定 64KB）を超えると破棄。
- **ルームID 自動生成**: ロビーの「生成」ボタンで `crypto.getRandomValues` による推測困難な ID を発行可能。
- 表示名はサーバー側で 32 文字に切り詰め、クライアントは `textContent` で描画（XSS 対策）。

## 制約・既知の限界

- **STUN のみ**のため、対称型 NAT など一部環境では接続できない場合がある（TURN 未使用）。
- メッシュ型のため帯域負荷が人数に応じて増える。**推奨は最大4人**。
- 認証なし。ルームID（合言葉）を知っていれば誰でも入室できる（合言葉が事実上のアクセス制御）。
