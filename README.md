# SyncText

基于 **WebRTC P2P** 的「网页间实时文本同步」工具 —— 任意两台带浏览器的设备，打开同一房间链接即可实时互相同步文本，**数据点对点直传，不经过业务服务器**。

> **灵感与致谢**：本项目为 [V2EX 帖子](https://www.v2ex.com/t/1199100) 中分享的 [SyncText](https://synctext.genwebapp.com/) 的开源复刻版，并对照其界面做了一比一还原。原项目解决的核心痛点：PC 端没有豆包语音输入，于是用**手机语音输入 → 网页实时同步到 PC → 直接黏贴给大模型当 prompt**。本仓库完整复刻其「房间 + 实时同步」体验，并附带一套**零依赖、可自托管**的实现。

---

## ✨ 特性

- **字符级实时双向同步**：一端输入 / 粘贴，另一端即时显示（基于 `requestAnimationFrame` 节流）。
- **顶栏状态机**：`已就绪 → 等待对方 → 已 P2P 直连`，一眼看清连接状态。
- **状态详情弹窗**：展示信令服务器连接情况、本机 / 对方 8 位短 ID。
- **操作按钮**：
  - `分享链接` —— 复制当前房间 URL（带 toast 提示）
  - `首页` —— 返回并重新生成随机房间
  - `清空` —— 二次确认后，两端同步清空
  - `复制文本` —— 一键复制编辑器全部内容
  - `重连接` —— 防抖后自动重载恢复连接
  - `EN` —— 语言标签切换（占位，切换按钮文字）
- **全屏编辑器 + 占位说明**：首次进入显示使用步骤、常用方式、注意事项（含反馈邮箱）。
- **右侧浮动按钮**：反馈 / Copilot 入口（UI 占位）。
- **零第三方依赖**：信令服务器用 Node 原生 `http` / `crypto` 手写 RFC6455 WebSocket；前端无需打包工具。二维码库 `qrcode.js` 已内置本地副本，离线可用。

---

## 🏗️ 架构

```
            ┌──────────────────────────┐
            │  信令服务器（仅协调连接）   │   只转发 SDP / ICE，不碰业务数据
            └──────────────────────────┘
                      /            \
                 连接协商          连接协商
                    /                \
                   v                  v
  ┌──────────────────────┐  ⇄ WebRTC P2P 直连 ⇄  ┌──────────────────────┐
  │   设备 A（如手机）    │  ⇄ 字符级实时同步文本 ⇄  │   设备 B（如 PC）     │
  └──────────────────────┘                      └──────────────────────┘
```

- **信令服务器**：本地用 `server.js`（零依赖 WebSocket 服务，负责房间管理与 `join / offer / answer / ICE` 中继）；部署到 Cloudflare 时改为 **Durable Object**（`src/room.js`，每个房间一个实例，天然按房间隔离），由入口 Worker（`src/worker.js`）把 `/ws?room=<id>` 路由到对应房间。
- **业务数据**：两端通过 `RTCPeerConnection` 的 `DataChannel` 直接传输，字符级实时同步。
- **房间机制**：`/r/<房间ID>`，分享同一链接即两端配对。

---

## 📁 项目结构

```
synctext-clone/
├── server.js            # 本地版：零依赖 WebSocket 信令 + 静态文件服务（Node 原生 http/crypto）
├── src/
│   ├── worker.js        # Cloudflare 版入口：/ws 路由到 Durable Object，其余交 Assets
│   └── room.js          # Cloudflare 版：Durable Object 房间级信令中继（等价 server.js 逻辑）
├── wrangler.toml        # Cloudflare 部署配置
├── package.json         # 仅含 start 脚本，无第三方依赖
├── public/
│   ├── index.html       # 页面结构（顶栏 + 编辑器 + 状态弹窗 + 浮动按钮）
│   ├── style.css        # 样式（浅色主题，对照原站 1:1 还原）
│   ├── app.js           # WebRTC 完美协商 + DataChannel 同步 + 顶栏交互
│   └── qrcode.js        # 本地二维码库（离线可用）
├── test-ws.js           # 端到端信令测试脚本（原生 WebSocket 客户端）
├── README.md
└── LICENSE
```

> 前端 `public/` 被本地版与 Cloudflare 版共用：前端以**同源**方式连接 `/ws?room=<id>`，因此两种部署无需区分前端代码。

---

## 🚀 快速开始

本项目**无需 `npm install`**（没有任何第三方依赖）。需要本地装有 Node.js ≥ 16。

```bash
# 1. 克隆并进入项目
git clone https://github.com/worldoi/SyncText.git
cd SyncText

# 2. 启动（默认端口 3000）
node server.js
# 或：npm start
# 修改端口：PORT=8080 node server.js

# 3. 打开浏览器
#    http://localhost:3000  → 自动跳转到随机房间 /r/<id>
```

---

## 📱 使用方式

### 同一台电脑自测
开两个浏览器标签页 / 窗口，都访问同一个 `/r/<房间ID>` 链接，即可看到双向实时同步效果。

### 手机 + PC 跨设备（局域网）
1. 在 PC 上复制页面顶栏的「分享链接」（形如 `http://192.168.x.x:3000/r/<id>`）。
2. 手机连**同一局域网**，打开该链接即可开始同步。
3. 若浏览器因非 HTTPS 限制 `ws://` 信令，可在 PC 侧用隧道（如 `cloudflared`）把服务暴露到公网 HTTPS，手机走 `wss://` 即可；WebRTC DataChannel 本身在局域网 HTTP 下多数浏览器可用。

### 公网 / 部署
- 正式对外服务建议套一层 **HTTPS**（如 Nginx + 证书 / Cloudflare Tunnel），否则部分浏览器会限制非安全上下文下的 WebSocket 与 WebRTC。
- 当前实现不含 TURN 中继，若两端处于对称型 NAT，可能无法直连。可后续接入公共 / 自建 TURN 服务器。

---

## ☁️ 部署到 Cloudflare

Cloudflare **不能**直接运行 `server.js` 这种长连接 Node 进程，需要把信令服务换成 Cloudflare 原生形态：

| 本地版（`server.js`） | Cloudflare 版 |
| --- | --- |
| Node 进程 + 手写 WebSocket | **Worker**（`src/worker.js`）+ **Durable Object**（`src/room.js`） |
| 静态文件由同一进程服务 | **Workers Assets** 托管 `public/`（SPA 回退让 `/r/<id>` 落到 `index.html`） |

Durable Object 以 `room` 名为实例 id，**每个房间一个对象**，天然按房间隔离；业务文本仍走两端 DataChannel 直连。

### 前置

- 已安装 `wrangler`
- 环境变量 `CLOUDFLARE_ACCOUNT_ID` 与 `CLOUDFLARE_API_TOKEN` 已就绪（本机已具备；`wrangler.toml` 未硬编码 account_id，自动读取）

### 部署

```bash
cd synctext-clone
wrangler deploy
# 完成后访问 https://<subdomain>.workers.dev/
# 同一 /r/<room> 链接两端配对即可同步
```

### 要点

- 前端**同源**连接 `/ws?room=<id>`，所以本地（`server.js`）与 Cloudflare（Worker）共用 `public/`，无需改前端。
- 公网 / 手机访问建议走 **HTTPS**：Worker 自带 TLS，`wss://` 直连，避免浏览器限制非安全上下文。
- 若 `*.workers.dev` 子域在本机不可达，给 Worker 绑定**自定义域**（如 `w.xxx.xyz`）访问更稳定。
- 跨对称型 NAT 如需公网可达，再接入 **TURN** 中继（当前仅 STUN）。

---

## 🔌 信令协议（简述）

客户端与服务端通过 WebSocket（`/ws`）交换 JSON 消息：

| 消息 | 方向 | 说明 |
| --- | --- | --- |
| `{type:'join', room}` | C → S | 加入房间 |
| `{type:'joined', id, room, peers}` | S → C | 加入成功，返回本端 ID 与已在线 peer |
| `{type:'peer-join', id}` | S → C | 有新 peer 加入 |
| `{type:'signal', data:{description|candidate}}` | C ⇄ S ⇄ C | 转发 SDP / ICE |

业务文本通过 DataChannel 直传，不经过信令服务器。

---

## 🛣️ 待增强

- TURN 中继（应对对称型 NAT / 公网直连失败）
- 多端网格同步（同一房间 > 2 人）
- 端到端加密
- 历史记录与离线消息
- 房间二维码扫码入口（库已内置，待接入 UI）
- 真正的多语言文案（当前 EN 仅切换按钮文字）

---

## 📄 License

[MIT](LICENSE) —— 自由使用、修改与分发。复刻灵感来自原版 SyncText，保留对原作者的致谢。
