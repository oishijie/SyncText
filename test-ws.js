'use strict';
// 零依赖 WebSocket 客户端测试：验证握手 101 + 信令中继
const net = require('net');
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function makeClient(name) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(3000, '127.0.0.1', () => {
      sock.write(
        'GET /ws HTTP/1.1\r\n' +
        'Host: localhost:3000\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });

    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    const client = { name, sock, messages: [], send(obj) { sendFrame(sock, 0x1, Buffer.from(JSON.stringify(obj))); } };

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const header = buf.subarray(0, idx).toString();
        if (!/101/.test(header)) { console.log(name, '握手失败'); process.exit(1); }
        console.log(name, '✓ WebSocket 握手 101');
        handshakeDone = true;
        buf = buf.subarray(idx + 4);
      }
      // 解析服务端发来的帧（未掩码）
      let data = buf;
      while (data.length >= 2) {
        const opcode = data[0] & 0x0f;
        let len = data[1] & 0x7f;
        let off = 2;
        if (len === 126) { len = data.readUInt16BE(2); off = 4; }
        else if (len === 127) { len = Number(data.readBigUInt64BE(2)); off = 10; }
        if (data.length < off + len) break;
        const payload = data.subarray(off, off + len).toString('utf8');
        data = data.subarray(off + len);
        if (opcode === 0x1) {
          console.log(name, '[debug] got text frame len=', payload.length, 'preview=', payload.slice(0, 40));
          try {
            const m = JSON.parse(payload);
            client.messages.push(m);
            client.onmessage && client.onmessage(m);
          } catch (_) {}
        }
      }
      buf = data;
    });
    sock.on('error', (e) => { console.log(name, 'err', e.message); });
    setTimeout(() => resolve(client), 200);
  });
}

function sendFrame(sock, opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  header[0] = 0x80 | opcode;
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  sock.write(Buffer.concat([header, mask, masked]));
}

(async () => {
  const a = await makeClient('A');
  a.send({ type: 'join', room: 'testroom' });
  await new Promise((r) => setTimeout(r, 150));
  const joinedA = a.messages.find((m) => m.type === 'joined');
  console.log('A joined:', joinedA ? '✓ peers=' + JSON.stringify(joinedA.peers) : '✗');

  const b = await makeClient('B');
  let bGotPeerJoin = false;
  let aGotPeerJoin = false;
  a.onmessage = (m) => { if (m.type === 'peer-join') aGotPeerJoin = true; };
  b.onmessage = (m) => { if (m.type === 'peer-join') bGotPeerJoin = true; };
  b.send({ type: 'join', room: 'testroom' });
  await new Promise((r) => setTimeout(r, 200));
  console.log('A 收到 B 加入:', aGotPeerJoin ? '✓' : '✗');
  console.log('B 收到 joined+peer:', (b.messages.some(m=>m.type==='joined')) ? '✓' : '✗');

  // 测试信令中继：B 发 signal，A 应收到 from=B.id
  const bId = b.messages.find(m=>m.type==='joined').id;
  let aRelay = null;
  a.onmessage = (m) => { if (m.type === 'signal' && m.from === bId) aRelay = m; };
  b.send({ type: 'signal', data: { description: { type: 'offer', sdp: 'fake' } } });
  await new Promise((r) => setTimeout(r, 200));
  console.log('信令中继(offer):', aRelay ? '✓ A 收到来自 B 的 offer' : '✗');

  console.log('\n全部信令测试完成。');
  a.sock.end(); b.sock.end();
  process.exit(0);
})();
