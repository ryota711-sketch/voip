/* =========================================================
   VADER CALL — WebRTC メッシュ クライアント
   - 同じルームIDの参加者と P2P でつながる（最大4人想定）
   - シグナリング（SDP / ICE 交換）は /ws の Durable Object 経由
   ========================================================= */

// WebRTC 設定：無料の公開 STUN のみ（TURN は使わない）
const RTC_CONFIG = {
  iceServers: [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
      ],
    },
  ],
};

// ---- 状態 ----
let ws = null;
let localStream = null;
let myPeerId = null;
let myName = "";
const peers = new Map(); // peerId -> { pc, name, candidateQueue: [] }

// ---- DOM ----
const lobby = document.getElementById("lobby");
const call = document.getElementById("call");
const joinForm = document.getElementById("join-form");
const joinBtn = document.getElementById("join-btn");
const nameInput = document.getElementById("name-input");
const roomInput = document.getElementById("room-input");
const lobbyError = document.getElementById("lobby-error");
const grid = document.getElementById("grid");
const roomLabel = document.getElementById("room-label");
const statusEl = document.getElementById("status");
const micBtn = document.getElementById("mic-btn");
const camBtn = document.getElementById("cam-btn");
const leaveBtn = document.getElementById("leave-btn");
const genRoomBtn = document.getElementById("gen-room-btn");

let currentRoom = "";

// 推測されにくいランダムなルームIDを生成（盗聴・総当たり対策）
function genRoomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  // 読みやすいよう 4 文字ごとに区切る（例: 1a2b-3c4d-5e6f-...）
  return hex.match(/.{1,4}/g).join("-");
}

// 「合言葉を生成」ボタン
if (genRoomBtn) {
  genRoomBtn.addEventListener("click", () => {
    roomInput.value = genRoomId();
  });
}

// ---- ロビー：入室処理 ----
joinForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  lobbyError.hidden = true;
  myName = nameInput.value.trim() || "ゲスト";
  currentRoom = roomInput.value.trim();
  if (!currentRoom) return;

  joinBtn.disabled = true;
  joinBtn.textContent = "接続中…";

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: true,
    });
  } catch (err) {
    showLobbyError(
      "カメラ/マイクにアクセスできませんでした。ブラウザの権限を確認してください。"
    );
    resetJoinBtn();
    return;
  }

  // peerId はサーバーが発行する（welcome メッセージで受け取る）
  enterCallScreen();
  connectSignaling();
});

function showLobbyError(msg) {
  lobbyError.textContent = msg;
  lobbyError.hidden = false;
}
function resetJoinBtn() {
  joinBtn.disabled = false;
  joinBtn.textContent = "入室する";
}

function enterCallScreen() {
  lobby.hidden = true;
  call.hidden = false;
  roomLabel.textContent = currentRoom;
  // 自分の映像タイル（peerId とは独立した固定 ID "self" を使用）
  addTile("self", myName, localStream, true);
  updateGridCount();
}

