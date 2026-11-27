import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  BookMarked,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Globe,
  HelpCircle,
  Lightbulb,
  Loader2,
  MessageSquare,
  PanelRight,
  Plus,
  Radio,
  Sparkles,
  Terminal,
  Trash2,
  X,
  XCircle
} from 'lucide-react';
import {
  DetectedCli,
  FeishuStatusEvent,
  FmcState,
  MuseChatMessage,
  PermissionLevel,
  TunnelStatusEvent,
  WorkflowRunState
} from '../types';
import { EmbeddedBrowserSlot } from './EmbeddedBrowserSlot';
import { MusePixelStage } from './MusePixelStage';
import { PermissionMenu } from './PermissionMenu';

interface MuseChatViewProps {
  state: FmcState;
  clis: DetectedCli[];
  feishuStatus: FeishuStatusEvent;
  tunnelStatus: TunnelStatusEvent;
  workflowStatus: WorkflowRunState | null;
  onChangePermission: (level: PermissionLevel) => Promise<void>;
  onCopyBrief: () => Promise<void>;
  copiedBrief: boolean;
  onNavigateBridge: () => void;
  onNavigateClis: () => void;
}

const QUICK_PROMPTS = [
  '检查本地所有已启用的 CLI 状态与默认模型',
  '发挥你的云端联网与网页操作能力，帮我查最新文档并把核心结论落盘到项目',
  '查看当前未决议题池，结合云端最新实践给我拍板建议'
];

