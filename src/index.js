/**
 * Cloudflare Worker エントリポイント
 *
 * - /ws へのリクエスト: WebRTC シグナリング用 Durable Object に委譲
 * - それ以外: 静的アセット（フロントエンド）を配信
 *
 * 映像/音声はブラウザ間の WebRTC P2P で直接やり取りするため、
 * サーバー（この Worker）は接続情報（SDP / ICE）の中継のみを担当する。
 */

// 1 ルームの最大参加人数（メッシュ型のため少人数に制限。DoS / 負荷対策）
const MAX_PEERS = 4;
// 中継する 1 メッセージの最大文字数（巨大ペイロードによる負荷を防止）
const MAX_MESSAGE_CHARS = 64 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // WebSocket によるシグナリング接続
    if (url.pathname === "/ws") {
      // Origin 検証：同一オリジンからの接続のみ許可（CSWSH 対策）
      const origin = request.headers.get("Origin");
      if (origin) {
        let originHost;
        try {
          originHost = new URL(origin).host;
        } catch (_) {
          return new Response("不正な Origin です", { status: 403 });
        }
        if (originHost !== url.host) {
          return new Response("許可されていない Origin です", { status: 403 });
        }
      }

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
 *  - peerId をサーバー側で発行し、新規ピアへ既存ピア一覧とともに返す（welcome）
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
    const name = (url.searchParams.get("name") || "ゲスト").slice(0, 32);
    // peerId はサーバー側で発行（クライアントによるなりすまし・重複を防止）
    const peerId = crypto.randomUUID();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation API でこの WebSocket を受け付ける
    this.ctx.acceptWebSocket(server);

    // 満室チェック（自分を含めて上限を超える場合は拒否）
    if (this.ctx.getWebSockets().length > MAX_PEERS) {
      server.send(JSON.stringify({ type: "room-full", max: MAX_PEERS }));
      server.close(1013, "room full"); // 1013: Try Again Later
      return new Response(null, { status: 101, webSocket: client });
    }

    // ピア情報をソケットに添付（Hibernation 復帰後も参照可能）
    server.serializeAttachment({ peerId, name });

    // 新規ピアへ自身の peerId と既存ピア一覧を返す
    const existing = this.ctx
      .getWebSockets()
      .filter((ws) => ws !== server)
      .map((ws) => ws.deserializeAttachment())
      .filter(Boolean);
    server.send(JSON.stringify({ type: "welcome", peerId, peers: existing }));

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
    // メッセージサイズの上限チェック（巨大ペイロードによる負荷を防止）
    if (typeof message === "string" && message.length > MAX_MESSAGE_CHARS) {
      return;
    }
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
