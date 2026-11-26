# MuseDeck

**MuseDeck** 是一款基于 Electron + React + TypeScript 的桌面端多 AI 编程 CLI 调度工作台。它通过 **Meta Muse** 作为总控监督者（Supervisor），结合 **飞书长连接机器人** 与内嵌 **Tailscale Funnel 公网穿透**，让你无论在电脑前还是外出用手机飞书，都能统一调度本机多个 AI 编程 CLI 协同开发。

---

## 核心特性

- **多 CLI 统一雷达与沙箱管理**：自动扫描并一键安装/更新/配置 `Claude Code`、`Codex`、`Gemini CLI`、`Antigravity CLI (agy)`、`Pi`、`OpenCode`、`DeepSeek`、`Kimi` 等本地 CLI；所有配置保存在独立沙箱目录，**绝不修改本机原有 CLI 配置文件**。
- **两段式前置审批与自治闭环**：
  - **项目归属确认**：每次新需求先确认归入已有项目或新建项目；
  - **执行方案与模型决策**：支持「用户默认设定 / Muse 智能决策 / Muse 问询决策」，结合每日自动拉取的权威大模型评测榜单（LMArena / Artificial Analysis / SWE-bench）与 **100% 精确优先级权重（能力 / 价格 / 剩余额度 / 响应速度）**，支持**同一 CLI 下不同模型处理不同子任务**与**递进式升档省预算**。
- **订阅制限额 & 按量余额监测**：支持 Codex 原生 `rate_limits`、本地 5h / 7 天 / 30 天滚动 Token 统计，以及 DeepSeek / OpenRouter / NewAPI / OneAPI / Kimi / 自定义 URL 的余额查询。
- **手机飞书全链路遥控**：
  - 支持飞书双向指令、图文/任意本地文档直传（Word / PDF / Excel / PPT / Markdown / ZIP）；
  - 支持 Muse 交互选项与权限审批自动推飞书，回复数字即可远程代点；
  - 支持安全白名单目录（项目目录 / 桌面 / 文档 / 下载）远程找文件、读文件、改文件并回传飞书。
- **本地 CLI 历史导入与真续聊**：右键项目一键扫描并导入 `~/.codex` 与 `~/.claude` 历史会话，顶栏与侧边栏折叠收纳，携带原生 `--resume` 无缝接续上下文。
- **个性化桌面体验**：Muse 实时动态形象同步、支持将当前 Muse 形象一键设为桌面/托盘图标、输入框上方像素风「摸鱼 ↔ 鞭策」动画舞台。

---

## 快速开始（开发与打包）

```bash
# 1. 安装依赖
npm install

# 2. 本地开发运行
npm run dev

# 3. 打包 Windows 安装包 (NSIS)
npm run dist:win
```

> **网络提示**：Meta Muse（`https://muse.ai`）在中国大陆直连网络环境下可能无法访问，使用 Muse 页面前请先开启 VPN / 代理（推荐系统代理或 TUN 模式）。

---

## License

MIT