export const MuseChatView: React.FC<MuseChatViewProps> = ({
  state,
  clis,
  feishuStatus,
  tunnelStatus,
  workflowStatus,
  onChangePermission,
  onCopyBrief,
  copiedBrief,
  onNavigateBridge,
  onNavigateClis
}) => {
  const [viewMode, setViewMode] = useState<'native' | 'web'>('native');
  const [showInspector, setShowInspector] = useState(true);
  const [messages, setMessages] = useState<MuseChatMessage[]>([]);
  const [lightboxImg, setLightboxImg] = useState<{ src: string; alt?: string } | null>(null);
  const [saveTip, setSaveTip] = useState('');
  const [hasPendingPermission, setHasPendingPermission] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [syncingBrief, setSyncingBrief] = useState(false);
  const [syncTip, setSyncTip] = useState('');
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [copiedDomain, setCopiedDomain] = useState(false);
  const [addingQuestion, setAddingQuestion] = useState(false);
  const [newQuestionText, setNewQuestionText] = useState('');
  const [showResolvedQuestions, setShowResolvedQuestions] = useState(false);
  const [expandedCapsules, setExpandedCapsules] = useState<Record<number, boolean>>({});
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (viewMode === 'native') {
      void window.fmc.hideEmbeddedViews();
    }
    const poll = async () => {
      const res = await window.fmc.readMuseMessages();
      if (res.messages.length > 0) setMessages(res.messages);
      setHasPendingPermission(res.hasPendingPermission);
    };
    void poll();
    const timer = setInterval(() => void poll(), 2200);
    return () => clearInterval(timer);
  }, [viewMode]);

  useEffect(() => {
    if (viewMode === 'native') {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length]);

  useEffect(() => {
    if (viewMode === 'native') {
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'auto' });
      });
    }
  }, [viewMode]);

  const sendText = async (raw: string) => {
    const text = raw.trim();
    if (!text || sending) return;
    if ((state.muse.unreadProactiveCount || 0) > 0) {
      void window.fmc.clearProactiveUnread();
    }
    setInput('');
    setSending(true);
    setMessages((prev) => [...prev, { role: 'user', text }]);
    try {
      const res = await window.fmc.sendMuseChat(text);
      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          { role: 'muse', text: `⚠️ ${res.message}（可点右上角切换至「网页视图」检查登录态）` }
        ]);
      }
    } finally {
      setSending(false);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    await sendText(input);
  };

  const handleCopyMessage = async (idx: number, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1800);
  };

  const currentPerm = state.permissionLevel || 'auto';
  const enabledClis = clis.filter((c) => c.config.enabled);
  const runningCliIds = Array.from(
    new Set(
      state.messages
        .filter((m) => m.source === 'cli' && m.status === 'running' && m.agentId)
        .map((m) => m.agentId as string)
    )
  );
  const recentTasks = state.messages
    .filter((m) => m.source === 'cli')
    .slice(-5)
    .reverse();

  const allQuestions = state.openQuestions || [];
  const openQuestions = allQuestions.filter((q) => q.status === 'open');
  const resolvedQuestions = allQuestions.filter((q) => q.status === 'resolved');
  const researchNotes = (state.researchNotes || []).slice(0, 6);
  const unreadProactive = state.muse.unreadProactiveCount || 0;

  const handleQuickAddQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = newQuestionText.trim();
    if (!q) return;
    setNewQuestionText('');
    setAddingQuestion(false);
    await window.fmc.mutateOpenQuestion({
      action: 'add',
      question: q,
      projectId: state.projects[0]?.id,
      projectName: state.projects[0]?.name
    });
  };

  const activeTunnelUrl = tunnelStatus.url || state.controlApi.tunnelUrl;

  if (viewMode === 'web') {
    return (
      <EmbeddedBrowserSlot
        target="muse"
        initialUrl={state.muse.webUrl || 'https://muse.ai'}
        visible={true}
        presets={[
          { label: 'Meta Muse', url: state.muse.webUrl || 'https://muse.ai' },
          { label: '飞书网页版', url: 'https://www.feishu.cn/messenger/' }
        ]}
        headerRight={
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={async () => {
                const res = await window.fmc.syncTunnelToMuse();
                setSyncTip(res.ok ? '已同步' : res.message);
                setTimeout(() => setSyncTip(''), 3000);
              }}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[#eaecef] bg-white px-2.5 py-1 text-[11.5px] font-medium text-[#3f3f46] transition-colors hover:bg-[#f4f4f5]"
            >
              <Radio className="h-3 w-3" />
              {syncTip || '同步地址'}
            </button>
            <button
              onClick={() => setViewMode('native')}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[#18181b] px-2.5 py-1 text-[11.5px] font-medium text-white transition-colors hover:bg-[#27272a]"
            >
              <MessageSquare className="h-3 w-3" />
              原生对话
            </button>
          </div>
        }
      />
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      {/* Slim Codex-style Top Header */}
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[#eaecef] bg-white px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <h2 className="truncate text-[13.5px] font-semibold text-[#111827]">Muse 总管</h2>
          <span className="inline-flex items-center gap-1 rounded-md bg-[#f4f4f5] px-2 py-0.5 text-[11px] font-medium text-[#52525b]">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                tunnelStatus.state === 'running' ? 'bg-emerald-500' : 'bg-[#a1a1aa]'
              }`}
            />
            {tunnelStatus.state === 'running' ? 'Tailscale 443' : '原生对话'}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={async () => {
              if (syncingBrief) return;
              setSyncingBrief(true);
              setSyncTip('同步中...');
              try {
                const res = await window.fmc.syncTunnelToMuse();
                setSyncTip(res.message);
                setTimeout(() => setSyncTip(''), 3500);
              } finally {
                setSyncingBrief(false);
              }
            }}
            disabled={syncingBrief}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium text-[#52525b] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827] disabled:opacity-60"
            title="立即将带版本号的最新协议发给 Muse（覆盖旧记忆）"
          >
            {syncingBrief ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Radio className="h-3.5 w-3.5" />
            )}
            {syncTip || '同步最新协议'}
          </button>

          <button
            onClick={() => void onCopyBrief()}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium text-[#52525b] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
          >
            {copiedBrief ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            {copiedBrief ? '已复制协议' : '复制协议'}
          </button>

          <button
            onClick={() => setViewMode('web')}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium text-[#52525b] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
          >
            <Globe className="h-3.5 w-3.5" />
            网页视图
          </button>

          <div className="mx-1 h-4 w-[1px] bg-[#eaecef]" />

          <button
            onClick={() => setShowInspector((v) => !v)}
            className={`rounded-lg p-1.5 transition-colors ${
              showInspector
                ? 'bg-[#f4f4f5] text-[#111827]'
                : 'text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#111827]'
            }`}
            title={showInspector ? '收起右侧概览栏' : '展开右侧概览栏'}
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Main Split: Center Chat + Optional Right Overview Inspector */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Center Conversation Stream */}
        <div className="flex min-w-0 flex-1 flex-col bg-white">
          {hasPendingPermission && (
            <div className="flex shrink-0 items-center justify-between border-b border-amber-200/80 bg-amber-50/70 px-5 py-2 text-[12px] text-amber-900">
              <span className="inline-flex items-center gap-2 font-medium">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                Muse 正在等待你确认外部站点访问权限，请切至网页视图点击「总是允许此站点」。
              </span>
              <button
                onClick={() => setViewMode('web')}
                className="rounded-lg bg-[#18181b] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#27272a]"
              >
                去网页确认
              </button>
            </div>
          )}

          {unreadProactive > 0 && (
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-200/80 bg-amber-50/60 px-5 py-2 text-[12px] text-amber-950">
              <span className="inline-flex min-w-0 items-center gap-2">
                <Lightbulb className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                <span className="truncate font-medium">
                  Muse 刚刚主动发起了 {unreadProactive} 条新思考追问
                  {state.muse.lastProactiveText ? `：「${state.muse.lastProactiveText.slice(0, 60)}」` : ''}
                </span>
              </span>
              <button
                type="button"
                onClick={() => void window.fmc.clearProactiveUnread()}
                className="shrink-0 rounded-lg border border-amber-300 bg-white px-2.5 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
              >
                知道了
              </button>
            </div>
          )}

          {/* Live Multi-Agent Workflow Progress & HITL Bar */}
          {workflowStatus && workflowStatus.phase !== 'idle' && (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[#eaecef] bg-[#fafafa] px-5 py-2 text-[12px]">
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium ${
                    workflowStatus.phase === 'paused_budget' || workflowStatus.phase === 'paused_quota'
                      ? 'bg-amber-100 text-amber-900'
                      : workflowStatus.phase === 'awaiting_project_approval'
                        ? 'bg-sky-100 text-sky-900'
                        : workflowStatus.phase === 'awaiting_plan_approval'
                          ? 'bg-indigo-100 text-indigo-900'
                          : workflowStatus.phase === 'awaiting_user'
                            ? 'bg-emerald-100 text-emerald-900'
                            : workflowStatus.phase === 'completed'
                              ? 'bg-[#ececef] text-[#52525b]'
                              : 'bg-[#18181b] text-white'
                  }`}
                >
                  {(workflowStatus.phase === 'running' || workflowStatus.phase === 'reviewing') && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  )}
                  {workflowStatus.phase === 'awaiting_project_approval'
                    ? '待批准项目归属'
                    : workflowStatus.phase === 'awaiting_plan_approval'
                      ? '待批准方案'
                      : workflowStatus.phase === 'running'
                        ? 'CLI 执行中'
                        : workflowStatus.phase === 'reviewing'
                          ? 'Muse 审阅中'
                          : workflowStatus.phase === 'awaiting_user'
                            ? '等待你验收'
                            : workflowStatus.phase === 'paused_quota'
                              ? '额度冷却等待续跑'
                              : workflowStatus.phase === 'paused_budget'
                                ? '预算 / 熔断暂停'
                                : '已验收结项'}
                </span>

                {(workflowStatus.pendingProjectProposal?.projectName || workflowStatus.approvedProjectName) && (
                  <span className="truncate rounded-md bg-[#f4f4f5] px-2 py-0.5 text-[11px] font-medium text-[#3f3f46]">
                    {workflowStatus.phase === 'awaiting_project_approval' && workflowStatus.pendingProjectProposal
                      ? `${workflowStatus.pendingProjectProposal.action === 'create_new' ? '拟新建' : '拟归入'}《${workflowStatus.pendingProjectProposal.projectName}》`
                      : `项目：《${workflowStatus.approvedProjectName || workflowStatus.pendingProjectProposal?.projectName}》`}
                  </span>
                )}

                <span className="font-mono text-[11.5px] text-[#52525b]">
                  第 {workflowStatus.round}/{workflowStatus.maxRounds} 轮
                </span>

                <span className="font-mono text-[11.5px] text-[#71717a]">
                  约 {Math.round(workflowStatus.tokensUsed / 1000)}k
                  {workflowStatus.tokenBudget > 0
                    ? ` / ${Math.round(workflowStatus.tokenBudget / 1000)}k`
                    : ''}{' '}
                  tokens
                </span>

                {workflowStatus.pauseReason && (
                  <span className="truncate text-[11.5px] text-amber-800">
                    · {workflowStatus.pauseReason}
                  </span>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {workflowStatus.phase === 'awaiting_project_approval' && (
                  <button
                    onClick={() => void window.fmc.approveProject()}
                    className="inline-flex items-center gap-1 rounded-lg bg-[#18181b] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#27272a]"
                  >
                    <Check className="h-3 w-3" />
                    批准项目归属
                  </button>
                )}
                {workflowStatus.phase === 'awaiting_plan_approval' && (
                  <button
                    onClick={() => void window.fmc.approvePlan()}
                    className="inline-flex items-center gap-1 rounded-lg bg-[#18181b] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#27272a]"
                  >
                    <Check className="h-3 w-3" />
                    批准并开工
                  </button>
                )}
                {workflowStatus.phase === 'paused_quota' && (
                  <button
                    onClick={() => void window.fmc.retryWorkflowQuota()}
                    className="rounded-lg bg-[#18181b] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#27272a]"
                  >
                    立即重试续跑
                  </button>
                )}
                {workflowStatus.phase === 'paused_budget' && (
                  <button
                    onClick={() => void window.fmc.resumeWorkflowBudget(100000)}
                    className="rounded-lg bg-[#18181b] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#27272a]"
                  >
                    追加 +100k 继续
                  </button>
                )}
                {(workflowStatus.phase === 'awaiting_user' || workflowStatus.phase === 'reviewing') && (
                  <button
                    onClick={() => void window.fmc.approveWorkflow()}
                    className="inline-flex items-center gap-1 rounded-lg bg-[#18181b] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#27272a]"
                  >
                    <Check className="h-3 w-3" />
                    满意通过
                  </button>
                )}
                <button
                  onClick={() => void window.fmc.resetWorkflow()}
                  className="rounded-lg border border-[#e4e4e7] bg-white px-2 py-1 text-[11px] font-medium text-[#52525b] hover:bg-[#f4f4f5] hover:text-[#111827]"
                >
                  重置
                </button>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto flex min-h-full max-w-[760px] flex-col px-6 py-6">
              {messages.length === 0 ? (
                <div className="my-auto flex flex-col items-center justify-center py-12 text-center">
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-2xl border border-[#eaecef] bg-[#fafafa] text-[#18181b]">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <h3 className="text-[15px] font-semibold text-[#111827]">向 Muse 总管下发任务</h3>
                  <p className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-[#71717a]">
                    统一桌面端原生对话界面，后台与内嵌 Muse 会话实时同步。如尚未登录，请先点右上角「网页视图」完成一次登录。
                  </p>
                  <p className="mt-2 max-w-md rounded-xl border border-amber-200/70 bg-amber-50/60 px-3 py-1.5 text-[11.5px] text-amber-900">
                    🌐 提示：Meta Muse 目前在国内直连网络下无法访问，若网页加载不出来或一直无响应，请尝试开启 VPN / 代理后重试。
                  </p>
                  <div className="mt-5 flex flex-wrap justify-center gap-2">
                    {QUICK_PROMPTS.map((q) => (
                      <button
                        key={q}
                        onClick={() => void sendText(q)}
                        className="rounded-xl border border-[#eaecef] bg-[#fafafa] px-3 py-1.5 text-[12px] text-[#3f3f46] transition-colors hover:border-[#d4d4d8] hover:bg-[#f4f4f5] hover:text-[#111827]"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  {messages.map((m, i) => {
                    const renderRichMedia = () => (
                      <>
                        {m.images && m.images.length > 0 && (
                          <div
                            className={`mt-2 grid gap-2 ${
                              m.images.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
                            }`}
                          >
                            {m.images.map((im, idx) => (
                              <button
                                key={idx}
                                type="button"
                                onClick={() => {
                                  setSaveTip('');
                                  setLightboxImg(im);
                                }}
                                className="group/img relative overflow-hidden rounded-xl border border-[#eaecef] bg-[#fafafa] text-left transition-all hover:border-[#d4d4d8]"
                                title="点击放大查看与保存"
                              >
                                <img
                                  src={im.src}
                                  alt={im.alt || 'Muse image'}
                                  loading="lazy"
                                  className="max-h-[320px] w-full object-contain transition-transform duration-200 group-hover/img:scale-[1.01]"
                                />
                              </button>
                            ))}
                          </div>
                        )}

                        {m.videos && m.videos.length > 0 && (
                          <div className="mt-2 space-y-2">
                            {m.videos.map((v, idx) => (
                              <video
                                key={idx}
                                src={v.src}
                                poster={v.poster}
                                controls
                                playsInline
                                className="max-h-[320px] w-full rounded-xl border border-[#eaecef] bg-black"
                              />
                            ))}
                          </div>
                        )}

                        {m.audios && m.audios.length > 0 && (
                          <div className="mt-2 space-y-1.5">
                            {m.audios.map((au, idx) => (
                              <audio key={idx} src={au.src} controls className="w-full" />
                            ))}
                          </div>
                        )}

                        {m.links && m.links.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {m.links.map((lk, idx) => (
                              <button
                                key={idx}
                                type="button"
                                onClick={() => void window.fmc.openExternal(lk.href)}
                                className="inline-flex max-w-full items-center gap-1 rounded-lg border border-[#eaecef] bg-[#fafafa] px-2 py-1 text-[11.5px] text-[#3f3f46] transition-colors hover:border-[#d4d4d8] hover:bg-[#f4f4f5] hover:text-[#111827]"
                                title={lk.href}
                              >
                                <ExternalLink className="h-3 w-3 shrink-0 text-[#71717a]" />
                                <span className="truncate">{lk.label}</span>
                              </button>
                            ))}
                          </div>
                        )}

                        {m.actions && m.actions.length > 0 && (
                          <div className="mt-2.5 border-t border-[#f1f1f3] pt-2.5">
                            {m.actions.some((a) => a.thumb) ? (
                              <div className="grid grid-cols-2 gap-2">
                                {m.actions.map((act) => (
                                  <button
                                    key={act.id}
                                    type="button"
                                    onClick={() => void window.fmc.clickMuseAction(act.id)}
                                    className="group/act flex flex-col overflow-hidden rounded-xl border border-[#e4e4e7] bg-[#fafafa] text-left transition-all hover:border-[#18181b] hover:bg-white"
                                  >
                                    {act.thumb && (
                                      <img
                                        src={act.thumb}
                                        alt={act.label}
                                        className="h-28 w-full object-cover"
                                      />
                                    )}
                                    <div className="px-2.5 py-1.5 text-[11.5px] font-medium text-[#111827] group-hover/act:text-[#18181b]">
                                      {act.label}
                                    </div>
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div className="flex flex-wrap gap-1.5">
                                {m.actions.map((act) => (
                                  <button
                                    key={act.id}
                                    type="button"
                                    onClick={() => void window.fmc.clickMuseAction(act.id)}
                                    className={`rounded-lg px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                                      act.kind === 'approve'
                                        ? 'bg-[#18181b] text-white hover:bg-[#27272a]'
                                        : act.kind === 'danger'
                                          ? 'border border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                                          : 'border border-[#e4e4e7] bg-[#fafafa] text-[#3f3f46] hover:border-[#18181b] hover:bg-white hover:text-[#111827]'
                                    }`}
                                  >
                                    {act.label}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {m.hasInteractiveCard && (
                          <div className="mt-2.5 border-t border-[#f1f1f3] pt-2">
                            <button
                              type="button"
                              onClick={() => setViewMode('web')}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-[#e4e4e7] bg-[#fafafa] px-2.5 py-1 text-[11.5px] font-medium text-[#3f3f46] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
                            >
                              <Globe className="h-3.5 w-3.5 text-[#52525b]" />
                              包含网页交互预览/卡片 · 切至网页视图操作
                            </button>
                          </div>
                        )}
                      </>
                    );

                    const rawMsgText = (m.text || '').trim();
                    const hasMediaOrActions = Boolean(
                      (m.images && m.images.length > 0) ||
                        (m.videos && m.videos.length > 0) ||
                        (m.audios && m.audios.length > 0) ||
                        (m.actions && m.actions.length > 0) ||
                        m.hasInteractiveCard
                    );

                    // Detect automated system envelopes so they fold into a clean 1-line capsule
                    let systemCapsuleLabel = '';
                    if (m.role === 'user') {
                      if (
                        /^【(?:MuseDeck|FMC)\s*调度协议/i.test(rawMsgText) ||
                        rawMsgText.includes('# MuseDeck 本地多智能体调度协议') ||
                        rawMsgText.includes('# FMC 本地多智能体调度协议') ||
                        rawMsgText.startsWith('【首次连通与站点访问权限预检】')
                      ) {
                        const revM = rawMsgText.match(/Rev\s*#(\d+)/i);
                        systemCapsuleLabel = `⚡ 已静默同步调度协议与接口凭证${revM ? ` (Rev #${revM[1]})` : ''}`;
                      } else if (/^【(?:FMC\s*)?工作流自动回执/.test(rawMsgText)) {
                        const roundM = rawMsgText.match(/第\s*\d+\/\d+\s*轮完成/);
                        systemCapsuleLabel = `📦 已向 Muse 静默回传本地 CLI 执行结果与 Diff${roundM ? ` · ${roundM[0]}` : ''}`;
                      } else if (rawMsgText.startsWith('【用户已批准项目归属】')) {
                        systemCapsuleLabel = '✅ 已向 Muse 同步确认项目归属';
                      } else if (rawMsgText.startsWith('【用户已批准执行方案】')) {
                        systemCapsuleLabel = '✅ 已向 Muse 同步批准执行方案';
                      } else if (
                        rawMsgText.startsWith('【⚡ CLI 额度触顶') ||
                        rawMsgText.startsWith('【额度恢复自动续跑】') ||
                        rawMsgText.startsWith('【额度冷却结束')
                      ) {
                        systemCapsuleLabel = '⚡ 检测到 CLI 限额，已自动触发跨工具无缝接力 / 续跑';
                      } else if (rawMsgText.startsWith('【飞书后台可视化导航代配任务')) {
                        systemCapsuleLabel = '🤖 已委派 Muse 智能接管飞书配置（本地隐私护盾已开启 · 零密钥接触）';
                      }
                    } else if (
                      m.role === 'muse' &&
                      !hasMediaOrActions &&
                      /^Rev\s*#\d+\s*(?:已覆盖|已更新|记下了)/i.test(rawMsgText) &&
                      rawMsgText.length < 360
                    ) {
                      const revM = rawMsgText.match(/Rev\s*#(\d+)/i);
                      systemCapsuleLabel = `✓ Muse 已静默更新协议记忆${revM ? ` (Rev #${revM[1]})` : ''}`;
                    }

                    if (systemCapsuleLabel) {
                      const isExpanded = Boolean(expandedCapsules[i]);
                      return (
                        <div key={i} className="my-1 flex flex-col items-center">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedCapsules((prev) => ({ ...prev, [i]: !prev[i] }))
                            }
                            className="inline-flex items-center gap-1.5 rounded-full border border-[#eaecef] bg-[#fafafa] px-3 py-1 text-[11px] font-medium text-[#71717a] transition-colors hover:border-[#d4d4d8] hover:text-[#111827]"
                          >
                            <span>{systemCapsuleLabel}</span>
                            {m.time && <span className="font-mono text-[10px] text-[#a1a1aa]">· {m.time}</span>}
                            {isExpanded ? (
                              <ChevronDown className="h-3 w-3 text-[#a1a1aa]" />
                            ) : (
                              <ChevronRight className="h-3 w-3 text-[#a1a1aa]" />
                            )}
                          </button>
                          {isExpanded && (
                            <div className="mt-2 max-h-64 w-full max-w-[88%] overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-[#eaecef] bg-[#fafafa] px-3.5 py-2.5 font-mono text-[11px] leading-relaxed text-[#52525b]">
                              {rawMsgText}
                            </div>
                          )}
                        </div>
                      );
                    }

                    // Strip hidden system instruction suffix on Feishu-forwarded user prompts so only clean user text shows
                    let displayUserText = m.text || '';
                    let fromFeishuBadge = false;
                    if (
                      m.role === 'user' &&
                      /^【来自手机飞书的(?:新需求|消息)】/.test(displayUserText)
                    ) {
                      fromFeishuBadge = true;
                      displayUserText = displayUserText
                        .replace(/^【来自手机飞书的(?:新需求|消息)】/, '')
                        .replace(/^（飞书话题串\s*#[^）]+）/, '')
                        .replace(/\n【附带飞书截图已同步粘贴[\s\S]*$/, '')
                        .replace(/\n（(?:请先调用|若这是联网查资料)[\s\S]*$/, '')
                        .trim();
                    }

                    return m.role === 'user' ? (
                      <div key={i} className="flex items-start justify-end gap-2.5">
                        <div className="flex max-w-[76%] flex-col items-end gap-1">
                          <div className="flex items-center gap-1.5 px-1 text-[11px] text-[#8a8f98]">
                            {fromFeishuBadge && (
                              <span className="rounded bg-[#f4f4f5] px-1.5 py-0.5 text-[10px] font-medium text-[#52525b]">
                                手机飞书
                              </span>
                            )}
                            <span className="font-medium text-[#71717a]">你</span>
                            {m.time && (
                              <>
                                <span>·</span>
                                <span className="font-mono text-[10.5px]">{m.time}</span>
                              </>
                            )}
                          </div>
                          <div className="whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-[#f4f4f5] px-4 py-2.5 text-[13.5px] leading-relaxed text-[#111827]">
                            {displayUserText && <div>{displayUserText}</div>}
                            {renderRichMedia()}
                          </div>
                        </div>
                        <div className="mt-4 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#18181b] text-[11px] font-semibold text-white shadow-2xs">
                          你
                        </div>
                      </div>
                    ) : (
                      <div key={i} className="group flex items-start gap-2.5">
                        <div className="mt-4 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#eaecef] bg-white shadow-2xs">
                          {state.muse.avatarUrl ? (
                            state.muse.avatarKind === 'video' ? (
                              <video
                                src={state.muse.avatarUrl}
                                autoPlay
                                loop
                                muted
                                playsInline
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <img
                                src={state.muse.avatarUrl}
                                alt="Muse"
                                className="h-full w-full object-cover"
                              />
                            )
                          ) : (
                            <Sparkles className="h-4 w-4 text-[#52525b]" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center justify-between px-0.5">
                            <div className="flex items-center gap-1.5 text-[11px] text-[#8a8f98]">
                              <span className="font-medium text-[#71717a]">Muse</span>
                              {m.time && (
                                <>
                                  <span>·</span>
                                  <span className="font-mono text-[10.5px]">{m.time}</span>
                                </>
                              )}
                            </div>
                            {m.text && (
                              <button
                                onClick={() => void handleCopyMessage(i, m.text)}
                                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[#8a8f98] opacity-0 transition-all group-hover:opacity-100 hover:bg-[#f4f4f5] hover:text-[#111827]"
                                title="复制回复"
                              >
                                {copiedIdx === i ? (
                                  <Check className="h-3 w-3 text-emerald-600" />
                                ) : (
                                  <Copy className="h-3 w-3" />
                                )}
                                {copiedIdx === i ? '已复制' : '复制'}
                              </button>
                            )}
                          </div>
                          <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-tl-md border border-[#eaecef] bg-white px-4 py-3 text-[13.5px] leading-[1.72] text-[#111827] shadow-2xs">
                            {m.text && <div>{m.text}</div>}
                            {renderRichMedia()}
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

          {/* Floating Codex-style Composer with Perched Pixel Stage */}
          <div className="shrink-0 bg-gradient-to-t from-white via-white to-white/80 px-5 pt-0 pb-4">
            <form onSubmit={(e) => void handleSend(e)} className="mx-auto max-w-[760px]">
              <MusePixelStage
                museAvatarUrl={state.muse.avatarUrl}
                runningCliIds={runningCliIds}
                clis={clis}
                hasUnreadProactive={unreadProactive > 0}
                openQuestionCount={openQuestions.length}
              />
              <div className="relative z-10 rounded-2xl border border-[#e4e4e7] bg-white px-3.5 pt-3 pb-2 shadow-composer transition-all focus-within:border-[#a1a1aa] focus-within:shadow-composer-focus">
                <textarea
                  rows={2}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleSend(e);
                    }
                  }}
                  placeholder="输入消息给 Muse 总管（Enter 发送，Shift+Enter 换行）..."
                  className="w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-[#111827] placeholder-[#a1a1aa] outline-none"
                />

                <div className="mt-1.5 flex items-center justify-between pt-1">
                  <div className="flex items-center gap-2 text-[11.5px] text-[#71717a]">
                    <button
                      type="button"
                      onClick={onNavigateClis}
                      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
                    >
                      <Terminal className="h-3.5 w-3.5 text-[#71717a]" />
                      <span>{enabledCliCountLabel(enabledClis.length)}</span>
                    </button>
                    <button
                      type="button"
                      onClick={onNavigateBridge}
                      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          tunnelStatus.state === 'running' ? 'bg-emerald-500' : 'bg-[#d4d4d8]'
                        }`}
                      />
                      <span>{tunnelStatus.state === 'running' ? '公网 443 就绪' : '隧道未开启'}</span>
                    </button>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <PermissionMenu value={currentPerm} onChange={onChangePermission} />

                    <button
                      type="submit"
                      disabled={sending || !input.trim()}
                      className="flex h-8 w-8 items-center justify-center rounded-full bg-[#18181b] text-white transition-colors hover:bg-[#27272a] disabled:bg-[#e4e4e7] disabled:text-[#a1a1aa]"
                      title="发送"
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

        {/* Collapsible Right Overview Inspector (Codex-style) */}
        {showInspector && (
          <aside className="flex w-[264px] shrink-0 flex-col overflow-y-auto border-l border-[#eaecef] bg-[#fafafa] p-4 text-[12px]">
            <div className="space-y-5">
              {/* Section 1: Overview */}
              <div>
                <div className="mb-2 text-[11px] font-medium text-[#8a8f98]">概览</div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-[#f1f1f3]">
                    <span className="text-[#52525b]">飞书长连接</span>
                    <span className="inline-flex items-center gap-1.5 font-medium text-[#111827]">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          feishuStatus.state === 'connected' ? 'bg-emerald-500' : 'bg-[#d4d4d8]'
                        }`}
                      />
                      {feishuStatus.state === 'connected' ? '在线' : '未连接'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-[#f1f1f3]">
                    <span className="text-[#52525b]">控制 API</span>
                    <span className="font-mono text-[11.5px] text-[#3f3f46]">
                      127.0.0.1:{state.controlApi.port}
                    </span>
                  </div>

                  {activeTunnelUrl && (
                    <button
                      onClick={async () => {
                        await navigator.clipboard.writeText(activeTunnelUrl);
                        setCopiedDomain(true);
                        setTimeout(() => setCopiedDomain(false), 1800);
                      }}
                      className="flex w-full items-center justify-between gap-2 rounded-lg border border-[#eaecef] bg-white px-2.5 py-2 text-left transition-colors hover:border-[#d4d4d8]"
                      title="点击复制公网域名"
                    >
                      <div className="min-w-0">
                        <div className="text-[10.5px] text-[#8a8f98]">公网永久域名</div>
                        <div className="truncate font-mono text-[11px] text-[#111827]">
                          {activeTunnelUrl.replace(/^https?:\/\//, '')}
                        </div>
                      </div>
                      {copiedDomain ? (
                        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                      ) : (
                        <Copy className="h-3.5 w-3.5 shrink-0 text-[#8a8f98]" />
                      )}
                    </button>
                  )}
                </div>
              </div>

              <div className="border-t border-[#eaecef]" />

              {/* Section 2: Open Questions Ledger (for Muse Proactive Follow-up) */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#8a8f98]">
                    <HelpCircle className="h-3 w-3 text-amber-600" />
                    未决议题池 ({openQuestions.length})
                  </span>
                  <button
                    type="button"
                    onClick={() => setAddingQuestion((v) => !v)}
                    className="inline-flex items-center gap-0.5 text-[11px] font-medium text-[#52525b] hover:text-[#111827]"
                    title="添加尚未定论的问题，供 Muse 后续主动思考与调研追问"
                  >
                    <Plus className="h-3 w-3" />
                    记悬念
                  </button>
                </div>

                {addingQuestion && (
                  <form onSubmit={(e) => void handleQuickAddQuestion(e)} className="mb-2 space-y-1.5">
                    <input
                      value={newQuestionText}
                      onChange={(e) => setNewQuestionText(e.target.value)}
                      placeholder="输入待定论的技术/产品问题..."
                      autoFocus
                      className="w-full rounded-lg border border-[#d4d4d8] bg-white px-2.5 py-1.5 text-[11.5px] text-[#111827] outline-none focus:border-[#18181b]"
                    />
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => setAddingQuestion(false)}
                        className="rounded-md px-2 py-0.5 text-[10.5px] text-[#71717a] hover:bg-[#f1f1f3]"
                      >
                        取消
                      </button>
                      <button
                        type="submit"
                        className="rounded-md bg-[#18181b] px-2 py-0.5 text-[10.5px] font-medium text-white hover:bg-[#27272a]"
                      >
                        存入议题池
                      </button>
                    </div>
                  </form>
                )}

                {openQuestions.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-[#e4e4e7] px-2.5 py-2 text-[11px] leading-relaxed text-[#8a8f98]">
                    暂无待定议题。遇到「先放一放 / 还没想好」的问题可随手记下或让 Muse 自动记录，供其后续主动思考追问。
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {openQuestions.slice(0, 6).map((q) => (
                      <div
                        key={q.id}
                        className="rounded-lg border border-[#eaecef] bg-white p-2 shadow-2xs"
                      >
                        <div className="text-[11.5px] font-medium leading-snug text-[#111827]">
                          {q.question}
                        </div>
                        {q.projectName && (
                          <div className="mt-0.5 text-[10px] text-[#8a8f98]">《{q.projectName}》</div>
                        )}
                        <div className="mt-1.5 flex items-center justify-between gap-1 border-t border-[#f4f4f5] pt-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              void window.fmc.mutateOpenQuestion({ action: 'ask_muse', id: q.id })
                            }
                            className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-900 hover:bg-amber-100"
                            title="让 Muse 用云端联网与思考能力分析此议题"
                          >
                            <Sparkles className="h-2.5 w-2.5 text-amber-600" />
                            让 Muse 云端深思
                          </button>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() =>
                                void window.fmc.mutateOpenQuestion({ action: 'resolve', id: q.id })
                              }
                              className="rounded px-1.5 py-0.5 text-[10.5px] text-emerald-700 hover:bg-emerald-50"
                              title="标记为已得出结论"
                            >
                              结项
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void window.fmc.mutateOpenQuestion({ action: 'delete', id: q.id })
                              }
                              className="rounded p-0.5 text-[#a1a1aa] hover:bg-[#f4f4f5] hover:text-red-600"
                              title="删除"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {resolvedQuestions.length > 0 && (
                  <div className="mt-1.5">
                    <button
                      type="button"
                      onClick={() => setShowResolvedQuestions((v) => !v)}
                      className="text-[10.5px] text-[#8a8f98] hover:text-[#111827]"
                    >
                      {showResolvedQuestions
                        ? '收起已结项议题'
                        : `查看已结项 (${resolvedQuestions.length})`}
                    </button>
                    {showResolvedQuestions && (
                      <div className="mt-1 space-y-1">
                        {resolvedQuestions.slice(0, 4).map((rq) => (
                          <div
                            key={rq.id}
                            className="flex items-center justify-between gap-1 rounded bg-[#f4f4f5] px-2 py-1 text-[10.5px] text-[#71717a]"
                          >
                            <span className="truncate line-through">{rq.question}</span>
                            <button
                              type="button"
                              onClick={() =>
                                void window.fmc.mutateOpenQuestion({ action: 'reopen', id: rq.id })
                              }
                              className="shrink-0 text-[#52525b] hover:underline"
                            >
                              重开
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Section 2.5: Cloud Scout Research Notes */}
              {researchNotes.length > 0 && (
                <>
                  <div className="border-t border-[#eaecef]" />
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#8a8f98]">
                        <BookMarked className="h-3 w-3 text-sky-600" />
                        云端调研情报 ({researchNotes.length})
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      {researchNotes.map((note) => (
                        <div
                          key={note.id}
                          className="group flex items-start justify-between gap-1.5 rounded-lg border border-[#eaecef] bg-white p-2 hover:border-[#d4d4d8]"
                        >
                          <button
                            type="button"
                            onClick={() => {
                              if (note.savedFilePath) void window.fmc.openPath(note.savedFilePath);
                            }}
                            className="min-w-0 flex-1 text-left"
                            title={note.savedFilePath || note.summary}
                          >
                            <div className="truncate text-[11.5px] font-medium text-[#111827]">
                              {note.title}
                            </div>
                            <div className="line-clamp-2 text-[10.5px] text-[#71717a]">
                              {note.summary}
                            </div>
                          </button>
                          <button
                            type="button"
                            onClick={() => void window.fmc.deleteResearchNote(note.id)}
                            className="shrink-0 rounded p-0.5 text-[#a1a1aa] opacity-0 group-hover:opacity-100 hover:text-red-600"
                            title="移除记录"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              <div className="border-t border-[#eaecef]" />

              {/* Section 3: Active CLIs */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-medium text-[#8a8f98]">
                    已启用 CLI ({enabledClis.length})
                  </span>
                  <button
                    onClick={onNavigateClis}
                    className="text-[11px] text-[#71717a] hover:text-[#111827]"
                  >
                    管理
                  </button>
                </div>
                {enabledClis.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-[#e4e4e7] px-3 py-2.5 text-[11.5px] text-[#8a8f98]">
                    暂无已启用的本地 CLI
                  </div>
                ) : (
                  <div className="space-y-1">
                    {enabledClis.map((c) => (
                      <div
                        key={c.id}
                        className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-[#f1f1f3]"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: c.badgeColor }}
                          />
                          <span className="truncate font-medium text-[#111827]">{c.name}</span>
                        </div>
                        <span className="max-w-[110px] truncate font-mono text-[10.5px] text-[#71717a]">
                          {c.config.defaultModel || '默认'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t border-[#eaecef]" />

              {/* Section 3: Recent Dispatched Tasks */}
              <div>
                <div className="mb-2 text-[11px] font-medium text-[#8a8f98]">
                  最近调度 ({recentTasks.length})
                </div>
                {recentTasks.length === 0 ? (
                  <p className="px-1 text-[11.5px] text-[#8a8f98]">暂无 CLI 执行记录</p>
                ) : (
                  <div className="space-y-1.5">
                    {recentTasks.map((t) => (
                      <div
                        key={t.id}
                        className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-[#f1f1f3]"
                      >
                        {t.status === 'running' ? (
                          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-amber-500" />
                        ) : t.status === 'error' ? (
                          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                        ) : (
                          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12px] font-medium text-[#111827]">
                            {t.title}
                          </div>
                          <div className="text-[10.5px] text-[#8a8f98]">
                            {t.agentId || 'cli'} / {new Date(t.createdAt).toLocaleTimeString()}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </aside>
        )}
      </div>
      {/* Fullscreen Image Lightbox */}
      {lightboxImg && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-6 backdrop-blur-xs"
          onClick={() => setLightboxImg(null)}
        >
          <div
            className="mb-3 flex items-center gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={async () => {
                const res = await window.fmc.saveMediaFile(lightboxImg.src, lightboxImg.alt || 'muse-image');
                setSaveTip(res.message);
                setTimeout(() => setSaveTip(''), 3000);
              }}
              className="inline-flex items-center gap-1.5 rounded-xl bg-white px-3 py-1.5 text-[12px] font-medium text-[#111827] shadow-sm transition-colors hover:bg-[#f4f4f5]"
            >
              <Download className="h-3.5 w-3.5" />
              {saveTip || '保存图片'}
            </button>
            <button
              type="button"
              onClick={() => setLightboxImg(null)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-white/15 text-white transition-colors hover:bg-white/25"
              title="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <img
            src={lightboxImg.src}
            alt={lightboxImg.alt || 'Muse preview'}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[82vh] max-w-[88vw] rounded-2xl object-contain shadow-2xl"
          />
        </div>
      )}
    </div>
  );
};

function enabledCliCountLabel(count: number): string {
  return count > 0 ? `${count} 个 CLI 已就绪` : '未启用 CLI';
}
