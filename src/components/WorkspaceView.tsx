import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  FileText,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  XCircle
} from 'lucide-react';
import {
  AggregatedMessage,
  CliSessionThread,
  CliUserConfig,
  DetectedCli,
  PermissionLevel,
  ProjectGroup,
  ReasoningEffort
} from '../types';
import { CliBrandIcon } from './CliBrandIcon';
import { PermissionMenu } from './PermissionMenu';

const EFFORT_STEPS: Array<{ id: ReasoningEffort; short: string; label: string }> = [
  { id: 'default', short: '默认', label: '跟随默认' },
  { id: 'low', short: 'Low', label: '低 (Low)' },
  { id: 'medium', short: 'Med', label: '中 (Medium)' },
  { id: 'high', short: 'High', label: '高 (High)' },
  { id: 'xhigh', short: 'XHigh', label: '超高 (XHigh)' }
];

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

function cleanCliReply(raw: string, agentId?: string): { clean: string; hasExtra: boolean } {
  const normalized = stripAnsi(raw || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return { clean: '', hasExtra: false };

  // Keep placeholder / status messages as-is
  if (normalized.startsWith('正在启动本地 CLI 进程')) {
    return { clean: normalized, hasExtra: false };
  }

  let result = normalized;

  // 1. Codex CLI specific extraction:
  // Codex exec prints metadata + echoed user prompt + warnings + "codex\n<reply>" + "tokens used\n<num>\n<final reply>"
  if (agentId === 'codex' || /\ntokens used\n[\d,]+\n/i.test(result) || /^session id:/m.test(result)) {
    const afterTokens = result.match(/\ntokens used\n[\d,]+\s*\n([\s\S]+)$/i);
    if (afterTokens && afterTokens[1].trim()) {
      result = afterTokens[1].trim();
    } else {
      const codexMarker = result.lastIndexOf('\ncodex\n');
      if (codexMarker !== -1) {
        result = result.slice(codexMarker + '\ncodex\n'.length);
        result = result.replace(/\ntokens used\n[\d,]+[\s\S]*$/i, '').trim();
      }
    }
  }

  // 2. Generic noisy CLI header/warning/telemetry line filter (Claude, Gemini, Codex, etc.)
  const lines = result.split('\n');
  const kept: string[] = [];
  let skipIndentedContinuation = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip indented continuation lines right after a "warning:" line
    if (skipIndentedContinuation) {
      if (/^\s+\S/.test(line) || /^performance and cause issues\.?$/i.test(trimmed)) {
        continue;
      }
      skipIndentedContinuation = false;
    }

    if (
      /^warning:\s*/i.test(trimmed) ||
      /^\(node:\d+\)/i.test(trimmed) ||
      /^\[DeprecationWarning\]/i.test(trimmed) ||
      /^OpenAI Codex v/i.test(trimmed) ||
      /^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/i.test(trimmed) ||
      /^-{4,}$/.test(trimmed) ||
      /^Loaded cached credentials\.?$/i.test(trimmed) ||
      /^YOLO mode is enabled/i.test(trimmed) ||
      /^Reading (additional input|prompt) from stdin/i.test(trimmed) ||
      /^tokens used$/i.test(trimmed)
    ) {
      if (/^warning:\s*/i.test(trimmed)) {
        skipIndentedContinuation = true;
      }
      // If "tokens used", also skip the immediately following number-only line
      if (/^tokens used$/i.test(trimmed) && i + 1 < lines.length && /^[\d,]+$/.test(lines[i + 1].trim())) {
        i++;
      }
      continue;
    }

    kept.push(line);
  }

  const cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const finalClean = cleaned || normalized;
  return {
    clean: finalClean,
    hasExtra: finalClean !== normalized
  };
}

