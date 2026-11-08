'use strict';

/* =========================================================================
 * SyncText - Cloudflare Worker 入口
 *  - /ws?room=<id>  -> 路由到对应房间的 Durable Object（信令中继）
 *  - 其它请求        -> 交给 Workers Assets 托管 public/ 下的静态文件
 *                      （not_found_handling=single-page-application 让 /r/<id> 回退到 index.html）
 * ========================================================================= */

// Durable Object 类需从入口文件导出，供 wrangler 识别与绑定
export { Room } from './room.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const room = url.searchParams.get('room');
      if (!room) return new Response('room required', { status: 400 });
      const id = env.Room.idFromName(room);
      const stub = env.Room.get(id);
      return stub.fetch(request);
    }

    // 静态资源（index.html / app.js / style.css / sha256-worker.js ...）
    return env.ASSETS.fetch(request);
  },
};
