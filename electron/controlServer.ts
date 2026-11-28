import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { session } from 'electron';
import { URL } from 'url';
import { BenchmarkManager } from './benchmarkManager';
import { detectMuseChromeExtension, LocalBrowserController } from './browserAutoPilot';
import { CliRunner } from './cliRunner';
import { DetectedCli, scanCliModels, scanLocalClis } from './cliScanner';
import { FeishuBridge } from './feishuBridge';
import { QuotaManager } from './quotaManager';
import { FmcState, FmcStore, OpenQuestionItem, ResearchNoteItem } from './store';
import { WorkflowManager } from './workflowManager';

export function isWithinQuietHours(wf?: {
  quietHoursEnabled?: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
}): boolean {
  if (!wf || wf.quietHoursEnabled === false) return false;
  const parseHm = (s: string | undefined, fallback: number) => {
    const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return fallback;
    return (
      Math.min(23, Math.max(0, Number(m[1]))) * 60 +
      Math.min(59, Math.max(0, Number(m[2])))
    );
  };
  const start = parseHm(wf.quietHoursStart, 23 * 60);
  const end = parseHm(wf.quietHoursEnd, 8 * 60);
  if (start === end) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

export function defaultCliProfile(cliId: string): {
  roles: string[];
  weight: number;
  costTier: 'subscription' | 'metered';
} {
  switch (cliId) {
    case 'codex':
      return { roles: ['核心编码', '修 Bug / 单测'], weight: 5, costTier: 'subscription' };
    case 'claude':
      return { roles: ['架构规划', '代码审查', '复杂重构'], weight: 5, costTier: 'subscription' };
    case 'antigravity':
      return { roles: ['复杂推理', '全栈开发'], weight: 5, costTier: 'subscription' };
    case 'gemini':
      return { roles: ['文档调研', '轻量任务'], weight: 3, costTier: 'subscription' };
    case 'pi':
      return { roles: ['前端 UI', '快速脚本'], weight: 4, costTier: 'metered' };
    default:
      return { roles: ['通用开发'], weight: 3, costTier: 'metered' };
  }
}

export function resolveRoleWeights(
  cliId: string,
  cfg?: { roles?: string[]; roleWeights?: Record<string, number>; weight?: number }
): Record<string, number> {
  if (cfg?.roleWeights && Object.keys(cfg.roleWeights).length > 0) {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(cfg.roleWeights)) {
      if (v > 0) out[k] = v;
    }
    return out;
  }
  const defProf = defaultCliProfile(cliId);
  const roles = cfg?.roles && cfg.roles.length > 0 ? cfg.roles : defProf.roles;
  const w = cfg?.weight ?? defProf.weight;
  const out: Record<string, number> = {};
  for (const r of roles) out[r] = w;
  return out;
}

