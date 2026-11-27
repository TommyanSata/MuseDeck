import { ChildProcess, execFile, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { CLI_REGISTRY, defaultProtocolForCli, locateCommand, resolveProtocolEndpoints } from './cliScanner';
import { AggregatedMessage, FmcStore } from './store';

const execFileAsync = promisify(execFile);

export interface DispatchRequest {
  projectId: string;
  sessionId?: string;
  agentId: string;
  prompt: string;
  source: 'user' | 'muse' | 'feishu';
  model?: string;
  reasoningEffort?: import('./store').ReasoningEffort;
  repoPath?: string;
  useWorktree?: boolean;
}

export interface RunningTaskInfo {
  taskId: string;
  projectId: string;
  agentId: string;
  model: string;
  messageId: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  output: string;
  cwd?: string;
  prompt?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  diffStat?: string;
  quotaExhausted?: boolean;
  quotaReason?: string;
  quotaRetryAfterMs?: number;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
}

export function detectQuotaExhaustion(
  output: string,
  exitCode?: number | null
): { exhausted: boolean; reason: string; retryAfterMs?: number } {
  const tail = (output || '').slice(-4000);
  const fatalRegex =
    /(?:usage[_ ]limit|rate[_ ]limit[_ ]exceeded|rate limit reached|you've hit your limit|hit your usage limit|exceeded your current quota|insufficient[_ ]quota|insufficient balance|credit balance is too low|billing hard limit|429\s+too many requests|resource_exhausted|quota exceeded|额度已用完|额度不足|余额不足|达到.*(?:使用|调用)?限额|触发限流)/i;
  const match = tail.match(fatalRegex);
  if (!match) return { exhausted: false, reason: '' };

  // Avoid false positives when a CLI succeeded (exitCode 0) and merely printed code mentioning "rate limit"
  if (exitCode === 0 && (output || '').length > 520) {
    return { exhausted: false, reason: '' };
  }

  let retryAfterMs: number | undefined;
  const minMatch = tail.match(/(?:try again|resets?|retry|wait)\s+in\s+(\d+)\s*(?:m|min|mins|minutes?)\b/i);
  const secMatch = tail.match(/(?:try again|resets?|retry|wait)\s+in\s+(\d+)\s*(?:s|sec|secs|seconds?)\b/i);
  const hrMatch = tail.match(/(?:try again|resets?|retry|wait)\s+in\s+(\d+)\s*(?:h|hr|hrs|hours?)\b/i);
  if (hrMatch) {
    retryAfterMs = Math.min(60 * 60_000, Math.max(60_000, Number(hrMatch[1]) * 60 * 60_000));
  } else if (minMatch) {
    retryAfterMs = Math.min(60 * 60_000, Math.max(60_000, Number(minMatch[1]) * 60_000));
  } else if (secMatch) {
    retryAfterMs = Math.min(60 * 60_000, Math.max(45_000, Number(secMatch[1]) * 1000));
  }

  const line =
    tail
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => fatalRegex.test(l)) || match[0];

  return {
    exhausted: true,
    reason: line.slice(0, 180),
    retryAfterMs
  };
}

export class CliRunner {
  private store: FmcStore;
  private onUiUpdate: (event: string, payload: unknown) => void;
  private tasks = new Map<string, RunningTaskInfo>();
  private procs = new Map<string, ChildProcess>();

  constructor(store: FmcStore, onUiUpdate: (event: string, payload: unknown) => void) {
    this.store = store;
    this.onUiUpdate = onUiUpdate;
  }

  getTask(taskId: string): RunningTaskInfo | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(): RunningTaskInfo[] {
    return Array.from(this.tasks.values()).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt)
    );
  }

  private async prepareWorktree(
    repoPath: string,
    agentId: string,
    taskId: string
  ): Promise<{ cwd: string; branch?: string; worktreePath?: string }> {
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoPath, timeout: 3000 });
      const branch = `fmc/${agentId}-${taskId.slice(-6)}`;
      const wtDir = path.join(repoPath, '.fmc-worktrees', taskId);
      fs.mkdirSync(path.dirname(wtDir), { recursive: true });
      await execFileAsync('git', ['worktree', 'add', '-b', branch, wtDir], {
        cwd: repoPath,
        timeout: 10000
      });
      return { cwd: wtDir, branch, worktreePath: wtDir };
    } catch {
      return { cwd: repoPath };
    }
  }

  private async collectDiffStat(cwd: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--short'], { cwd, timeout: 3000 });
      const { stdout: diffOut } = await execFileAsync('git', ['diff', '--stat'], { cwd, timeout: 3000 });
      return [stdout.trim(), diffOut.trim()].filter(Boolean).join('\n').slice(0, 1500);
    } catch {
      return '';
    }
  }

  private buildCommand(
    agentId: string,
    prompt: string,
    model: string,
    extraArgs: string,
    cliCfg?: import('./store').CliUserConfig,
    permissionLevel: import('./store').PermissionLevel = 'auto',
    effortOverride?: import('./store').ReasoningEffort,
    externalSessionId?: string
  ): {
    cmd: string;
    args: string[];
  } {
    const def = CLI_REGISTRY.find((c) => c.id === agentId);
    const baseCmd = def?.command || agentId;
    const extras = extraArgs.trim() ? extraArgs.trim().split(/\s+/) : [];

    const effectiveEffort =
      effortOverride && effortOverride !== 'default'
        ? effortOverride
        : cliCfg?.reasoningEffort && cliCfg.reasoningEffort !== 'default'
          ? cliCfg.reasoningEffort
          : undefined;
    const effort = effectiveEffort;

    switch (agentId) {
      case 'claude': {
        const args = ['-p', prompt, '--output-format', 'text'];
        if (externalSessionId) {
          args.push('--resume', externalSessionId);
        }
        if (permissionLevel === 'ask_review') {
          args.push('--permission-mode', 'plan');
        } else if (permissionLevel === 'default') {
          args.push('--permission-mode', 'default');
        } else if (permissionLevel === 'auto') {
          args.push('--permission-mode', 'acceptEdits');
        } else if (permissionLevel === 'turbo') {
          args.push('--dangerously-skip-permissions');
        }
        if (effort) {
          args.push('--effort', effort === 'xhigh' ? 'max' : effort);
        }
        if (model) args.push('--model', model);
        return { cmd: baseCmd, args: [...args, ...extras] };
      }
      case 'codex': {
        const args = externalSessionId
          ? ['exec', 'resume', '--skip-git-repo-check']
          : ['exec', '--skip-git-repo-check'];
        if (permissionLevel === 'ask_review') {
          args.push('--sandbox', 'read-only');
        } else if (permissionLevel === 'default') {
          args.push('--sandbox', 'workspace-write');
        } else if (permissionLevel === 'auto') {
          args.push('--sandbox', 'workspace-write', '--full-auto');
        } else if (permissionLevel === 'turbo') {
          args.push('--dangerously-bypass-approvals-and-sandbox');
        }
        if (effort) {
          args.push('-c', `model_reasoning_effort="${effort}"`);
        }
        if (cliCfg?.authMode === 'api_key' && cliCfg.apiKey) {
          const protocol = cliCfg.apiProtocol || defaultProtocolForCli('codex');
          const { baseUrl } = resolveProtocolEndpoints(protocol, cliCfg.baseUrl, 'codex');
          const wireApi = protocol === 'openai_chat' ? 'chat' : 'responses';
          args.push(
            '-c', 'model_provider="fmc_api"',
            '-c', 'model_providers.fmc_api.name="FMC Custom API"',
            '-c', `model_providers.fmc_api.base_url="${baseUrl}"`,
            '-c', `model_providers.fmc_api.wire_api="${wireApi}"`,
            '-c', 'model_providers.fmc_api.env_key="FMC_CODEX_API_KEY"'
          );
        }
        if (model) args.push('-m', model);
        if (externalSessionId) args.push(externalSessionId);
        args.push(prompt);
        return { cmd: baseCmd, args: [...args, ...extras] };
      }
      case 'gemini': {
        const args = ['-p', prompt];
        if (model) args.push('-m', model);
        return { cmd: baseCmd, args: [...args, ...extras] };
      }
      case 'pi': {
        const args = ['-p', prompt];
        if (effort) args.push('--thinking', effort);
        if (model) args.push('--model', model);
        return { cmd: baseCmd, args: [...args, ...extras] };
      }
      case 'antigravity': {
        const args = ['-p', prompt];
        if (permissionLevel === 'ask_review') {
          args.push('--mode', 'plan');
        } else if (permissionLevel === 'default') {
          args.push('--mode', 'accept-edits');
        } else if (permissionLevel === 'auto') {
          args.push('--mode', 'auto');
        } else if (permissionLevel === 'turbo') {
          args.push('--dangerously-skip-permissions');
        }
        if (effort) {
          args.push('--effort', effort);
        }
        if (model) args.push('--model', model);
        return { cmd: baseCmd, args: [...args, ...extras] };
      }
      case 'opencode': {
        return { cmd: baseCmd, args: ['run', prompt, ...extras] };
      }
      default: {
        return { cmd: baseCmd, args: ['-p', prompt, ...extras] };
      }
    }
  }

  async dispatch(req: DispatchRequest): Promise<RunningTaskInfo> {
    const state = this.store.getState();
    const project =
      state.projects.find((p) => p.id === req.projectId) || state.projects[0];
    const cliCfg = state.cliConfigs[req.agentId];
    const def = CLI_REGISTRY.find((c) => c.id === req.agentId);
    const model = req.model || cliCfg?.defaultModel || def?.models[0] || '';
    const repoPath = req.repoPath || project.repoPath || process.cwd();

    const taskId = `task-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const matchedSession = req.sessionId
      ? (state.sessions || []).find(
          (s) => s.id === req.sessionId || s.externalSessionId === req.sessionId
        )
      : undefined;
    const effectiveSessionId = matchedSession?.id || req.sessionId;
    const externalSessionId = matchedSession?.externalSessionId;

    // 1. Record incoming directive message
    const directiveMsg: AggregatedMessage = this.store.addMessage({
      projectId: project.id,
      sessionId: effectiveSessionId,
      source: req.source,
      agentId: req.agentId,
      model,
      role: 'directive',
      title: `${req.source === 'muse' ? 'Muse 派单' : req.source === 'feishu' ? '飞书指令' : '本地下发'} → ${def?.name || req.agentId}`,
      content: req.prompt,
      status: 'done',
      taskId
    });
    this.onUiUpdate('message:added', directiveMsg);

    // 2. Prepare optional Git Worktree
    let cwd = repoPath;
    let worktreeBranch: string | undefined;
    let worktreePath: string | undefined;
    if (req.useWorktree && fs.existsSync(repoPath)) {
      const wt = await this.prepareWorktree(repoPath, req.agentId, taskId);
      cwd = wt.cwd;
      worktreeBranch = wt.branch;
      worktreePath = wt.worktreePath;
    }

    // 3. Create live streaming output message placeholder
    const outputMsg = this.store.addMessage({
      projectId: project.id,
      sessionId: effectiveSessionId,
      source: 'cli',
      agentId: req.agentId,
      model,
      role: 'output',
      title: `${def?.name || req.agentId} (${model || '默认模型'}${req.reasoningEffort && req.reasoningEffort !== 'default' ? ` · ${req.reasoningEffort}` : ''})`,
      content: '正在启动本地 CLI 进程...',
      status: 'running',
      worktreeBranch,
      taskId
    });
    this.onUiUpdate('message:added', outputMsg);

    const taskInfo: RunningTaskInfo = {
      taskId,
      projectId: project.id,
      agentId: req.agentId,
      model,
      messageId: outputMsg.id,
      status: 'running',
      output: '',
      cwd,
      prompt: req.prompt,
      worktreePath,
      worktreeBranch,
      startedAt: new Date().toISOString()
    };
    this.tasks.set(taskId, taskInfo);

    // 4. Build environment with optional custom API Key / Base URL
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (cliCfg?.authMode === 'api_key') {
      if (cliCfg.apiKey && def?.apiKeyEnv) {
        env[def.apiKeyEnv] = cliCfg.apiKey;
      }
      if (req.agentId === 'codex' && cliCfg.apiKey) {
        env.FMC_CODEX_API_KEY = cliCfg.apiKey;
      }
      if (req.agentId === 'claude' && cliCfg.apiKey) {
        env.ANTHROPIC_AUTH_TOKEN = cliCfg.apiKey;
      }
      if (cliCfg.baseUrl && def?.baseUrlEnv) {
        const protocol = cliCfg.apiProtocol || defaultProtocolForCli(req.agentId);
        const { baseUrl: resolvedBase } = resolveProtocolEndpoints(protocol, cliCfg.baseUrl, req.agentId);
        env[def.baseUrlEnv] = resolvedBase;
      }
    }

    const { cmd, args } = this.buildCommand(
      req.agentId,
      req.prompt,
      model,
      cliCfg?.extraArgs || '',
      cliCfg,
      state.permissionLevel || 'auto',
      req.reasoningEffort,
      externalSessionId
    );

    const resolvedExec = await locateCommand(cmd);
    if (!resolvedExec) {
      const msg = `未在系统 PATH 检测到命令 "${cmd}"（${def?.name || req.agentId} 尚未安装）。\n请先前往左侧「应用 / CLI 雷达」点击「一键安装」，安装完成后即可直接调度。`;
      taskInfo.status = 'error';
      taskInfo.output = msg;
      taskInfo.finishedAt = new Date().toISOString();
      this.store.updateMessage(outputMsg.id, {
        role: 'error',
        status: 'error',
        content: msg
      });
      this.onUiUpdate('task:finished', taskInfo);
      return taskInfo;
    }

    const child = spawn(resolvedExec, args, {
      cwd: fs.existsSync(cwd) ? cwd : process.cwd(),
      env: { ...env, PYTHONUTF8: '1', FORCE_COLOR: '0' },
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedExec),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.procs.set(taskId, child);

    let lastPush = 0;
    const appendOutput = (chunk: string) => {
      taskInfo.output += chunk;
      const now = Date.now();
      if (now - lastPush > 200) {
        lastPush = now;
        const updated = this.store.updateMessage(outputMsg.id, {
          content: taskInfo.output.slice(-24000),
          status: 'running'
        });
        if (updated) this.onUiUpdate('message:updated', updated);
      }
    };

    child.stdout?.on('data', (buf: Buffer) => appendOutput(buf.toString('utf-8')));
    child.stderr?.on('data', (buf: Buffer) => appendOutput(buf.toString('utf-8')));

    child.on('error', (err) => {
      taskInfo.status = 'error';
      taskInfo.output += `\n[启动失败] ${err.message}\n请检查该 CLI 是否已安装并在系统 PATH 中。`;
      taskInfo.finishedAt = new Date().toISOString();
      const updated = this.store.updateMessage(outputMsg.id, {
        content: taskInfo.output,
        status: 'error',
        role: 'error'
      });
      if (updated) this.onUiUpdate('message:updated', updated);
      this.onUiUpdate('task:finished', taskInfo);
      this.procs.delete(taskId);
    });

    child.on('close', async (code) => {
      this.procs.delete(taskId);
      if (taskInfo.status === 'cancelled') return;
      taskInfo.exitCode = code;
      const quotaCheck = detectQuotaExhaustion(taskInfo.output, code);
      if (quotaCheck.exhausted) {
        taskInfo.status = 'error';
        taskInfo.quotaExhausted = true;
        taskInfo.quotaReason = quotaCheck.reason;
        taskInfo.quotaRetryAfterMs = quotaCheck.retryAfterMs;
      } else {
        taskInfo.status = code === 0 ? 'done' : 'error';
      }
      taskInfo.finishedAt = new Date().toISOString();
      const diffStat = await this.collectDiffStat(cwd);
      taskInfo.diffStat = diffStat || undefined;

      const finalText = taskInfo.output.trim() || `(进程已退出，exit code = ${code})`;
      const updated = this.store.updateMessage(outputMsg.id, {
        content: finalText.slice(-32000),
        status: taskInfo.status,
        role: taskInfo.status === 'error' ? 'error' : 'output',
        diffStat: taskInfo.diffStat
      });
      if (updated) this.onUiUpdate('message:updated', updated);
      this.onUiUpdate('task:finished', taskInfo);
    });

    return taskInfo;
  }

  cancel(taskId: string): boolean {
    const proc = this.procs.get(taskId);
    const info = this.tasks.get(taskId);
    if (!info) return false;
    info.status = 'cancelled';
    info.finishedAt = new Date().toISOString();
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
    }
    this.procs.delete(taskId);
    const updated = this.store.updateMessage(info.messageId, {
      status: 'cancelled',
      content: `${info.output}\n\n[已手动中止]`
    });
    if (updated) this.onUiUpdate('message:updated', updated);
    return true;
  }
}
