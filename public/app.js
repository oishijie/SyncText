'use strict';

/* =========================================================================
 * SyncText 复刻版 - 房间页交互与 WebRTC 同步
 *  - 解析 /r/<roomId> 房间号并填入顶栏
 *  - 按钮：分享链接、首页、清空、复制文本、重连接、状态详情、EN、发文件、主题
 *  - WebRTC DataChannel P2P 同步文本 + 互传文件（信令仅中继 SDP/ICE）
 *  - 文件传输协议（128KB 分块/位图断点续传/SHA-256 校验/暂停取消）
 *    移植自 Link Mesh（AGPL-3.0）github.com/hesanyue50-lang/link-mesh
 * ========================================================================= */

// 国内 STUN 放前面：Google STUN 在部分网络不可达会导致拿不到 srflx 候选（同 Link Mesh）
const ICE_SERVERS = [
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
  { urls: 'stun:stun.qq.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.nextcloud.com:443' },
  { urls: 'stun:stun.syncthing.net:3478' },
];

const CONNECT_TIMEOUT_MS = 60 * 1000; // 建连总超时（ICE+DTLS 通常 10-20s，移动网 STUN 重试可到 40s，30s 会误杀）

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
const netHint      = document.getElementById('netHint');
const toastEl      = document.getElementById('toast');
const btnSend      = document.getElementById('btnSend');
const btnTheme     = document.getElementById('btnTheme');
const fileInput    = document.getElementById('fileInput');
const transfersEl  = document.getElementById('transfers');
const confirmBox   = document.getElementById('confirmBox');
const confirmName  = document.getElementById('confirmName');
const confirmMeta  = document.getElementById('confirmMeta');
const confirmHint  = document.getElementById('confirmHint');
const btnAccept    = document.getElementById('btnAccept');
const btnReject    = document.getElementById('btnReject');
const autoAcceptEl = document.getElementById('autoAccept');
const dropMask     = document.getElementById('dropMask');
const roomPill     = document.getElementById('roomPill');
const btnMore      = document.getElementById('btnMore');
const moreMenu     = document.getElementById('moreMenu');

// 顶栏 URL 同步
try { history.replaceState(null, '', '/r/' + encodeURIComponent(room)); } catch (_) {}

// ---------- 状态 ----------
let ws = null;
let myId = null;
let amFirst = false;
let pc = null;
let channel = null;
let fileChannel = null;
let peerId = null;
let makingOffer = false;
let ignoreOffer = false;
let applyingRemote = false;
let statusState = 'connecting';
let popoverOpen = false;
let connectWatchdog = null;     // 建连 60s 看门狗
let candidateTypes = new Set(); // 本地 ICE 候选类型普查，失败时用于归因

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
    pc = null; channel = null; fileChannel = null;
    onPeerGone(); // 所有进行中的文件传输标记失败
    setStatus('waiting', '等待节点');
  } else if (msg.type === 'signal') {
    // 兼容读 from ?? id：旧版 DO 广播用的是 id 字段，会导致 polite 判定恒为 false
    onSignal(msg.data, msg.from ?? msg.id);
  }
}

// ---------- WebRTC ----------
function ensurePeer() {
  if (pc) return;
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      // 记录本地候选类型，建连失败时给出归因提示（同 Link Mesh 的候选普查）
      if (candidate.type) candidateTypes.add(candidate.type);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'signal', data: { candidate } }));
      }
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
    const s = pc.connectionState;
    if (s === 'connected') {
      clearConnectWatchdog();
      setStatus('ready', '已就绪');
    } else if (s === 'disconnected') {
      setStatus('connecting', '节点连接中');
    } else if (s === 'failed') {
      clearConnectWatchdog();
      reportConnectFailure();
    }
  };

  pc.ondatachannel = (e) => {
    if (e.channel.label === 'file') { fileChannel = e.channel; setupFileChannel(e.channel); }
    else { channel = e.channel; setupChannel(e.channel); }
  };
  maybeCreateChannel();
  armConnectWatchdog();
}

// 建连超时归因：按本地候选普查给出三种提示（移植自 Link Mesh WebRtcSession）
function reportConnectFailure() {
  setStatus('failed', '连接失败');
  let reason;
  if (!candidateTypes.has('srflx') && !candidateTypes.has('prflx') && !candidateTypes.has('relay')) {
    reason = '网络可能禁用了 UDP（STUN 不可达）';
  } else if (!candidateTypes.has('host')) {
    reason = '双方似乎不在同一网段';
  } else {
    reason = '疑似对称型 NAT 或防火墙拦截，无中继服务器无法直连';
  }
  if (netHint) { netHint.textContent = '失败原因：' + reason; netHint.hidden = false; }
  showToast('P2P 连接失败：' + reason);
}

function armConnectWatchdog() {
  clearConnectWatchdog();
  connectWatchdog = setTimeout(() => {
    if (pc && pc.connectionState !== 'connected') reportConnectFailure();
  }, CONNECT_TIMEOUT_MS);
}

function clearConnectWatchdog() {
  if (connectWatchdog) { clearTimeout(connectWatchdog); connectWatchdog = null; }
}