interface WorkspaceViewProps {
  projects: ProjectGroup[];
  sessions?: CliSessionThread[];
  messages: AggregatedMessage[];
  clis: DetectedCli[];
  activeProjectId: string;
  activeCliId: string;
  activeSessionId?: string;
  onSelectSession?: (sessionId: string) => void;
  onCreateSession?: () => Promise<void>;
  museAvatarUrl?: string;
  museAvatarKind?: 'image' | 'video';
  permissionLevel: PermissionLevel;
  onChangePermission: (level: PermissionLevel) => Promise<void>;
  onOpenNewProject: () => void;
  onSaveCliConfig: (cliId: string, config: CliUserConfig) => Promise<void>;
  onDispatch: (req: {
    projectId: string;
    sessionId?: string;
    agentId: string;
    prompt: string;
    useWorktree: boolean;
  }) => Promise<void>;
  onCancelTask: (taskId: string) => Promise<void>;
}

export const WorkspaceView: React.FC<WorkspaceViewProps> = ({
  projects,
  sessions = [],
  messages,
  clis,
  activeProjectId,
  activeCliId,
  activeSessionId = '',
  onSelectSession,
  onCreateSession,
  museAvatarUrl,
  museAvatarKind,
  permissionLevel,
  onChangePermission,
  onOpenNewProject,
  onSaveCliConfig,
  onDispatch,
  onCancelTask
}) => {
  const [prompt, setPrompt] = useState('');
  const [useWorktree, setUseWorktree] = useState(true);
  const [sending, setSending] = useState(false);
  const [rawVisibleMap, setRawVisibleMap] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Composer inline model switcher popover
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showSessionMenu, setShowSessionMenu] = useState(false);
  const [modelList, setModelList] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [customModelInput, setCustomModelInput] = useState('');
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const sessionMenuRef = useRef<HTMLDivElement | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  const activeProject = projects.find((p) => p.id === activeProjectId) || projects[0];
  const activeCli = clis.find((c) => c.id === activeCliId) || clis[0];
  const threadSessions = sessions
    .filter((s) => s.projectId === activeProject?.id && s.cliId === activeCliId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const currentSession = threadSessions.find((s) => s.id === activeSessionId);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
      if (sessionMenuRef.current && !sessionMenuRef.current.contains(e.target as Node)) {
        setShowSessionMenu(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  useEffect(() => {
    const defaults = activeCli?.models || [];
    const current = activeCli?.config.defaultModel;
    const merged = Array.from(new Set([...(current ? [current] : []), ...defaults]));
    setModelList(merged);
    setShowModelMenu(false);
    setCustomModelInput('');
  }, [activeCliId, activeCli?.config.defaultModel, activeCli?.models]);

  const handleRefreshModels = async () => {
    if (!activeCli || loadingModels) return;
    setLoadingModels(true);
    try {
      const res = await window.fmc.scanCliModels(activeCli.id, activeCli.config);
      if (res.models.length > 0) {
        setModelList(
          Array.from(
            new Set([
              ...(activeCli.config.defaultModel ? [activeCli.config.defaultModel] : []),
              ...res.models
            ])
          )
        );
      }
    } finally {
      setLoadingModels(false);
    }
  };

  const handleSelectModel = async (nextModel: string) => {
    const trimmed = nextModel.trim();
    if (!activeCli || !trimmed) return;
    await onSaveCliConfig(activeCli.id, {
      ...activeCli.config,
      defaultModel: trimmed
    });
    setShowModelMenu(false);
    setCustomModelInput('');
  };

  const currentEffort: ReasoningEffort = activeCli?.config.reasoningEffort || 'default';
  const currentEffortIdx = Math.max(
    0,
    EFFORT_STEPS.findIndex((s) => s.id === currentEffort)
  );
  const currentEffortMeta = EFFORT_STEPS[currentEffortIdx] || EFFORT_STEPS[0];

  const handleSelectEffort = async (nextEffort: ReasoningEffort) => {
    if (!activeCli) return;
    await onSaveCliConfig(activeCli.id, {
      ...activeCli.config,
      reasoningEffort: nextEffort
    });
  };

  // Strictly isolated conversation stream for (activeProject, activeCli, activeSessionId)
  const threadMessages = messages.filter(
    (m) =>
      m.projectId === activeProject?.id &&
      m.agentId === activeCliId &&
      (activeSessionId ? m.sessionId === activeSessionId : !m.sessionId)
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [threadMessages.length, activeProjectId, activeCliId, activeSessionId]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || !activeProject || sending) return;
    setSending(true);
    try {
      const text = prompt.trim();
      setPrompt('');
      await onDispatch({
        projectId: activeProject.id,
        sessionId: activeSessionId || undefined,
        agentId: activeCliId,
        prompt: text,
        useWorktree
      });
    } finally {
      setSending(false);
    }
  };

  const handleCopy = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      {/* Slim Dedicated CLI Conversation Header */}
      <header className="flex h-11 shrink-0 items-center justify-between gap-4 border-b border-[#eaecef] bg-white px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <CliBrandIcon
            cliId={activeCliId}
            avatarUrl={activeCli?.config.avatarUrl}
            className="h-4 w-4 shrink-0"
          />
          <h2 className="truncate text-[13.5px] font-semibold text-[#111827]">
            {activeCli?.name || activeCliId}
          </h2>
          <span className="text-[#d4d4d8]">/</span>
          <span className="truncate text-[12.5px] font-medium text-[#52525b]">
            {activeProject?.name || '默认总控台'}
          </span>

          {/* Multi-Session Switcher (for imported & new sessions inside this project + CLI) */}
          <div ref={sessionMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setShowSessionMenu((v) => !v)}
              className="inline-flex max-w-[200px] items-center gap-1 rounded-lg border border-[#eaecef] bg-[#fafafa] px-2 py-0.5 text-[11.5px] font-medium text-[#3f3f46] transition-colors hover:border-[#d4d4d8] hover:bg-[#f4f4f5] hover:text-[#111827]"
              title="切换当前项目下的多个 CLI 独立会话（支持原生 resume 续聊）"
            >
              <span className="truncate">
                {currentSession ? currentSession.title : '默认主会话'}
              </span>
              {threadSessions.length > 0 && (
                <span className="shrink-0 rounded bg-[#e4e4e7] px-1 text-[10px] text-[#52525b]">
                  {threadSessions.length + 1}
                </span>
              )}
              <ChevronDown className="h-3 w-3 shrink-0 text-[#8a8f98]" />
            </button>

            {showSessionMenu && (
              <div className="absolute top-full left-0 z-50 mt-1.5 w-72 overflow-hidden rounded-xl border border-[#e4e4e7] bg-white p-1.5 text-[12px] shadow-popover">
                <div className="mb-1 flex items-center justify-between px-2 py-1">
                  <span className="text-[11px] font-medium text-[#8a8f98]">
                    当前项目会话（支持原上下文续聊）
                  </span>
                  {onCreateSession && (
                    <button
                      type="button"
                      onClick={() => {
                        setShowSessionMenu(false);
                        void onCreateSession();
                      }}
                      className="inline-flex items-center gap-0.5 rounded-md bg-[#18181b] px-2 py-0.5 text-[10.5px] font-medium text-white hover:bg-[#27272a]"
                    >
                      <Plus className="h-2.5 w-2.5" />
                      新建会话
                    </button>
                  )}
                </div>
                <div className="max-h-60 space-y-0.5 overflow-y-auto">
                  <button
                    type="button"
                    onClick={() => {
                      onSelectSession?.('');
                      setShowSessionMenu(false);
                    }}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                      !activeSessionId
                        ? 'bg-[#f4f4f5] font-medium text-[#111827]'
                        : 'text-[#3f3f46] hover:bg-[#fafafa]'
                    }`}
                  >
                    <span className="truncate">默认主会话</span>
                    {!activeSessionId && <Check className="h-3.5 w-3.5 text-[#18181b]" />}
                  </button>
                  {threadSessions.map((sess) => {
                    const selected = sess.id === activeSessionId;
                    return (
                      <button
                        key={sess.id}
                        type="button"
                        onClick={() => {
                          onSelectSession?.(sess.id);
                          setShowSessionMenu(false);
                        }}
                        className={`flex w-full items-start justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                          selected
                            ? 'bg-[#f4f4f5] font-medium text-[#111827]'
                            : 'text-[#3f3f46] hover:bg-[#fafafa]'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12px]">{sess.title}</div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-[#8a8f98]">
                            {sess.source === 'imported' && (
                              <span className="rounded bg-[#ececef] px-1 text-[#52525b]">
                                本地导入 · resume
                              </span>
                            )}
                            <span>{new Date(sess.updatedAt).toLocaleDateString('zh-CN')}</span>
                          </div>
                        </div>
                        {selected && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#18181b]" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          {activeCli?.config.defaultModel && (
            <span className="hidden rounded-md bg-[#f4f4f5] px-2 py-0.5 font-mono text-[11px] text-[#52525b] sm:inline">
              {activeCli.config.defaultModel}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          {activeProject?.repoPath && (
            <span className="hidden max-w-[260px] truncate font-mono text-[11px] text-[#8a8f98] lg:inline">
              {activeProject.repoPath}
            </span>
          )}
          <button
            onClick={onOpenNewProject}
            className="inline-flex items-center gap-1 rounded-lg border border-[#eaecef] bg-white px-2.5 py-1 text-[11.5px] font-medium text-[#52525b] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
          >
            <Plus className="h-3.5 w-3.5" />
            新建项目
          </button>
        </div>
      </header>

      {/* Isolated Single-CLI Conversation Stream */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-[820px] flex-col px-6 py-6">
          {threadMessages.length === 0 ? (
            <div className="my-auto flex flex-col items-center justify-center py-14 text-center">
              <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-[#eaecef] bg-[#fafafa]">
                <CliBrandIcon cliId={activeCliId} className="h-6 w-6" />
              </div>
              <h3 className="text-[15px] font-semibold text-[#111827]">
                {activeCli?.name || activeCliId} · {activeProject?.name || '默认总控台'}
              </h3>
              <p className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-[#71717a]">
                这是 {activeCli?.name || activeCliId} 在当前项目中的独立对话窗口。无论是本地下发还是由 Muse / 飞书派单给该 CLI 的任务，都会清晰沉淀在此。
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {threadMessages.map((msg) => {
                const isUserBubble = msg.role === 'directive' && msg.source !== 'cli';

                if (isUserBubble) {
                  const senderLabel =
                    msg.source === 'muse'
                      ? 'Muse 派单'
                      : msg.source === 'feishu'
                        ? '飞书指令'
                        : msg.source === 'system'
                          ? '系统'
                          : '你';
                  return (
                    <div key={msg.id} className="flex items-start justify-end gap-2.5">
                      <div className="flex max-w-[76%] flex-col items-end gap-1">
                        <div className="flex items-center gap-1.5 px-1 text-[11px] text-[#8a8f98]">
                          <span className="font-medium text-[#71717a]">{senderLabel}</span>
                          <span>·</span>
                          <span>{new Date(msg.createdAt).toLocaleTimeString()}</span>
                        </div>
                        <div className="whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-[#f4f4f5] px-4 py-2.5 text-[13.5px] leading-relaxed text-[#111827]">
                          {msg.content}
                        </div>
                      </div>
                      <div className="mt-4 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#eaecef] bg-[#18181b] text-[11px] font-semibold text-white shadow-2xs">
                        {msg.source === 'muse' ? (
                          museAvatarUrl ? (
                            museAvatarKind === 'video' ? (
                              <video
                                src={museAvatarUrl}
                                autoPlay
                                loop
                                muted
                                playsInline
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <img src={museAvatarUrl} alt="Muse" className="h-full w-full object-cover" />
                            )
                          ) : (
                            <Sparkles className="h-3.5 w-3.5 text-white" />
                          )
                        ) : msg.source === 'feishu' ? (
                          <span className="flex h-full w-full items-center justify-center bg-[#3370ff] text-[11px] font-semibold text-white">
                            飞
                          </span>
                        ) : (
                          '你'
                        )}
                      </div>
                    </div>
                  );
                }

                const { clean, hasExtra } = cleanCliReply(msg.content, msg.agentId || activeCliId);
                const showRaw = Boolean(rawVisibleMap[msg.id]);
                const displayedText = showRaw ? msg.content : clean;

                return (
                  <div key={msg.id} className="flex items-start gap-2.5">
                    {/* Circular CLI Brand Avatar with Live Status Dot */}
                    <div className="relative mt-1 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#eaecef] bg-white shadow-2xs">
                      <CliBrandIcon
                        cliId={msg.agentId || activeCliId}
                        avatarUrl={clis.find((c) => c.id === (msg.agentId || activeCliId))?.config.avatarUrl}
                        className="h-5 w-5"
                      />
                      <span
                        className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-white ${
                          msg.status === 'running'
                            ? 'animate-pulse bg-amber-500'
                            : msg.status === 'error' || msg.role === 'error'
                              ? 'bg-red-500'
                              : 'bg-emerald-500'
                        }`}
                      />
                    </div>

                    <div
                      className={`min-w-0 flex-1 overflow-hidden rounded-2xl rounded-tl-md border transition-colors ${
                        msg.role === 'error'
                          ? 'border-red-200/80 bg-red-50/30'
                          : 'border-[#eaecef] bg-white shadow-2xs'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 border-b border-[#f1f1f3] bg-[#fafafa] px-4 py-2">
                        <div className="flex min-w-0 items-center gap-2 text-[12px]">
                          {msg.status === 'running' ? (
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-500" />
                          ) : msg.status === 'error' || msg.role === 'error' ? (
                            <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                          )}

                          <span className="truncate font-medium text-[#111827]">{msg.title}</span>

                          {msg.worktreeBranch && (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[#f4f4f5] px-1.5 py-0.5 font-mono text-[10.5px] text-[#52525b]">
                              <GitBranch className="h-3 w-3" />
                              {msg.worktreeBranch}
                            </span>
                          )}
                        </div>

                        <div className="flex shrink-0 items-center gap-2">
                          {msg.status === 'running' && msg.taskId && (
                            <button
                              onClick={() => void onCancelTask(msg.taskId!)}
                              className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-0.5 text-[11px] font-medium text-red-600 transition-colors hover:bg-red-50"
                            >
                              <Square className="h-2.5 w-2.5 fill-current" />
                              中止
                            </button>
                          )}
                          {hasExtra && (
                            <button
                              onClick={() =>
                                setRawVisibleMap((prev) => ({ ...prev, [msg.id]: !prev[msg.id] }))
                              }
                              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[#71717a] transition-colors hover:bg-[#ececef] hover:text-[#111827]"
                              title="切换查看原始终端日志或纯净回复"
                            >
                              <FileText className="h-3 w-3" />
                              {showRaw ? '纯净回复' : '原始日志'}
                            </button>
                          )}
                          <button
                            onClick={() => void handleCopy(msg.id, displayedText)}
                            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[#71717a] transition-colors hover:bg-[#ececef] hover:text-[#111827]"
                            title="复制回复内容"
                          >
                            {copiedId === msg.id ? (
                              <Check className="h-3 w-3 text-emerald-600" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </button>
                          <span className="text-[11px] text-[#8a8f98]">
                            {new Date(msg.createdAt).toLocaleTimeString()}
                          </span>
                        </div>
                      </div>

                      <div className="p-3.5">
                        {showRaw ? (
                          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-[#fafafa] p-3.5 font-mono text-[11.5px] leading-relaxed text-[#52525b] ring-1 ring-[#f1f1f3]">
                            {displayedText}
                          </pre>
                        ) : (
                          <div className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-[#fafafa] px-4 py-3 text-[13.5px] leading-[1.7] text-[#111827] ring-1 ring-[#f1f1f3]">
                            {displayedText}
                          </div>
                        )}

                        {msg.diffStat && (
                          <div className="mt-3 rounded-xl border border-[#eaecef] bg-[#fafafa] p-3">
                            <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-[#3f3f46]">
                              <GitBranch className="h-3.5 w-3.5 text-emerald-600" />
                              Git 变更摘要
                            </div>
                            <pre className="mt-1.5 overflow-x-auto font-mono text-[11px] leading-relaxed text-[#52525b]">
                              {msg.diffStat}
                            </pre>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Floating Codex Composer (bound to this CLI) */}
      <div className="shrink-0 bg-gradient-to-t from-white via-white to-white/80 px-5 pt-2 pb-4">
        <form onSubmit={(e) => void handleSend(e)} className="mx-auto max-w-[820px]">
          <div className="rounded-2xl border border-[#e4e4e7] bg-white px-3.5 pt-3 pb-2 shadow-composer transition-all focus-within:border-[#a1a1aa] focus-within:shadow-composer-focus">
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend(e);
                }
              }}
              placeholder={`向 ${activeCli?.name || activeCliId} 下发开发指令（Enter 发送，Shift+Enter 换行）...`}
              className="w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-[#111827] placeholder-[#a1a1aa] outline-none"
            />

            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex items-center gap-1.5">
                {/* Interactive Model Switcher Pill */}
                <div ref={modelMenuRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setShowModelMenu((v) => !v)}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] font-medium transition-colors ${
                      showModelMenu
                        ? 'bg-[#ececef] text-[#111827]'
                        : 'bg-[#f4f4f5] text-[#111827] hover:bg-[#ececef]'
                    }`}
                    title="点击切换当前 CLI 使用的模型"
                  >
                    <CliBrandIcon cliId={activeCliId} className="h-3.5 w-3.5 shrink-0" />
                    <span>{activeCli?.name || activeCliId}</span>
                    {activeCli?.config.defaultModel && (
                      <span className="max-w-[140px] truncate font-mono text-[10.5px] text-[#71717a]">
                        · {activeCli.config.defaultModel}
                      </span>
                    )}
                    {currentEffort !== 'default' && (
                      <span className="rounded bg-white px-1 py-0.2 font-mono text-[10px] font-medium text-[#3f3f46] ring-1 ring-[#e4e4e7]">
                        {currentEffortMeta.short}
                      </span>
                    )}
                    <ChevronDown
                      className={`h-3 w-3 text-[#8a8f98] transition-transform ${
                        showModelMenu ? 'rotate-180' : ''
                      }`}
                    />
                  </button>

                  {showModelMenu && (
                    <div className="absolute bottom-full left-0 z-50 mb-2 w-76 overflow-hidden rounded-2xl border border-[#e4e4e7] bg-white p-2 shadow-popover">
                      {/* Codex-style Reasoning Effort Slider */}
                      <div className="mb-2 rounded-xl bg-[#fafafa] px-3 py-2.5 ring-1 ring-[#f1f1f3]">
                        <div className="mb-1.5 flex items-center justify-between text-[11px]">
                          <span className="inline-flex items-center gap-1 font-medium text-[#3f3f46]">
                            <Brain className="h-3.5 w-3.5 text-[#52525b]" />
                            思考等级
                          </span>
                          <span className="font-mono text-[11px] font-semibold text-[#111827]">
                            {currentEffortMeta.label}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={EFFORT_STEPS.length - 1}
                          step={1}
                          value={currentEffortIdx}
                          onChange={(e) => {
                            const idx = Number(e.target.value);
                            const step = EFFORT_STEPS[idx];
                            if (step) void handleSelectEffort(step.id);
                          }}
                          className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-[#e4e4e7] accent-[#18181b]"
                        />
                        <div className="mt-1.5 flex items-center justify-between text-[10px] text-[#8a8f98]">
                          {EFFORT_STEPS.map((s) => (
                            <button
                              key={s.id}
                              type="button"
                              onClick={() => void handleSelectEffort(s.id)}
                              className={`transition-colors ${
                                currentEffort === s.id
                                  ? 'font-semibold text-[#111827]'
                                  : 'hover:text-[#3f3f46]'
                              }`}
                            >
                              {s.short}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="flex items-center justify-between px-2 py-1">
                        <span className="text-[11px] font-medium text-[#8a8f98]">
                          切换 {activeCli?.name || activeCliId} 模型
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleRefreshModels()}
                          disabled={loadingModels}
                          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium text-[#52525b] hover:bg-[#f4f4f5] hover:text-[#111827] disabled:opacity-50"
                        >
                          <RefreshCw className={`h-3 w-3 ${loadingModels ? 'animate-spin' : ''}`} />
                          {loadingModels ? '拉取中' : '扫描模型'}
                        </button>
                      </div>

                      <div className="max-h-56 space-y-0.5 overflow-y-auto px-0.5">
                        {modelList.map((m) => {
                          const selected = m === activeCli?.config.defaultModel;
                          return (
                            <button
                              key={m}
                              type="button"
                              onClick={() => void handleSelectModel(m)}
                              className={`flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-1.5 text-left font-mono text-[11.5px] transition-colors ${
                                selected
                                  ? 'bg-[#f4f4f5] font-medium text-[#111827]'
                                  : 'text-[#3f3f46] hover:bg-[#fafafa] hover:text-[#111827]'
                              }`}
                            >
                              <span className="truncate">{m}</span>
                              {selected && <Check className="h-3.5 w-3.5 shrink-0 text-[#111827]" />}
                            </button>
                          );
                        })}
                      </div>

                      <div className="mt-1.5 flex items-center gap-1.5 border-t border-[#f1f1f3] px-1 pt-1.5">
                        <input
                          value={customModelInput}
                          onChange={(e) => setCustomModelInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void handleSelectModel(customModelInput);
                            }
                          }}
                          placeholder="输入自定义模型名回车..."
                          className="min-w-0 flex-1 rounded-lg border border-[#e4e4e7] px-2 py-1 font-mono text-[11px] text-[#111827] outline-none focus:border-[#18181b]"
                        />
                        <button
                          type="button"
                          onClick={() => void handleSelectModel(customModelInput)}
                          disabled={!customModelInput.trim()}
                          className="rounded-lg bg-[#18181b] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#27272a] disabled:opacity-40"
                        >
                          确定
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setUseWorktree((v) => !v)}
                  className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11.5px] font-medium transition-colors ${
                    useWorktree
                      ? 'bg-[#f4f4f5] text-[#111827]'
                      : 'text-[#8a8f98] hover:bg-[#f4f4f5] hover:text-[#3f3f46]'
                  }`}
                  title="自动创建 Git Worktree 隔离分支，防止并发任务互相覆盖"
                >
                  <GitBranch className="h-3 w-3" />
                  Worktree {useWorktree ? '已开' : '已关'}
                </button>
              </div>

              <div className="flex items-center gap-1.5">
                <PermissionMenu value={permissionLevel} onChange={onChangePermission} />

                <button
                  type="submit"
                  disabled={sending || !prompt.trim()}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-[#18181b] text-white transition-colors hover:bg-[#27272a] disabled:bg-[#e4e4e7] disabled:text-[#a1a1aa]"
                  title="发送指令"
                >
                  {sending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArrowUp className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
