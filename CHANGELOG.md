# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号采用 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.4.0] - 2026-11-08

### Added
- 扫码加入房间：「分享链接」按钮与顶栏房间胶囊打开分享弹窗（房间二维码 +
  链接 + 一键复制）；桌面端居中卡片，移动端底部抽屉；二维码由本地
  `qrcode-generator`（MIT）渲染 SVG，保持零依赖；可扫性经 jsqr 解码回环验证
- 首页随机房间号：直接访问站点时本地生成 8 位随机房间
  （无歧义字符集，`crypto.getRandomValues`，约 40bit 熵），替代固定默认房间
  0808，避免所有访客挤进同一房间；`/r/<房间号>` 显式路径行为不变
- 房间胶囊可发现性：内置品牌色二维码图标、悬停主题色反馈、
  tooltip「分享房间：二维码 / 复制链接」、首次访问一次性提示气泡

### Fixed
- 深色模式下 Toast 背景与文字同为浅色导致不可读（新增 `--toast-fg` 成对变量）

## [1.3.0] - 2026-11-08

### Changed
- UI 全面重构为现代清爽风：品牌化顶栏（渐变 Logo + 房间胶囊 + 状态胶囊）、
  编辑器焦点卡片、hero 式引导页 + 三步上手 + 折叠注意事项、
  次级操作收入「⋯」菜单、传输卡片升级（扩展名徽标 + 渐变进度条）、
  确认弹窗毛玻璃背板、Toast 底部居中；移除装饰性浮动按钮，反馈改页脚链接

### Fixed
- 文本同步的 rAF 节流在后台标签页永不触发且卡死节流标志——
  页面隐藏时降级 `setTimeout`（修复后台页面打字不同步）

## [1.2.0] - 2026-11-08

### Changed
- 文件传输提速 2-3 倍（回环实测 60MB：1.75 → 3~5 MB/s）：
  4MB 大块读取后内存切块、背压水位 1MB→4MB、帧缓冲复用、
  分块大小按 `maxMessageSize` 自适应（256KB/128KB/64KB/16KB）

### Fixed
- 手机端点「发文件」弹出图片选择器：`<input type=file>` 显式 `accept="*/*"`
- 自适应分块后发送端总块数未同步计算导致传输永久卡死；新增空读防御

## [1.1.0] - 2026-11-08

### Added
- P2P 文件互传（协议移植自 [Link Mesh](https://github.com/hesanyue50-lang/link-mesh)，
  AGPL-3.0）：128KB 分块、位图断点续传（接收端 OPFS 落盘 + localStorage 位图，
  每 1.5s 落盘）、SHA-256 整文件校验（发送前流式计算 + 完成时全量重算）、
  暂停/继续/取消、60s 背压水位、接收确认卡片（60s 超时自动拒绝）、
  自动接收开关（默认开）
- 零依赖增量 SHA-256（`public/sha256-worker.js`，Web Worker）
- 深色/浅色/跟随系统三态主题（首屏无闪烁）
- STUN 列表国内优先 6 项；建连 60s 超时并按本地候选普查给出失败归因
- 许可证由 MIT 调整为 AGPL-3.0（因移植 Link Mesh 衍生作品，README 登记致谢）

### Fixed
- Cloudflare 版信令中继 `signal` 广播字段 `id`→`from`：恢复完美协商的
  polite 判定（此前 CF 部署下该机制失效）

## [1.0.0] - 2026-07-27

### Added
- 初始复刻版：房间制 WebRTC P2P 文本实时双向同步（全量 LWW + 光标选区同步）
- 零依赖本地版 `server.js`（手写 RFC6455 WebSocket 信令 + 静态服务）
- Cloudflare 版：Worker + Durable Object 信令中继 + Workers Assets（SPA 回退）
- 顶栏交互：分享链接、清空、复制文本、重连接、状态详情弹窗

[Unreleased]: https://github.com/oishijie/SyncText/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/oishijie/SyncText/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/oishijie/SyncText/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/oishijie/SyncText/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/oishijie/SyncText/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/oishijie/SyncText/releases/tag/v1.0.0