// DataChannel 创建约定：仅由 id 较小的一端创建（sync + file 两条一次 offer 带出，
// 避免两端各建导致先到者的通道 offer 被丢弃、永远打不开）
function maybeCreateChannel() {
  if (!pc || !myId || !peerId) return;
  if (myId < peerId) {
    if (!channel) { channel = pc.createDataChannel('sync'); setupChannel(channel); }
    if (!fileChannel) {
      fileChannel = pc.createDataChannel('file');
      fileChannel.binaryType = 'arraybuffer';
      setupFileChannel(fileChannel);
    }
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
  const flush = () => { rafPending = false; sendText(); };
  // 后台标签页的 rAF 永远不会触发（会卡住 rafPending），隐藏时降级为定时器
  if (document.hidden) setTimeout(flush, 50);
  else requestAnimationFrame(flush);
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

// ---------- 文件传输（协议移植自 Link Mesh，AGPL-3.0） ----------
// 控制消息走 file 通道 JSON 文本帧；数据块是二进制帧：uint32 fileId + uint32 chunkIndex + 原始字节
// 同一通道可双向同时传输，靠 fileId 路由到各自的传输任务
const FILE_CHUNK = 128 * 1024;        // 基准分块（实际按 maxMessageSize 自适应，见 beginSendFile）
const READ_BLOCK = 4 * 1024 * 1024;   // 每次读 4MB 再在内存里切块，消除每块一次的 await 往返
const HIGH_WATER = 4 * 1024 * 1024;   // 背压高水位：跨网高 RTT 下 1MB 窗口填不满管道
const LOW_WATER = 1 * 1024 * 1024;    // 背压低水位：恢复发送
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const transfers = new Map();          // fileId -> transfer
const sendQueue = [];                 // 发送队列（同一时刻只跑一个发送任务）
const ACTIVE_SEND = new Set(['hashing', 'offering', 'sending', 'verifying']);
const TERMINAL = new Set(['done', 'failed', 'rejected', 'canceled']);
let hashJobSeq = 0;
let opfsSupport = null;               // null=未探测

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTerminal = (t) => TERMINAL.has(t.state);

function newFileId() {
  let id;
  do { id = (Math.random() * 0xffffffff) >>> 0; } while (!id || transfers.has(id));
  return id;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + units[i];
}

// 位图与 Base64 互转（等价 Link Mesh 的 BitSet.toByteArray 编码，1GB 文件位图约 1KB）
function bytesToB64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
function bitTest(bits, i) { return i < bits.length * 8 && !!(bits[i >> 3] & (1 << (i & 7))); }
function countBits(bits, total) { let n = 0; for (let i = 0; i < total; i++) if (bitTest(bits, i)) n++; return n; }
function highestSetBit(bits) { for (let i = bits.length * 8 - 1; i >= 0; i--) if (bitTest(bits, i)) return i; return -1; }

// ---------- 哈希 Worker 封装 ----------
let hashWorker = null;
const hashJobs = new Map(); // job -> { resolve, onProgress? }

function getHashWorker() {
  if (hashWorker) return hashWorker;
  try { hashWorker = new Worker('/sha256-worker.js'); } catch (_) { return null; }
  hashWorker.onmessage = (e) => {
    const m = e.data;
    const job = hashJobs.get(m.job);
    if (!job) return;
    if (m.op === 'progress') { if (job.onProgress) job.onProgress(m.done, m.total); }
    else if (m.op === 'done') { hashJobs.delete(m.job); job.resolve(m.hex); }
  };
  hashWorker.onerror = () => {
    for (const [, job] of hashJobs) job.resolve(null);
    hashJobs.clear();
  };
  return hashWorker;
}

function hashFile(file, onProgress) {
  const w = getHashWorker();
  if (!w) return Promise.resolve(null);
  return new Promise((resolve) => {
    const job = ++hashJobSeq;
    hashJobs.set(job, { resolve, onProgress });
    try { w.postMessage({ op: 'file', job, file }); }
    catch (_) { hashJobs.delete(job); resolve(null); }
  });
}

// OPFS 操作兜底超时：个别环境下 createWritable 可能永久挂起，超时后降级内存模式
function withTimeout(p, ms, tag) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(tag + '超时')), ms)),
  ]);
}

// ---------- 传输卡片 UI ----------
function makeCard(t) {
  const el = document.createElement('div');
  el.className = 'tcard' + (t.dir === 'send' ? ' out' : ' in');
  // 扩展名徽标（无扩展名显示「文件」）；最长 4 字符避免撑爆图标位
  const dot = t.name.lastIndexOf('.');
  const ext = dot > 0 ? t.name.slice(dot + 1).slice(0, 4).toUpperCase() : '文件';
  el.innerHTML =
    '<div class="t-icon"></div>' +
    '<div class="t-body">' +
      '<div class="t-head"><span class="t-name"></span><span class="t-size"></span></div>' +
      '<div class="t-bar"><i></i></div>' +
      '<div class="t-meta"><span class="t-state"></span><span class="t-speed"></span></div>' +
    '</div>' +
    '<div class="t-acts"><button class="t-btn pause" hidden></button><button class="t-btn cancel" title="取消">✕</button></div>';
  el.querySelector('.t-icon').textContent = ext;
  el.querySelector('.t-name').textContent = t.name;
  el.querySelector('.t-size').textContent = formatBytes(t.size);
  const btnPause = el.querySelector('.t-btn.pause');
  btnPause.addEventListener('click', () => togglePause(t));
  el.querySelector('.t-btn.cancel').addEventListener('click', () => {
    if (isTerminal(t)) { removeCard(t); return; }
    cancelTransfer(t, false);
  });
  t.card = el;
  t.btnPause = btnPause;
  if (transfersEl) transfersEl.appendChild(el);
  updateCard(t);
}