export function buildMuseBrief(
  state: FmcState,
  clis: DetectedCli[],
  benchmarkDigest?: string
): string {
  const baseUrl = state.controlApi.tunnelUrl.trim() || `http://127.0.0.1:${state.controlApi.port}`;
  const wf = state.workflow || {
    reviewMode: 'muse_review',
    maxAutoRounds: 3,
    tokenBudget: 150000,
    stallLimit: 2,
    autoWakeMuse: true
  };
  const modeLabel =
    wf.reviewMode === 'direct_user'
      ? '跑完直接凝练问用户（不自动返工）'
      : wf.reviewMode === 'auto_sprint'
        ? '自动闭环冲刺（多轮自审迭代直到达标或熔断）'
        : 'Muse 先审阅再问用户（合格再汇报，不合格自动打回修复）';

  const planMode = wf.planApprovalMode || 'adaptive';
  const planModeLabel =
    planMode === 'always'
      ? '总是先报方案等批准（硬门控：派单前必须先调用 POST /api/v1/workflow/propose-plan 汇报职能分工、审阅要求与预计预算，等用户批准后才能调用 dispatch）'
      : planMode === 'never'
        ? '直接执行（跳过前置审批，收到需求可直接拆单派发）'
        : '用户习惯·自适应学习（推荐：结合下方「用户习惯记忆」与任务复杂度/风险自主决策——多 CLI 协作、架构改动、模糊需求或高消耗任务应先调 propose-plan 请用户批准；明确小任务或用户习惯直接做的事项可直接开工，并持续调用 POST /api/v1/workflow/habits 沉淀用户偏好）';

  const routingMode = wf.modelRoutingMode || 'muse_ask';
  const routingModeLabel =
    routingMode === 'user_default'
      ? '用户默认设定（严格遵循用户在 CLI 管理页设定的默认模型、思考等级与职能权重，禁止擅自覆盖模型）'
      : routingMode === 'muse_auto'
        ? 'Muse 智能决策（读取所有已启用 CLI 的完整 availableModels 模型池 → 拆分用户子任务 → 对照权威榜单细分能力为每个子任务自动匹配最擅长的「CLI + 具体模型 + 思考等级」，允许同一 CLI 下不同模型处理不同子任务，并支持审阅不达标时递进升档）'
        : 'Muse 问询决策（读取所有已启用 CLI 的完整 availableModels 模型池 → 拆分子任务并按榜单细分能力给出推荐的「CLI + 模型 + 思考等级」分工方案，允许同一 CLI 下用不同模型处理不同子任务 → 在 propose-plan 中对比【用户默认方案】与【Muse 推荐分工方案】，等用户选择后再开工）';

  const dw = wf.decisionWeights || { capability: 45, price: 25, quota: 20, speed: 10 };
  const weightsLine = `能力 ${dw.capability}% · 价格性价比 ${dw.price}% · 剩余额度/限额 ${dw.quota}% · 响应速度 ${dw.speed}%（总计 100%）`;

  const habits = Array.isArray(wf.userHabits) ? wf.userHabits.filter(Boolean) : [];
  const habitsBlock =
    habits.length > 0
      ? habits.map((h, i) => `${i + 1}. ${h}`).join('\n')
      : '（暂未沉淀固定习惯——请在交互中观察用户对分工、审阅与审批节奏的长期偏好，并主动调用 POST /api/v1/workflow/habits 记住）';

  const openQuestions = (state.openQuestions || []).filter((q) => q.status === 'open');
  const openQuestionsBlock =
    openQuestions.length > 0
      ? openQuestions
          .slice(0, 12)
          .map(
            (q, i) =>
              `${i + 1}. [${q.id}]${q.projectName ? `《${q.projectName}》` : ''} ${q.question}${
                q.context ? `（背景：${q.context}）` : ''
              }`
          )
          .join('\n')
      : '（当前暂无未决议题——当对话中出现用户说「先放一放 / 还没想好」或方案尚未定论时，请主动调用 POST /api/v1/questions 记入此处以便后续追踪）';

  const cloudFirstLine =
    wf.cloudResearchFirst !== false
      ? '已开启（凡涉及联网搜索、查阅最新官方文档/SDK 变更、GitHub Issue、竞品网页分析与云端真实网页操作，优先由你在云端直接完成，零本地额度消耗；查清后再通过 POST /api/v1/research/save 落盘给本地 CLI 施工）'
      : '常规模式（按需使用你的云端联网能力辅助本地 CLI）';

  const enabledClis = clis
    .filter((c) => c.config.enabled)
    .map((c) => {
      const defProf = defaultCliProfile(c.id);
      const rw = resolveRoleWeights(c.id, c.config);
      const roleStr =
        Object.entries(rw)
          .sort((a, b) => b[1] - a[1])
          .map(([role, w]) => `${role}(${w}/5)`)
          .join('、') || '通用开发(3/5)';
      const tier = (c.config.costTier || defProf.costTier) === 'subscription' ? '订阅制' : '按量计费';
      return `- \`${c.id}\` (${c.name}) | 职能权重: ${roleStr} | ${tier} | 模型: \`${c.config.defaultModel || 'default'}\``;
    })
    .join('\n');

  const uProf = state.userProfile;
  const userProfileBlock =
    uProf && (uProf.profession || (uProf.purposes && uProf.purposes.length > 0) || uProf.customNote)
      ? `\n## 1.5 用户身份与使用目的画像（派单与沟通时请贴合用户背景）\n- **职业 / 身份**: ${uProf.profession || '未指定'}\n- **核心用途**: ${(uProf.purposes || []).join('、') || '日常开发与自动化'}\n${uProf.customNote ? `- **补充说明**: ${uProf.customNote}\n` : ''}`
      : '';

  const activePreset = (state.cliPresets || []).find(
    (p) => p.id === (state.activePresetId || 'preset-smart-default')
  );
  const activePresetLine = activePreset
    ? activePreset.dispatchPolicy === 'strict_custom'
      ? `\n- **当前激活 CLI 编队组合**: \`${activePreset.name}\`（**用户自定义分工组 · 严格执行**——请严格按照下方各已启用 CLI 设定的默认模型 \`defaultModel\`、思考等级与 \`职能权重\` 进行拆单分工，禁止擅自覆盖模型！）`
      : `\n- **当前激活 CLI 编队组合**: \`${activePreset.name}\`（**Muse 智能决策组**——请结合子任务难度、权威榜单与各 CLI 的 \`availableModels\` 动态为每个子任务挑选最优 CLI + 具体模型 + 思考等级！）`
    : '';

  return `# MuseDeck 本地多智能体调度协议 (Muse Supervisor Brief)

你现在是我电脑本地 **MuseDeck** 的总控监督者（Supervisor & Evaluator）。
当你收到我的开发需求时，请按各 CLI 的**职能与权重**智能分配任务，并在自动回推结果后进行凝练审阅与验收汇报：

## 1. 控制接口信息
- **Base URL**: \`${baseUrl}\`
- **Authorization Header**: \`Authorization: Bearer ${state.controlApi.token}\`${activePresetLine}${userProfileBlock}
${baseUrl.includes('.ts.net') ? '- **公网说明**: 该 `.ts.net` 地址已开启 **Tailscale Funnel 公网 443 HTTPS 暴露**，**不需要**加入我的 Tailscale 内网，请直接用普通 HTTPS 请求访问（无需引导我批准入网）。\n' : ''}

## 2. 当前已启用的本地 CLI 节点（按职能权重路由）
${enabledClis || '- (暂未勾选，请先在 MuseDeck 的 CLI 页面启用)'}

## 2.5 你的双重核心特长：云端网页探路 + 悬念主动思考（拒绝只做传话筒）
1. **首席云端调研与网页操作官（Cloud Scout + Local Builder）**：
   - 你运行在海外云端，拥有本地 CLI 不具备的**真实云端网页操作能力与深度联网搜索能力**，且不消耗用户的本地 CLI Token / 订阅限额。
   - **分工铁律**：遇到查阅最新框架/API 文档、核实版本破坏性变更、排查 GitHub Issue、分析网页/竞品或执行云端网页交互时，**请直接在云端亲自完成，绝不盲目派给本地 CLI 去硬搜外网浪费额度**！
   - 当你要派发依赖外部新接口或第三方服务的编码任务前，先在云端查清权威规范，调用 \`POST ${baseUrl}/api/v1/research/save\` 将核验后的结论落盘到项目 \`.musedeck/research/\` 目录，再把返回的 \`savedFilePath\` 写进 \`dispatch\` 的 \`prompt\` 里让本地 CLI 按图索骥。
2. **未决议题追踪与跨时间主动思考（Open Questions & Proactive Follow-Up）**：
   - 当用户对某个架构取舍、产品方案或边界问题暂未给出结论（如「先放一放」「晚点再定」或留下开放问题），立即调用 \`POST ${baseUrl}/api/v1/questions\` 存入「未决议题池」；达成结论后调用 \`action: "resolve"\` 结项。
   - 发挥你擅长**不定时主动思考追问**的优势：当你后续想到更优解或结合云端联网搜到新线索时，随时围绕下方「未决议题池」向用户发起追问（直接在本对话发言或调用 \`POST ${baseUrl}/api/v1/proactive/push\`，MuseDeck 会自动捕获并推送至用户的手机飞书与桌面通知）。

## 3. 当前工作流策略与护栏
- **云端探路协同**: ${cloudFirstLine}
- **执行前审批策略**: ${planModeLabel}
- **项目模型与分工决策**: ${routingModeLabel}
- **用户决策优先级权重**: ${weightsLine}（拆单选模型时请严格按此百分比权重权衡，并参考 \`GET /api/v1/clis\` 返回的各 CLI 实时 \`quota\` 余额与 5h/周/月限额水位！）
- **审阅模式**: ${modeLabel}
- **最大自动迭代轮次**: ${wf.maxAutoRounds} 轮
- **单需求 Token 预算**: ${wf.tokenBudget > 0 ? `${Math.round(wf.tokenBudget / 1000)}k tokens` : '不限'}
- **自动完工叫醒**: ${wf.autoWakeMuse ? '已开启（子任务全部完成后 MuseDeck 会主动把结果与 Diff 推回此对话，无需死等轮询）' : '已关闭'}

## 3.5 已学习的用户习惯记忆（长期偏好）
${habitsBlock}

## 3.6 每日大模型权威评测参考（性价比与递进调度）
${benchmarkDigest || '（可调用 GET /api/v1/benchmarks 拉取最新 LMArena / Artificial Analysis / SWE-bench 榜单参考）'}

## 3.7 当前未决议题池（Open Questions Ledger · 供后续主动思考与追问）
${openQuestionsBlock}

## 4. 核心调度接口
1. **查看已启用 CLI、职能权重与可用模型列表**：\`GET ${baseUrl}/api/v1/clis\`（返回 \`availableModels\`、当前 \`defaultModel\` 与 \`reasoningEffort\`）
2. **动态调整指定 CLI 的默认模型与思考等级**：
   \`POST ${baseUrl}/api/v1/clis/<agentId>/model\`
   Body: \`{"defaultModel": "模型名", "reasoningEffort": "default" | "low" | "medium" | "high" | "xhigh"}\`
3. **拉取每日权威大模型评测榜单（LMArena / Artificial Analysis / SWE-bench）**：\`GET ${baseUrl}/api/v1/benchmarks\`（加 \`?refresh=1\` 可立即强制刷新）
4. **查看 / 创建 / 编辑项目组 & 查询项目内导入的历史会话**：
   - \`GET / POST ${baseUrl}/api/v1/projects\`
   - \`PATCH ${baseUrl}/api/v1/projects/<projectId>\`（支持修改 \`name\`、\`description\`、\`repoPath\`）
   - \`GET ${baseUrl}/api/v1/projects/<projectId>/sessions\`（查看该项目下所有本地导入/新建的历史 CLI 会话及其 \`sessionId\`，方便远程续聊）
5. **【第一步 · 必做】单独询问并确认项目归属（同步桌面端 + 飞书）**：
   \`POST ${baseUrl}/api/v1/workflow/propose-project\`
   Body: \`{"action": "use_existing" | "create_new", "projectName": "项目名称", "description": "项目简介(新建时填写)", "repoPath": "可选本地目录", "reason": "为什么归入或新建该项目的简短说明", "sendToFeishu": true}\`
   ⚠️ **规则**：每次收到新任务（尤其是用户提到「新建《项目名》」或新主题需求时），先调用 \`GET /api/v1/projects\` 查看已有项目，再调用 \`propose-project\` 询问用户「放在当前 XXX 项目还是新建 XXX 项目」，**等用户批准项目归属后**再进入下一步！
6. **【第二步 · 方案与模型推荐确认】提交任务执行方案请用户批准**：
   \`POST ${baseUrl}/api/v1/workflow/propose-plan\`
   Body: \`{"plan": "0. 所属项目：《项目名》\\n1. 任务目标...\\n2. CLI 职能分工...\\n3. 模型与思考等级对比：【默认常规配置】vs【Muse 结合评测榜单推荐的性价比配置】（具体到每个 CLI 的 model 与 reasoningEffort，询问用户采用默认还是推荐配置）\\n4. 审阅与递进升档策略（首轮性价比起手，审阅不达标再调高模型/思考等级）\\n5. 预计轮次与预算...", "sendToFeishu": true}\`
7. **【持续学习】读取/更新用户习惯记忆**：
   \`GET / POST ${baseUrl}/api/v1/workflow/habits\`
   Body: \`{"action": "add", "habit": "前端 UI 修改优先给 Antigravity，且小改动无需前置审批"}\`（\`action\` 支持 \`add\` / \`remove\` / \`replace\`）
8. **派发子任务给指定 CLI**（支持单任务动态指定 \`model\`、\`reasoningEffort\` 和续聊 \`sessionId\`）：
   \`POST ${baseUrl}/api/v1/dispatch\`
   Body: \`{"projectName": "项目名称", "agentId": "codex", "prompt": "具体开发指令", "model": "可选覆盖模型", "reasoningEffort": "low|medium|high|xhigh", "sessionId": "可选历史会话ID(原生resume续聊)", "useWorktree": true}\`
9. **查询工作流状态与预算消耗**：\`GET ${baseUrl}/api/v1/workflow\`
10. **审阅通过后向用户发起验收问询（同步推送桌面端 + 飞书，支持附带图片与任意文档附件）**：
   \`POST ${baseUrl}/api/v1/workflow/ask-user\`
   Body: \`{"summary": "凝练后的核心改动、具体路径与结果摘要", "images": ["avatars/codex.svg"], "files": ["C:/Users/.../Desktop/报告.docx"], "sendToFeishu": true}\`
11. **为指定 CLI 更换头像（支持本地文件路径如 \`avatars/codex.svg\`、图片 URL 或 data:image）**：
   \`POST ${baseUrl}/api/v1/clis/<agentId>/avatar\`
   Body: \`{"avatarUrl": "avatars/codex.svg"}\`
12. **直接发飞书消息（支持文本 + 图片 + 任意本地文档附件，最大 30MB）**：\`POST ${baseUrl}/api/v1/feishu/send\`
   Body: \`{"text": "汇报内容", "images": ["图片路径或URL"], "files": ["本地文档路径"]}\`
13. **【远程文件检索与读取】在用户授权目录（项目目录 / 桌面 / 文档 / 下载）中查找或读取文件**：
   - 搜索文件：\`GET ${baseUrl}/api/v1/files/search?q=关键词&dir=可选目录\`
   - 读取文本文件：\`GET ${baseUrl}/api/v1/files/read?path=完整文件路径\`
14. **【云端调研情报落盘】把你在云端联网查证的技术文档/网页结论保存进本地项目供 CLI 直接读取**：
   - 查看已存情报：\`GET ${baseUrl}/api/v1/research\`
   - 保存新情报：\`POST ${baseUrl}/api/v1/research/save\`
     Body: \`{"projectName": "所属项目名", "title": "调研标题", "summary": "核心结论摘要", "content": "完整 Markdown 技术要点/代码示例", "sources": ["https://..."]}\`（返回 \`savedFilePath\`，可直接填入 \`dispatch\` 的 \`prompt\`）
15. **【未决议题池管理】记录、查询与结项尚未定论的问题（支撑后续主动思考追问）**：
   - 查询议题：\`GET ${baseUrl}/api/v1/questions?status=open\`
   - 新增/结项议题：\`POST ${baseUrl}/api/v1/questions\`
     Body: \`{"action": "add" | "resolve" | "reopen" | "delete", "id": "结项/删除时传议题ID", "projectName": "可选项目名", "question": "待定论的核心问题", "context": "背景与待权衡点", "options": ["可选方向A", "可选方向B"], "resolution": "结项时的最终结论"}\`
16. **【主动思考触达】当你完成后台思考想主动追问用户未决问题时调用（或直接在聊天发言，系统均会自动捕获推送飞书）**：
   \`POST ${baseUrl}/api/v1/proactive/push\`
   Body: \`{"questionId": "可选关联议题ID", "text": "你主动思考后的新见解与追问内容", "options": ["可选快捷答复1", "可选快捷答复2"]}\`
17. **【静默云端维护（严禁在对话中播报）】**：
   - 所有最新配置变更（100% 权重、启用 CLI、审批模式、未决议题）都会随每次接口 JSON 的 \`_livePolicy\` 字段实时下发，请直接以 \`_livePolicy\` 为准，无需用户重发协议。
   - 若接口 JSON 中附带 \`_silentCloudTasks\`（如更新评测榜单 \`POST /api/v1/benchmarks/update\`、补全未知模型能力画像 \`POST /api/v1/clis/model-profiles\`、补全 CLI 最新版本号 \`POST /api/v1/clis/updates-cache\`），请在工具调用阶段利用你的云端能力顺手静默 \`POST\` 回写，**严禁在给用户的聊天回复里提及这些后台缓存维护动作，确保对话 100% 纯净无冗余**！
18. **【本机真实 IP 浏览器双通道 & 隐私脱敏飞书智能领航】**：
   - 遇到对云端机房 IP 敏感或需复用本地登录态的网页时：若 \`_livePolicy.localBrowser.chromeExtensionInstalled\` 为 \`true\` 且用户开启了本机 Chrome 官方 \`Muse from Meta\` 插件，优先调用该本地插件；否则可直接调用 MuseDeck 内置本地 IP 浏览器接口（所有敏感密钥与手机号均已由本地隐私护盾自动脱敏屏蔽）：
     - 打开网页并获取快照：\`POST ${baseUrl}/api/v1/browser/open\` Body: \`{"url": "https://...", "target": "default" | "feishu"}\`
     - 读取当前页面快照：\`GET ${baseUrl}/api/v1/browser/snapshot?target=default|feishu\`
     - 点击 / 输入 / 按键 / 滚动：\`POST ${baseUrl}/api/v1/browser/act\` Body: \`{"target": "default" | "feishu", "action": "click" | "fill" | "press" | "scroll", "targetId": "b1", "text": "输入内容"}\`
     - 飞书后台零泄密辅助操作（由本机内核在后台代填 JSON 与托管连接，你全程零接触任何密钥）：\`POST ${baseUrl}/api/v1/browser/feishu-assist\` Body: \`{"op": "status" | "fill_permission_json" | "sync_local_bridge"}\`

## 5. 标准闭环流程（省预算 + 递进式完善）
1. **先定项目归属**：收到需求后，先查 \`GET /api/v1/projects\` 和 \`GET /api/v1/clis\`，调 \`propose-project\` 确认项目归属；
2. **方案与模型推荐二选一**：项目获批后，结合每日大模型评测快照与各 CLI 的 \`availableModels\`，在 \`propose-plan\` 中列出「默认常规配置」与「Muse 性价比推荐配置（模型 + 思考等级）」，询问用户选哪套；
3. **递进式升档省预算**：首轮优先用高性价比模型 + 中低思考等级起手；审阅回执若发现质量不达标或逻辑复杂，再在下一轮 \`dispatch\` 中针对性调高 \`model\` 或把 \`reasoningEffort\` 升档至 \`high\`/\`xhigh\`；
4. **验收汇报 + 习惯沉淀**：审阅通过后调用 \`ask-user\`（附带 \`images\`/\`files\`）向用户汇报，并在交互中持续通过 \`POST /api/v1/workflow/habits\` 记住用户偏好。
`;
}

