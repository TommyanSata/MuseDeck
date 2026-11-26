<div align="center">
  <img src="build/icon.png" alt="MuseDeck Logo" width="96" height="96" />
  <h1>MuseDeck</h1>
  <p><strong>基于 Meta Muse、飞书长连接与 Tailscale Funnel 的桌面端多 AI 编程 CLI 调度工作台</strong></p>

  <p>
    <a href="README.md">English</a> ·
    <a href="README_zh.md"><strong>简体中文</strong></a>
  </p>

  <p>
    <a href="https://github.com/TommyanSata/MuseDeck/releases/latest">
      <img src="https://img.shields.io/github/v/release/TommyanSata/MuseDeck?style=flat-square&color=18181b" alt="Latest Release" />
    </a>
    <img src="https://img.shields.io/badge/platform-Windows%20x64-0078D6?style=flat-square" alt="Windows x64" />
    <img src="https://img.shields.io/badge/stack-Electron%20%2B%20React%20%2B%20TypeScript-3178C6?style=flat-square" alt="Tech Stack" />
    <img src="https://img.shields.io/badge/license-MIT-10b981?style=flat-square" alt="MIT License" />
  </p>
</div>

---

## 为什么选择 MuseDeck？

现在很多开发者同时在本地使用多个 AI 编程 CLI——`Claude Code`、`Codex`、`Gemini CLI`、`Antigravity CLI (agy)`、`Pi`、`OpenCode`、`DeepSeek`、`Kimi`——但每个工具的模型强项、限额节奏和计费方式各不相同。

**MuseDeck** 把它们统一收拢到一个极简桌面指挥台里，以 **Meta Muse** 作为总控监督者（Supervisor），以 **手机飞书** 作为随时随地的远程遥控器：

- **「云端探路 + 本地施工」双引擎协同**：充分发挥 Meta Muse 原生的**海外云端真实网页操作与深度联网搜索能力**（零本地 CLI 额度消耗、不受本机网络限制）——先由 Muse 在云端查清最新 SDK 文档、破坏性更新与竞品页面，一键将核验情报落盘至 `.musedeck/research/`，再交给本地 CLI 按图施工，大幅降低幻觉与返工。
- **未决议题池 & Muse 主动思考实时触达**：内置**未决议题池（Open Questions Ledger）**记录尚未拍板的架构与产品悬念；后台无感捕获 Muse 招牌的**跨时间主动思考追问**，实时推送到你的**手机飞书与桌面原生通知**（自带可调的 `23:00–08:00` 夜间免打扰开关，像素小人头顶还会亮起灵感灯泡）。
- **沙箱隔离，绝不污染本机配置**：所有 CLI 的模型、接口、职能权重与头像均保存在 MuseDeck 独立沙箱中，**绝不修改**你本机的 `~/.codex`、`~/.claude`、`~/.gemini` 原配置文件。
- **省预算的精细化多模型分工**：每日后台自动拉取三大权威大模型评测榜单（*LMArena* / *Artificial Analysis* / *SWE-bench*），实时监测订阅制 5h/周/月限额与按量付费余额，严格按你设定的 **100% 优先级权重（能力 / 价格 / 剩余额度 / 响应速度）** 拆分任务——**支持同一个 CLI 下用不同模型分别处理不同子任务**，首轮性价比起手、审阅不达标再递进升档。
- **两段式前置审批，把每一分预算花在刀刃上**：每次新需求先单独确认**项目归属**（归入已有项目或新建项目），再确认**执行方案与模型分工**，桌面端一键点击或飞书回复「批准 / OK」才正式开工。
- **手机飞书全链路远程遥控**：无需公网服务器或固定 IP，支持在飞书里收发图文与任意本地文档（`Word / PDF / Excel / PPT / ZIP / 代码`），支持回复数字远程代点 Muse 的交互选择框与权限弹窗。

---

## 核心特色一览

| 模块 | 特色与优势 |
| :--- | :--- |
| **多 CLI 雷达与配置管理** | 一键安装 / 更新 / 卸载、实时扫描本地模型池、CC-Switch 同款供应商预设与测速、5 档思考等级、自定义职能标签与 `0–5` 独立权重。 |
| **项目级 CLI 隔离与历史真续聊** | 右键任意项目可独立限定允许使用的 CLI、编辑简介；支持扫描导入 `~/.codex` / `~/.claude` 本地历史对话，多任务折叠收纳，携带原生 `--resume` 无缝接续上下文。 |
| **限额与余额守护** | 直读 Codex 原生 `rate_limits`，统计近 5h/7天/30天本地消耗；支持 DeepSeek、OpenRouter、NewAPI/OneAPI、Kimi 与自定义 URL 余额探测。 |
| **内嵌 Tailscale Funnel 穿透** | 内置纯用户态 `tsnet` sidecar，开机自动以 443 HTTPS 暴露本地控制接口（Bearer Token 鉴权），免去复杂内网穿透配置。 |
| **远程文件检索与飞书文档直传** | 授权白名单目录（项目目录 / 桌面 / 文档 / 下载，自动拦截 `.ssh`、`.env` 等敏感文件）快速搜索与读取，支持将电脑文档以飞书附件直传手机（最大 30 MB）。 |

---

## 快速开始

### 方式一：直接下载安装包（推荐）
前往 [**GitHub Releases**](https://github.com/TommyanSata/MuseDeck/releases/latest) 下载最新的 Windows x64 安装包（`MuseDeck-Setup-x.y.z.exe`），按内置引导 3 步完成配置即可使用。

### 方式二：从源码运行与打包
```bash
# 1. 克隆仓库
git clone https://github.com/TommyanSata/MuseDeck.git
cd MuseDeck

# 2. 安装依赖
npm install

# 3. 启动本地开发模式
npm run dev

# 4. 打包 Windows 安装包 (NSIS)
npm run dist:win
```

> **网络提示**：Meta Muse（`https://muse.ai`）目前在中国大陆直连网络环境下可能无法访问。如遇到网页白屏或加载失败，请先开启 VPN / 代理（推荐开启系统代理或 TUN 模式）后再刷新。

---

## License

MIT © [TommyanSata](https://github.com/TommyanSata)
