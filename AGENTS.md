# AGENTS.md — SyncText 开发与代理协作规范

> 本文件面向在本仓库工作的 AI 编码代理与人类开发者：项目是什么、怎么跑、
> 改动时有哪些必须遵守的约束和已知的坑。动手改代码前请先读完。

## 项目概览

**SyncText**：基于 WebRTC P2P 的「网页间实时文本同步 + 文件互传」工具。
任意两台带浏览器的设备打开同一房间链接即可互相同步文本、互传文件，
**业务数据点对点直传，服务器只中继信令（SDP/ICE）**。

- 线上地址：`https://sync.142588.xyz`（Cloudflare Workers 自定义域）
- 许可证：**AGPL-3.0**（传染性开源，见下文 License 约束）
- 灵感来源：[SyncText 原版](https://synctext.genwebapp.com/)；文件传输协议移植自
  [Link Mesh](https://github.com/hesanyue50-lang/link-mesh)（AGPL-3.0）

## 硬性约束（改代码前必读）

1. **零依赖**：不引入任何 npm 包、构建工具、前端框架。需要的库以本地文件
   形式放进 `public/`（如 `qrcode.js`），并保留其许可证头。
2. **中文注释**：所有注释、提交信息、用户可见文案使用简体中文，与现有风格一致。
3. **双实现同步改**：信令有两套等价实现——本地版 `server.js` 与 Cloudflare 版
   `src/room.js`。**改信令协议字段必须两处同改**（历史上 `id`/`from` 字段失配
   导致过完美协商失效的 bug）。前端只按同源 `/ws` 连接，不感知后端差异。
4. **风格**：`'use strict'` 开头；camelCase 命名；DOM 引用带 `El`/`btn` 前缀；
   常量 UPPER_SNAKE；每文件头部有分节横幅注释；小节用 `// ---------- xx ----------`。

## 常用命令

```bash
# 本地开发（Node ≥ 16，零 npm install）
node server.js                # http://localhost:3000，首页自动生成随机房间
#                             # 启动时自动打印所有局域网地址（热点场景用）
#                             # 双击 局域网共享.bat 等效（Windows）

# Cloudflare 本地模拟
npx wrangler dev --port 8787

# 部署（注意：本机环境变量 CLOUDFLARE_API_TOKEN 属于另一账号，必须绕开；
# OAuth 已登录目标账号）
env -u CLOUDFLARE_API_TOKEN \
  CLOUDFLARE_ACCOUNT_ID=102f26cf6428e86b57f17b06581142e4 \
  npx wrangler deploy

# 语法检查（无测试框架）
node --check public/app.js && node --check public/sha256-worker.js

# 信令中继测试（原生 WebSocket 客户端）
node test-ws.js    # 本地版
node test-cf.js    # wrangler dev 版

# 手工验收清单（双浏览器窗口进同一房间）
#  文本双向同步 / 互传文件(校验一致) / 暂停-恢复 / 取消 / 接收方刷新后续传
#  拒绝弹窗(60s 倒计时) / 深浅主题切换 / 手机视口布局
```

## 架构速览

```
浏览器 A ⇄ DataChannel('sync'  文本)  ⇄ 浏览器 B
        ⇄ DataChannel('file'  文件)  ⇄
        ⇅ WebSocket /ws?room=<id>（仅信令）
Cloudflare Worker ──> Durable Object Room（每房间一实例，纯内存转发）
```

- **完美协商**：`polite = myId > from`；仅 id 较小的一端创建 `sync`/`file`
  两条 DataChannel（一次 offer 带出）。
- **文件子协议**（file 通道，JSON 控制帧 + 二进制块帧
  `uint32 fileId + uint32 chunkIndex + bytes`，小端）：
  `file-offer → file-accept{bitmap} → [chunks] → file-done → file-result`，
  另有 `file-pause/resume/cancel/ping`。
- **断点续传**：接收端写 OPFS（`synctext/.part-<sha256前16>-<size>`），
  位图 Base64 存 localStorage（key `st.part.*`），每 1.5s 随磁盘落盘一次；
  重发同哈希同尺寸文件自动跳块；**校验必须整文件重算**（不能只算本次会话
  收到的块，历史块在磁盘上）；校验失败删断点。
- **哈希**：`public/sha256-worker.js` 零依赖增量 SHA-256 跑在 Worker 里
  （crypto.subtle 无流式接口）；发送前算 offer 哈希，接收完成时整文件重算比对。

## 已知陷阱（都真实踩过）

- **后台标签页 rAF 不触发**：文本发送的 rAF 节流在页面隐藏时永不执行且
  卡死节流标志——必须 `document.hidden` 时降级 `setTimeout`。
- **`t.total` 必须按自适应后的 `t.chunkSize` 计算**（分块大小按
  `maxMessageSize` 自适应 256KB/128KB/64KB/16KB），否则发送泵永久卡死。
- **`<input type=file>` 要显式 `accept="*/*"`**，否则部分手机浏览器/WebView
  缺省弹相册选择器。
- **背压水位是吞吐关键**：HIGH_WATER 1MB 在高 RTT 跨网时填不满管道（现为 4MB）。
- **Toast 颜色**：深浅主题下背景与前景必须成对改（`--toast-bg`/`--toast-fg`），
  深色模式出现过浅底浅字不可读。
- **`ICE candidate` 的 `sdpMid/sdpMLineIndex` 必须保留**，丢失会被对端静默丢弃。
- localStorage 里除 `st.part.*` 外还有 `st.theme`、`st.autoAccept`、
  `st.shareHint`，遍历时注意按前缀过滤且容错非 JSON 值。

## 发布流程

1. 改动 → `node --check` 全部 JS → 本地双窗口手工验收清单过一遍。
2. 更新 `CHANGELOG.md`（Keep a Changelog 格式）与必要的 `README.md` 段落。
3. `git commit`（中文提交信息，格式 `feat:/fix:/refactor: 摘要` + 正文要点）。
4. `wrangler deploy`（命令见上，勿用环境里的旧 token）。
5. 线上冒烟：打开 `https://sync.142588.xyz`，确认版本行为已生效。

## License 约束

本项目整体 **AGPL-3.0**。引用/移植第三方代码时：
- 保留其许可证头与版权声明（`public/qrcode.js` 为 MIT，勿删头部）；
- 在 `README.md` 致谢章节登记来源；
- 若将本项目部署为网络服务，须依 AGPL §13 向使用者提供本仓库源码。