function removeCard(t) {
  if (t.card && t.card.parentNode) t.card.parentNode.removeChild(t.card);
  if (transfersEl) transfersEl.hidden = transfersEl.children.length === 0;
}

function updateCard(t) {
  if (!t.card) return;
  const bytes = t.dir === 'send' ? Math.min(t.next * t.chunkSize, t.size) : t.gotBytes;
  let pct = t.size ? Math.min(100, Math.floor((bytes * 100) / t.size)) : 100;
  let stateText = '';
  switch (t.state) {
    case 'hashing':
      stateText = '正在计算校验值…';
      pct = t.hashDone ? Math.min(100, Math.floor((t.hashDone * 100) / t.size)) : 0;
      break;
    case 'offering': stateText = '等待对方确认…'; break;
    case 'sending':
      stateText = (t.pauseLocal || t.pauseRemote) ? '已暂停' : (t.resumeCount ? '续传中' : '传输中');
      break;
    case 'receiving': stateText = t.uiPaused ? '已暂停' : (t.resume && t.gotCount > 0 ? '续传中' : '接收中'); break;
    case 'verifying': stateText = t.dir === 'send' ? '等待校验结果…' : '正在校验…'; break;
    case 'done': stateText = t.dir === 'recv' ? '✓ 接收完成' : '✓ 发送完成 · 校验一致'; break;
    case 'failed': stateText = '✕ ' + (t.errMsg || '失败'); break;
    case 'rejected': stateText = '对方拒绝接收'; break;
    case 'canceled': stateText = '已取消'; break;
  }
  t.card.querySelector('.t-bar i').style.width = pct + '%';
  t.card.querySelector('.t-state').textContent = stateText;
  t.card.querySelector('.t-meta').classList.toggle('err', t.state === 'failed');
  const showSpeed = (t.state === 'sending' && !t.pauseLocal && !t.pauseRemote) || (t.state === 'receiving' && !t.uiPaused);
  t.card.querySelector('.t-speed').textContent = showSpeed && t.speedVal > 0 ? formatBytes(t.speedVal) + '/s' : '';
  if (t.btnPause) {
    const paused = t.dir === 'send' ? (t.pauseLocal || t.pauseRemote) : t.uiPaused;
    t.btnPause.hidden = !(t.state === 'sending' || t.state === 'receiving');
    t.btnPause.textContent = paused ? '▶' : '⏸';
  }
}

function calcSpeed(t, cur, now) {
  if (!t.speedT) { t.speedT = now; t.speedBytes = cur; return; }
  const dt = now - t.speedT;
  if (dt >= 1000) {
    t.speedVal = Math.max(0, Math.round(((cur - t.speedBytes) * 1000) / dt));
    t.speedT = now;
    t.speedBytes = cur;
  }
}

// 200ms UI 节流（同 Link Mesh 的刷新节奏）；速度用 1s 窗口采样
setInterval(() => {
  const now = Date.now();
  for (const t of transfers.values()) {
    if (t.state === 'sending' && !t.pauseLocal && !t.pauseRemote) calcSpeed(t, Math.min(t.next * t.chunkSize, t.size), now);
    else if (t.state === 'receiving' && !t.uiPaused) calcSpeed(t, t.gotBytes, now);
    else t.speedVal = 0;
    updateCard(t);
  }
  if (transfersEl) transfersEl.hidden = transfersEl.children.length === 0;
}, 200);

// ---------- 通道层 ----------
function setupFileChannel(ch) {
  ch.onmessage = (e) => {
    if (typeof e.data === 'string') {
      let m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m) handleFileCtrl(m);
    } else if (e.data instanceof ArrayBuffer) {
      onFileChunk(e.data);
    }
  };
  ch.onclose = () => {
    if (fileChannel === ch) fileChannel = null;
  };
  ch.onopen = () => { startNextSend(); };
}

function sendCtrl(obj) {
  if (!fileChannel || fileChannel.readyState !== 'open') return false;
  try { fileChannel.send(JSON.stringify(obj)); return true; } catch (_) { return false; }
}

// ---------- 发送端 ----------
function startSendFile(file) {
  if (!fileChannel || fileChannel.readyState !== 'open') {
    showToast('P2P 文件通道未就绪，等连接建立后再试');
    return;
  }
  const busy = [...transfers.values()].some((t) => t.dir === 'send' && ACTIVE_SEND.has(t.state));
  if (busy || sendQueue.length) {
    sendQueue.push(file);
    showToast('已加入发送队列：' + (file.name || '未命名文件'));
    return;
  }
  beginSendFile(file);
}

