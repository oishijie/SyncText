'use strict';
// 本地验证 Cloudflare 版信令：两个客户端连接 /ws?room=demo，检查 join / peer-join / signal 中继
const URL = 'ws://127.0.0.1:8787/ws?room=demo';
const results = { A: [], B: [] };

function mk(name) {
  const ws = new WebSocket(URL);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room: 'demo' }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    results[name].push(m.type + (m.id ? ':' + m.id.slice(0, 4) : ''));
  };
  ws.onerror = (e) => console.log(name, 'ERR', e.message || e.error || 'err');
  return ws;
}

const A = mk('A');
setTimeout(() => {
  const B = mk('B');
  setTimeout(() => {
    B.send(JSON.stringify({ type: 'signal', data: { description: { type: 'offer', sdp: 'x' } } }));
    setTimeout(() => {
      console.log('A log:', results.A);
      console.log('B log:', results.B);
      const aJoined = results.A.some((x) => x.startsWith('joined'));
      const aPeerJoin = results.A.some((x) => x.startsWith('peer-join'));
      const bJoined = results.B.some((x) => x.startsWith('joined'));
      const aGotSignal = results.A.some((x) => x.startsWith('signal'));
      console.log('CHECK aJoined=%s aPeerJoin=%s bJoined=%s aGotSignal=%s',
        aJoined, aPeerJoin, bJoined, aGotSignal);
      const ok = aJoined && aPeerJoin && bJoined && aGotSignal;
      console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
      process.exit(ok ? 0 : 1);
    }, 800);
  }, 800);
}, 300);
