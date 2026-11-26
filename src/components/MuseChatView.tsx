import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Globe,
  Loader2,
  MessageSquare,
  PanelRight,
  Radio,
  Sparkles,
  Terminal,
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
  '列出当前所有项目组，并汇报最近一次任务结果',
  '请测试本地控制接口连通性并回复我结果'
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

          {/* Live Multi-Agent Workflow Progress & HITL Bar */}
          {workflowStatus && workflowStatus.phase !== 'idle' && (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[#eaecef] bg-[#fafafa] px-5 py-2 text-[12px]">
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium ${
                    workflowStatus.phase === 'paused_budget'
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

                    return m.role === 'user' ? (
                      <div key={i} className="flex items-start justify-end gap-2.5">
                        <div className="flex max-w-[76%] flex-col items-end gap-1">
                          <div className="flex items-center gap-1.5 px-1 text-[11px] text-[#8a8f98]">
                            <span className="font-medium text-[#71717a]">你</span>
                            {m.time && (
                              <>
                                <span>·</span>
                                <span className="font-mono text-[10.5px]">{m.time}</span>
                              </>
                            )}
                          </div>
                          <div className="whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-[#f4f4f5] px-4 py-2.5 text-[13.5px] leading-relaxed text-[#111827]">
                            {m.text && <div>{m.text}</div>}
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

              {/* Section 2: Active CLIs */}
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