async function beginSendFile(file) {
  // 分块大小按链路 maxMessageSize 自适应（实测该值是真实约束：
  // 超过它发大消息会有明显额外开销，64KB 链路发 128KB 反而慢 ~40%）
  const mms = (fileChannel && fileChannel.maxMessageSize) || 65536;
  let chunkSize = FILE_CHUNK;
  if (mms >= 262144) chunkSize = 256 * 1024;
  else if (mms >= 131072) chunkSize = 131072;
  else if (mms >= 65536) chunkSize = 65536;
  else chunkSize = Math.max(16384, Math.floor(mms / 16384) * 16384);

  const t = {
    dir: 'send',
    fileId: newFileId(),
    file,
    name: file.name || '未命名',
    size: file.size,
    mime: file.type || 'application/octet-stream',
    chunkSize,
    state: 'hashing',
    next: 0,
    pauseLocal: false,
    pauseRemote: false,
    pumping: false,
    resumeCount: 0,
    speedT: 0,
    speedBytes: 0,
    speedVal: 0,
    // 块读缓冲与帧缓冲（泵循环里填充/复用）
    blkBuf: null,
    blkStart: 0,
    blkCount: 0,
    frameBuf: new Uint8Array(8 + chunkSize),
  };
  // 总块数必须按自适应后的 chunkSize 计算，否则与发送泵的实际切块数不一致会永久卡死
  t.total = Math.max(1, Math.ceil(t.size / t.chunkSize));
  transfers.set(t.fileId, t);
  makeCard(t);
  // 先流式算 SHA-256，算完才发 offer（同 Link Mesh：进度置 -1 的阶段）
  const hex = await hashFile(file, (done) => { t.hashDone = done; });
  if (t.state !== 'hashing') { startNextSend(); return; } // 期间被取消
  if (!hex) { failTransfer(t, '校验值计算失败'); startNextSend(); return; }
  t.sha256 = hex;
  t.state = 'offering';
  updateCard(t);
  sendCtrl({
    type: 'file-offer',
    fileId: t.fileId,
    name: t.name,
    size: t.size,
    mime: t.mime,
    chunkSize: t.chunkSize,
    totalChunks: t.total,
    sha256: hex,
  });
  t.offerTimer = setTimeout(() => {
    if (t.state === 'offering') { failTransfer(t, '对方未响应'); startNextSend(); }
  }, 90 * 1000);
}

function startNextSend() {
  while (sendQueue.length) {
    const f = sendQueue.shift();
    if (f) { beginSendFile(f); return; }
  }
}

function waitForDrain(t) {
  return new Promise((resolve) => {
    const start = Date.now();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const tick = () => {
      if (t.state !== 'sending' || !fileChannel || fileChannel.readyState !== 'open' || fileChannel.bufferedAmount <= LOW_WATER) return finish();
      // 背压停滞 60s 判失败（同 Link Mesh 的等待上限）
      if (Date.now() - start > 60 * 1000) { failTransfer(t, '对端接收停滞，传输中止'); return finish(); }
      setTimeout(tick, 100);
    };
    try {
      fileChannel.bufferedAmountLowThreshold = LOW_WATER;
      fileChannel.addEventListener('bufferedamountlow', finish, { once: true });
    } catch (_) {}
    tick();
  });
}

async function pumpSend(t) {
  if (t.pumping) return;
  t.pumping = true;
  try {
    while (t.state === 'sending') {
      if (t.pauseLocal || t.pauseRemote) {
        // 暂停期间 5s 保活（同 Link Mesh 的 PING 帧）
        if (Date.now() - (t.lastPing || 0) > 5000) { t.lastPing = Date.now(); sendCtrl({ type: 'file-ping', fileId: t.fileId }); }
        await sleep(150);
        continue;
      }
      // 断点续传：跳过对方已有的块
      if (t.resumeBits && bitTest(t.resumeBits, t.next)) { t.next++; continue; }
      if (t.next >= t.total) break;
      if (!fileChannel || fileChannel.readyState !== 'open') { failTransfer(t, '连接已断开'); break; }
      if (fileChannel.bufferedAmount > HIGH_WATER) { await waitForDrain(t); continue; }

      // 当前块不在块缓冲内时，一次读 READ_BLOCK 再在内存中切块
      if (!t.blkBuf || t.next < t.blkStart || t.next >= t.blkStart + t.blkCount) {
        const start = t.next * t.chunkSize;
        const end = Math.min(start + READ_BLOCK, t.size);
        let buf;
        try { buf = await t.file.slice(start, end).arrayBuffer(); }
        catch (_) { failTransfer(t, '本地文件读取失败'); break; }
        if (t.state !== 'sending') break; // 等待读取期间被取消
        if (t.pauseLocal || t.pauseRemote || fileChannel.bufferedAmount > HIGH_WATER) continue; // 重新走循环判断
        if (!buf.byteLength) { failTransfer(t, '本地文件读取异常'); break; } // 防御：文件被截断/读空，避免空转
        t.blkBuf = buf;
        t.blkStart = t.next;
        t.blkCount = Math.ceil(buf.byteLength / t.chunkSize);
      }

      // 帧缓冲复用：uint32 fileId + uint32 chunkIndex + 原始字节
      const off = (t.next - t.blkStart) * t.chunkSize;
      const len = Math.min(t.chunkSize, t.blkBuf.byteLength - off);
      const dv = new DataView(t.frameBuf.buffer);
      dv.setUint32(0, t.fileId, true);
      dv.setUint32(4, t.next, true);
      t.frameBuf.set(new Uint8Array(t.blkBuf, off, len), 8);
      try { fileChannel.send(t.frameBuf.subarray(0, 8 + len)); } catch (_) { failTransfer(t, '发送失败'); break; }
      t.next++;
    }
    if (t.state === 'sending' && t.next >= t.total) {
      t.state = 'verifying';
      updateCard(t);
      sendCtrl({ type: 'file-done', fileId: t.fileId, sha256: t.sha256 });
      // 校验大文件需要时间，放宽到 120s（同 Link Mesh）
      t.resultTimer = setTimeout(() => {
        if (t.state === 'verifying') { failTransfer(t, '校验结果等待超时'); startNextSend(); }
      }, 120 * 1000);
    }
  } finally { t.pumping = false; }
}

