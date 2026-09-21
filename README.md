# 你画我猜 · 联机版

一个**零依赖**的在线你画我猜游戏。只用 Node 原生 `http` 模块 + 手写的 WebSocket 实现，
**不装任何 npm 包**，克隆下来就能跑。

同一份代码既能当局域网服务器用（断网也能玩），也能丢到云服务器上给外网的朋友玩。

```
双击 start-game.bat   →  浏览器打开 http://localhost:3000   →  开玩
```

---

## 特点

**联机方式（启动器里选）**

| 方式 | 场景 | 说明 |
|---|---|---|
| 局域网联机 | 同一个 WiFi / 路由器下 | 本机起服，断网也能用，延迟 <1ms |
| 公网联机 | 朋友在外网 | 部署到自己的云服务器，需自行配置（见下） |
| Cloudflare 隧道 | 保底方案 | 不用买服务器，临时给外网朋友用，约 355ms |

**玩法**

- 词库 578 个词 / 20 个分类（简单 202 · 中等 233 · 困难 143），房主可限定主题
- 选词引擎：房间内已用词硬排除 + 跨房间软冷却，池子刷空自动重洗 → 长局也几乎不重复
- 换词：房主可设 2 / 3 / 5 次，选词阶段「换一批」
- 自定义词库：逗号 / 换行 / 分号分隔，自动去重、限长
- 限制开关：只用一个颜色、一笔画完、禁用橡皮、盲画模式、接盘画（下一轮继承上一轮画布）
- 猜词温度提示：🔥 很近 / 🌤 方向对 / 🌥 沾边，分层给提示但不剧透
- 开天眼：主动揭示一个字，本回合画手收益 -15
- 计分：猜中速度排名、连击加成、追赶机制、星级投票（画作分）
- 断线重连：宽限期内回来分数和身份都保留
- 手机 / 平板 / 桌面三端自适应，横竖屏切换自动重排

---

## 快速开始

需要 **Node.js ≥ 18**（[下载](https://nodejs.org)）。

```bash
node server.js
# 然后浏览器打开 http://localhost:3000
```

Windows 用户可以直接双击：

- `start-game.bat` — 起局域网服务器（会打印出局域网地址，发给朋友即可）
- `stop-game.bat` — 停掉服务器
- `诊断.bat` — 一键网络诊断（公网 IP / 端口 / 防火墙）

命令行参数：

```bash
node server.js                    # 默认 3000 端口
PORT=3001 node server.js          # 换端口（Windows: set PORT=3001 && node server.js）
node launch.js --lan              # 启动器：直接走局域网
node launch.js --tunnel           # 启动器：直接走 Cloudflare 隧道
node launch.js --dry              # 只打印菜单和前置检查，不启动
```

---

## 公网联机（可选）

公网那项需要你自己的服务器，地址**不写死在代码里**：

```bash
cp deploy.example.json deploy.local.json
# 编辑 deploy.local.json，把 vpsUrl 改成 http://你的服务器IP:3000
```

`deploy.local.json` 已在 `.gitignore` 里，不会进仓库。不配也能用，
只是启动器里「[2] 公网联机」会显示「未配置」。

服务器上只要装好 Node，把仓库拷过去 `node server.js` 即可（可以配 systemd 托管）。
Cloudflare 隧道方式还需要 `cloudflared`，放到 `tools/cloudflared.exe`（Windows）
或系统 PATH 里（Linux / macOS）。

---

## 测试

```bash
node test/run-all.js        # 跑全部 13 个套件
npm test                    # 同上
```

单跑某一块：

```bash
node test/e2e.js            # 端到端：两个真实 WebSocket 客户端走完整两局
node test/dom.js            # 前端 DOM 冒烟
node test/responsive.js     # 真浏览器多设备渲染（需要 Chrome）
node test/warmth.js         # 猜词温度
node test/wordpool.js       # 词库 & 选词引擎压测
node test/avatars.js        # 头像图标一致性
node test/bat-encoding.js   # 批处理脚本换行/编码防回归
```

端到端测试默认连 `127.0.0.1`，也可以指向远程服务器验证部署：

```bash
HOST=你的服务器IP PORT=3000 node test/e2e.js
```

---

## 项目结构

```
server.js            服务端：HTTP 静态服务 + 手写 WebSocket + 全部游戏逻辑
words.js             词库（578 词 / 20 分类）
picker.js            选词引擎（硬排除 + 软冷却 + 自动重洗）
public/
  index.html         页面骨架
  app.js             前端逻辑（状态机、渲染、画布、WebSocket 客户端）
  style.css          样式（含手机/平板/桌面三套布局）
  compat.js          老浏览器兜底（PointerEvent / ResizeObserver / clipboard / --vh）
  avatars/           18 个头像图标（Microsoft Fluent Emoji，MIT）
launch.js            桌面启动器（选联机方式）
start-game.bat       局域网一键起服（纯 ASCII，中文由 Node 输出）
doctor.js            网络诊断
test/                13 个测试套件
```

---

## 一些实现细节

**为什么没有依赖？** WebSocket 握手和帧编解码都是手写的（`server.js` 里
`httpServer.on('upgrade')` 往下那一段），前端也是原生 API。好处是没有
`npm install`、没有供应链风险、拷到任何装了 Node 的机器上就能跑。

**批处理脚本为什么全是纯 ASCII？** cmd.exe 解析「含 UTF-8 中文 + 纯 LF 换行」
的 `.bat` 时会从行中间开始读，把命令首字母吃掉（`title` → `'itle'`、
`goto` → `'oto'`），脚本静默失效。所以 `.bat` 一律保持 ASCII，
中文界面全部交给 Node 打印（UTF-8 + `chcp 65001` 渲染正常）。
`test/bat-encoding.js` 会守住这条规则。

**头像为什么用图片而不是 emoji 字符？** 直接写 `🐱` 是由操作系统自己的
emoji 字体渲染的，Windows 用 Segoe UI Emoji、安卓用 Noto Color Emoji、
iOS 用 Apple Color Emoji，同一局里各端长得不一样。改成
[Microsoft Fluent Emoji](https://github.com/microsoft/fluentui-emoji)（MIT）的
矢量图后全平台一致。详见 `public/avatars/SOURCE.md`。

**局域网 IP 是怎么打印出来的？** 服务端启动时枚举 `os.networkInterfaces()`，
把所有非内网回环的 IPv4 都列出来，附带网卡名，方便判断该发哪个给朋友。

---

## 授权

代码以 **MIT** 授权开源，见 [LICENSE](LICENSE)。

头像图标来自 [Microsoft Fluent Emoji](https://github.com/microsoft/fluentui-emoji)，同样是 MIT。

---

## 作者

炸鸡 · QQ 3627690979
