'use strict';

/* =========================================================================
 * SyncText 复刻版 - 房间页交互与 WebRTC 同步
 *  - 解析 /r/<roomId> 房间号并填入顶栏
 *  - 按钮：分享链接、首页、清空、复制文本、重连接、状态详情、EN
 *  - WebRTC DataChannel P2P 同步文本（信令仅中继 SDP/ICE）
 * ========================================================================= */

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

// ---------- 房间号解析 ----------
function getRoomFromUrl() {
  const m = (location.pathname || '').match(/^\/r\/([^/?#]+)/);
  if (m) return decodeURIComponent(m[1]);
  const qs = new URLSearchParams(location.search);
  if (qs.get('room')) return qs.get('room');
  return '0808';
}
const room = getRoomFromUrl();
const roomEl = document.getElementById('room');
if (roomEl) roomEl.textContent = room;

// ---------- DOM ----------
const editor       = document.getElementById('editor');
const placeholder  = document.getElementById('placeholder');
const statusEl     = document.getElementById('status');
const btnStatus    = document.getElementById('btnStatus');
const btnShare     = document.getElementById('btnShare');
const btnHome      = document.getElementById('btnHome');
const btnClear     = document.getElementById('btnClear');
const btnCopyText  = document.getElementById('btnCopyText');
const btnReconnect = document.getElementById('btnReconnect');
const btnLang      = document.getElementById('btnLang');
const popover      = document.getElementById('statusPopover');
const myIdEl       = document.getElementById('myId');
const peerIdEl     = document.getElementById('peerId');
const serverRow    = popover ? popover.querySelector('.row.server') : null;
const toastEl      = document.getElementById('toast');

// 顶栏 URL 同步
try { history.replaceState(null, '', '/r/' + encodeURIComponent(room)); } catch (_) {}

// ---------- 状态 ----------
let ws = null;
let myId = null;
let amFirst = false;
let pc = null;
let channel = null;
let peerId = null;
let makingOffer = false;
let ignoreOffer = false;
let applyingRemote = false;
let statusState = 'connecting';
let popoverOpen = false;

function setStatus(state, text) {
  statusState = state;
  if (statusEl) {
    statusEl.dataset.state = state;
    statusEl.textContent = text;
  }
  if (serverRow) serverRow.dataset.state = state;
}

function showToast(text) {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toastEl.hidden = true; }, 1500);
}

// placeholder 在用户开始输入时隐藏
function refreshPlaceholder() {
  if (!placeholder) return;
  placeholder.style.display = editor.value.trim() ? 'none' : '';
}
editor.addEventListener('input', () => {
  refreshPlaceholder();
  if (applyingRemote) return;
  scheduleSend();
});

// ---------- 信令 ----------
function connectSignaling() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    ws = new WebSocket(proto + '://' + location.host + '/ws?room=' + encodeURIComponent(room));
  } catch (err) {
    setStatus('disconnected', '服务器未连接');
    setTimeout(connectSignaling, 1500);
    return;
  }

  ws.onopen = () => {
    setStatus('connecting', '服务器连接中');
    ws.send(JSON.stringify({ type: 'join', room }));
  };
  ws.onclose = () => {
    setStatus('disconnected', '服务器未连接');
    setTimeout(connectSignaling, 1500);
  };
  ws.onerror = () => { /* 静默 */ };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    handleSignal(msg);
  };
}

function handleSignal(msg) {
  if (msg.type === 'joined') {
    myId = msg.id;
    amFirst = !msg.peers || msg.peers.length === 0;
    if (myIdEl) myIdEl.textContent = myId.slice(0, 8);
    const peers = msg.peers || [];
    if (peers.length) { peerId = peers[0]; if (peerIdEl) peerIdEl.textContent = peerId.slice(0, 8); }
    else if (peerIdEl) peerIdEl.textContent = '—';
    ensurePeer();
    maybeCreateChannel();
    setStatus(amFirst ? 'waiting' : 'connecting', amFirst ? '等待节点' : '节点连接中');
  } else if (msg.type === 'peer-join') {
    peerId = msg.id;
    if (peerIdEl) peerIdEl.textContent = (msg.id || '').slice(0, 8);
    ensurePeer();
    maybeCreateChannel();
    setStatus('connecting', '节点连接中');
  } else if (msg.type === 'peer-leave') {
    if (peerIdEl) peerIdEl.textContent = '—';
    peerId = null;
    if (pc) { try { pc.close(); } catch (_) {} }
    pc = null; channel = null;
    setStatus('waiting', '等待节点');
  } else if (msg.type === 'signal') {
    onSignal(msg.data, msg.from);
  }
}