// ---------- 接收端 ----------
async function detectOpfs() {
  if (opfsSupport !== null) return opfsSupport;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('synctext', { create: true });
    const probe = await dir.getFileHandle('.probe', { create: true });
    const w = await probe.createWritable();
    await w.write(new Uint8Array([1]));
    await w.close();
    await dir.removeEntry('.probe').catch(() => {});
    opfsSupport = true;
  } catch (_) { opfsSupport = false; }
  return opfsSupport;
}

function stateKey(t) { return 'st.part.' + t.sha256.slice(0, 16) + '-' + t.size; }

function saveRecvState(t) {
  try {
    localStorage.setItem(stateKey(t), JSON.stringify({
      name: t.name, size: t.size, mime: t.mime, chunkSize: t.chunkSize,
      total: t.total, sha256: t.sha256, bits: bytesToB64(t.bitmap), partName: t.partName,
    }));
  } catch (_) {}
}

function dropResume(t) {
  try { localStorage.removeItem(stateKey(t)); } catch (_) {}
  if (t.opfsDir && t.partName) {
    try { t.opfsDir.removeEntry(t.partName).catch(() => {}); } catch (_) {}
  }
}

function findResumable(m) {
  try {
    const suffix = m.sha256.slice(0, 16) + '-' + m.size;
    const raw = localStorage.getItem('st.part.' + suffix);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s && s.size === m.size && s.chunkSize === m.chunkSize && s.total === m.totalChunks && typeof s.bits === 'string') {
      return Object.assign({}, s, { partName: '.part-' + suffix });
    }
    localStorage.removeItem('st.part.' + suffix); // 状态损坏，弃用
  } catch (_) {}
  return null;
}

async function openPartWriter(t) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('synctext', { create: true });
  t.opfsDir = dir;
  let reuse = false;
  if (t.resume) {
    // 恢复校验（同 Link Mesh：文件长度与位图对得上才续，否则清空重来）
    try {
      const fh = await dir.getFileHandle(t.partName);
      const f = await fh.getFile();
      const maxSet = highestSetBit(t.bitmap);
      const expected = maxSet < 0 ? 0 : Math.min((maxSet + 1) * t.chunkSize, t.size);
      if (f.size === expected) { t.fileHandle = fh; reuse = true; }
      else await dir.removeEntry(t.partName).catch(() => {});
    } catch (_) { /* 文件不存在 → 全新接收 */ }
  }
  if (!reuse) {
    t.fileHandle = await dir.getFileHandle(t.partName, { create: true });
    t.bitmap = new Uint8Array(Math.ceil(t.total / 8));
    t.gotCount = 0;
    t.gotBytes = 0;
    t.resume = null;
  }
  t.writable = await t.fileHandle.createWritable({ keepExistingData: true });
}

// 位图定期落盘：此刻内存位图 = 已写入并关闭缓存的块，刷新页面后可续
function enqueueFlush(t) {
  t.writeChain = t.writeChain.then(async () => {
    try {
      if (!t.writable) return;
      await t.writable.close();
      t.writable = await t.fileHandle.createWritable({ keepExistingData: true });
      saveRecvState(t);
    } catch (_) { /* finalize 时会暴露真实错误 */ }
  });
}

// 接收确认弹窗（同 Link Mesh 规则：明确拒绝与 60s 超时都只是拒绝本次，不拉黑）
const offerQueue = [];
let modalActive = null;

function autoAcceptOn() { return autoAcceptEl ? autoAcceptEl.checked : true; }

function askAccept(t) {
  // 自动接收：跳过确认弹窗直接同意（默认开，同 Link Mesh 的 autoAcceptFiles 默认值）
  if (autoAcceptOn()) {
    showToast('已自动接收：' + t.name + (t.resume ? '（续传）' : ''));
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    t._resolveAccept = resolve;
    offerQueue.push(t);
    pumpConfirm();
  });
}

