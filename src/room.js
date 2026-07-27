'use strict';

/* =========================================================================
 * SyncText - 房间级信令中继（Cloudflare Durable Object）
 *
 * 与原 server.js 等价：只转发 SDP / ICE，不碰业务文本。
 * 每个房间 = 一个 Room 实例（由 room 名派生 id），天然按房间隔离。
 * 业务文本由两端走 WebRTC DataChannel 直连，不经过这里。
 * ========================================================================= */

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.conns = []; // [{ ws, id }]
  }

  async fetch(request) {
    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // 一组配对 socket：client 给浏览器，server 在 Worker 侧使用
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const entry = { ws: server, id: Math.random().toString(36).slice(2, 10) };
    this.conns.push(entry);

    const sendSelf = (obj) => {
      try { server.send(JSON.stringify(obj)); } catch (_) {}
    };
    const broadcast = (obj, except) => {
      for (const c of this.conns) {
        if (c === except) continue;
        try { c.ws.send(JSON.stringify(obj)); } catch (_) {}
      }
    };

    server.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'join') {
        const peers = this.conns.filter((c) => c !== entry).map((c) => c.id);
        sendSelf({ type: 'joined', id: entry.id, room: msg.room, peers });
        // 通知已在房间里的其他端：有新成员
        broadcast({ type: 'peer-join', id: entry.id }, entry);
      } else if (msg.type === 'signal') {
        // 转发 offer / answer / ICE 给房间内其他端
        broadcast({ type: 'signal', id: entry.id, data: msg.data }, entry);
      }
    });

    const cleanup = () => {
      const i = this.conns.indexOf(entry);
      if (i >= 0) this.conns.splice(i, 1);
      broadcast({ type: 'peer-leave', id: entry.id }, entry);
    };
    server.addEventListener('close', cleanup);
    server.addEventListener('error', cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }
}