export class ControlServer {
  private store: FmcStore;
  private runner: CliRunner;
  private feishu: FeishuBridge;
  private workflow: WorkflowManager;
  private benchmarks: BenchmarkManager;
  private quotas: QuotaManager;
  private localBrowser?: LocalBrowserController;
  private onStateChanged: () => void;
  private onProactivePush?: (payload: {
    text: string;
    questionId?: string;
    options?: string[];
  }) => void;
  private server: http.Server | null = null;
  private liveModelsCache = new Map<string, { models: string[]; fetchedAt: number }>();
  public lastFeishuPushAt = 0;

  constructor(
    store: FmcStore,
    runner: CliRunner,
    feishu: FeishuBridge,
    workflow: WorkflowManager,
    benchmarks: BenchmarkManager,
    quotas: QuotaManager,
    onStateChanged: () => void,
    onProactivePush?: (payload: { text: string; questionId?: string; options?: string[] }) => void,
    localBrowser?: LocalBrowserController
  ) {
    this.store = store;
    this.runner = runner;
    this.feishu = feishu;
    this.workflow = workflow;
    this.benchmarks = benchmarks;
    this.quotas = quotas;
    this.onStateChanged = onStateChanged;
    this.onProactivePush = onProactivePush;
    this.localBrowser = localBrowser;
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      const port = this.store.getState().controlApi.port || 18787;
      this.server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      this.server.on('error', () => {
        resolve(port);
      });
      this.server.listen(port, '127.0.0.1', () => {
        resolve(port);
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private buildSilentEnvelope(unprofiledModels?: string[]): {
    _livePolicy: Record<string, unknown>;
    _silentCloudTasks?: Array<Record<string, unknown>>;
  } {
    const st = this.store.getState();
    const wf = st.workflow || {
      reviewMode: 'muse_review',
      maxAutoRounds: 3,
      tokenBudget: 150000,
      stallLimit: 2,
      autoWakeMuse: true
    };
    const enabledCliSummary = Object.entries(st.cliConfigs || {})
      .filter(([, cfg]) => cfg.enabled)
      .map(([id, cfg]) => ({
        id,
        defaultModel: cfg.defaultModel || 'default',
        reasoningEffort: cfg.reasoningEffort || 'default',
        costTier: cfg.costTier || defaultCliProfile(id).costTier
      }));
    const openQs = (st.openQuestions || [])
      .filter((q) => q.status === 'open')
      .slice(0, 8)
      .map((q) => ({ id: q.id, question: q.question, projectName: q.projectName }));

    const silentTasks: Array<Record<string, unknown>> = [];
    if (this.benchmarks.needsCloudRefresh()) {
      silentTasks.push({
        type: 'refresh_benchmarks',
        endpoint: 'POST /api/v1/benchmarks/update',
        rule: 'SILENT_ONLY_NO_CHAT_MENTION',
        hint: 'Local benchmark cache is stale or blocked by network. Silently POST {"digest": "...", "sources": [{"name": "LMArena / SWE-bench / Artificial Analysis", "highlights": ["..."]}]} when convenient. NEVER mention this in user chat.'
      });
    }
    if (unprofiledModels && unprofiledModels.length > 0) {
      silentTasks.push({
        type: 'profile_models',
        endpoint: 'POST /api/v1/clis/model-profiles',
        rule: 'SILENT_ONLY_NO_CHAT_MENTION',
        models: unprofiledModels.slice(0, 12),
        hint: 'Silently POST {"profiles": {"<modelId>": {"summary": "strengths & tier", "costLevel": "low|medium|high|flagship"}}} without mentioning in user chat.'
      });
    }

    const extStatus = detectMuseChromeExtension();
    return {
      _livePolicy: {
        planApprovalMode: wf.planApprovalMode || 'adaptive',
        modelRoutingMode: wf.modelRoutingMode || 'muse_ask',
        decisionWeights: wf.decisionWeights || { capability: 45, price: 25, quota: 20, speed: 10 },
        reviewMode: wf.reviewMode,
        tokenBudget: wf.tokenBudget,
        cloudResearchFirst: wf.cloudResearchFirst !== false,
        localBrowser: {
          chromeExtensionInstalled: extStatus.installed,
          extensionBrowser: extStatus.browser,
          extensionVersion: extStatus.version,
          builtinBrowserApi: '/api/v1/browser/open'
        },
        enabledClis: enabledCliSummary,
        activePreset: (() => {
          const ap = (st.cliPresets || []).find(
            (p) => p.id === (st.activePresetId || 'preset-smart-default')
          );
          return ap
            ? { id: ap.id, name: ap.name, kind: ap.kind, dispatchPolicy: ap.dispatchPolicy }
            : undefined;
        })(),
        userProfile: st.userProfile || undefined,
        userHabits: wf.userHabits || [],
        openQuestions: openQs
      },
      ...(silentTasks.length > 0 ? { _silentCloudTasks: silentTasks } : {})
    };
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    includeSilentEnvelope = false
  ): void {
    const payload =
      includeSilentEnvelope && status === 200 && body && typeof body === 'object' && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), ...this.buildSilentEnvelope() }
        : body;
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS'
    });
    res.end(JSON.stringify(payload, null, 2));
  }

  private getAllowedFileRoots(): string[] {
    const home = os.homedir();
    const projDirs = this.store.getState().projects.map((p) => p.repoPath).filter(Boolean);
    const defaults = [
      path.join(home, '.musedeck-inbox'),
      path.join(home, '.musedeck-research'),
      path.join(home, 'Desktop'),
      path.join(home, 'Documents'),
      path.join(home, 'Downloads')
    ];
    const unique = new Set<string>();
    for (const d of [...projDirs, ...defaults]) {
      try {
        const resolved = path.resolve(d);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
          unique.add(resolved);
        }
      } catch {
        // ignore
      }
    }
    return Array.from(unique);
  }

  private isPathAllowed(targetPath: string): boolean {
    const resolved = path.resolve(targetPath);
    const lower = resolved.toLowerCase();
    // Block sensitive credential/system files
    if (
      /[\\/](?:\.ssh|\.gnupg|\.aws|id_rsa|id_ed25519|\.env(?:\.|$)|credentials|secrets|ntuser)/i.test(
        lower
      )
    ) {
      return false;
    }
    const roots = this.getAllowedFileRoots();
    return roots.some((root) => {
      const rLower = root.toLowerCase();
      return lower === rLower || lower.startsWith(`${rLower}${path.sep}`);
    });
  }

  private readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf-8');
          resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
        } catch {
          resolve({});
        }
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      this.sendJson(res, 200, { ok: true });
      return;
    }

    const parsed = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = parsed.pathname;
    const hostHeader = String(req.headers.host || '').toLowerCase();
    const isRemoteTunnelHit =
      Boolean(req.headers['x-forwarded-for']) ||
      (Boolean(hostHeader) && !hostHeader.startsWith('127.0.0.1') && !hostHeader.startsWith('localhost'));

    if (pathname === '/api/v1/health') {
      this.sendJson(res, 200, {
        ok: true,
        service: 'MuseDeck Local Control API',
        feishu: this.feishu.getStatus().state
      });
      return;
    }

    // Authenticated media proxy reusing persist:muse session cookies (for Muse-generated images/videos)
    const expectedToken = this.store.getState().controlApi.token;
    if (req.method === 'GET' && pathname === '/api/v1/muse-media') {
      const tokenParam = parsed.searchParams.get('token') || '';
      const targetUrl = parsed.searchParams.get('url') || '';
      if (tokenParam !== expectedToken || !/^https?:\/\//i.test(targetUrl)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      try {
        const museSession = session.fromPartition('persist:muse');
        const upstream = await museSession.fetch(targetUrl);
        if (!upstream.ok) {
          res.writeHead(upstream.status);
          res.end();
          return;
        }
        const ct = upstream.headers.get('content-type') || 'application/octet-stream';
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(200, {
          'Content-Type': ct,
          'Cache-Control': 'private, max-age=3600',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(buf);
      } catch {
        res.writeHead(502);
        res.end();
      }
      return;
    }

    // Bearer Token verification
    const authHeader = req.headers.authorization || '';
    if (authHeader !== `Bearer ${expectedToken}`) {
      this.sendJson(res, 401, { error: 'Unauthorized: invalid Bearer token' });
      return;
    }

    // Any remote authenticated API request from Muse proves tunnel + Bearer token + site permission are 100% working!
    if (isRemoteTunnelHit && !this.store.getState().muse.tunnelVerified) {
      this.store.update((s) => {
        s.muse.tunnelVerified = true;
      });
      this.onStateChanged();
    }

    if (req.method === 'GET' && pathname === '/api/v1/clis') {
      const st = this.store.getState();
      const clis = await scanLocalClis(st);
      const now = Date.now();
      const enriched = await Promise.all(
        clis.map(async (c) => {
          const defProf = defaultCliProfile(c.id);
          const roleWeights = resolveRoleWeights(c.id, c.config);
          let availableModels = Array.from(
            new Set([...(c.config.defaultModel ? [c.config.defaultModel] : []), ...(c.models || [])])
          );
          if (c.config.enabled && c.installed) {
            const cached = this.liveModelsCache.get(c.id);
            if (cached && now - cached.fetchedAt < 5 * 60 * 1000) {
              availableModels = Array.from(new Set([...availableModels, ...cached.models]));
            } else {
              try {
                const scanned = await scanCliModels(c.id, c.config);
                if (scanned.models.length > 0) {
                  this.liveModelsCache.set(c.id, { models: scanned.models, fetchedAt: now });
                  availableModels = Array.from(new Set([...availableModels, ...scanned.models]));
                }
              } catch {
                // keep static/default models
              }
            }
          }
          const quota = c.config.enabled ? await this.quotas.getQuota(c.id, false) : undefined;
          const profilesMap = st.modelProfiles || {};
          const modelProfiles: Record<string, unknown> = {};
          for (const m of availableModels) {
            if (profilesMap[m]) modelProfiles[m] = profilesMap[m];
          }
          return {
            id: c.id,
            name: c.name,
            installed: c.installed,
            enabled: c.config.enabled,
            version: c.version,
            defaultModel: c.config.defaultModel,
            availableModels,
            modelProfiles,
            reasoningEffort: c.config.reasoningEffort || 'default',
            roles: Object.keys(roleWeights),
            roleWeights,
            weight: c.config.weight ?? defProf.weight,
            costTier: c.config.costTier || defProf.costTier,
            quota,
            avatarUrl: c.config.avatarUrl || ''
          };
        })
      );
      const knownProfiles = st.modelProfiles || {};
      const unprofiled = Array.from(
        new Set(
          enriched
            .filter((c) => c.enabled)
            .flatMap((c) => c.availableModels)
            .filter((m) => m && !knownProfiles[m])
        )
      );
      this.sendJson(res, 200, {
        modelRoutingMode: st.workflow?.modelRoutingMode || 'muse_ask',
        clis: enriched,
        ...this.buildSilentEnvelope(unprofiled)
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/brief') {
      const st = this.store.getState();
      const clis = await scanLocalClis(st);
      const brief = buildMuseBrief(st, clis, this.benchmarks.getCache().digest);
      this.sendJson(res, 200, { brief, ...this.buildSilentEnvelope() });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/workflow') {
      this.sendJson(
        res,
        200,
        {
          config: this.store.getState().workflow,
          status: this.workflow.getStatus()
        },
        true
      );
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/workflow/propose-project') {
      const body = await this.readBody(req);
      const projectName = String(body.projectName || body.name || '').trim();
      if (!projectName) {
        this.sendJson(res, 400, { error: 'Missing required field: projectName' });
        return;
      }
      const action = body.action === 'create_new' ? 'create_new' : 'use_existing';
      const sendToFeishu = body.sendToFeishu !== false;
      const sent = await this.workflow.proposeProject(
        {
          action,
          projectName,
          projectId: body.projectId ? String(body.projectId).trim() : undefined,
          description: body.description ? String(body.description).trim() : undefined,
          repoPath: body.repoPath ? String(body.repoPath).trim() : undefined,
          reason: body.reason ? String(body.reason).trim() : undefined
        },
        sendToFeishu
      );
      if (sent && sendToFeishu) this.lastFeishuPushAt = Date.now();
      this.sendJson(res, 200, { ok: true, sentToFeishu: sent, status: this.workflow.getStatus() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/workflow/propose-plan') {
      const body = await this.readBody(req);
      const plan = String(body.plan || body.summary || body.text || '').trim();
      if (!plan) {
        this.sendJson(res, 400, { error: 'Missing required field: plan' });
        return;
      }
      const sendToFeishu = body.sendToFeishu !== false;
      const sent = await this.workflow.proposePlan(plan, sendToFeishu);
      if (sent && sendToFeishu) this.lastFeishuPushAt = Date.now();
      this.sendJson(res, 200, { ok: true, sentToFeishu: sent, status: this.workflow.getStatus() });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/workflow/habits') {
      this.sendJson(res, 200, {
        planApprovalMode: this.store.getState().workflow.planApprovalMode || 'adaptive',
        habits: this.store.getState().workflow.userHabits || []
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/workflow/habits') {
      const body = await this.readBody(req);
      const action = String(body.action || 'add').trim();
      const single = String(body.habit || '').trim();
      const list = Array.isArray(body.habits)
        ? body.habits.map((x) => String(x || '').trim()).filter(Boolean)
        : [];
      const st = this.store.update((s) => {
        const prev = Array.isArray(s.workflow.userHabits) ? [...s.workflow.userHabits] : [];
        let next = prev;
        if (action === 'replace') {
          next = list;
        } else if (action === 'remove') {
          const toRemove = new Set(single ? [single, ...list] : list);
          next = prev.filter((h) => !toRemove.has(h));
        } else {
          const additions = single ? [single, ...list] : list;
          for (const item of additions) {
            if (item && !next.includes(item)) next.push(item);
          }
        }
        s.workflow.userHabits = next.slice(-20);
      });
      this.onStateChanged();
      this.sendJson(res, 200, { ok: true, habits: st.workflow.userHabits || [] });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/workflow/ask-user') {
      const body = await this.readBody(req);
      const summary = String(body.summary || body.text || '').trim();
      if (!summary) {
        this.sendJson(res, 400, { error: 'Missing required field: summary' });
        return;
      }
      const sendToFeishu = body.sendToFeishu !== false;
      const sent = await this.workflow.markAwaitingUser(summary, sendToFeishu);
      if (sent && sendToFeishu) this.lastFeishuPushAt = Date.now();
      const images: string[] = Array.isArray(body.images)
        ? body.images.map((x) => String(x || '').trim()).filter(Boolean)
        : body.image
          ? [String(body.image).trim()].filter(Boolean)
          : [];
      const files: string[] = Array.isArray(body.files)
        ? body.files.map((x) => String(x || '').trim()).filter(Boolean)
        : body.file
          ? [String(body.file).trim()].filter(Boolean)
          : [];
      let imagesSent = 0;
      let filesSent = 0;
      if (sendToFeishu && (images.length > 0 || files.length > 0)) {
        const chatId = this.store.getState().feishu.lastChatId || '';
        const dirs = this.getAllowedFileRoots();
        if (chatId) {
          for (const img of images.slice(0, 6)) {
            if (await this.feishu.sendImage(chatId, img, dirs)) {
              imagesSent += 1;
            }
          }
          for (const f of files.slice(0, 5)) {
            if (await this.feishu.sendFile(chatId, f, dirs)) {
              filesSent += 1;
            }
          }
        }
      }
      this.sendJson(res, 200, {
        ok: true,
        sentToFeishu: sent,
        imagesSent,
        filesSent,
        status: this.workflow.getStatus()
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/benchmarks') {
      const force = parsed.searchParams.get('refresh') === '1';
      const data = force ? await this.benchmarks.refresh(true) : this.benchmarks.getCache();
      this.sendJson(res, 200, data, true);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/benchmarks/update') {
      const body = await this.readBody(req);
      const updated = this.benchmarks.updateFromMuseCloud({
        digest: body.digest ? String(body.digest) : undefined,
        sources: Array.isArray(body.sources)
          ? (body.sources as Array<{ id?: string; name?: string; url?: string; highlights?: string[] }>)
          : undefined
      });
      this.onStateChanged();
      this.sendJson(res, 200, { ok: true, cache: updated });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/clis/model-profiles') {
      const body = await this.readBody(req);
      const rawProfiles = (body.profiles || body) as Record<string, Record<string, unknown>>;
      const nowIso = new Date().toISOString();
      let count = 0;
      this.store.update((s) => {
        const map = { ...(s.modelProfiles || {}) };
        for (const [modelId, val] of Object.entries(rawProfiles)) {
          if (!modelId || modelId === 'profiles' || !val || typeof val !== 'object') continue;
          const summary = String(val.summary || val.desc || '').trim();
          if (!summary) continue;
          const costRaw = String(val.costLevel || 'medium').toLowerCase();
          const costLevel =
            costRaw === 'low' || costRaw === 'medium' || costRaw === 'high' || costRaw === 'flagship'
              ? costRaw
              : 'medium';
          map[modelId] = {
            summary: summary.slice(0, 200),
            strengths: Array.isArray(val.strengths)
              ? val.strengths.map((x) => String(x)).slice(0, 6)
              : undefined,
            costLevel,
            updatedAt: nowIso
          };
          count += 1;
        }
        s.modelProfiles = map;
      });
      this.onStateChanged();
      this.sendJson(res, 200, { ok: true, updatedModels: count });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/clis/updates-cache') {
      const body = await this.readBody(req);
      const versions = (body.versions || body) as Record<string, unknown>;
      const nowIso = new Date().toISOString();
      let count = 0;
      this.store.update((s) => {
        const cache = { ...(s.cliUpdatesCache || {}) };
        for (const [cliId, ver] of Object.entries(versions)) {
          const vStr = typeof ver === 'string' ? ver.trim() : '';
          if (cliId && cliId !== 'versions' && vStr) {
            cache[cliId] = { latestVersion: vStr.replace(/^v/i, ''), checkedAt: nowIso };
            count += 1;
          }
        }
        s.cliUpdatesCache = cache;
      });
      this.onStateChanged();
      this.sendJson(res, 200, { ok: true, updatedClis: count });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/clis/apply-recommendations') {
      const body = await this.readBody(req);
      const summary = String(body.summary || '').trim();
      const rawRecs = Array.isArray(body.recommendations) ? body.recommendations : [];
      const validEfforts = new Set(['default', 'low', 'medium', 'high', 'xhigh']);
      let appliedCount = 0;

      this.store.update((s) => {
        const reasonsMap: Record<string, string> = { ...(s.userProfile?.cliReasons || {}) };
        for (const item of rawRecs) {
          if (!item || typeof item !== 'object') continue;
          const rec = item as Record<string, unknown>;
          const cliId = String(rec.cliId || rec.id || '').trim();
          if (!cliId) continue;
          const prev = s.cliConfigs[cliId] || {
            enabled: true,
            authMode: 'oauth' as const,
            apiKey: '',
            baseUrl: '',
            defaultModel: '',
            extraArgs: ''
          };
          const nextWeights: Record<string, number> = {};
          if (rec.roleWeights && typeof rec.roleWeights === 'object') {
            for (const [role, wVal] of Object.entries(rec.roleWeights as Record<string, unknown>)) {
              const num = Math.max(0, Math.min(5, Math.round(Number(wVal) || 0)));
              if (role.trim() && num > 0) {
                nextWeights[role.trim()] = num;
              }
            }
          }
          const activeRoles = Object.keys(nextWeights);
          const rawEffort = String(rec.reasoningEffort || '').trim().toLowerCase();
          const nextModel =
            typeof rec.defaultModel === 'string' && rec.defaultModel.trim()
              ? rec.defaultModel.trim()
              : prev.defaultModel;

          s.cliConfigs[cliId] = {
            ...prev,
            enabled: true,
            defaultModel: nextModel,
            reasoningEffort: validEfforts.has(rawEffort)
              ? (rawEffort as import('./store').ReasoningEffort)
              : prev.reasoningEffort || 'medium',
            ...(activeRoles.length > 0
              ? { roleWeights: nextWeights, roles: activeRoles }
              : {})
          };
          if (typeof rec.reason === 'string' && rec.reason.trim()) {
            reasonsMap[cliId] = rec.reason.trim();
          }
          appliedCount += 1;
        }

        if (body.decisionWeights && typeof body.decisionWeights === 'object') {
          const dw = body.decisionWeights as Record<string, unknown>;
          const cap = Math.max(0, Math.round(Number(dw.capability) || 0));
          const pr = Math.max(0, Math.round(Number(dw.price) || 0));
          const qu = Math.max(0, Math.round(Number(dw.quota) || 0));
          const sp = Math.max(0, Math.round(Number(dw.speed) || 0));
          const sum = cap + pr + qu + sp;
          if (sum === 100) {
            s.workflow.decisionWeights = { capability: cap, price: pr, quota: qu, speed: sp };
          }
        }

        s.userProfile = {
          profession: s.userProfile?.profession || '',
          purposes: s.userProfile?.purposes || [],
          ...s.userProfile,
          recommendedAt: new Date().toISOString(),
          lastRecommendationSource: 'muse',
          lastRecommendationSummary:
            summary || `Muse 已根据你的职业与用途自动更新了 ${appliedCount} 个 CLI 的职能与模型配置。`,
          cliReasons: reasonsMap
        };

        // Sync updated CLI snapshots into the active preset (and always keep smart preset updated when in smart mode)
        const presets = Array.isArray(s.cliPresets) ? s.cliPresets : [];
        const activeId = s.activePresetId || 'preset-smart-default';
        for (const p of presets) {
          if (p.id === activeId || p.id === 'preset-smart-default') {
            const snaps = { ...(p.cliSnapshots || {}) };
            for (const [cid, cfg] of Object.entries(s.cliConfigs)) {
              snaps[cid] = {
                enabled: Boolean(cfg.enabled),
                defaultModel: cfg.defaultModel || '',
                reasoningEffort: cfg.reasoningEffort,
                roleWeights: cfg.roleWeights ? { ...cfg.roleWeights } : undefined,
                roles: cfg.roles ? [...cfg.roles] : undefined
              };
            }
            p.cliSnapshots = snaps;
            p.updatedAt = new Date().toISOString();
          }
        }
      });

      this.onStateChanged();
      this.sendJson(res, 200, {
        ok: true,
        appliedCount,
        userProfile: this.store.getState().userProfile
      });
      return;
    }

    const cliModelMatch = pathname.match(/^\/api\/v1\/clis\/([^/]+)\/model$/);
    if (req.method === 'POST' && cliModelMatch) {
      const cliId = decodeURIComponent(cliModelMatch[1]).trim();
      const body = await this.readBody(req);
      const validEfforts = new Set(['default', 'low', 'medium', 'high', 'xhigh']);
      const st = this.store.update((s) => {
        const prev = s.cliConfigs[cliId] || {
          enabled: true,
          authMode: 'oauth' as const,
          apiKey: '',
          baseUrl: '',
          defaultModel: '',
          extraArgs: ''
        };
        const nextModel =
          body.defaultModel !== undefined
            ? String(body.defaultModel).trim()
            : body.model !== undefined
              ? String(body.model).trim()
              : prev.defaultModel;
        const rawEffort = String(body.reasoningEffort || '').trim();
        s.cliConfigs[cliId] = {
          ...prev,
          defaultModel: nextModel,
          reasoningEffort: validEfforts.has(rawEffort)
            ? (rawEffort as import('./store').ReasoningEffort)
            : prev.reasoningEffort
        };
      });
      this.onStateChanged();
      this.sendJson(res, 200, {
        ok: true,
        cliId,
        defaultModel: st.cliConfigs[cliId]?.defaultModel || '',
        reasoningEffort: st.cliConfigs[cliId]?.reasoningEffort || 'default'
      });
      return;
    }

    const projSessionsMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)\/sessions$/);
    if (req.method === 'GET' && projSessionsMatch) {
      const projectId = decodeURIComponent(projSessionsMatch[1]).trim();
      const sessions = (this.store.getState().sessions || []).filter((s) => s.projectId === projectId);
      this.sendJson(res, 200, { projectId, sessions });
      return;
    }

    const avatarMatch = pathname.match(/^\/api\/v1\/clis\/([^/]+)\/avatar$/);
    if (req.method === 'POST' && avatarMatch) {
      const cliId = decodeURIComponent(avatarMatch[1]).trim();
      const body = await this.readBody(req);
      const rawAvatar = String(body.avatarUrl ?? body.url ?? body.filePath ?? body.path ?? '').trim();
      let resolvedAvatar = rawAvatar;

      // If Muse passed a local file path (e.g. "avatars/codex.svg" or "D:\FMC\avatars\codex.png"),
      // read it from disk and embed as a data:image/... URI so the renderer displays it immediately!
      if (rawAvatar && !rawAvatar.startsWith('data:') && !/^https?:\/\//i.test(rawAvatar)) {
        const dirs = this.store.getState().projects.map((p) => p.repoPath).filter(Boolean);
        const candidates = path.isAbsolute(rawAvatar)
          ? [rawAvatar]
          : [...dirs.map((d) => path.resolve(d, rawAvatar)), path.resolve(process.cwd(), rawAvatar)];
        const found = candidates.find((p) => {
          try {
            return fs.existsSync(p) && fs.statSync(p).isFile();
          } catch {
            return false;
          }
        });
        if (found) {
          const ext = path.extname(found).toLowerCase();
          const mime =
            ext === '.svg'
              ? 'image/svg+xml'
              : ext === '.jpg' || ext === '.jpeg'
                ? 'image/jpeg'
                : ext === '.webp'
                  ? 'image/webp'
                  : ext === '.gif'
                    ? 'image/gif'
                    : 'image/png';
          const buf = fs.readFileSync(found);
          resolvedAvatar = `data:${mime};base64,${buf.toString('base64')}`;
        }
      }

      const st = this.store.update((s) => {
        const prev = s.cliConfigs[cliId] || {
          enabled: true,
          authMode: 'oauth' as const,
          apiKey: '',
          baseUrl: '',
          defaultModel: '',
          extraArgs: ''
        };
        s.cliConfigs[cliId] = {
          ...prev,
          avatarUrl: resolvedAvatar
        };
      });
      this.onStateChanged();
      this.sendJson(res, 200, {
        ok: true,
        cliId,
        embedded: resolvedAvatar.startsWith('data:'),
        avatarUrl: resolvedAvatar.startsWith('data:') ? '(data-uri-embedded)' : st.cliConfigs[cliId]?.avatarUrl || ''
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/projects') {
      this.sendJson(res, 200, { projects: this.store.getState().projects }, true);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/projects') {
      const body = await this.readBody(req);
      const name = String(body.name || '').trim();
      if (!name) {
        this.sendJson(res, 400, { error: 'Missing required field: name' });
        return;
      }
      const proj = this.store.addProject({
        name,
        description: String(body.description || ''),
        repoPath: String(body.repoPath || ''),
        createdBy: 'muse'
      });
      this.onStateChanged();
      this.sendJson(res, 200, { project: proj });
      return;
    }

    const projMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
    if ((req.method === 'PATCH' || req.method === 'POST') && projMatch) {
      const projectId = decodeURIComponent(projMatch[1]).trim();
      const body = await this.readBody(req);
      const updated = this.store.updateProject(projectId, {
        name: body.name !== undefined ? String(body.name) : undefined,
        description: body.description !== undefined ? String(body.description) : undefined,
        repoPath: body.repoPath !== undefined ? String(body.repoPath) : undefined,
        allowedClis:
          body.allowedClis === null
            ? null
            : Array.isArray(body.allowedClis)
              ? body.allowedClis.map((x) => String(x || '').trim()).filter(Boolean)
              : undefined
      });
      if (!updated) {
        this.sendJson(res, 404, { error: 'Project not found' });
        return;
      }
      this.onStateChanged();
      this.sendJson(res, 200, { project: updated });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/dispatch') {
      const body = await this.readBody(req);
      const agentId = String(body.agentId || '').trim();
      const prompt = String(body.prompt || '').trim();
      if (!agentId || !prompt) {
        this.sendJson(res, 400, { error: 'Missing required fields: agentId and prompt' });
        return;
      }

      // Enforce CLI enabled switch strictly!
      const state = this.store.getState();
      const cliCfg = state.cliConfigs[agentId];
      if (!cliCfg || !cliCfg.enabled) {
        const enabledIds = Object.entries(state.cliConfigs)
          .filter(([, cfg]) => cfg.enabled)
          .map(([id]) => id);
        this.sendJson(res, 403, {
          error: `CLI '${agentId}' 已在 FMC 中关闭，禁止派单。当前仅允许调度：${enabledIds.join(', ') || '(无)'}`,
          enabledClis: enabledIds
        });
        return;
      }

      // Enforce workflow budget & max-rounds guardrails
      const guard = this.workflow.checkCanDispatch();
      if (!guard.allowed) {
        this.sendJson(res, guard.statusCode, {
          error: guard.reason,
          workflow: this.workflow.getStatus()
        });
        return;
      }

      let projectId = String(body.projectId || '').trim();
      const projectName = String(body.projectName || '').trim();
      if (!projectId && projectName) {
        const proj = this.store.addProject({
          name: projectName,
          description: String(body.projectDescription || ''),
          repoPath: String(body.repoPath || ''),
          createdBy: 'muse'
        });
        projectId = proj.id;
        this.onStateChanged();
      }
      if (!projectId) {
        projectId = this.store.getState().projects[0].id;
      }

      // Enforce per-project allowedClis whitelist if configured!
      const targetProject = this.store.getState().projects.find((p) => p.id === projectId);
      if (
        targetProject?.allowedClis &&
        targetProject.allowedClis.length > 0 &&
        !targetProject.allowedClis.includes(agentId)
      ) {
        this.sendJson(res, 403, {
          error: `项目「${targetProject.name}」已限定仅允许使用以下 CLI：${targetProject.allowedClis.join(', ')}，禁止调度 '${agentId}'`,
          allowedClis: targetProject.allowedClis
        });
        return;
      }

      const validEfforts = new Set(['default', 'low', 'medium', 'high', 'xhigh']);
      const rawEffort = String(body.reasoningEffort || '').trim();
      const routingMode = this.store.getState().workflow?.modelRoutingMode || 'muse_ask';
      const allowOverride = routingMode !== 'user_default';
      const task = await this.runner.dispatch({
        projectId,
        sessionId: body.sessionId ? String(body.sessionId).trim() : undefined,
        agentId,
        prompt,
        source: 'muse',
        model: allowOverride && body.model ? String(body.model) : undefined,
        reasoningEffort:
          allowOverride && validEfforts.has(rawEffort)
            ? (rawEffort as import('./store').ReasoningEffort)
            : undefined,
        repoPath: body.repoPath ? String(body.repoPath) : undefined,
        useWorktree: Boolean(body.useWorktree)
      });
      this.workflow.onTaskDispatched(task, prompt, 'muse');
      this.sendJson(res, 200, { task, workflow: this.workflow.getStatus() });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/tasks') {
      this.sendJson(res, 200, { tasks: this.runner.listTasks() });
      return;
    }

    const taskMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
    if (req.method === 'GET' && taskMatch) {
      const task = this.runner.getTask(taskMatch[1]);
      if (!task) {
        this.sendJson(res, 404, { error: 'Task not found' });
        return;
      }
      this.sendJson(res, 200, { task });
      return;
    }

    const cancelMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const ok = this.runner.cancel(cancelMatch[1]);
      this.sendJson(res, ok ? 200 : 404, { cancelled: ok });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/files/search') {
      const q = (parsed.searchParams.get('q') || '').trim().toLowerCase();
      const dirParam = (parsed.searchParams.get('dir') || '').trim();
      const roots = dirParam
        ? this.isPathAllowed(dirParam)
          ? [path.resolve(dirParam)]
          : []
        : this.getAllowedFileRoots();

      const results: Array<{ name: string; path: string; size: number; updatedAt: string }> = [];
      const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'release', '.next', '__pycache__', '.venv']);

      const walk = (dir: string, depth: number) => {
        if (depth > 4 || results.length >= 30) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          if (results.length >= 30) break;
          if (ent.name.startsWith('.') && ent.isDirectory()) continue;
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            if (!SKIP_DIRS.has(ent.name)) walk(full, depth + 1);
          } else if (ent.isFile()) {
            if (!this.isPathAllowed(full)) continue;
            if (!q || ent.name.toLowerCase().includes(q) || full.toLowerCase().includes(q)) {
              try {
                const st = fs.statSync(full);
                results.push({
                  name: ent.name,
                  path: full,
                  size: st.size,
                  updatedAt: st.mtime.toISOString()
                });
              } catch {
                // ignore
              }
            }
          }
        }
      };

      for (const r of roots) walk(r, 0);
      this.sendJson(res, 200, { roots, files: results });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/files/read') {
      const filePath = (parsed.searchParams.get('path') || '').trim();
      if (!filePath || !this.isPathAllowed(filePath)) {
        this.sendJson(res, 403, { error: 'Path is missing or outside allowed safe directories' });
        return;
      }
      try {
        const resolved = path.resolve(filePath);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
          this.sendJson(res, 404, { error: 'File not found' });
          return;
        }
        const st = fs.statSync(resolved);
        const maxBytes = 64 * 1024;
        const buf = fs.readFileSync(resolved);
        const truncated = buf.length > maxBytes;
        const content = buf.subarray(0, maxBytes).toString('utf-8');
        this.sendJson(res, 200, { path: resolved, size: st.size, truncated, content });
      } catch (err) {
        this.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/feishu/send') {
      const body = await this.readBody(req);
      const text = String(body.text || '').trim();
      const images: string[] = Array.isArray(body.images)
        ? body.images.map((x) => String(x || '').trim()).filter(Boolean)
        : body.image
          ? [String(body.image).trim()].filter(Boolean)
          : [];
      const files: string[] = Array.isArray(body.files)
        ? body.files.map((x) => String(x || '').trim()).filter(Boolean)
        : body.file
          ? [String(body.file).trim()].filter(Boolean)
          : [];
      const chatId = String(body.chatId || this.store.getState().feishu.lastChatId || '');
      if ((!text && images.length === 0 && files.length === 0) || !chatId) {
        this.sendJson(res, 400, { error: 'Missing text/images/files or verified Feishu chatId' });
        return;
      }
      const sent = text ? await this.feishu.sendText(chatId, text) : true;
      let imagesSent = 0;
      let filesSent = 0;
      const dirs = this.getAllowedFileRoots();
      for (const img of images.slice(0, 6)) {
        if (await this.feishu.sendImage(chatId, img, dirs)) {
          imagesSent += 1;
        }
      }
      for (const f of files.slice(0, 5)) {
        if (await this.feishu.sendFile(chatId, f, dirs)) {
          filesSent += 1;
        }
      }
      if (sent || imagesSent > 0 || filesSent > 0) {
        this.lastFeishuPushAt = Date.now();
      }
      this.sendJson(res, sent || imagesSent > 0 || filesSent > 0 ? 200 : 500, {
        sent,
        imagesSent,
        filesSent
      });
      return;
    }

    // Cloud Scout Research Notes API: Muse saves verified cloud web research into project .musedeck/research/
    if (req.method === 'GET' && pathname === '/api/v1/research') {
      const projectId = (parsed.searchParams.get('projectId') || '').trim();
      const all = this.store.getState().researchNotes || [];
      const notes = projectId ? all.filter((n) => n.projectId === projectId) : all;
      this.sendJson(res, 200, { notes });
      return;
    }

    if (req.method === 'POST' && (pathname === '/api/v1/research/save' || pathname === '/api/v1/research')) {
      const body = await this.readBody(req);
      const title = String(body.title || '').trim();
      const content = String(body.content ?? body.summary ?? '').trim();
      const summary = String(body.summary || content.slice(0, 280)).trim();
      if (!title || !content) {
        this.sendJson(res, 400, { error: 'Missing required fields: title and content/summary' });
        return;
      }
      const st = this.store.getState();
      const reqProjId = String(body.projectId || '').trim();
      const reqProjName = String(body.projectName || '').trim().toLowerCase();
      const proj =
        st.projects.find((p) => p.id === reqProjId) ||
        (reqProjName ? st.projects.find((p) => p.name.trim().toLowerCase() === reqProjName) : undefined) ||
        st.projects[0];

      const sources = Array.isArray(body.sources)
        ? body.sources.map((s) => String(s || '').trim()).filter(Boolean)
        : [];
      const now = new Date();
      const stamp = now
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, '')
        .replace('T', '-');
      const slug =
        title
          .toLowerCase()
          .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 36) || 'research';

      let baseDir = path.join(os.homedir(), '.musedeck-research');
      if (proj?.repoPath) {
        try {
          const candidate = path.resolve(proj.repoPath);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            baseDir = path.join(candidate, '.musedeck', 'research');
          }
        } catch {
          // fallback to home research dir
        }
      }
      fs.mkdirSync(baseDir, { recursive: true });
      const savedFilePath = path.join(baseDir, `${stamp}-${slug}.md`);
      const mdLines = [
        `# ${title}`,
        '',
        `- **调研时间**: ${now.toLocaleString('zh-CN')}`,
        proj ? `- **所属项目**: ${proj.name}` : '',
        sources.length > 0 ? `- **参考来源**:\n${sources.map((u) => `  - ${u}`).join('\n')}` : '',
        '',
        '## 核心摘要',
        summary,
        '',
        '## 详细云端调研内容',
        content,
        ''
      ].filter((line) => line !== '');
      fs.writeFileSync(savedFilePath, mdLines.join('\n'), 'utf-8');

      const note: ResearchNoteItem = {
        id: `res-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        projectId: proj?.id,
        projectName: proj?.name,
        title,
        summary: summary.slice(0, 360),
        sources,
        savedFilePath,
        createdAt: now.toISOString()
      };
      this.store.update((s) => {
        const list = Array.isArray(s.researchNotes) ? s.researchNotes : [];
        s.researchNotes = [note, ...list].slice(0, 100);
      });
      this.onStateChanged();
      this.sendJson(res, 200, { ok: true, savedFilePath, note });
      return;
    }

    // Open Questions Ledger API: tracks unresolved decisions for Muse proactive follow-ups
    if (req.method === 'GET' && pathname === '/api/v1/questions') {
      const statusFilter = (parsed.searchParams.get('status') || '').trim();
      const projectId = (parsed.searchParams.get('projectId') || '').trim();
      let list = this.store.getState().openQuestions || [];
      if (statusFilter === 'open' || statusFilter === 'resolved') {
        list = list.filter((q) => q.status === statusFilter);
      }
      if (projectId) {
        list = list.filter((q) => q.projectId === projectId);
      }
      this.sendJson(res, 200, { questions: list });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/questions') {
      const body = await this.readBody(req);
      const action = String(body.action || 'add').trim().toLowerCase();
      const nowIso = new Date().toISOString();
      const st = this.store.getState();

      if (action === 'resolve' || action === 'reopen' || action === 'delete') {
        const id = String(body.id || '').trim();
        if (!id) {
          this.sendJson(res, 400, { error: 'Missing required field: id' });
          return;
        }
        let target: OpenQuestionItem | undefined;
        this.store.update((s) => {
          const list = Array.isArray(s.openQuestions) ? s.openQuestions : [];
          if (action === 'delete') {
            s.openQuestions = list.filter((q) => q.id !== id);
          } else {
            target = list.find((q) => q.id === id);
            if (target) {
              target.status = action === 'resolve' ? 'resolved' : 'open';
              if (body.resolution !== undefined) {
                target.resolution = String(body.resolution || '').trim();
              }
              target.updatedAt = nowIso;
            }
            s.openQuestions = list;
          }
        });
        this.onStateChanged();
        this.sendJson(res, 200, { ok: true, question: target, questions: this.store.getState().openQuestions || [] });
        return;
      }

      const questionText = String(body.question || '').trim();
      if (!questionText) {
        this.sendJson(res, 400, { error: 'Missing required field: question' });
        return;
      }
      const reqProjId = String(body.projectId || '').trim();
      const reqProjName = String(body.projectName || '').trim();
      const matchedProj =
        st.projects.find((p) => p.id === reqProjId) ||
        (reqProjName
          ? st.projects.find((p) => p.name.trim().toLowerCase() === reqProjName.toLowerCase())
          : undefined);

      let savedItem!: OpenQuestionItem;
      this.store.update((s) => {
        const list = Array.isArray(s.openQuestions) ? s.openQuestions : [];
        const dup = list.find(
          (q) => q.status === 'open' && q.question.trim().toLowerCase() === questionText.toLowerCase()
        );
        if (dup) {
          if (body.context) dup.context = String(body.context).trim();
          if (Array.isArray(body.options)) {
            dup.options = body.options.map((o) => String(o || '').trim()).filter(Boolean);
          }
          dup.updatedAt = nowIso;
          savedItem = dup;
        } else {
          savedItem = {
            id: `q-${Date.now().toString(36).slice(-5)}`,
            projectId: matchedProj?.id || reqProjId || undefined,
            projectName: matchedProj?.name || reqProjName || undefined,
            question: questionText,
            context: body.context ? String(body.context).trim() : undefined,
            options: Array.isArray(body.options)
              ? body.options.map((o) => String(o || '').trim()).filter(Boolean)
              : undefined,
            status: 'open',
            source: body.source === 'user' || body.source === 'cli' ? body.source : 'muse',
            createdAt: nowIso,
            updatedAt: nowIso
          };
          list.unshift(savedItem);
        }
        s.openQuestions = list.slice(0, 100);
      });
      this.onStateChanged();
      this.sendJson(res, 200, { ok: true, question: savedItem });
      return;
    }

    // Explicit Proactive Thought Push API from Muse
    if (req.method === 'POST' && pathname === '/api/v1/proactive/push') {
      const body = await this.readBody(req);
      const text = String(body.text || body.message || '').trim();
      if (!text) {
        this.sendJson(res, 400, { error: 'Missing required field: text' });
        return;
      }
      const questionId = body.questionId ? String(body.questionId).trim() : undefined;
      const options = Array.isArray(body.options)
        ? body.options.map((o) => String(o || '').trim()).filter(Boolean)
        : undefined;
      if (questionId) {
        this.store.update((s) => {
          const q = (s.openQuestions || []).find((item) => item.id === questionId);
          if (q) q.lastAskedAt = new Date().toISOString();
        });
      }
      this.onProactivePush?.({ text, questionId, options });
      this.sendJson(res, 200, {
        ok: true,
        quietHoursActive: isWithinQuietHours(this.store.getState().workflow)
      });
      return;
    }

    // Local-IP Controlled Browser API (with automatic local privacy redaction shield)
    if (this.localBrowser && pathname.startsWith('/api/v1/browser/')) {
      try {
        if (req.method === 'GET' && pathname === '/api/v1/browser/status') {
          this.sendJson(res, 200, this.localBrowser.getStatus());
          return;
        }
        if (req.method === 'GET' && pathname === '/api/v1/browser/snapshot') {
          const target = parsed.searchParams.get('target') === 'feishu' ? 'feishu' : 'default';
          const snap = await this.localBrowser.snapshot(target);
          this.sendJson(res, 200, snap);
          return;
        }
        if (req.method === 'POST' && pathname === '/api/v1/browser/open') {
          const body = await this.readBody(req);
          const url = String(body.url || '').trim();
          if (!url) {
            this.sendJson(res, 400, { error: 'Missing required field: url' });
            return;
          }
          const target = body.target === 'feishu' ? 'feishu' : undefined;
          const snap = await this.localBrowser.openUrl(
            url,
            typeof body.waitMs === 'number' ? body.waitMs : 1800,
            target
          );
          this.sendJson(res, 200, { ok: true, snapshot: snap });
          return;
        }
        if (req.method === 'POST' && pathname === '/api/v1/browser/act') {
          const body = await this.readBody(req);
          const actType = String(body.action || 'click').toLowerCase();
          if (actType !== 'click' && actType !== 'fill' && actType !== 'press' && actType !== 'scroll') {
            this.sendJson(res, 400, { error: 'Invalid action; expected click, fill, press, or scroll' });
            return;
          }
          const result = await this.localBrowser.act({
            action: actType,
            target: body.target === 'feishu' ? 'feishu' : undefined,
            targetId: body.targetId ? String(body.targetId) : undefined,
            text: body.text !== undefined ? String(body.text) : undefined,
            key: body.key ? String(body.key) : undefined,
            direction:
              body.direction === 'up' || body.direction === 'top' || body.direction === 'bottom'
                ? body.direction
                : 'down'
          });
          this.sendJson(res, 200, result);
          return;
        }
        if (req.method === 'POST' && pathname === '/api/v1/browser/feishu-assist') {
          const body = await this.readBody(req);
          const opRaw = String(body.op || 'status').trim();
          const validOps = new Set([
            'status',
            'create_or_enter_app',
            'add_bot_capability',
            'fill_permission_json',
            'sync_local_bridge',
            'configure_events',
            'prepare_version'
          ]);
          if (!validOps.has(opRaw)) {
            this.sendJson(res, 400, {
              error:
                'Invalid op; expected status, create_or_enter_app, add_bot_capability, fill_permission_json, sync_local_bridge, configure_events, or prepare_version'
            });
            return;
          }
          const result = await this.localBrowser.feishuAssist(
            opRaw as
              | 'status'
              | 'create_or_enter_app'
              | 'add_bot_capability'
              | 'fill_permission_json'
              | 'sync_local_bridge'
              | 'configure_events'
              | 'prepare_version',
            {
              botName: body.botName ? String(body.botName) : undefined,
              botDesc: body.botDesc ? String(body.botDesc) : undefined
            }
          );
          this.sendJson(res, 200, result);
          return;
        }
      } catch (err) {
        this.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
    }

    this.sendJson(res, 404, { error: `Unknown endpoint: ${pathname}` });
  }
}
