/**
 * Cloudflare Worker エントリポイント
 *
 * - /ws へのリクエスト: WebRTC シグナリング用 Durable Object に委譲
 * - それ以外: 静的アセット（フロントエンド）を配信
 *
 * 映像/音声はブラウザ間の WebRTC P2P で直接やり取りするため、
 * サーバー（この Worker）は接続情報（SDP / ICE）の中継のみを担当する。
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // WebSocket によるシグナリング接続
    if (url.pathname === "/ws") {
      const room = url.searchParams.get("room");
      if (!room) {
        return new Response("room パラメータが必要です", { status: 400 });
      }
      // ルームIDから一意な Durable Object インスタンスを取得（ルーム＝1インスタンス）
      const id = env.SIGNALING.idFromName(room);
      const stub = env.SIGNALING.get(id);
      return stub.fetch(request);
    }

    // 静的アセット（index.html / styles.css / app.js）を配信
    return env.ASSETS.fetch(request);
  },
};

/**
 * シグナリング用 Durable Object
 *
 * ルームごとに 1 インスタンスが起動し、参加者（ピア）の WebSocket を管理する。
 * WebSocket Hibernation API を使い、アイドル時の課金を回避する。
 *
 * 役割:
 *  - 新規ピアに既存ピア一覧（peers）を返す
 *  - 既存ピアへ新規参加（peer-joined）を通知する
 *  - offer / answer / ice-candidate を宛先ピア（to）へ中継する
 *  - 切断時に退室（peer-left）を通知する
 */
export class SignalingRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket 接続が必要です", { status: 426 });
    }

    const url = new URL(request.url);
    const peerId = url.searchParams.get("peer");
    const name = (url.searchParams.get("name") || "ゲスト").slice(0, 32);

    if (!peerId) {
      return new Response("peer パラメータが必要です", { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation API でこの WebSocket を受け付ける
    this.ctx.acceptWebSocket(server);
    // ピア情報をソケットに添付（Hibernation 復帰後も参照可能）
    server.serializeAttachment({ peerId, name });

    // 新規ピアへ既存ピア一覧を送る
    const existing = this.ctx
      .getWebSockets()
      .filter((ws) => ws !== server)
      .map((ws) => ws.deserializeAttachment())
      .filter(Boolean);
    server.send(JSON.stringify({ type: "peers", peers: existing }));

    // 既存ピアへ新規参加を通知
    this.broadcast(server, { type: "peer-joined", peer: { peerId, name } });

    return new Response(null, { status: 101, webSocket: client });
  }

  /** sender 以外の全ピアへ送信 */
  broadcast(sender, msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== sender) {
        try {
          ws.send(data);
        } catch (_) {
          /* 送信失敗は無視（切断済みなど） */
        }
      }
    }
  }

  /** 特定の peerId のピアへ送信 */
  sendTo(targetPeerId, msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att && att.peerId === targetPeerId) {
        try {
          ws.send(data);
        } catch (_) {
          /* 送信失敗は無視 */
        }
      }
    }
  }

  async webSocketMessage(ws, message) {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (_) {
      return;
    }
    const from = ws.deserializeAttachment();
    if (!from) return;

    // offer / answer / ice-candidate は宛先（to）ピアへ、送信元（from）を付けて中継
    if (msg.to) {
      this.sendTo(msg.to, { ...msg, from: from.peerId });
    }
  }

  async webSocketClose(ws) {
    this.handleLeave(ws);
  }

  async webSocketError(ws) {
    this.handleLeave(ws);
  }

  handleLeave(ws) {
    const att = ws.deserializeAttachment();
    try {
      ws.close();
    } catch (_) {
      /* すでに閉じている場合は無視 */
    }
    if (att) {
      this.broadcast(ws, { type: "peer-left", peer: { peerId: att.peerId } });
    }
  }
}
