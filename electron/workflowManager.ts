import { DispatchRequest, RunningTaskInfo } from './cliRunner';
import { QuotaManager } from './quotaManager';
import { FmcStore, WorkflowConfig } from './store';

export type WorkflowPhase =
  | 'idle'
  | 'awaiting_project_approval'
  | 'awaiting_plan_approval'
  | 'running'
  | 'reviewing'
  | 'awaiting_user'
  | 'paused_quota'
  | 'paused_budget'
  | 'completed';

export interface PendingProjectProposal {
  action: 'use_existing' | 'create_new';
  projectName: string;
  projectId?: string;
  description?: string;
  repoPath?: string;
  reason?: string;
}

export interface WorkflowRunState {
  id: string;
  phase: WorkflowPhase;
  goal: string;
  round: number;
  maxRounds: number;
  tokensUsed: number;
  tokenBudget: number;
  consecutiveStalls: number;
  activeTaskIds: string[];
  completedTaskCount: number;
  pendingProjectProposal?: PendingProjectProposal;
  projectApproved?: boolean;
  approvedProjectName?: string;
  pendingPlan?: string;
  planApproved?: boolean;
  lastSummary?: string;
  pauseReason?: string;
  quotaRetryAt?: string;
  lastHandoffFrom?: string;
  updatedAt: string;
}

interface CompletedBatchItem {
  taskId: string;
  projectId: string;
  agentId: string;
  model: string;
  status: 'done' | 'error' | 'cancelled';
  cleanOutput: string;
  diffStat?: string;
  cwd?: string;
  prompt: string;
  quotaExhausted?: boolean;
  quotaReason?: string;
  quotaRetryAfterMs?: number;
  tokens: number;
}

interface PendingQuotaResumeTask {
  projectId: string;
  agentId: string;
  model?: string;
  prompt: string;
  repoPath?: string;
}