function pumpConfirm() {
  if (modalActive || !offerQueue.length) return;
  modalActive = offerQueue.shift();
  if (confirmName) confirmName.textContent = modalActive.name;
  if (confirmMeta) confirmMeta.textContent = formatBytes(modalActive.size) + (modalActive.resume ? ' · 检测到断点，将自动续传' : '');
  if (confirmBox) confirmBox.hidden = false;
  startConfirmCountdown(modalActive);
}

function startConfirmCountdown(t) {
  let left = 60;
  const show = () => { if (confirmHint) confirmHint.textContent = '对方正在等待，' + left + ' 秒后自动拒绝'; };
  show();
  t._confirmTimer = setInterval(() => {
    left--;
    if (left <= 0) { settleConfirm(t, false); return; }
    show();
  }, 1000);
}

function settleConfirm(t, ok) {
  if (!t || t._settled) return;
  t._settled = true;
  if (t._confirmTimer) { clearInterval(t._confirmTimer); t._confirmTimer = null; }
  if (modalActive === t) {
    if (confirmBox) confirmBox.hidden = true;
    modalActive = null;
  }
  const r = t._resolveAccept;
  t._resolveAccept = null;
  if (r) r(ok);
  pumpConfirm();
}

function sanitizeName(s) {
  const n = String(s || '').replace(/[\\/]/g, '_').slice(0, 128).trim();
  return n || '未命名';
}

async function onFileOffer(m) {
  if (typeof m.fileId !== 'number' || typeof m.size !== 'number' || !m.size) return;
  if (typeof m.chunkSize !== 'number' || m.chunkSize <= 0 || m.chunkSize > MAX_FRAME_BYTES - 8) return;
  if (m.totalChunks !== Math.ceil(m.size / m.chunkSize)) return;
  if (typeof m.sha256 !== 'string' || m.sha256.length !== 64) return;
  if (transfers.has(m.fileId)) return;
  if (!getHashWorker()) { sendCtrl({ type: 'file-reject', fileId: m.fileId, reason: '本页无法计算校验值' }); return; }

  const t = {
    dir: 'recv',
    fileId: m.fileId,
    name: sanitizeName(m.name),
    size: m.size,
    mime: m.mime || 'application/octet-stream',
    chunkSize: m.chunkSize,
    total: m.totalChunks,
    sha256: m.sha256,
    state: 'confirming',
    bitmap: null,
    gotCount: 0,
    gotBytes: 0,
    resume: null,
    uiPaused: false,
    writeChain: Promise.resolve(),
    speedT: 0,
    speedBytes: 0,
    speedVal: 0,
  };

  // 断点续传匹配：同哈希同尺寸 → 复用已收块，位图回传给发送端跳块
  t.resume = findResumable(m);

  const opfsOk = await detectOpfs();
  if (!opfsOk && t.size > 200 * 1024 * 1024) {
    sendCtrl({ type: 'file-reject', fileId: t.fileId, reason: '浏览器不支持磁盘缓存，超过 200MB 无法接收' });
    showToast('文件过大且浏览器不支持断点缓存，已拒绝');
    return;
  }
  t.opfs = opfsOk;

  const ok = await askAccept(t);
  if (!ok) { sendCtrl({ type: 'file-reject', fileId: t.fileId, reason: '用户拒绝或超时' }); return; }
  if (!fileChannel || fileChannel.readyState !== 'open') return; // 等待期间连接断开

  transfers.set(t.fileId, t);
  makeCard(t);
  t.bitmap = t.resume ? b64ToBytes(t.resume.bits) : new Uint8Array(Math.ceil(t.total / 8));
  t.gotCount = countBits(t.bitmap, t.total);
  const suffix = t.sha256.slice(0, 16) + '-' + t.size;
  t.partName = '.part-' + suffix;
  if (t.opfs) {
    try { await withTimeout(openPartWriter(t), 5000, '打开缓存文件'); }
    catch (_) { t.opfs = false; }
  }
  if (!t.opfs) t.chunks = new Array(t.total);
  t.state = 'receiving';
  updateCard(t);
  t.flushTimer = setInterval(() => { if (t.opfs && t.writable) enqueueFlush(t); }, 1500);
  sendCtrl({ type: 'file-accept', fileId: t.fileId, bitmap: bytesToB64(t.bitmap) });
}

function onFileChunk(ab) {
  if (ab.byteLength <= 8) return;
  const dv = new DataView(ab);
  const t = transfers.get(dv.getUint32(0, true));
  if (!t || t.dir !== 'recv') return;
  const idx = dv.getUint32(4, true);
  if (idx >= t.total) return;
  const payload = new Uint8Array(ab, 8);
  if (payload.byteLength > t.chunkSize) return;
  if (bitTest(t.bitmap, idx)) return; // 重复块忽略
  t.writeChain = t.writeChain.then(async () => {
    if (isTerminal(t)) return;
    try {
      if (t.writable) {
        await t.writable.write({ type: 'write', position: idx * t.chunkSize, data: payload });
      } else {
        t.chunks[idx] = payload.slice(); // 内存兜底
      }
      t.bitmap[idx >> 3] |= 1 << (idx & 7);
      t.gotCount++;
      t.gotBytes += payload.byteLength;
    } catch (err) {
      failTransfer(t, '写入失败：' + (err && err.message || err));
    }
  });
}

