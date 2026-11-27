import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Copy,
  ExternalLink,
  Loader2,
  Radio,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles
} from 'lucide-react';
import {
  CliUserConfig,
  DecisionPriorityWeights,
  DetectedCli,
  FeishuAutoStepReport,
  FeishuStatusEvent,
  FmcState,
  ModelRoutingMode,
  MuseExtensionStatus,
  PermissionLevel,
  PlanApprovalMode,
  TunnelStatusEvent,
  WorkflowReviewMode
} from '../types';
import { CliManagerView } from './CliManagerView';
import { EmbeddedBrowserSlot } from './EmbeddedBrowserSlot';
import { FeishuSetupGuide } from './FeishuSetupGuide';

interface OnboardingWizardProps {
  state: FmcState;
  clis: DetectedCli[];
  scanning: boolean;
  feishuStatus: FeishuStatusEvent;
  onRescanClis: () => void;
  onSaveCliConfig: (cliId: string, config: CliUserConfig) => Promise<void>;
  onComplete: () => Promise<void>;
}

const DEFAULT_WEIGHTS: DecisionPriorityWeights = {
  capability: 45,
  price: 25,
  quota: 20,
  speed: 10
};

function rebalanceWeights(
  current: DecisionPriorityWeights,
  changedKey: keyof DecisionPriorityWeights,
  rawNext: number
): DecisionPriorityWeights {
  const nextVal = Math.max(0, Math.min(100, Math.round(rawNext)));
  const remaining = 100 - nextVal;
  const otherKeys = (['capability', 'price', 'quota', 'speed'] as const).filter(
    (k) => k !== changedKey
  );
  const otherSum = otherKeys.reduce((acc, k) => acc + current[k], 0);
  const res: DecisionPriorityWeights = { ...current, [changedKey]: nextVal };
  if (otherSum === 0) {
    const base = Math.floor(remaining / otherKeys.length);
    let rem = remaining - base * otherKeys.length;
    for (const k of otherKeys) {
      res[k] = base + (rem > 0 ? 1 : 0);
      if (rem > 0) rem -= 1;
    }
    return res;
  }
  let assigned = 0;
  otherKeys.forEach((k, idx) => {
    if (idx === otherKeys.length - 1) {
      res[k] = Math.max(0, remaining - assigned);
    } else {
      const share = Math.min(
        remaining - assigned,
        Math.max(0, Math.round((current[k] / otherSum) * remaining))
      );
      res[k] = share;
      assigned += share;
    }
  });
  return res;
}

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({
  state,
  clis,
  scanning,
  feishuStatus,
  onRescanClis,
  onSaveCliConfig,
  onComplete
}) => {
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [appId, setAppId] = useState(state.feishu.appId || '');
  const [appSecret, setAppSecret] = useState(state.feishu.appSecret || '');
  const [museUrl, setMuseUrl] = useState(state.muse.webUrl || 'https://muse.ai');
  const [tunnelUrl, setTunnelUrl] = useState(state.controlApi.tunnelUrl || '');
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatusEvent>({ state: 'stopped' });
  const [copiedKey, setCopiedKey] = useState('');
  const [connecting, setConnecting] = useState(false);

  // Step 2: Workflow & decision policy states
  const [permLevel, setPermLevel] = useState<PermissionLevel>(state.permissionLevel || 'auto');
  const [planMode, setPlanMode] = useState<PlanApprovalMode>(
    state.workflow?.planApprovalMode || 'adaptive'
  );
  const [routingMode, setRoutingMode] = useState<ModelRoutingMode>(
    state.workflow?.modelRoutingMode || 'muse_ask'
  );
  const [reviewMode, setReviewMode] = useState<WorkflowReviewMode>(
    state.workflow?.reviewMode || 'muse_review'
  );
  const [tokenBudget, setTokenBudget] = useState<number>(state.workflow?.tokenBudget ?? 150000);
  const [weights, setWeights] = useState<DecisionPriorityWeights>({
    ...DEFAULT_WEIGHTS,
    ...(state.workflow?.decisionWeights || {})
  });
  const [cloudResearchFirst, setCloudResearchFirst] = useState<boolean>(
    state.workflow?.cloudResearchFirst !== false
  );
  const [proactivePushEnabled, setProactivePushEnabled] = useState<boolean>(
    state.workflow?.proactivePushEnabled !== false
  );
  const [quietHoursEnabled, setQuietHoursEnabled] = useState<boolean>(
    state.workflow?.quietHoursEnabled !== false
  );

  // Step 4 Muse pre-flight & Step 5 Privacy-Shielded Muse Feishu Co-Pilot states
  const [botNameDraft, setBotNameDraft] = useState('MuseDeck');
  const [runningMuseCoPilot, setRunningMuseCoPilot] = useState(false);
  const [runningFeishuAuto, setRunningFeishuAuto] = useState(false);
  const [feishuAutoTip, setFeishuAutoTip] = useState('');
  const [feishuStepReport, setFeishuStepReport] = useState<FeishuAutoStepReport[]>([]);
  const [extStatus, setExtStatus] = useState<MuseExtensionStatus | null>(null);
  const [extTip, setExtTip] = useState('');
  const [testingPerm, setTestingPerm] = useState(false);
  const [permTip, setPermTip] = useState('');
  const [syncingAvatar, setSyncingAvatar] = useState(false);
  const [avatarTip, setAvatarTip] = useState('');

  useEffect(() => {
    if (state.feishu.appId && state.feishu.appId !== appId) {
      setAppId(state.feishu.appId);
    }
    if (state.feishu.appSecret && state.feishu.appSecret !== appSecret) {
      setAppSecret(state.feishu.appSecret);
    }
  }, [state.feishu.appId, state.feishu.appSecret]);

  useEffect(() => {
    void window.fmc.getMuseExtensionStatus().then(setExtStatus);
    const offFeishuAuto = window.fmc.onEvent('autopilot:feishuProgress', (payload) => {
      const p = payload as { message?: string };
      if (p?.message) setFeishuAutoTip(p.message);
    });
    return () => offFeishuAuto();
  }, []);

  useEffect(() => {
    void window.fmc.getTunnelStatus().then((st) => {
      setTunnelStatus(st);
      if (st.url) setTunnelUrl(st.url);
    });
    const off = window.fmc.onEvent('tunnel:status', (payload) => {
      const st = payload as TunnelStatusEvent;
      setTunnelStatus(st);
      if (st.url) setTunnelUrl(st.url);
    });
    return () => off();
  }, []);

  const trimmedAppId = appId.trim();
  const trimmedAppSecret = appSecret.trim();
  const isCurrentFeishuSaved =
    Boolean(trimmedAppId) &&
    trimmedAppId === (state.feishu.appId || '').trim() &&
    trimmedAppSecret === (state.feishu.appSecret || '').trim();
  const hasUnsavedFeishuDraft =
    Boolean(trimmedAppId || trimmedAppSecret) && !isCurrentFeishuSaved;
  const isFeishuConnected =
    isCurrentFeishuSaved &&
    feishuStatus.state === 'connected' &&
    (!feishuStatus.connectedAppId || feishuStatus.connectedAppId === trimmedAppId);
  const isFeishuVerified = Boolean(
    isCurrentFeishuSaved &&
      state.feishu.verified &&
      state.feishu.verifiedAppId === trimmedAppId
  );
  const feishuBotAppLink = /^cli_[a-zA-Z0-9]+$/.test(trimmedAppId)
    ? `https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(trimmedAppId)}`
    : '';
  const enabledCount = clis.filter((c) => c.config.enabled).length;
  const isTunnelReady = Boolean(tunnelStatus.state === 'running' || tunnelUrl.trim());
  const isMuseVerified = Boolean(state.muse.tunnelVerified);

  const copyText = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(''), 2000);
  };

  const handleConnectFeishu = async () => {
    setConnecting(true);
    try {
      await window.fmc.connectFeishu(appId, appSecret);
    } finally {
      setConnecting(false);
    }
  };

  const handleRunMuseCoPilot = async () => {
    if (runningMuseCoPilot || runningFeishuAuto) return;
    setRunningMuseCoPilot(true);
    setFeishuStepReport([]);
    setFeishuAutoTip('正在检查左侧飞书登录态并开启本地隐私脱敏护盾唤醒 Muse...');
    try {
      const res = await window.fmc.runMuseFeishuCoPilot({
        botName: botNameDraft
      });
      setFeishuAutoTip(res.message);
    } finally {
      setRunningMuseCoPilot(false);
    }
  };

  const handleRunFeishuAutoPilot = async () => {
    if (runningFeishuAuto || runningMuseCoPilot) return;
    setRunningFeishuAuto(true);
    setFeishuStepReport([]);
    setFeishuAutoTip('正在检查左侧飞书开放平台登录态并执行本地脚本代配...');
    try {
      const res = await window.fmc.runFeishuAutoPilot({
        botName: botNameDraft,
        existingAppId: appId.trim() || undefined
      });
      if (res.appId) setAppId(res.appId);
      if (res.appSecret) setAppSecret(res.appSecret);
      if (res.stepReport) setFeishuStepReport(res.stepReport);
      setFeishuAutoTip(res.message);
    } finally {
      setRunningFeishuAuto(false);
    }
  };

  const handleToggleTailscale = async () => {
    if (tunnelStatus.state === 'running' || tunnelStatus.state === 'starting') {
      const st = await window.fmc.stopTunnel();
      setTunnelStatus(st);
    } else {
      setTunnelStatus({
        state: 'starting',
        mode: 'tailscale',
        message: '正在启动内嵌 Tailscale 永久 443 域名...'
      });
      const st = await window.fmc.startTailscaleTunnel();
      setTunnelStatus(st);
      if (st.url) setTunnelUrl(st.url);
    }
  };

  const handleStartServeo = async () => {
    setTunnelStatus({
      state: 'starting',
      mode: 'serveo',
      message: '正在连接免注册 Serveo 443 HTTPS 隧道...'
    });
    const st = await window.fmc.startServeoTunnel();
    setTunnelStatus(st);
    if (st.url) setTunnelUrl(st.url);
  };

  const handleSaveStep2AndNext = async () => {
    await window.fmc.setPermissionLevel(permLevel);
    await window.fmc.updateWorkflowConfig({
      planApprovalMode: planMode,
      modelRoutingMode: routingMode,
      reviewMode,
      tokenBudget,
      decisionWeights: weights,
      cloudResearchFirst,
      proactivePushEnabled,
      quietHoursEnabled
    });
    goStep(3);
  };

  const handleTriggerPreflight = async () => {
    if (testingPerm) return;
    setTestingPerm(true);
    setPermTip('正在同步最新协议并让 Muse 发起连通性握手...');
    try {
      await window.fmc.updateControlApi({ tunnelUrl });
      const res = await window.fmc.testMuseSitePermission();
      setPermTip(res.message);
    } finally {
      setTestingPerm(false);
    }
  };

  const handleAutoClickAllow = async () => {
    const res = await window.fmc.autoClickMuseAlwaysAllow();
    setPermTip(res.message);
  };

  const handleCopyBrief = async () => {
    await window.fmc.updateControlApi({ tunnelUrl });
    const brief = await window.fmc.getMuseBrief();
    await copyText('brief', brief);
  };

  const goStep = (next: 1 | 2 | 3 | 4 | 5) => {
    void window.fmc.hideEmbeddedViews();
    setStep(next);
  };

  const steps = [
    { num: 1 as const, label: '本地 CLI', done: enabledCount > 0 },
    { num: 2 as const, label: '决策与预算', done: step > 2 },
    { num: 3 as const, label: '公网隧道', done: isTunnelReady },
    { num: 4 as const, label: '连通 Muse', done: isMuseVerified },
    { num: 5 as const, label: '飞书机器人', done: isFeishuVerified }
  ];

  return (
    <div className="flex h-screen flex-col bg-white text-[#111827] select-none">
      {/* Unified Minimalist Top Header */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[#eaecef] bg-white px-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#18181b] text-[12px] font-bold text-white">
            M
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-semibold tracking-tight text-[#111827]">
              MuseDeck
            </span>
            <span className="rounded-md bg-[#f4f4f5] px-2 py-0.5 text-[11px] font-medium text-[#71717a]">
              初始配置向导
            </span>
          </div>
        </div>

        {/* 5-Step Segmented Stepper */}
        <div className="flex items-center rounded-xl bg-[#f4f4f5] p-1 text-[11.5px]">
          {steps.map((item) => {
            const active = step === item.num;
            return (
              <button
                key={item.num}
                onClick={() => goStep(item.num)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 font-medium transition-all ${
                  active
                    ? 'bg-white text-[#111827] shadow-2xs'
                    : 'text-[#71717a] hover:text-[#111827]'
                }`}
              >
                {item.done ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                ) : (
                  <span
                    className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
                      active ? 'bg-[#18181b] text-white' : 'bg-[#e4e4e7] text-[#52525b]'
                    }`}
                  >
                    {item.num}
                  </span>
                )}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        <button
          onClick={() => void onComplete()}
          className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-[#71717a] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
        >
          跳过向导
        </button>
      </header>

      {/* Main Content */}
      <div className="min-h-0 flex-1 overflow-hidden select-text">
        {/* ================= STEP 1: LOCAL CLIs & MODEL SCANNING ================= */}
        {step === 1 && (
          <div className="flex h-full flex-col bg-white">
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
              <div className="mx-auto max-w-[940px]">
                <div className="mb-4">
                  <h2 className="text-[15px] font-semibold text-[#111827]">
                    第 1 步：选择并配置本机 AI 编程 CLI（沙箱隔离，不改本机原配置）
                  </h2>
                  <p className="mt-1 text-[12px] text-[#71717a]">
                    勾选你要启用的 CLI（启用 2 个以上可在某一个额度耗尽时由 Muse 自动无缝接力！），点击卡片上的「配置」可扫描可用模型。
                  </p>
                </div>
                <CliManagerView
                  clis={clis}
                  scanning={scanning}
                  onRescan={onRescanClis}
                  onSaveConfig={onSaveCliConfig}
                  compact
                />
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-between border-t border-[#eaecef] bg-white px-6 py-3">
              <span className="text-[12px] text-[#71717a]">
                当前已启用 <strong className="text-[#111827]">{enabledCount}</strong> 个本地 CLI
              </span>
              <button
                onClick={() => goStep(2)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#18181b] px-4 py-2 text-[12.5px] font-medium text-white transition-colors hover:bg-[#27272a]"
              >
                下一步：决策与预算策略
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* ================= STEP 2: WORKFLOW, ROUTING & 100% PRIORITY WEIGHTS ================= */}
        {step === 2 && (
          <div className="flex h-full flex-col bg-[#fafafa]">
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
              <div className="mx-auto max-w-[820px] space-y-4 text-[12.5px]">
                <div>
                  <h2 className="text-[15px] font-semibold text-[#111827]">
                    第 2 步：设定 Muse 智能决策、审批与预算护栏（进入软件后可随时在「软件设置」修改）
                  </h2>
                  <p className="mt-0.5 text-[12px] text-[#71717a]">
                    决定 Muse 如何为你确认方案、如何为每个子任务挑选最划算的模型，以及单次任务的预算上限。
                  </p>
                </div>

                {/* 1. Pre-execution approval */}
                <section className="rounded-2xl border border-[#eaecef] bg-white p-4">
                  <div className="font-semibold text-[#111827]">1. 执行前方案审批策略</div>
                  <p className="mt-0.5 text-[11.5px] text-[#71717a]">
                    每次收到新需求先确认所属项目，随后按以下策略决定是否等你批准方案再派单
                  </p>
                  <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                    {(
                      [
                        {
                          id: 'adaptive',
                          title: '用户习惯（自适应·推荐）',
                          desc: '结合任务复杂度与你沉淀的习惯自主决定先报方案还是直接做'
                        },
                        {
                          id: 'always',
                          title: '总是先报方案等批准',
                          desc: '硬门控：每次必须经你批准分工与方案后才允许调用本地 CLI'
                        },
                        {
                          id: 'never',
                          title: '直接执行（跳过方案审批）',
                          desc: '确认项目后直接拆单开工，适合追求全自动冲刺'
                        }
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setPlanMode(opt.id)}
                        className={`rounded-xl border p-3 text-left transition-colors ${
                          planMode === opt.id
                            ? 'border-[#18181b] bg-[#fafafa]'
                            : 'border-[#eaecef] hover:bg-[#fafafa]'
                        }`}
                      >
                        <div className="font-medium text-[#111827]">{opt.title}</div>
                        <div className="mt-0.5 text-[11px] text-[#71717a]">{opt.desc}</div>
                      </button>
                    ))}
                  </div>
                </section>

                {/* 2. Model & Task Routing + 100% Priority Weights */}
                <section className="rounded-2xl border border-[#eaecef] bg-white p-4">
                  <div className="font-semibold text-[#111827]">
                    2. 项目模型与分工决策 + 100% 优先级权重
                  </div>
                  <p className="mt-0.5 text-[11.5px] text-[#71717a]">
                    支持读取所有已开 CLI 的全量模型池与每日权威榜单，同一个 CLI 下可用不同模型处理不同子任务，且当某个 CLI 额度触顶时按此权重自动无缝换工具接力
                  </p>
                  <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                    {(
                      [
                        {
                          id: 'muse_ask',
                          title: 'Muse 问询决策（推荐）',
                          desc: '对比【你的默认配置】与【Muse 性价比推荐配置】请你二选一'
                        },
                        {
                          id: 'muse_auto',
                          title: 'Muse 智能决策',
                          desc: '按子任务专长与下方权重自动匹配最优 CLI + 模型 + 思考等级'
                        },
                        {
                          id: 'user_default',
                          title: '用户默认设定',
                          desc: '严格固定使用你在 CLI 管理里设置的默认模型与思考等级'
                        }
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setRoutingMode(opt.id)}
                        className={`rounded-xl border p-3 text-left transition-colors ${
                          routingMode === opt.id
                            ? 'border-[#18181b] bg-[#fafafa]'
                            : 'border-[#eaecef] hover:bg-[#fafafa]'
                        }`}
                      >
                        <div className="font-medium text-[#111827]">{opt.title}</div>
                        <div className="mt-0.5 text-[11px] text-[#71717a]">{opt.desc}</div>
                      </button>
                    ))}
                  </div>

                  {/* 100% Priority Sliders */}
                  <div className="mt-3.5 rounded-xl border border-[#eaecef] bg-[#fafafa] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[12px] font-medium text-[#111827]">
                        决策优先级配比（总计{' '}
                        <span className="font-mono text-emerald-700">
                          {weights.capability + weights.price + weights.quota + weights.speed}%
                        </span>
                        ）
                      </span>
                      <div className="flex gap-1">
                        {[
                          { label: '均衡推荐', w: { capability: 45, price: 25, quota: 20, speed: 10 } },
                          { label: '质量优先', w: { capability: 65, price: 10, quota: 15, speed: 10 } },
                          { label: '极致省钱', w: { capability: 25, price: 40, quota: 25, speed: 10 } }
                        ].map((p) => (
                          <button
                            key={p.label}
                            type="button"
                            onClick={() => setWeights(p.w)}
                            className="rounded-md border border-[#e4e4e7] bg-white px-2 py-0.5 text-[10.5px] font-medium text-[#52525b] hover:border-[#18181b] hover:text-[#111827]"
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {(
                        [
                          { key: 'capability', label: '模型能力' },
                          { key: 'price', label: '价格性价比' },
                          { key: 'quota', label: '剩余额度/限额' },
                          { key: 'speed', label: '响应速度' }
                        ] as const
                      ).map((it) => (
                        <div
                          key={it.key}
                          className="rounded-lg border border-[#eaecef] bg-white px-2.5 py-2"
                        >
                          <div className="flex items-center justify-between text-[11.5px]">
                            <span className="font-medium text-[#3f3f46]">{it.label}</span>
                            <span className="font-mono font-semibold text-[#111827]">
                              {weights[it.key]}%
                            </span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={weights[it.key]}
                            onChange={(e) =>
                              setWeights(
                                rebalanceWeights(weights, it.key, Number.parseInt(e.target.value, 10))
                              )
                            }
                            className="mt-1 h-1.5 w-full cursor-pointer accent-[#18181b]"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </section>

                {/* 3. Review Mode, Permission Level & Token Budget */}
                <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="rounded-2xl border border-[#eaecef] bg-white p-4">
                    <div className="font-semibold text-[#111827]">3. 本地 CLI 执行权限等级</div>
                    <div className="mt-2.5 grid grid-cols-2 gap-1.5">
                      {(
                        [
                          { id: 'auto', label: '自动编辑（推荐）' },
                          { id: 'turbo', label: 'Turbo 全放行' },
                          { id: 'default', label: '默认安全确认' },
                          { id: 'ask_review', label: '只读规划模式' }
                        ] as const
                      ).map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setPermLevel(p.id)}
                          className={`rounded-xl border px-2.5 py-2 text-[11.5px] font-medium transition-colors ${
                            permLevel === p.id
                              ? 'border-[#18181b] bg-[#18181b] text-white'
                              : 'border-[#eaecef] bg-[#fafafa] text-[#3f3f46] hover:bg-[#f4f4f5]'
                          }`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-[#eaecef] bg-white p-4">
                    <div className="font-semibold text-[#111827]">4. 完工审阅与单次预算护栏</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {(
                        [
                          { id: 'muse_review', label: 'Muse 先审阅再问我' },
                          { id: 'direct_user', label: '跑完直接问我' },
                          { id: 'auto_sprint', label: '自动闭环冲刺' }
                        ] as const
                      ).map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => setReviewMode(r.id)}
                          className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium ${
                            reviewMode === r.id
                              ? 'border-[#18181b] bg-[#fafafa] text-[#111827]'
                              : 'border-[#eaecef] text-[#71717a]'
                          }`}
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2.5 flex items-center justify-between gap-2">
                      <span className="text-[11.5px] text-[#71717a]">单需求预算上限：</span>
                      <div className="flex rounded-lg bg-[#f4f4f5] p-0.5">
                        {[
                          { v: 50000, l: '50k' },
                          { v: 150000, l: '150k' },
                          { v: 300000, l: '300k' },
                          { v: 0, l: '不限' }
                        ].map((b) => (
                          <button
                            key={b.v}
                            type="button"
                            onClick={() => setTokenBudget(b.v)}
                            className={`rounded-md px-2 py-0.5 font-mono text-[11px] font-medium ${
                              tokenBudget === b.v ? 'bg-white text-[#111827] shadow-2xs' : 'text-[#71717a]'
                            }`}
                          >
                            {b.l}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>

                {/* 5. Cloud Scout & Proactive Muse Superpowers */}
                <section className="rounded-2xl border border-[#eaecef] bg-white p-4">
                  <div className="font-semibold text-[#111827]">
                    5. Muse 云端探路与主动思考推送（推荐全开）
                  </div>
                  <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-[#eaecef] bg-[#fafafa] p-3">
                      <input
                        type="checkbox"
                        checked={cloudResearchFirst}
                        onChange={(e) => setCloudResearchFirst(e.target.checked)}
                        className="mt-0.5 accent-[#18181b]"
                      />
                      <div>
                        <div className="font-medium text-[#111827]">云端探路 + 本地施工协同</div>
                        <div className="mt-0.5 text-[11px] leading-relaxed text-[#71717a]">
                          联网搜索、查最新文档与云端网页操作直接由 Muse 完成（零本地 CLI 额度消耗），情报自动落盘供本地 CLI 施工。
                        </div>
                      </div>
                    </label>

                    <div className="rounded-xl border border-[#eaecef] bg-[#fafafa] p-3">
                      <label className="flex cursor-pointer items-start gap-2.5">
                        <input
                          type="checkbox"
                          checked={proactivePushEnabled}
                          onChange={(e) => setProactivePushEnabled(e.target.checked)}
                          className="mt-0.5 accent-[#18181b]"
                        />
                        <div>
                          <div className="font-medium text-[#111827]">主动思考实时推送飞书与桌面</div>
                          <div className="mt-0.5 text-[11px] leading-relaxed text-[#71717a]">
                            自动记录未定论议题；当 Muse 不定时主动追问时实时推送到手机飞书与桌面通知。
                          </div>
                        </div>
                      </label>
                      {proactivePushEnabled && (
                        <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 pl-6 text-[11px] font-medium text-[#52525b]">
                          <input
                            type="checkbox"
                            checked={quietHoursEnabled}
                            onChange={(e) => setQuietHoursEnabled(e.target.checked)}
                            className="accent-[#18181b]"
                          />
                          开启夜间免打扰（23:00–08:00 静音不推飞书，可在设置调整时段）
                        </label>
                      )}
                    </div>
                  </div>
                </section>
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-between border-t border-[#eaecef] bg-white px-6 py-3">
              <button
                onClick={() => goStep(1)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[#e4e4e7] bg-white px-3.5 py-2 text-[12.5px] font-medium text-[#52525b] hover:bg-[#f4f4f5]"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                上一步
              </button>
              <button
                onClick={() => void handleSaveStep2AndNext()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#18181b] px-4 py-2 text-[12.5px] font-medium text-white hover:bg-[#27272a]"
              >
                保存策略，下一步：开启公网隧道
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* ================= STEP 3: HTTPS 443 TUNNEL ================= */}
        {step === 3 && (
          <div className="flex h-full flex-col bg-[#fafafa]">
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
              <div className="mx-auto max-w-[740px] space-y-4 text-[12.5px]">
                <div>
                  <h2 className="text-[15px] font-semibold text-[#111827]">
                    第 3 步：开启 443 HTTPS 公网穿透（让云端 Meta Muse 能访问你的本机接口）
                  </h2>
                  <p className="mt-0.5 text-[12px] text-[#71717a]">
                    推荐使用内置的 <strong>Tailscale Funnel</strong>：无需安装客户端、无需云服务器，完成一次免费网页授权即可获得<strong>永久不变的 .ts.net 域名</strong>。
                  </p>
                </div>

                <section className="rounded-2xl border border-[#eaecef] bg-white p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[13.5px] font-semibold text-[#111827]">
                        内嵌 Tailscale 永久 443 隧道
                      </div>
                      <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                        本地控制端口 127.0.0.1:{state.controlApi.port}（带随机 Bearer Token 鉴权保护）
                      </div>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11.5px] font-medium ${
                        tunnelStatus.state === 'running'
                          ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200'
                          : tunnelStatus.state === 'starting'
                            ? 'bg-amber-50 text-amber-800 ring-1 ring-amber-200'
                            : 'bg-[#f4f4f5] text-[#52525b]'
                      }`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${
                          tunnelStatus.state === 'running'
                            ? 'bg-emerald-500'
                            : tunnelStatus.state === 'starting'
                              ? 'animate-pulse bg-amber-500'
                              : 'bg-[#a1a1aa]'
                        }`}
                      />
                      {tunnelStatus.state === 'running'
                        ? '永久域名已在线'
                        : tunnelStatus.state === 'starting'
                          ? '等待浏览器网页授权...'
                          : '尚未启动'}
                    </span>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2.5">
                    <button
                      onClick={() => void handleToggleTailscale()}
                      className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-[12.5px] font-medium transition-colors ${
                        tunnelStatus.state === 'running' || tunnelStatus.state === 'starting'
                          ? 'border border-[#e4e4e7] bg-[#f4f4f5] text-[#111827] hover:bg-[#e4e4e7]'
                          : 'bg-[#18181b] text-white hover:bg-[#27272a]'
                      }`}
                    >
                      {tunnelStatus.state === 'starting' ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Cloud className="h-4 w-4" />
                      )}
                      {tunnelStatus.state === 'running'
                        ? '停止内嵌隧道'
                        : tunnelStatus.state === 'starting'
                          ? '正在等待网页授权（点击可取消）'
                          : '一键启动 Tailscale 永久 443 域名（推荐）'}
                    </button>

                    {tunnelStatus.state !== 'running' && (
                      <button
                        type="button"
                        onClick={() => void handleStartServeo()}
                        className="rounded-xl border border-[#e4e4e7] bg-white px-3.5 py-2.5 text-[12px] font-medium text-[#52525b] hover:bg-[#f4f4f5] hover:text-[#111827]"
                        title="无需注册账号的临时备用 HTTPS 隧道"
                      >
                        改用免注册临时隧道 (Serveo)
                      </button>
                    )}
                  </div>

                  {tunnelStatus.authUrl && tunnelStatus.state !== 'running' && (
                    <div className="mt-3.5 rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-[12px] text-amber-950">
                      <div className="flex items-center justify-between gap-2 font-semibold">
                        <span>已弹出 Tailscale 自动授权小窗（若未看到请点击右侧打开）：</span>
                        <button
                          type="button"
                          onClick={() => void window.fmc.openExternal(tunnelStatus.authUrl!)}
                          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[#18181b] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#27272a]"
                        >
                          <ExternalLink className="h-3 w-3" />
                          打开授权网页
                        </button>
                      </div>
                      <div className="mt-1 break-all font-mono text-[11px] text-amber-800">
                        {tunnelStatus.authUrl}
                      </div>
                    </div>
                  )}

                  {tunnelStatus.message && (
                    <p
                      className={`mt-2.5 text-[11.5px] ${
                        tunnelStatus.state === 'error'
                          ? 'text-red-600'
                          : tunnelStatus.state === 'running'
                            ? 'font-medium text-emerald-700'
                            : 'text-[#71717a]'
                      }`}
                    >
                      {tunnelStatus.message}
                    </p>
                  )}

                  <div className="mt-3">
                    <label className="mb-1 block text-[11.5px] font-medium text-[#52525b]">
                      当前公网 HTTPS 地址（成功后自动填入，也可手动粘贴自定义反代域名）：
                    </label>
                    <input
                      value={tunnelUrl}
                      onChange={(e) => setTunnelUrl(e.target.value)}
                      placeholder="https://fmc-hub.tailxxxx.ts.net"
                      className="w-full rounded-xl border border-[#e4e4e7] bg-[#fafafa] px-3 py-2 font-mono text-[12px] text-[#111827] outline-none focus:border-[#18181b] focus:bg-white"
                    />
                  </div>
                </section>

                <section className="rounded-2xl border border-[#eaecef] bg-white p-5">
                  <h3 className="text-[13px] font-semibold text-[#111827]">
                    Tailscale 自动授权说明（内置本地自动点击助手）
                  </h3>
                  <ol className="mt-2.5 list-decimal space-y-2 pl-4 text-[12px] leading-relaxed text-[#52525b]">
                    <li>
                      <strong>自动弹出本地授权窗口：</strong>点击上方启动按钮后，使用{' '}
                      <strong>Google / GitHub / Microsoft</strong> 登录一次，内置助手会<strong>自动点击「Connect」与「Enable Funnel」</strong>。
                    </li>
                    <li>
                      <strong>首次若提示需先开 HTTPS：</strong>进入顶部 <strong>DNS</strong> 标签页，滑到底部开启{' '}
                      <strong>MagicDNS</strong> 与 <strong>Enable HTTPS</strong> 即可。
                    </li>
                    <li>
                      <strong>自动回填并关闭窗口：</strong>授权通过后约 3~8 秒自动获取专属 <code className="rounded bg-[#f4f4f5] px-1">.ts.net</code> 永久域名并自动关闭小窗。
                    </li>
                  </ol>
                </section>
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-between border-t border-[#eaecef] bg-white px-6 py-3">
              <button
                onClick={() => goStep(2)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[#e4e4e7] bg-white px-3.5 py-2 text-[12.5px] font-medium text-[#52525b] hover:bg-[#f4f4f5]"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                上一步
              </button>
              <button
                onClick={() => goStep(4)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#18181b] px-4 py-2 text-[12.5px] font-medium text-white hover:bg-[#27272a]"
              >
                下一步：登录 Muse 并授权站点权限
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* ================= STEP 4: MUSE LOGIN & SITE PERMISSION PRE-FLIGHT ================= */}
        {step === 4 && (
          <div className="grid h-full grid-cols-12">
            <div className="col-span-7 h-full border-r border-[#eaecef]">
              <EmbeddedBrowserSlot
                target="muse"
                initialUrl={museUrl}
                visible={step === 4}
                presets={[
                  { label: 'Meta Muse', url: 'https://muse.ai' },
                  { label: '飞书网页版', url: 'https://www.feishu.cn/messenger/' }
                ]}
              />
            </div>

            <div className="col-span-5 flex h-full flex-col overflow-hidden bg-[#fafafa]">
              <div className="flex-1 space-y-4 overflow-y-auto p-5 text-[12.5px]">
                <section className="rounded-2xl border border-[#eaecef] bg-white p-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-[13.5px] font-semibold text-[#111827]">
                      1. 登录左侧 Meta Muse 账号
                    </h2>
                    <button
                      type="button"
                      disabled={syncingAvatar}
                      onClick={async () => {
                        setSyncingAvatar(true);
                        try {
                          const r = await window.fmc.fetchMuseAvatar();
                          setAvatarTip(r.ok ? '已同步 Muse 形象' : r.message || '');
                        } finally {
                          setSyncingAvatar(false);
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-[#e4e4e7] px-2 py-0.5 text-[11px] font-medium text-[#3f3f46] hover:bg-[#f4f4f5]"
                    >
                      <RefreshCw className={`h-3 w-3 ${syncingAvatar ? 'animate-spin' : ''}`} />
                      同步形象
                    </button>
                  </div>
                  <div className="mt-2.5 flex items-start gap-1.5 rounded-xl border border-amber-200/80 bg-amber-50/70 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
                    <span className="shrink-0">🌐</span>
                    <span>
                      <strong>网络提示：</strong>Meta Muse（muse.ai）在国内直连网络下无法打开。若左侧空白或转圈，请开启系统代理或 TUN 模式后再点刷新。
                    </span>
                  </div>
                  <div className="mt-2.5 flex gap-2">
                    <input
                      value={museUrl}
                      onChange={(e) => setMuseUrl(e.target.value)}
                      className="min-w-0 flex-1 rounded-xl border border-[#e4e4e7] bg-white px-3 py-1.5 font-mono text-[11.5px] text-[#111827] outline-none focus:border-[#18181b]"
                    />
                    <button
                      onClick={() => {
                        void window.fmc.updateMuseConfig({ webUrl: museUrl });
                        void window.fmc.navigateEmbeddedView('muse', museUrl);
                      }}
                      className="rounded-xl border border-[#e4e4e7] bg-[#fafafa] px-3 py-1.5 text-[12px] font-medium text-[#3f3f46] hover:bg-[#f4f4f5]"
                    >
                      跳转
                    </button>
                  </div>
                  {avatarTip && <p className="mt-1.5 text-[11px] text-emerald-700">{avatarTip}</p>}
                </section>

                <section className="rounded-2xl border border-[#18181b] bg-white p-4 shadow-2xs">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="flex items-center gap-1.5 text-[13.5px] font-semibold text-[#111827]">
                      <ShieldCheck className="h-4 w-4 text-[#18181b]" />
                      2. 发送协议并提前授权「总是允许此站点」（关键！）
                    </h2>
                    {isMuseVerified && (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-800">
                        已打通
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-[#52525b]">
                    先在这里完成一次性站点授权握手，下一步即可直接让上岗的 Muse 帮你智能接管配置飞书机器人！
                  </p>

                  <ol className="mt-2.5 list-decimal space-y-1.5 pl-4 text-[11.5px] text-[#3f3f46]">
                    <li>确保左侧已登录进入与 Muse 的聊天对话框；</li>
                    <li>点击下方黑色按钮「<strong>发送协议并触发站点权限预检</strong>」；</li>
                    <li>
                      当左侧 Muse 弹出是否允许访问你的 <code className="rounded bg-[#f4f4f5] px-1">.ts.net</code> 域名时，点击 <strong>「总是允许此站点」</strong>（或点下方辅助按钮自动点）！
                    </li>
                  </ol>

                  <div className="mt-3 space-y-2">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void handleTriggerPreflight()}
                        disabled={testingPerm}
                        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#18181b] px-3.5 py-2 text-[12px] font-medium text-white transition-colors hover:bg-[#27272a] disabled:opacity-50"
                      >
                        {testingPerm ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Send className="h-3.5 w-3.5" />
                        )}
                        发送协议并触发站点权限预检
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleCopyBrief()}
                        className="inline-flex items-center gap-1 rounded-xl border border-[#e4e4e7] bg-white px-3 py-2 text-[11.5px] font-medium text-[#3f3f46] hover:bg-[#f4f4f5]"
                        title="手动复制协议备用"
                      >
                        {copiedKey === 'brief' ? (
                          <Check className="h-3.5 w-3.5 text-emerald-600" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        复制协议
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleAutoClickAllow()}
                      className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-[#e4e4e7] bg-[#fafafa] px-3 py-1.5 text-[11.5px] font-medium text-[#3f3f46] transition-colors hover:border-[#18181b] hover:bg-white hover:text-[#111827]"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      若左侧已弹出权限询问，点此自动点击「总是允许此站点」
                    </button>
                  </div>

                  {permTip && (
                    <p className="mt-2 text-[11px] leading-relaxed text-[#52525b]">{permTip}</p>
                  )}

                  <div
                    className={`mt-3 rounded-xl border px-3 py-2.5 text-[11.5px] ${
                      isMuseVerified
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                        : 'border-[#eaecef] bg-[#fafafa] text-[#71717a]'
                    }`}
                  >
                    {isMuseVerified ? (
                      <div className="flex items-center gap-1.5 font-medium">
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                        <span>
                          双向握手验证成功！Muse 已正式打通本机接口，现在点「下一步」即可让 Muse 接管配置你的飞书机器人！
                        </span>
                      </div>
                    ) : (
                      <span>
                        等待 Muse 访问本机接口验证中……一旦你在左侧点完「总是允许此站点」，此处会自动变绿。
                      </span>
                    )}
                  </div>
                </section>

                <section className="rounded-2xl border border-[#eaecef] bg-white p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-[13px] font-semibold text-[#111827]">
                      3. 本地真实 IP 浏览器联动（防云端 IP 风控 · 可选增强）
                    </h2>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${
                        extStatus?.installed
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-[#f4f4f5] text-[#52525b]'
                      }`}
                    >
                      {extStatus?.installed
                        ? `已装官方插件 v${extStatus.version || ''}`
                        : '内置本地浏览器已就绪'}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-[#52525b]">
                    {extStatus?.installed
                      ? `已检测到你本机 ${extStatus.browser === 'edge' ? 'Edge' : 'Chrome'} 安装了官方「Muse from Meta」插件！同时 MuseDeck 已内置隐私脱敏受控浏览器双保险。`
                      : 'MuseDeck 已内置本地 IP 隐私脱敏受控浏览器供 Muse 调用；你也可在本机 Chrome 安装官方「Muse from Meta」扩展。'}
                  </p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        const r = await window.fmc.launchMuseExtensionHost(!extStatus?.installed);
                        setExtStatus(r.status);
                        setExtTip(r.message);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-[#18181b] px-3 py-1.5 text-[11.5px] font-medium text-white hover:bg-[#27272a]"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {extStatus?.installed ? '唤醒本机 Chrome 官方插件' : '前往安装官方 Muse 插件'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void window.fmc.openLocalControlledBrowser()}
                      className="inline-flex items-center gap-1 rounded-xl border border-[#e4e4e7] bg-[#fafafa] px-2.5 py-1.5 text-[11.5px] font-medium text-[#3f3f46] hover:bg-[#f4f4f5]"
                    >
                      打开内置本地浏览器
                    </button>
                  </div>
                  {extTip && <p className="mt-1.5 text-[11px] text-[#52525b]">{extTip}</p>}
                </section>
              </div>

              <div className="flex shrink-0 items-center justify-between border-t border-[#eaecef] bg-white px-5 py-3">
                <button
                  onClick={() => goStep(3)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-[#e4e4e7] bg-white px-3.5 py-2 text-[12.5px] font-medium text-[#52525b] hover:bg-[#f4f4f5]"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  上一步
                </button>
                <button
                  onClick={() => goStep(5)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[#18181b] px-4 py-2 text-[12.5px] font-medium text-white hover:bg-[#27272a]"
                >
                  下一步：配置飞书机器人（支持 Muse 接管）
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ================= STEP 5: FEISHU BOT (PRIVACY-SHIELDED MUSE CO-PILOT) ================= */}
        {step === 5 && (
          <div className="grid h-full grid-cols-12">
            <div className="col-span-7 h-full border-r border-[#eaecef]">
              <EmbeddedBrowserSlot
                target="feishu"
                initialUrl="https://open.feishu.cn/app"
                visible={step === 5}
                presets={[
                  { label: '飞书开放平台', url: 'https://open.feishu.cn/app' },
                  { label: '飞书网页版', url: 'https://www.feishu.cn/messenger/' }
                ]}
              />
            </div>

            <div className="col-span-5 flex h-full flex-col overflow-hidden bg-[#fafafa]">
              <div className="flex-1 space-y-4 overflow-y-auto p-5">
                {/* Privacy-Shielded Muse Co-Pilot Card */}
                <section className="rounded-2xl border border-[#18181b] bg-white p-4 shadow-2xs">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-[#111827]">
                      <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                      扫码后让 Muse 智能接管配置（本地隐私脱敏护盾）
                    </h2>
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
                      Muse 0 接触密钥
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-[#52525b]">
                    先在左侧用手机飞书<strong>扫码登录开放平台</strong>（确认右上角企业与手机飞书一致），然后点击「<strong>🤖 让 Muse 接管配置</strong>」：Muse 会智能识别左侧界面按钮完成建应用、开机器人、导权限与配事件；所有 App Secret 密钥均在本地自动屏蔽并由本机底层暗中托管连线，<strong>绝不发送给 Muse</strong>！
                  </p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <input
                      value={botNameDraft}
                      onChange={(e) => setBotNameDraft(e.target.value)}
                      placeholder="新机器人名称（如 MuseDeck）"
                      className="min-w-[140px] flex-1 rounded-xl border border-[#e4e4e7] bg-[#fafafa] px-3 py-1.5 text-[12px] text-[#111827] outline-none focus:border-[#18181b] focus:bg-white"
                    />
                    <button
                      type="button"
                      disabled={runningMuseCoPilot || runningFeishuAuto}
                      onClick={() => void handleRunMuseCoPilot()}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-[#18181b] px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[#27272a] disabled:opacity-50"
                    >
                      {runningMuseCoPilot ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                      )}
                      {runningMuseCoPilot ? '正在唤醒 Muse...' : '🤖 让 Muse 接管配置'}
                    </button>
                    <button
                      type="button"
                      disabled={runningFeishuAuto || runningMuseCoPilot}
                      onClick={() => void handleRunFeishuAutoPilot()}
                      className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-[#e4e4e7] bg-white px-2.5 py-1.5 text-[11.5px] font-medium text-[#52525b] hover:bg-[#f4f4f5] hover:text-[#111827] disabled:opacity-50"
                      title="若尚未打通 Muse，也可使用内置本地脚本代配"
                    >
                      {runningFeishuAuto ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      本地脚本代配
                    </button>
                  </div>
                  {feishuAutoTip && (
                    <div className="mt-2 rounded-xl border border-[#eaecef] bg-[#fafafa] px-3 py-2 text-[11px] leading-relaxed text-[#3f3f46]">
                      <div className="font-medium text-[#111827]">{feishuAutoTip}</div>
                      {feishuStepReport.length > 0 && (
                        <ul className="mt-2 space-y-1.5 border-t border-[#eaecef] pt-2">
                          {feishuStepReport.map((item, idx) => (
                            <li key={idx} className="flex items-start gap-1.5">
                              <span className="mt-0.5 shrink-0">
                                {item.status === 'ok' ? '✅' : item.status === 'warn' ? '⚠️' : '👉'}
                              </span>
                              <div>
                                <span className="font-semibold text-[#111827]">{item.step}：</span>
                                <span className="text-[#52525b]">{item.detail}</span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </section>

                <section className="rounded-2xl border border-[#eaecef] bg-white p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-[13.5px] font-semibold text-[#111827]">飞书机器人凭证</h2>
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[#52525b]">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          hasUnsavedFeishuDraft
                            ? 'bg-amber-500'
                            : isFeishuVerified
                              ? 'bg-emerald-500'
                              : isFeishuConnected
                                ? 'animate-pulse bg-amber-500'
                                : 'bg-[#d4d4d8]'
                        }`}
                      />
                      {hasUnsavedFeishuDraft
                        ? '新凭证待连接'
                        : isFeishuVerified
                          ? '当前机器人已验通'
                          : isFeishuConnected
                            ? '长连接在线（待发消息验通）'
                            : '未连接'}
                    </span>
                  </div>

                  <div className="space-y-2.5 text-[12.5px]">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-1 block text-[11.5px] font-medium text-[#52525b]">
                          App ID
                        </label>
                        <input
                          value={appId}
                          onChange={(e) => setAppId(e.target.value)}
                          placeholder="cli_a1b2c3..."
                          className="w-full rounded-xl border border-[#e4e4e7] bg-white px-3 py-1.5 text-[12px] text-[#111827] outline-none focus:border-[#18181b]"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11.5px] font-medium text-[#52525b]">
                          App Secret
                        </label>
                        <input
                          type="password"
                          value={appSecret}
                          onChange={(e) => setAppSecret(e.target.value)}
                          placeholder="本地自动托管（也可手动粘贴）"
                          className="w-full rounded-xl border border-[#e4e4e7] bg-white px-3 py-1.5 text-[12px] text-[#111827] outline-none focus:border-[#18181b]"
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => void handleConnectFeishu()}
                        disabled={!appId.trim() || !appSecret.trim() || connecting}
                        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#18181b] px-4 py-2 text-[12.5px] font-medium text-white transition-colors hover:bg-[#27272a] disabled:opacity-40"
                      >
                        {connecting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Radio className="h-3.5 w-3.5" />
                        )}
                        {hasUnsavedFeishuDraft
                          ? '连接到此新机器人（自动清空旧验证）'
                          : '连接飞书长连接（无需公网服务器）'}
                      </button>

                      {feishuBotAppLink && (
                        <button
                          type="button"
                          onClick={() => void window.fmc.openExternal(feishuBotAppLink)}
                          className="inline-flex items-center gap-1 rounded-xl border border-[#e4e4e7] bg-white px-3 py-2 text-[12px] font-medium text-[#111827] transition-colors hover:bg-[#f4f4f5]"
                          title="发布应用版本后，点此可免搜索直接在飞书客户端打开该机器人的聊天框"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          唤起机器人对话
                        </button>
                      )}
                    </div>

                    <div
                      className={`rounded-xl border px-3 py-2 text-[11.5px] ${
                        hasUnsavedFeishuDraft
                          ? 'border-amber-200 bg-amber-50/70 text-amber-900'
                          : isFeishuVerified
                            ? 'border-emerald-200 bg-emerald-50/70 text-emerald-900'
                            : isFeishuConnected
                              ? 'border-amber-200 bg-amber-50/70 text-amber-900'
                              : 'border-[#eaecef] bg-[#fafafa] text-[#71717a]'
                      }`}
                    >
                      {hasUnsavedFeishuDraft ? (
                        <span>
                          检测到你修改了应用凭证（尚未连接）。请点击上方黑色按钮连接到新机器人。
                        </span>
                      ) : isFeishuVerified ? (
                        <div className="flex items-center justify-between gap-2">
                          <span>
                            当前机器人（<code className="font-mono">{trimmedAppId}</code>）已双向验通！收到测试消息：「
                            {state.feishu.lastPingMessage || '你好'}」
                          </span>
                          <button
                            type="button"
                            onClick={() => void window.fmc.resetFeishuVerification()}
                            className="shrink-0 rounded-md border border-emerald-300 bg-white px-2 py-0.5 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100"
                          >
                            重新验证
                          </button>
                        </div>
                      ) : isFeishuConnected ? (
                        <span>
                          当前机器人（<code className="font-mono">{trimmedAppId}</code>）长连接已在线：待左侧发布版本后，点「唤起机器人对话」发一句「你好」（机器人将秒贴 👀 表情并回执）即可完成验通！
                        </span>
                      ) : (
                        <span>
                          {feishuStatus.state === 'error'
                            ? feishuStatus.message
                            : '扫码登录左侧飞书后台后，点击上方「🤖 让 Muse 接管配置」即可自动完成'}
                        </span>
                      )}
                    </div>
                  </div>
                </section>

                <FeishuSetupGuide
                  feishuConnected={isFeishuConnected}
                  feishuVerified={isFeishuVerified}
                  appId={appId}
                  appSecret={appSecret}
                  onNavigateFeishuUrl={(url) => void window.fmc.navigateEmbeddedView('feishu', url)}
                />
              </div>

              <div className="flex shrink-0 items-center justify-between border-t border-[#eaecef] bg-white px-5 py-3">
                <button
                  onClick={() => goStep(4)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-[#e4e4e7] bg-white px-3.5 py-2 text-[12.5px] font-medium text-[#52525b] hover:bg-[#f4f4f5]"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  上一步
                </button>
                <div className="flex items-center gap-3">
                  {!isFeishuVerified && (
                    <button
                      onClick={() => void onComplete()}
                      className="text-[12px] text-[#8a8f98] hover:text-[#111827]"
                    >
                      稍后再配飞书，先进工作台
                    </button>
                  )}
                  <button
                    onClick={() => void onComplete()}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-[#18181b] px-5 py-2 text-[12.5px] font-medium text-white hover:bg-[#27272a]"
                  >
                    完成配置，进入 MuseDeck
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
