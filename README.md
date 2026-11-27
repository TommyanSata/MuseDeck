<div align="center">
  <img src="build/icon.png" alt="MuseDeck Logo" width="96" height="96" />
  <h1>MuseDeck</h1>
  <p><strong>A Desktop Multi-CLI AI Coding Workbench powered by Meta Muse, Feishu Bot &amp; Tailscale Funnel</strong></p>

  <p>
    <a href="README.md"><strong>English</strong></a> ·
    <a href="README_zh.md">简体中文</a>
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

## Why MuseDeck?

Modern developers often run **multiple local AI coding CLIs** at the same time — `Claude Code`, `Codex`, `Gemini CLI`, `Antigravity CLI (agy)`, `Pi`, `OpenCode`, `DeepSeek`, `Kimi` — each with different strengths, models, rate limits, and pricing tiers.

**MuseDeck** unifies them into one clean desktop command deck with **Meta Muse** as your autonomous Supervisor and **Feishu (Lark)** as your mobile remote control:

- **Cloud Scout + Local Builder Synergy**: Leverages Meta Muse's native **cloud web search & live cloud browser actions** at zero local CLI token cost — Muse verifies latest SDK docs, breaking changes, and live web pages in the cloud first, then saves grounded briefs directly into `.musedeck/research/` for local CLIs to implement without hallucination.
- **Proactive Thinking Follow-Up & Open Questions Ledger**: Tracks unresolved architectural or product trade-offs in an **Open Questions Ledger** (`/api/v1/questions`), captures Muse's signature **asynchronous proactive follow-ups**, and pushes them straight to your **mobile Feishu & desktop notifications** (with configurable `23:00–08:00` Night Quiet Hours).
- **Zero Config Pollution**: Every CLI's models, endpoints, roles, weights, and avatars live in MuseDeck's isolated sandbox — your local `~/.codex`, `~/.claude`, and `~/.gemini` files are **never modified**.
- **Budget-Smart Multi-Model Routing**: Automatically fetches daily LLM benchmarks (*LMArena*, *Artificial Analysis*, *SWE-bench*), monitors subscription 5h/weekly/monthly usage & metered API balances, and routes subtasks by your exact **100% priority weights** (*Capability / Price / Quota / Speed*) — even using **different models within the same CLI** for different subtasks, escalating only when review finds gaps.
- **Two-Stage Human-in-the-Loop Approval**: Confirm **Project Routing** first, then approve the **Execution Plan & Model Allocation** (on desktop or by replying `"OK"` in mobile Feishu) before a single token is spent.
- **Full Mobile Remote Control**: Receive review summaries, generated images, and arbitrary local documents (`Word / PDF / Excel / PPT / ZIP / Code`) directly in Feishu, and remotely click Muse's interactive option cards by replying `1 / 2 / 3`.

---

## Key Capabilities

| Capability | Highlights |
| :--- | :--- |
| **Multi-CLI Radar & Manager** | One-click install/update/uninstall, live local model scanning, CC-Switch style provider presets, latency testing, 5-tier reasoning effort slider, custom roles & `0–5` per-role weights. |
| **Per-Project CLI Whitelist & History Resume** | Right-click any project to restrict allowed CLIs, edit metadata, or scan & import local `~/.codex` / `~/.claude` sessions with native `--resume` continuation. |
| **Quota & Balance Awareness** | Reads Codex native `rate_limits`, tracks rolling 5h/7d/30d local token usage, and queries metered balances for DeepSeek, OpenRouter, NewAPI/OneAPI, Kimi, or custom URLs. |
| **Embedded Tailscale Funnel & Local Auto-Pilot** | Built-in userspace `tsnet` sidecar with automated `Connect / Enable Funnel` clicker, one-click Feishu Open Platform bot configurator, official **Muse from Meta** Chrome extension linkage, and a local-IP `/api/v1/browser/*` engine to avoid cloud IP blocks. |
| **Remote File Search & Feishu Attachments** | Safe allowlisted directory search/read (`Projects / Desktop / Documents / Downloads`, blocking `.ssh` & `.env`) and direct Feishu file transfer up to 30 MB. |

---

## Quick Start

### Option 1: Download Prebuilt Installer (Recommended)
Grab the latest Windows x64 installer from [**GitHub Releases**](https://github.com/TommyanSata/MuseDeck/releases/latest) (`MuseDeck-Setup-x.y.z.exe`).

### Option 2: Run from Source
```bash
# 1. Clone the repository
git clone https://github.com/TommyanSata/MuseDeck.git
cd MuseDeck

# 2. Install dependencies
npm install

# 3. Start in development mode
npm run dev

# 4. Build Windows NSIS installer
npm run dist:win
```

> **Network Note**: Meta Muse (`https://muse.ai`) may not be directly reachable from mainland China without a VPN / proxy. If the Muse web pane fails to load, enable your VPN (system proxy or TUN mode) and reload.

---

## License

MIT © [TommyanSata](https://github.com/TommyanSata)