export function extractTokensFromOutput(prompt: string, output: string): number {
  const normalized = (output || '').replace(/\r\n/g, '\n');
  const codexMatch = normalized.match(/tokens used\s*\n\s*([\d,]+)/i);
  if (codexMatch) {
    const n = Number(codexMatch[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  const genericMatch = normalized.match(/total[_ ]tokens["']?\s*[:=]\s*([\d,]+)/i);
  if (genericMatch) {
    const n = Number(genericMatch[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  const chars = (prompt || '').length + normalized.length;
  return Math.max(100, Math.round(chars / 3));
}

function cleanBriefOutput(raw: string): string {
  const normalized = (raw || '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  const afterTokens = normalized.match(/\ntokens used\n[\d,]+\s*\n([\s\S]+)$/i);
  const body = afterTokens?.[1]?.trim() || normalized;
  return body.length > 1800 ? `${body.slice(0, 1800)}\n...(已截断，完整内容见 MuseDeck 桌面端)` : body;
}

export class WorkflowManager {
  private store: FmcStore;
  private onStatus: (status: WorkflowRunState) => void;
  private wakeMuse: (text: string) => Promise<{ ok: boolean; message: string }>;
  private notifyFeishu: (text: string) => Promise<boolean>;
  private quotas?: QuotaManager;
  private redispatchTask?: (req: DispatchRequest) => Promise<RunningTaskInfo>;

  private run: WorkflowRunState;
  private batchResults: CompletedBatchItem[] = [];
  private taskPrompts = new Map<string, string>();
  private batchTimer: NodeJS.Timeout | null = null;
  private quotaResumeTimer: NodeJS.Timeout | null = null;
  private quotaRetryCount = 0;
  private pendingQuotaTasks: PendingQuotaResumeTask[] = [];

  constructor(
    store: FmcStore,
    onStatus: (status: WorkflowRunState) => void,
    wakeMuse: (text: string) => Promise<{ ok: boolean; message: string }>,
    notifyFeishu: (text: string) => Promise<boolean>
  ) {
    this.store = store;
    this.onStatus = onStatus;
    this.wakeMuse = wakeMuse;
    this.notifyFeishu = notifyFeishu;
    this.run = this.createIdleRun();
  }

  attachQuotaServices(
    quotas: QuotaManager,
    redispatchTask: (req: DispatchRequest) => Promise<RunningTaskInfo>
  ): void {
    this.quotas = quotas;
    this.redispatchTask = redispatchTask;
  }

  private clearTimers(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.quotaResumeTimer) {
      clearTimeout(this.quotaResumeTimer);
      this.quotaResumeTimer = null;
    }
  }

  private getConfig(): WorkflowConfig {
    return (
      this.store.getState().workflow || {
        reviewMode: 'muse_review',
        maxAutoRounds: 3,
        tokenBudget: 150000,
        stallLimit: 2,
        autoWakeMuse: true
      }
    );
  }

  private createIdleRun(): WorkflowRunState {
    const cfg = this.getConfig();
    return {
      id: `wf-${Date.now()}`,
      phase: 'idle',
      goal: '',
      round: 0,
      maxRounds: cfg.maxAutoRounds,
      tokensUsed: 0,
      tokenBudget: cfg.tokenBudget,
      consecutiveStalls: 0,
      activeTaskIds: [],
      completedTaskCount: 0,
      updatedAt: new Date().toISOString()
    };
  }

  private emit(): void {
    this.run.updatedAt = new Date().toISOString();
    this.onStatus({ ...this.run, activeTaskIds: [...this.run.activeTaskIds] });
  }

  getStatus(): WorkflowRunState {
    const cfg = this.getConfig();
    this.run.maxRounds = cfg.maxAutoRounds;
    if (this.run.phase === 'idle') {
      this.run.tokenBudget = cfg.tokenBudget;
    }
    return { ...this.run, activeTaskIds: [...this.run.activeTaskIds] };
  }

  /** Called when a user sends a new high-level requirement to Muse (desktop or Feishu) */
  startNewGoal(goal: string): void {
    const cfg = this.getConfig();
    this.clearTimers();
    this.batchResults = [];
    this.pendingQuotaTasks = [];
    this.quotaRetryCount = 0;
    const approvalMode = cfg.planApprovalMode || 'adaptive';
    this.run = {
      id: `wf-${Date.now()}`,
      phase: 'awaiting_project_approval',
      goal: goal.slice(0, 200),
      round: 0,
      maxRounds: cfg.maxAutoRounds,
      tokensUsed: 0,
      tokenBudget: cfg.tokenBudget,
      consecutiveStalls: 0,
      activeTaskIds: [],
      completedTaskCount: 0,
      pendingProjectProposal: undefined,
      projectApproved: false,
      approvedProjectName: undefined,
      pendingPlan: undefined,
      planApproved: approvalMode === 'never',
      updatedAt: new Date().toISOString()
    };
    this.emit();
  }

  /** Guardrail check before Muse dispatches a local CLI task */
  checkCanDispatch(): { allowed: boolean; statusCode: number; reason?: string } {
    const cfg = this.getConfig();
    this.run.maxRounds = cfg.maxAutoRounds;
    const approvalMode = cfg.planApprovalMode || 'adaptive';

    if (this.run.phase === 'awaiting_project_approval' && !this.run.projectApproved) {
      return {
        allowed: false,
        statusCode: 409,
        reason:
          '当前任务正在等待用户确认【项目归属】。请先调用 POST /api/v1/workflow/propose-project 询问用户将本次任务放入哪个已有项目或新建项目，获批后再继续制定执行方案与派单。'
      };
    }

    if (
      (approvalMode === 'always' && !this.run.planApproved) ||
      (this.run.phase === 'awaiting_plan_approval' && !this.run.planApproved)
    ) {
      return {
        allowed: false,
        statusCode: 409,
        reason:
          '当前任务正在等待用户批准执行方案。请先调用 POST /api/v1/workflow/propose-plan 向用户汇报职能分工、模型配置、审阅标准与预计预算，等用户批准后再派单执行。'
      };
    }

    if (this.run.phase === 'paused_budget') {
      return {
        allowed: false,
        statusCode: 402,
        reason: this.run.pauseReason || '当前工作流已因预算或熔断暂停，请等待用户确认或追加预算。'
      };
    }

    if (this.run.tokenBudget > 0 && this.run.tokensUsed >= this.run.tokenBudget) {
      this.triggerPause(
        `已达到单次需求 Token 预算上限（${Math.round(this.run.tokensUsed / 1000)}k / ${Math.round(this.run.tokenBudget / 1000)}k）`
      );
      return {
        allowed: false,
        statusCode: 402,
        reason: this.run.pauseReason
      };
    }

    if (
      this.run.activeTaskIds.length === 0 &&
      cfg.maxAutoRounds > 0 &&
      this.run.round >= cfg.maxAutoRounds
    ) {
      this.run.phase = 'awaiting_user';
      this.run.pauseReason = `已达到最大自动迭代轮次（${this.run.round}/${cfg.maxAutoRounds}），请向用户凝练汇报并等待验收。`;
      this.emit();
      return {
        allowed: false,
        statusCode: 429,
        reason: this.run.pauseReason
      };
    }

    return { allowed: true, statusCode: 200 };
  }

  onTaskDispatched(task: RunningTaskInfo, prompt: string, source: 'user' | 'muse' | 'feishu'): void {
    if (source !== 'muse') return;
    this.clearTimers();
    this.run.quotaRetryAt = undefined;
    const cfg = this.getConfig();
    if (this.run.phase === 'idle' || this.run.phase === 'completed' || this.run.phase === 'awaiting_user') {
      this.run = {
        ...this.createIdleRun(),
        phase: 'running',
        goal: prompt.slice(0, 160),
        round: 1,
        tokenBudget: cfg.tokenBudget
      };
      this.batchResults = [];
    } else if (this.run.activeTaskIds.length === 0) {
      this.run.round += 1;
      this.run.phase = 'running';
      this.run.pauseReason = undefined;
      this.batchResults = [];
    }

    this.run.activeTaskIds.push(task.taskId);
    this.taskPrompts.set(task.taskId, prompt);
    this.emit();
  }

  onTaskFinished(task: RunningTaskInfo): void {
    const idx = this.run.activeTaskIds.indexOf(task.taskId);
    if (idx === -1) return;

    this.run.activeTaskIds.splice(idx, 1);
    const prompt = this.taskPrompts.get(task.taskId) || task.prompt || '';
    this.taskPrompts.delete(task.taskId);

    if (task.status === 'done') {
      this.quotas?.clearRuntimeExhausted(task.agentId);
      this.quotaRetryCount = 0;
    }

    const tokens = extractTokensFromOutput(prompt, task.output);
    this.run.tokensUsed += tokens;
    this.run.completedTaskCount += 1;

    this.batchResults.push({
      taskId: task.taskId,
      projectId: task.projectId,
      agentId: task.agentId,
      model: task.model,
      status: task.status === 'running' ? 'done' : task.status,
      cleanOutput: cleanBriefOutput(task.output),
      diffStat: task.diffStat,
      cwd: task.cwd || task.worktreePath,
      prompt,
      quotaExhausted: task.quotaExhausted,
      quotaReason: task.quotaReason,
      quotaRetryAfterMs: task.quotaRetryAfterMs,
      tokens
    });

    this.emit();

    if (this.run.activeTaskIds.length === 0) {
      if (this.batchTimer) clearTimeout(this.batchTimer);
      this.batchTimer = setTimeout(() => {
        void this.handleBatchCompleted();
      }, 2500);
    }
  }

  private triggerPause(reason: string): void {
    this.clearTimers();
    this.run.phase = 'paused_budget';
    this.run.quotaRetryAt = undefined;
    this.run.pauseReason = reason;
    this.emit();
    void this.notifyFeishu(
      `⚠️ 【MuseDeck 工作流已自动暂停】\n原因：${reason}\n已完成子任务：${this.run.completedTaskCount} 个，累计消耗约 ${Math.round(this.run.tokensUsed / 1000)}k tokens。\n请在桌面端点击继续或直接回复修改意见。`
    );
  }

  /** Immediately resume tasks that were waiting for quota cooldown */
  async retryQuotaNow(): Promise<WorkflowRunState> {
    if (this.quotaResumeTimer) {
      clearTimeout(this.quotaResumeTimer);
      this.quotaResumeTimer = null;
    }
    this.run.quotaRetryAt = undefined;
    this.run.pauseReason = undefined;

    const tasksToRun = [...this.pendingQuotaTasks];
    this.pendingQuotaTasks = [];

    if (tasksToRun.length > 0 && this.redispatchTask) {
      this.run.phase = 'running';
      this.emit();
      for (const item of tasksToRun) {
        this.quotas?.clearRuntimeExhausted(item.agentId);
        const resumedPrompt = `【额度恢复自动续跑】请检查当前工作区已有代码改动，直接接着完成未竟任务（无需重复已完成部分）：\n\n${item.prompt}`;
        const dispatched = await this.redispatchTask({
          projectId: item.projectId,
          agentId: item.agentId,
          model: item.model || undefined,
          prompt: resumedPrompt,
          source: 'muse',
          repoPath: item.repoPath,
          useWorktree: false
        });
        this.onTaskDispatched(dispatched, resumedPrompt, 'muse');
      }
      return this.getStatus();
    }

    this.run.phase = 'reviewing';
    this.emit();
    await this.wakeMuse(
      '【额度冷却结束 · 请继续推进任务】用户或自动定时器已触发续跑，请检查当前工作流进度并继续派单完成剩余任务。'
    );
    return this.getStatus();
  }

  private async handleBatchCompleted(): Promise<void> {
    this.batchTimer = null;
    if (this.run.activeTaskIds.length > 0 || this.batchResults.length === 0) return;

    const cfg = this.getConfig();
    const results = [...this.batchResults];
    this.batchResults = [];

    // ==================== QUOTA EXHAUSTION SEAMLESS HANDOFF & AUTO-RESUME ====================
    const quotaHitItems = results.filter((r) => r.status === 'error' && r.quotaExhausted);
    if (quotaHitItems.length > 0) {
      for (const q of quotaHitItems) {
        this.quotas?.markRuntimeExhausted(
          q.agentId,
          q.quotaReason || 'CLI 额度或速率达到上限',
          q.quotaRetryAfterMs || 30 * 60_000
        );
      }
      // Do NOT penalize round count or stall breaker when hitting provider quota limits!
      this.run.round = Math.max(0, this.run.round - 1);

      const st = this.store.getState();
      const targetProj =
        st.projects.find((p) => p.id === quotaHitItems[0].projectId) || st.projects[0];
      const exhaustedSet = new Set(quotaHitItems.map((q) => q.agentId));
      const backupClis = Object.entries(st.cliConfigs || {})
        .filter(([id, c]) => {
          if (!c.enabled || exhaustedSet.has(id)) return false;
          if (this.quotas?.isRuntimeExhausted(id)) return false;
          if (
            targetProj?.allowedClis &&
            targetProj.allowedClis.length > 0 &&
            !targetProj.allowedClis.includes(id)
          ) {
            return false;
          }
          return true;
        })
        .map(([id, c]) => ({
          id,
          defaultModel: c.defaultModel || 'default',
          weight: c.weight ?? 4
        }))
        .sort((a, b) => b.weight - a.weight);

      const exhaustedNames = Array.from(exhaustedSet).join(', ');

      // Case A: Healthy backup CLI(s) available -> Instant Seamless Cross-CLI Handoff via Muse!
      if (backupClis.length > 0 && cfg.autoWakeMuse) {
        this.run.projectApproved = true;
        this.run.planApproved = true;
        this.run.phase = 'reviewing';
        this.run.lastHandoffFrom = exhaustedNames;
        this.run.pauseReason = `检测到 ${exhaustedNames} 额度触顶，正在自动移交 ${backupClis.map((b) => b.id).join('/')} 接力`;
        this.emit();

        void this.notifyFeishu(
          `⚡ 【额度触顶 · 自动无缝接力】\n检测到 [${exhaustedNames}] 触发额度/速率上限（${quotaHitItems[0].quotaReason || 'Usage limit'}）。\nMuseDeck 已自动唤醒 Muse 将同一工作区无缝移交给备选工具 [${backupClis.map((b) => b.id).join(' / ')}] 接力完成，无需你手动干预！`
        );

        const handoffDetails = quotaHitItems
          .map((q, i) => {
            const diffInfo = q.diffStat ? `\n- 已产生的半成品改动 (Git Status/Diff):\n${q.diffStat}` : '\n- 当前尚未产生代码改动，可直接从头实现';
            return `### 待接力子任务 ${i + 1}
- 原执行 CLI: \`${q.agentId}\`（因限额中断：${q.quotaReason || 'rate/usage limit'}）
- 所属项目: 《${targetProj?.name || '默认总控台'}》 (projectId: \`${q.projectId}\`)
- 接力工作目录 (repoPath): \`${q.cwd || targetProj?.repoPath || ''}\`${diffInfo}
- 原任务指令:\n${q.prompt}`;
          })
          .join('\n\n');

        const handoffPrompt = `【⚡ CLI 额度触顶 · 自动跨工具无缝接力】
刚刚执行的 \`${exhaustedNames}\` 触发了额度/速率限制，已被本地临时标记为冷却状态。
当前工作流已保持 \`planApproved = true\`，**请勿重复询问用户审批**！

【当前健康可用的备选 CLI（已按用户优先级排序）】
${backupClis.map((b) => `- \`${b.id}\` (默认模型: \`${b.defaultModel}\`)`).join('\n')}

${handoffDetails}

【无缝接力要求】
请立即从上述健康备选 CLI 中挑选最合适的一个，调用 \`POST /api/v1/dispatch\`：
1. 传入上面给出的相同 \`repoPath\`，并将 \`useWorktree\` 设为 \`false\`（直接在原工作区/分支上检查已有进展并接着完成剩余工作！）；
2. 在 \`prompt\` 中提醒接力 CLI 先查看当前目录已有改动，衔接完成未竟部分。`;

        await this.wakeMuse(handoffPrompt);
        return;
      }

      // Case B: Single-CLI user (no other enabled healthy CLI) -> Smart Cooldown Wait & Auto-Resume!
      if (this.quotaRetryCount < 3) {
        this.quotaRetryCount += 1;
        const delayMs =
          quotaHitItems[0].quotaRetryAfterMs ||
          (this.quotaRetryCount === 1 ? 2 * 60_000 : 15 * 60_000);
        const waitMin = Math.max(1, Math.round(delayMs / 60_000));
        this.pendingQuotaTasks = quotaHitItems.map((q) => ({
          projectId: q.projectId,
          agentId: q.agentId,
          model: q.model,
          prompt: q.prompt,
          repoPath: q.cwd
        }));
        this.run.phase = 'paused_quota';
        this.run.quotaRetryAt = new Date(Date.now() + delayMs).toISOString();
        this.run.pauseReason = `[${exhaustedNames}] 额度触顶，约 ${waitMin} 分钟后自动续跑（第 ${this.quotaRetryCount}/3 次）`;
        this.emit();

        if (this.quotaResumeTimer) clearTimeout(this.quotaResumeTimer);
        this.quotaResumeTimer = setTimeout(() => {
          void this.retryQuotaNow();
        }, delayMs);

        void this.notifyFeishu(
          `⏳ 【额度冷却等待 · 到点自动续跑】\n[${exhaustedNames}] 暂时触发限额（${quotaHitItems[0].quotaReason || 'Usage limit'}），当前未启用其他备选 CLI。\n系统将在约 ${waitMin} 分钟后自动在同一工作区续跑（第 ${this.quotaRetryCount}/3 次）；你也可开启其他 CLI，或回复「继续」立即重试。`
        );
        return;
      }

      this.triggerPause(
        `[${exhaustedNames}] 连续 3 次冷却等待后额度仍未恢复；请在 CLI 管理页启用备选工具接力，或等额度重置后点击「立即续跑」`
      );
      return;
    }

    // ==================== NORMAL BATCH COMPLETION ====================
    const allFailed = results.every((r) => r.status === 'error');
    if (allFailed) {
      this.run.consecutiveStalls += 1;
    } else {
      this.run.consecutiveStalls = 0;
    }

    if (this.run.tokenBudget > 0 && this.run.tokensUsed >= this.run.tokenBudget) {
      this.triggerPause(
        `单次需求 Token 消耗已达预算阈值（${Math.round(this.run.tokensUsed / 1000)}k / ${Math.round(this.run.tokenBudget / 1000)}k）`
      );
      return;
    }

    if (cfg.stallLimit > 0 && this.run.consecutiveStalls >= cfg.stallLimit) {
      this.triggerPause(`连续 ${this.run.consecutiveStalls} 轮子任务执行出错，已触发防空转熔断`);
      return;
    }

    if (!cfg.autoWakeMuse) {
      this.run.phase = 'awaiting_user';
      this.emit();
      return;
    }

    this.run.phase = 'reviewing';
    this.emit();

    const budgetRatio =
      this.run.tokenBudget > 0 ? Math.round((this.run.tokensUsed / this.run.tokenBudget) * 100) : 0;
    const reachedMaxRounds = cfg.maxAutoRounds > 0 && this.run.round >= cfg.maxAutoRounds;

    const taskSummaries = results
      .map((r, i) => {
        const diffPart = r.diffStat ? `\n[Git Diff]\n${r.diffStat}` : '';
        return `### 子任务 ${i + 1}: ${r.agentId} (${r.model}) — 状态: ${r.status} | 约 ${Math.round(r.tokens / 1000)}k tokens\n${r.cleanOutput}${diffPart}`;
      })
      .join('\n\n');

    let nextInstruction = '';
    if (reachedMaxRounds) {
      nextInstruction =
        '⚠️ 已达到本轮最大自动迭代上限，请【不要再派发新任务】，立即凝练以上成果并调用 POST /api/v1/workflow/ask-user 向用户汇报并询问是否满意。';
    } else if (cfg.reviewMode === 'direct_user') {
      nextInstruction =
        '当前策略为【跑完直接凝练问用户】：请勿自动返工，直接把上述结果凝练成清晰结论，并调用 POST /api/v1/workflow/ask-user 向用户汇报并询问是否满意。';
    } else if (cfg.reviewMode === 'auto_sprint') {
      nextInstruction =
        '当前策略为【自动闭环冲刺】：请严格审阅上述结果与 Diff；若未完全达标则继续拆单修复（【递进式升档省预算】：若因难度高或理解不足导致不满意，下一轮派单时可在 dispatch 中针对性调高 model 或把 reasoningEffort 升档至 high/xhigh），若已完全验收通过则调用 POST /api/v1/workflow/ask-user 向用户汇报。';
    } else {
      nextInstruction =
        '当前策略为【Muse 先审阅再问用户】：请先审阅上述结果与代码 Diff；若发现明显缺陷或报错可直接打回对应 CLI 修复（【递进式升档省预算】：若本轮用常规/低档模型不达标，返工时可针对性调高 model 或 reasoningEffort 到 high/xhigh）；若审阅无误，请凝练要点并调用 POST /api/v1/workflow/ask-user 向用户汇报并询问是否满意。';
    }

    const budgetWarning =
      budgetRatio >= 75
        ? `\n⚠️ 预算提醒：当前已消耗 ${budgetRatio}% 预算，请尽量精简上下文并尽快收尾。`
        : '';

    const wakeupPrompt = `【FMC 工作流自动回执 · 第 ${this.run.round}/${cfg.maxAutoRounds} 轮完成】
累计消耗：约 ${Math.round(this.run.tokensUsed / 1000)}k / ${this.run.tokenBudget > 0 ? `${Math.round(this.run.tokenBudget / 1000)}k` : '不限'} tokens${budgetWarning}

${taskSummaries}

【下一步指令】
${nextInstruction}`;

    await this.wakeMuse(wakeupPrompt);
  }

  /** Stage 1: Called by Muse via POST /api/v1/workflow/propose-project before plan & dispatch */
  async proposeProject(
    proposal: PendingProjectProposal,
    sendToFeishu = true
  ): Promise<boolean> {
    this.run.phase = 'awaiting_project_approval';
    this.run.pendingProjectProposal = proposal;
    this.run.projectApproved = false;
    this.run.pauseReason = undefined;
    this.emit();

    if (sendToFeishu) {
      const actionLine =
        proposal.action === 'create_new'
          ? `此次任务建议**新建项目**：《${proposal.projectName}》`
          : `此次任务适合放在当前已有项目：《${proposal.projectName}》`;
      const extraLines = [
        proposal.description ? `项目简介：${proposal.description}` : '',
        proposal.repoPath ? `本地目录：${proposal.repoPath}` : '',
        proposal.reason ? `归类理由：${proposal.reason}` : ''
      ]
        .filter(Boolean)
        .join('\n');
      const msg = `📁 【项目归属确认 · 待你批准】\n${actionLine}${extraLines ? `\n${extraLines}` : ''}\n\n👉 回复「批准 / 同意 / 可以」即确认项目归属并进入下一步任务方案确认，或直接回复想归入/新建的项目名。`;
      return this.notifyFeishu(msg);
    }
    return true;
  }

  async approveProject(onProjectsChanged?: () => void): Promise<WorkflowRunState> {
    const prop = this.run.pendingProjectProposal;
    const cfg = this.getConfig();
    const approvalMode = cfg.planApprovalMode || 'adaptive';
    let targetProj = this.store.getState().projects[0];

    if (prop) {
      if (prop.action === 'create_new' && prop.projectName.trim()) {
        targetProj = this.store.addProject({
          name: prop.projectName.trim(),
          description: prop.description || '',
          repoPath: prop.repoPath || '',
          createdBy: 'muse'
        });
        onProjectsChanged?.();
      } else {
        const matched =
          this.store.getState().projects.find(
            (p) =>
              (prop.projectId && p.id === prop.projectId) ||
              p.name.trim().toLowerCase() === prop.projectName.trim().toLowerCase()
          ) || this.store.getState().projects[0];
        targetProj = matched;
      }
    }

    this.run.projectApproved = true;
    this.run.approvedProjectName = targetProj?.name || prop?.projectName || '默认总控台';
    this.run.phase = approvalMode === 'never' ? 'running' : 'awaiting_plan_approval';
    this.run.pauseReason = undefined;
    this.emit();

    const nextStep =
      approvalMode === 'never'
        ? `当前为直接执行模式，请立即向项目《${this.run.approvedProjectName}》(projectId: ${targetProj?.id || 'proj-default'}) 派单执行。`
        : `现在请制定本次任务的执行方案（务必在方案中再次写明「所属项目：《${this.run.approvedProjectName}》」，并列出各 CLI 职能分工、模型与审阅要求），调用 POST /api/v1/workflow/propose-plan 发给用户做最终确认。`;

    await this.wakeMuse(
      `【用户已批准项目归属】本次任务已确定归属项目：《${this.run.approvedProjectName}》（projectId: ${targetProj?.id || 'proj-default'}）。\n${nextStep}`
    );
    return this.getStatus();
  }

  async reviseProjectFeedback(feedback: string): Promise<WorkflowRunState> {
    this.run.projectApproved = false;
    this.run.phase = 'awaiting_project_approval';
    this.emit();
    await this.wakeMuse(
      `【用户对项目归属提出修改】\n「${feedback}」\n请按用户的要求调整归属项目（放进已有项目或改名新建），再次调用 POST /api/v1/workflow/propose-project 请用户确认。`
    );
    return this.getStatus();
  }

  /** Stage 2: Called by Muse via POST /api/v1/workflow/propose-plan before dispatching tasks */
  async proposePlan(plan: string, sendToFeishu = true): Promise<boolean> {
    this.run.phase = 'awaiting_plan_approval';
    this.run.pendingPlan = plan;
    this.run.planApproved = false;
    this.run.pauseReason = undefined;
    this.emit();

    if (sendToFeishu) {
      const msg = `📝 【Muse 执行方案确认 · 待你批准】\n${plan}\n\n👉 回复「批准 / 开始 / 可以」即正式开工，或直接回复修改意见调整分工与审阅要求。`;
      return this.notifyFeishu(msg);
    }
    return true;
  }

  async approvePlan(): Promise<WorkflowRunState> {
    this.run.projectApproved = true;
    this.run.planApproved = true;
    this.run.phase = 'running';
    this.run.pauseReason = undefined;
    this.emit();
    await this.wakeMuse(
      '【用户已批准执行方案】请立即按照已批准的职能分工、模型配置与审阅要求开始派单执行。'
    );
    return this.getStatus();
  }

  markApprovedSilently(stage: 'project' | 'plan', onProjectsChanged?: () => void): WorkflowRunState {
    if (stage === 'project' || !this.run.projectApproved) {
      const prop = this.run.pendingProjectProposal;
      if (prop && prop.action === 'create_new' && prop.projectName.trim()) {
        const created = this.store.addProject({
          name: prop.projectName.trim(),
          description: prop.description || '',
          repoPath: prop.repoPath || '',
          createdBy: 'muse'
        });
        this.run.approvedProjectName = created.name;
        onProjectsChanged?.();
      }
      this.run.projectApproved = true;
      if (stage === 'project') {
        const cfg = this.getConfig();
        this.run.phase = (cfg.planApprovalMode || 'adaptive') === 'never' ? 'running' : 'awaiting_plan_approval';
      }
    }
    if (stage === 'plan') {
      this.run.projectApproved = true;
      this.run.planApproved = true;
      this.run.phase = 'running';
      this.run.pauseReason = undefined;
    }
    this.emit();
    return this.getStatus();
  }

  async revisePlanFeedback(feedback: string): Promise<WorkflowRunState> {
    this.run.planApproved = false;
    this.run.phase = 'awaiting_plan_approval';
    this.emit();
    await this.wakeMuse(
      `【用户对执行方案提出修改意见】\n「${feedback}」\n请按用户要求调整职能分工或审阅设置，并再次调用 POST /api/v1/workflow/propose-plan 请用户确认。若其中包含用户的长期偏好/习惯，请顺手调用 POST /api/v1/workflow/habits 记住。`
    );
    return this.getStatus();
  }

  async markAwaitingUser(summary: string, sendToFeishu = true): Promise<boolean> {
    this.run.phase = 'awaiting_user';
    this.run.lastSummary = summary;
    this.run.pauseReason = undefined;
    this.emit();

    if (sendToFeishu) {
      const msg = `📋 【Muse 审阅完成 · 请验收】\n${summary}\n\n（累计 ${this.run.round} 轮 · 约 ${Math.round(this.run.tokensUsed / 1000)}k tokens）\n👉 直接回复「满意」结项，或回复修改意见继续迭代。`;
      return this.notifyFeishu(msg);
    }
    return true;
  }

  approveByUser(): WorkflowRunState {
    this.clearTimers();
    this.run.phase = 'completed';
    this.run.pauseReason = undefined;
    this.emit();
    return this.getStatus();
  }

  async addBudgetAndResume(extraTokens = 100000): Promise<WorkflowRunState> {
    this.clearTimers();
    this.run.tokenBudget = Math.max(this.run.tokensUsed, this.run.tokenBudget) + extraTokens;
    this.run.consecutiveStalls = 0;
    this.run.pauseReason = undefined;
    this.run.phase = 'reviewing';
    this.emit();
    await this.wakeMuse(
      `【MuseDeck 通知】用户已追加 +${Math.round(extraTokens / 1000)}k tokens 预算（新上限 ${Math.round(this.run.tokenBudget / 1000)}k），工作流已解除暂停，请继续推进未完成的任务。`
    );
    return this.getStatus();
  }

  async sendUserFeedback(feedback: string): Promise<WorkflowRunState> {
    if (this.run.phase === 'paused_quota' && /^(继续|重试|续跑|retry|continue)$/i.test(feedback.trim())) {
      return this.retryQuotaNow();
    }
    this.clearTimers();
    this.run.round = 0;
    this.run.consecutiveStalls = 0;
    this.run.pauseReason = undefined;
    this.run.phase = 'running';
    this.emit();
    await this.wakeMuse(
      `【用户验收反馈】${feedback}\n请根据用户反馈继续调度合适的本地 CLI 修改，并在完成后再次汇报验收。`
    );
    return this.getStatus();
  }

  reset(): WorkflowRunState {
    this.clearTimers();
    this.batchResults = [];
    this.pendingQuotaTasks = [];
    this.quotaRetryCount = 0;
    this.run = this.createIdleRun();
    this.emit();
    return this.getStatus();
  }
}