function onFileDone(t) {
  if (t.state !== 'receiving') return;
  t.state = 'verifying';
  updateCard(t);
  t.writeChain = t.writeChain.then(() => finalizeRecv(t));
}

async function finalizeRecv(t) {
  try { if (t.writable) { await t.writable.close(); t.writable = null; } } catch (_) {}
  clearInterval(t.flushTimer);
  // 全量重算 SHA-256：必须覆盖磁盘上历史会话已写入的块，
  // 否则断点续传场景下校验必然失败（同 Link Mesh 在 FILE_DONE 后重算整个文件）
  let hex = null;
  try {
    const whole = t.opfs ? await t.fileHandle.getFile() : new Blob(t.chunks, { type: t.mime });
    hex = await hashFile(whole);
  } catch (_) {}
  const ok = !!hex && hex === t.sha256;
  try { sendCtrl({ type: 'file-result', fileId: t.fileId, ok }); } catch (_) {}
  if (ok) {
    t.state = 'done';
    updateCard(t);
    await offerDownload(t);
    // 浏览器已接管下载，延迟清理缓存文件（留足下载启动时间）
    setTimeout(() => dropResume(t), 15 * 1000);
    showToast('「' + t.name + '」接收完成，已开始下载');
    setTimeout(() => removeCard(t), 8000);
  } else {
    t.state = 'failed';
    t.errMsg = hex ? 'SHA-256 校验不一致' : '校验值计算失败';
    // 坏数据不留断点（Link Mesh 踩坑：位图错会导致永远跳块、反复失败）
    dropResume(t);
    updateCard(t);
    showToast('接收校验失败：' + t.name);
    setTimeout(() => removeCard(t), 10000);
  }
}

async function offerDownload(t) {
  try {
    let file;
    if (t.opfs) file = await t.fileHandle.getFile();
    else file = new Blob(t.chunks, { type: t.mime });
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = t.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30 * 1000);
  } catch (_) {
    showToast('自动下载失败，请刷新后重试');
  }
}

// ---------- 传输控制 ----------
function cleanupTimers(t) {
  if (t.offerTimer) { clearTimeout(t.offerTimer); t.offerTimer = null; }
  if (t.resultTimer) { clearTimeout(t.resultTimer); t.resultTimer = null; }
  if (t.flushTimer) { clearInterval(t.flushTimer); t.flushTimer = null; }
}

function failTransfer(t, msg) {
  if (isTerminal(t)) return;
  t.state = 'failed';
  t.errMsg = msg;
  cleanupTimers(t);
  if (t._resolveAccept) settleConfirm(t, false);
  if (t.dir === 'recv') {
    // 保留断点：对方重新发送同一文件可续传
    t.writeChain = t.writeChain.then(async () => {
      try { if (t.writable) { await t.writable.close(); t.writable = null; } } catch (_) {}
      if (t.gotCount > 0) saveRecvState(t);
    });
  }
  if (t.dir === 'send') startNextSend();
  updateCard(t);
  setTimeout(() => removeCard(t), 8000);
  showToast((t.dir === 'send' ? '发送失败：' : '接收失败：') + msg);
}

function cancelTransfer(t, byRemote) {
  if (isTerminal(t)) return;
  t.state = 'canceled';
  cleanupTimers(t);
  if (t._resolveAccept) settleConfirm(t, false);
  sendCtrl({ type: 'file-cancel', fileId: t.fileId }); // 通知对端停止（对端已终态时会自动忽略）
  if (t.dir === 'send') {
    startNextSend();
  } else {
    t.writeChain = t.writeChain.then(async () => {
      try { if (t.writable) { await t.writable.close(); t.writable = null; } } catch (_) {}
      if (!byRemote) dropResume(t); // 本地取消不要了；对方取消则保留断点
    });
  }
  updateCard(t);
  setTimeout(() => removeCard(t), 4000);
}

function togglePause(t) {
  if (t.dir === 'send') {
    if (t.state !== 'sending') return;
    t.pauseLocal = !t.pauseLocal;
    sendCtrl({ type: t.pauseLocal ? 'file-pause' : 'file-resume', fileId: t.fileId });
    if (!t.pauseLocal) pumpSend(t); // 恢复时唤醒发送泵
  } else {
    if (t.state !== 'receiving') return;
    t.uiPaused = !t.uiPaused;
    sendCtrl({ type: t.uiPaused ? 'file-pause' : 'file-resume', fileId: t.fileId });
  }
  updateCard(t);
}

function onPeerGone() {
  sendQueue.length = 0;
  for (const t of transfers.values()) {
    if (!isTerminal(t)) failTransfer(t, '对方已断开连接');
  }
}