// ---- シグナリング接続 ----
function connectSignaling() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws?room=${encodeURIComponent(
    currentRoom
  )}&name=${encodeURIComponent(myName)}`;
  ws = new WebSocket(url);

  ws.addEventListener("open", () => setStatus("接続済み"));
  ws.addEventListener("close", () => setStatus("切断されました"));
  ws.addEventListener("error", () => setStatus("接続エラー"));
  ws.addEventListener("message", (ev) => handleSignal(JSON.parse(ev.data)));
}

function setStatus(text) {
  statusEl.textContent = text;
}

function signalSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ---- シグナリング受信 ----
async function handleSignal(msg) {
  switch (msg.type) {
    case "welcome":
      // サーバーが発行した自分の peerId を受け取る
      myPeerId = msg.peerId;
      // 自分は新規参加者。既存ピア全員へこちらから offer を送る（衝突回避）
      for (const p of msg.peers) {
        await createPeer(p.peerId, p.name, true);
      }
      updateStatusCount();
      break;

    case "room-full":
      // 満室：通話画面を閉じ、ロビーでエラー表示
      leaveCall(`このルームは満室です（最大 ${msg.max} 人）。`);
      break;

    case "peer-joined":
      // 既存ピア側：新規参加者を記録（offer は相手から届くのを待つ）
      if (!peers.has(msg.peer.peerId)) {
        peers.set(msg.peer.peerId, {
          pc: null,
          name: msg.peer.name,
          candidateQueue: [],
        });
      }
      updateStatusCount();
      break;

    case "offer":
      await handleOffer(msg);
      break;

    case "answer":
      await handleAnswer(msg);
      break;

    case "ice-candidate":
      await handleCandidate(msg);
      break;

    case "peer-left":
      removePeer(msg.peer.peerId);
      updateStatusCount();
      break;
  }
}

// ---- PeerConnection の生成 ----
async function createPeer(peerId, name, isInitiator) {
  let entry = peers.get(peerId);
  if (entry && entry.pc) return entry.pc; // 既に確立済み

  const pc = new RTCPeerConnection(RTC_CONFIG);
  entry = entry || { name, candidateQueue: [] };
  entry.pc = pc;
  entry.name = name || entry.name;
  peers.set(peerId, entry);

  // 自分のトラックを送出
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  // 相手の映像/音声を受信
  pc.addEventListener("track", (ev) => {
    addTile(peerId, entry.name, ev.streams[0], false);
    updateGridCount();
  });

  // ICE 候補を相手へ中継
  pc.addEventListener("icecandidate", (ev) => {
    if (ev.candidate) {
      signalSend({
        type: "ice-candidate",
        to: peerId,
        candidate: ev.candidate,
      });
    }
  });

  pc.addEventListener("connectionstatechange", () => {
    if (
      pc.connectionState === "failed" ||
      pc.connectionState === "closed"
    ) {
      removePeer(peerId);
      updateStatusCount();
    }
  });

  // 新規参加者（initiator）側から offer を作成して送る
  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signalSend({ type: "offer", to: peerId, sdp: pc.localDescription });
  }

  return pc;
}

async function handleOffer(msg) {
  const pc = await createPeer(msg.from, peerEntryName(msg.from), false);
  await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  await flushCandidates(msg.from);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signalSend({ type: "answer", to: msg.from, sdp: pc.localDescription });
}

async function handleAnswer(msg) {
  const entry = peers.get(msg.from);
  if (!entry || !entry.pc) return;
  await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  await flushCandidates(msg.from);
}

async function handleCandidate(msg) {
  const entry = peers.get(msg.from);
  if (!entry) return;
  // remoteDescription 設定前に届いた候補はキューに溜める
  if (!entry.pc || !entry.pc.remoteDescription) {
    entry.candidateQueue.push(msg.candidate);
    return;
  }
  try {
    await entry.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
  } catch (_) {
    /* 無視 */
  }
}

async function flushCandidates(peerId) {
  const entry = peers.get(peerId);
  if (!entry || !entry.pc) return;
  while (entry.candidateQueue.length) {
    const c = entry.candidateQueue.shift();
    try {
      await entry.pc.addIceCandidate(new RTCIceCandidate(c));
    } catch (_) {
      /* 無視 */
    }
  }
}

function peerEntryName(peerId) {
  const e = peers.get(peerId);
  return e ? e.name : "ゲスト";
}

function removePeer(peerId) {
  const entry = peers.get(peerId);
  if (entry && entry.pc) {
    try {
      entry.pc.close();
    } catch (_) {}
  }
  peers.delete(peerId);
  removeTile(peerId);
  updateGridCount();
}

// ---- ビデオタイル ----
function addTile(peerId, name, stream, isLocal) {
  let tile = document.getElementById(`tile-${peerId}`);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "tile" + (isLocal ? " local" : "");
    tile.id = `tile-${peerId}`;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    if (isLocal) video.muted = true; // 自分の音はミュート（ハウリング防止）

    const label = document.createElement("span");
    label.className = "name";
    label.textContent = isLocal ? `${name}（あなた）` : name;

    tile.appendChild(video);
    tile.appendChild(label);
    grid.appendChild(tile);
  }
  const video = tile.querySelector("video");
  if (stream && video.srcObject !== stream) {
    video.srcObject = stream;
  }
}

function removeTile(peerId) {
  const tile = document.getElementById(`tile-${peerId}`);
  if (tile) tile.remove();
}

function updateGridCount() {
  const n = grid.children.length;
  grid.className = "grid count-" + Math.min(Math.max(n, 1), 4);
}

function updateStatusCount() {
  const n = peers.size + 1; // 自分を含む
  setStatus(`参加者 ${n} 人`);
}

// ---- コントロール ----
micBtn.addEventListener("click", () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  micBtn.classList.toggle("off", !track.enabled);
  micBtn.querySelector(".icon").textContent = track.enabled ? "🎤" : "🔇";
});

camBtn.addEventListener("click", () => {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  camBtn.classList.toggle("off", !track.enabled);
  camBtn.querySelector(".icon").textContent = track.enabled ? "📷" : "🚫";
});

leaveBtn.addEventListener("click", () => leaveCall());

// 通話を終了してロビーへ戻す。errorMessage を渡すとロビーにエラー表示する。
function leaveCall(errorMessage) {
  if (ws) {
    try {
      ws.close();
    } catch (_) {}
    ws = null;
  }
  for (const [, entry] of peers) {
    if (entry.pc) {
      try {
        entry.pc.close();
      } catch (_) {}
    }
  }
  peers.clear();
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }

  if (errorMessage) {
    // ロビーへ戻してエラーを表示（満室など）
    grid.innerHTML = "";
    call.hidden = true;
    lobby.hidden = false;
    resetJoinBtn();
    showLobbyError(errorMessage);
  } else {
    // 通常の退室は再読み込みでクリーンな状態に
    location.reload();
  }
}

// ページを閉じる際に通知
window.addEventListener("pagehide", () => {
  if (ws) {
    try {
      ws.close();
    } catch (_) {}
  }
});