// ---------- WebRTC ----------
function ensurePeer() {
  if (pc) return;
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = ({ candidate }) => {
    if (candidate && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'signal', data: { candidate } }));
    }
  };

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      ws.send(JSON.stringify({ type: 'signal', data: { description: pc.localDescription } }));
    } catch (e) { /* noop */ } finally { makingOffer = false; }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') setStatus('ready', '已就绪');
    else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') setStatus('connecting', '节点连接中');
  };

  pc.ondatachannel = (e) => { channel = e.channel; setupChannel(channel); };
  maybeCreateChannel();
}

// 单一 DataChannel：仅由 id 较小的一端创建（避免两端各建一条导致先到者的通道 offer 被丢弃、永远打不开）
function maybeCreateChannel() {
  if (!pc || !myId || !peerId || channel) return;
  if (myId < peerId) {
    channel = pc.createDataChannel('sync');
    setupChannel(channel);
  }
  // 否则等待对方通过 ondatachannel 把通道推过来
}

function setupChannel(ch) {
  ch.onopen = () => {
    setStatus('ready', '已就绪');
    if (editor.value) sendText();
  };
  ch.onclose = () => setStatus('waiting', '等待节点');
  ch.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m.type === 'text') applyRemote(m);
  };
}

async function onSignal(data, from) {
  ensurePeer();
  if (!pc || !myId) return;
  const polite = myId > from;
  try {
    if (data.description) {
      const offerCollision = data.description.type === 'offer'
        && (makingOffer || pc.signalingState !== 'stable');
      ignoreOffer = !polite && offerCollision;
      if (ignoreOffer) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        await pc.setLocalDescription();
        ws.send(JSON.stringify({ type: 'signal', data: { description: pc.localDescription } }));
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); }
      catch (err) { if (!ignoreOffer) throw err; }
    }
  } catch (e) { /* noop */ }
}

// ---------- 文本同步 ----------
let rafPending = false;
function scheduleSend() {
  if (!channel || channel.readyState !== 'open') return;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; sendText(); });
}
function sendText() {
  if (!channel || channel.readyState !== 'open') return;
  try {
    channel.send(JSON.stringify({
      type: 'text',
      text: editor.value,
      selStart: editor.selectionStart,
      selEnd: editor.selectionEnd,
    }));
  } catch (_) {}
}
function applyRemote(m) {
  if (typeof m.text !== 'string') return;
  applyingRemote = true;
  editor.value = m.text;
  refreshPlaceholder();
  try {
    const s = Math.min(m.selStart ?? editor.value.length, editor.value.length);
    const e = Math.min(m.selEnd ?? editor.value.length, editor.value.length);
    editor.setSelectionRange(s, e);
  } catch (_) {}
  applyingRemote = false;
}

// ---------- 按钮 ----------
async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  }
}

const shareUrl = location.origin + '/r/' + encodeURIComponent(room);

btnShare && btnShare.addEventListener('click', async () => {
  if (await copyToClipboard(shareUrl)) showToast('链接已复制');
});

btnHome && btnHome.addEventListener('click', () => {
  if (confirm('确定要离开当前房间返回首页吗？')) location.href = '/';
});

btnClear && btnClear.addEventListener('click', () => {
  if (!editor.value || confirm('确定清空当前内容？两端都会同步清空。')) {
    editor.value = '';
    refreshPlaceholder();
    sendText();
  }
});

btnCopyText && btnCopyText.addEventListener('click', async () => {
  if (await copyToClipboard(editor.value)) showToast('文本已复制');
});

let reconnecting = false;
btnReconnect && btnReconnect.addEventListener('click', () => {
  if (reconnecting) { showToast('请不要频繁刷新'); return; }
  reconnecting = true;
  setTimeout(() => { reconnecting = false; location.reload(); }, 400);
});

btnStatus && btnStatus.addEventListener('click', () => {
  if (!popover) return;
  popoverOpen = !popoverOpen;
  popover.hidden = !popoverOpen;
});
document.addEventListener('click', (e) => {
  if (!popoverOpen || !popover) return;
  if (popover.contains(e.target) || btnStatus.contains(e.target)) return;
  popoverOpen = false;
  popover.hidden = true;
});

btnLang && btnLang.addEventListener('click', () => {
  btnLang.textContent = btnLang.textContent === 'EN' ? '中文' : 'EN';
});

// 浮动按钮仅做装饰占位（与原站右下圆形按钮位置一致）
document.querySelectorAll('.float-btn').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    showToast(el.title || '操作');
  });
});

// 启动
refreshPlaceholder();
connectSignaling();
