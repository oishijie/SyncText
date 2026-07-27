'use strict';

/**
 * SyncText 复刻版 - 零依赖信令服务器 + 静态文件服务
 *
 * 设计要点（对应原项目）：
 *  - 信令服务器只负责协调 WebRTC 连接（交换 SDP / ICE），不传输业务数据
 *  - 业务文本在两个网页之间走 WebRTC DataChannel 直连（P2P），不经过本服务器
 *  - 房间机制：/r/<roomId>，同一房间的两个设备配对
 *  - 完全使用 Node 原生模块（http / crypto / fs），无需 npm install
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---------------------------------------------------------------------------
// 1. 静态文件服务（同时作为 SPA：未知路径回退到 index.html）
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // 解析并尝试映射到真实文件
  const resolved = path.normalize(path.join(PUBLIC_DIR, urlPath));
  const safeBase = PUBLIC_DIR + path.sep;
  if (!resolved.startsWith(safeBase)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(resolved, (err, stat) => {
    if (!err && stat.isFile()) {
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(resolved).pipe(res);
      return;
    }
    // 非文件（如 /r/xxxx 房间链接）→ 回退到 index.html
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    fs.readFile(indexPath, (e2, data) => {
      if (e2) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(data);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. 房间 + 连接管理
// ---------------------------------------------------------------------------
/** ws -> { id, room } */
const connections = new Map();
/** room -> Set<ws> */
const rooms = new Map();

function sendWs(ws, obj) {
  if (ws && typeof ws.send === 'function') {
    try { ws.send(JSON.stringify(obj)); } catch (_) { /* ignore */ }
  }
}

function handleMessage(ws, raw) {
  const meta = connections.get(ws);
  if (!meta) return;
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'join') {
    const room = String(msg.room || '').slice(0, 64).trim() || 'default';
    meta.room = room;
    if (!rooms.has(room)) rooms.set(room, new Set());
    const set = rooms.get(room);
    const peers = [...set].map((p) => connections.get(p).id);
  set.add(ws);
  sendWs(ws, { type: 'joined', id: meta.id, room, peers });
    // 通知房间内其他成员有新成员加入
    for (const p of set) {
      if (p !== ws) sendWs(p, { type: 'peer-join', id: meta.id });
    }
  } else if (msg.type === 'signal') {
    const room = meta.room;
    if (!room || !rooms.has(room)) return;
    // 中继 SDP / ICE 给房间内其他成员（可指定 to）
    for (const p of rooms.get(room)) {
      if (p === ws) continue;
      if (msg.to && connections.get(p).id !== msg.to) continue;
      sendWs(p, { type: 'signal', from: meta.id, data: msg.data });
    }
  } else if (msg.type === 'leave') {
    cleanup(ws);
  }
}

function cleanup(ws) {
  const meta = connections.get(ws);
  if (!meta) return;
  if (meta.room && rooms.has(meta.room)) {
    const set = rooms.get(meta.room);
    set.delete(ws);
    for (const p of set) sendWs(p, { type: 'peer-leave', id: meta.id });
    if (set.size === 0) rooms.delete(meta.room);
  }
  connections.delete(ws);
}

// ---------------------------------------------------------------------------
// 3. 零依赖 WebSocket 实现（仅服务端，处理文本帧 + ping/pong + close）
// ---------------------------------------------------------------------------
function createWs(socket) {
  let buffer = Buffer.alloc(0);
  const handlers = {};

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    // 尽可能多地解析完整帧
    while (true) {
      if (buffer.length < 2) break;
      const b0 = buffer[0];
      const b1 = buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < offset + 2) break;
        len = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buffer.length < offset + 8) break;
        len = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      let maskKey;
      if (masked) {
        if (buffer.length < offset + 4) break;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + len) break;
      let payload = buffer.subarray(offset, offset + len);
      if (masked) {
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
        payload = unmasked;
      }
      buffer = buffer.subarray(offset + len);

      if (opcode === 0x8) { // close
        try { socket.end(); } catch (_) {}
        return;
      } else if (opcode === 0x9) { // ping -> pong
        sendFrame(socket, 0xa, payload);
        continue;
      } else if (opcode === 0xa) { // pong
        continue;
      } else if (opcode === 0x1 || opcode === 0x2) { // text / binary
        if (handlers.message) handlers.message(payload.toString('utf8'));
      }
      // 大于单帧的消息（fin=0）在此场景下极少出现，浏览器对小消息总是 fin=1
    }
  });

  socket.on('close', () => { if (handlers.close) handlers.close(); });
  socket.on('error', () => { if (handlers.close) handlers.close(); });

  return {
    send: (str) => sendFrame(socket, 0x1, Buffer.from(str, 'utf8')),
    on: (ev, fn) => { handlers[ev] = fn; },
    _socket: socket,
  };
}

function sendFrame(socket, opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN=1 + opcode，服务端发送不加掩码
  try { socket.write(Buffer.concat([header, payload])); } catch (_) {}
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  const ws = createWs(socket);
  connections.set(ws, { id: crypto.randomUUID(), room: null });
  ws.on('message', (raw) => handleMessage(ws, raw));
  ws.on('close', () => cleanup(ws));
});

server.listen(PORT, HOST, () => {
  console.log(`SyncText 复刻版已启动: http://localhost:${PORT}`);
  console.log(`手机/另一设备在同一局域网打开 http://<本机IP>:${PORT}/r/<房间ID> 即可配对`);
});