function handleFileCtrl(m) {
  const t = m.fileId != null ? transfers.get(m.fileId) : null;
  switch (m.type) {
    case 'file-offer':
      onFileOffer(m);
      break;
    case 'file-accept':
      if (t && t.dir === 'send' && t.state === 'offering') {
        if (t.offerTimer) { clearTimeout(t.offerTimer); t.offerTimer = null; }
        t.resumeBits = typeof m.bitmap === 'string' ? b64ToBytes(m.bitmap) : null;
        t.resumeCount = t.resumeBits ? countBits(t.resumeBits, t.total) : 0;
        t.state = 'sending';
        updateCard(t);
        pumpSend(t);
      }
      break;
    case 'file-reject':
      if (t && t.dir === 'send' && !isTerminal(t)) {
        t.state = 'rejected';
        cleanupTimers(t);
        startNextSend();
        updateCard(t);
        setTimeout(() => removeCard(t), 8000);
        showToast('对方拒绝接收' + (m.reason ? '：' + m.reason : ''));
      }
      break;
    case 'file-pause':
      if (t && t.dir === 'send') { t.pauseRemote = true; updateCard(t); }
      else if (t && t.dir === 'recv') { t.uiPaused = true; updateCard(t); }
      break;
    case 'file-resume':
      if (t && t.dir === 'send') { t.pauseRemote = false; updateCard(t); }
      else if (t && t.dir === 'recv') { t.uiPaused = false; updateCard(t); }
      break;
    case 'file-cancel':
      if (t && !isTerminal(t)) cancelTransfer(t, true);
      break;
    case 'file-done':
      if (t && t.dir === 'recv') onFileDone(t);
      break;
    case 'file-result':
      if (t && t.dir === 'send' && t.state === 'verifying') {
        if (t.resultTimer) { clearTimeout(t.resultTimer); t.resultTimer = null; }
        t.state = m.ok ? 'done' : 'failed';
        t.errMsg = m.ok ? null : 'SHA-256 校验不一致';
        startNextSend();
        updateCard(t);
        setTimeout(() => removeCard(t), m.ok ? 8000 : 10000);
        showToast(m.ok ? '文件传输完成，校验一致' : '传输完成但校验不一致，建议重传');
      }
      break;
    case 'file-ping':
      break; // 暂停期保活，忽略
  }
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

// 发文件：顶栏按钮 + 隐藏 input + 全页拖放
btnSend && btnSend.addEventListener('click', () => { fileInput && fileInput.click(); });
fileInput && fileInput.addEventListener('change', () => {
  const files = fileInput.files;
  for (const f of files) startSendFile(f);
  fileInput.value = '';
});
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || ![...(e.dataTransfer.types || [])].includes('Files')) return;
  dragDepth++;
  if (dropMask) dropMask.hidden = false;
});
document.addEventListener('dragleave', () => {
  if (dragDepth > 0 && --dragDepth === 0 && dropMask) dropMask.hidden = true;
});
document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  if (dropMask) dropMask.hidden = true;
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  for (const f of files) startSendFile(f);
});

// 接收确认弹窗按钮
btnAccept && btnAccept.addEventListener('click', () => settleConfirm(modalActive, true));
btnReject && btnReject.addEventListener('click', () => settleConfirm(modalActive, false));

// 自动接收开关（默认开，同 Link Mesh 的 autoAcceptFiles）
if (autoAcceptEl) {
  try { autoAcceptEl.checked = localStorage.getItem('st.autoAccept') !== '0'; } catch (_) { autoAcceptEl.checked = true; }
  autoAcceptEl.addEventListener('change', () => {
    try { localStorage.setItem('st.autoAccept', autoAcceptEl.checked ? '1' : '0'); } catch (_) {}
  });
}

// ---------- 更多菜单 ----------
function closeMenu() {
  if (moreMenu) moreMenu.hidden = true;
}
btnMore && btnMore.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!moreMenu) return;
  moreMenu.hidden = !moreMenu.hidden;
});
moreMenu && moreMenu.addEventListener('click', (e) => {
  if (e.target.closest('button')) closeMenu(); // 点任意菜单项后自动收起
});
document.addEventListener('click', (e) => {
  if (moreMenu && !moreMenu.hidden && !moreMenu.contains(e.target) && !btnMore.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMenu();
    if (popoverOpen && popover) { popoverOpen = false; popover.hidden = true; }
  }
});

// 房间胶囊：点击即复制分享链接（与「分享链接」按钮同效）
roomPill && roomPill.addEventListener('click', async () => {
  if (await copyToClipboard(shareUrl)) showToast('链接已复制');
});

// ---------- 主题（浅色 / 深色 / 跟随系统） ----------
const THEME_KEY = 'st.theme';
function applyTheme(mode) {
  if (mode === 'dark' || mode === 'light') document.documentElement.dataset.theme = mode;
  else document.documentElement.removeAttribute('data-theme');
  if (btnTheme) btnTheme.textContent = mode === 'dark' ? '主题 · 深色' : mode === 'light' ? '主题 · 浅色' : '主题 · 自动';
}
let themeMode = 'auto';
try { themeMode = localStorage.getItem(THEME_KEY) || 'auto'; } catch (_) {}
applyTheme(themeMode);
btnTheme && btnTheme.addEventListener('click', () => {
  themeMode = themeMode === 'auto' ? 'dark' : themeMode === 'dark' ? 'light' : 'auto';
  try { localStorage.setItem(THEME_KEY, themeMode); } catch (_) {}
  applyTheme(themeMode);
});

// 启动
refreshPlaceholder();
connectSignaling();
