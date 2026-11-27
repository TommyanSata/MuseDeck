import React, { useRef, useState } from 'react';
import {
  Download,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Loader2,
  Monitor,
  Power,
  RefreshCw,
  RotateCcw,
  Sliders,
  Sparkles,
  Type
} from 'lucide-react';
import {
  AppSettings,
  AppUpdateCheckResult,
  BenchmarkCache,
  CloseBehavior,
  DecisionPriorityWeights,
  FmcState,
  ModelRoutingMode,
  MuseDisplayMode,
  MuseExtensionStatus,
  PlanApprovalMode,
  WorkflowConfig,
  WorkflowReviewMode
} from '../types';

export const DEFAULT_APP_SETTINGS: AppSettings = {
  fontSize: 'normal',
  fontFamily: 'system',
  monoFont: 'system',
  closeBehavior: 'ask',
  launchAtLogin: false,
  checkUpdateOnStartup: true,
  museDisplayMode: 'avatar'
};

const DEFAULT_DECISION_WEIGHTS: DecisionPriorityWeights = {
  capability: 45,
  price: 25,
  quota: 20,
  speed: 10
};

const DECISION_WEIGHT_META: Array<{
  key: keyof DecisionPriorityWeights;
  label: string;
  desc: string;
  barColor: string;
}> = [
  { key: 'capability', label: '模型能力', desc: '优先选择榜单高分与最强代码/推理模型', barColor: 'bg-[#18181b]' },
  { key: 'price', label: '价格性价比', desc: '优先省钱与高性价比模型，必要时再递进升档', barColor: 'bg-emerald-500' },
  { key: 'quota', label: '剩余额度 / 限额', desc: '优先消耗订阅闲置额度、避开临近 5h 限流或低余额节点', barColor: 'bg-sky-500' },
  { key: 'speed', label: '响应速度', desc: '优先选择低延迟与快速输出模型', barColor: 'bg-amber-400' }
];

function rebalanceDecisionWeights(
  current: DecisionPriorityWeights,
  changedKey: keyof DecisionPriorityWeights,
  rawNext: number
): DecisionPriorityWeights {
  const nextVal = Math.max(0, Math.min(100, Math.round(rawNext)));
  const remaining = 100 - nextVal;
  const otherKeys = (['capability', 'price', 'quota', 'speed'] as const).filter((k) => k !== changedKey);
  const otherSum = otherKeys.reduce((acc, k) => acc + current[k], 0);

  const result: DecisionPriorityWeights = { ...current, [changedKey]: nextVal };
  if (otherSum === 0) {
    const base = Math.floor(remaining / otherKeys.length);
    let rem = remaining - base * otherKeys.length;
    for (const k of otherKeys) {
      result[k] = base + (rem > 0 ? 1 : 0);
      if (rem > 0) rem -= 1;
    }
    return result;
  }

  let assigned = 0;
  otherKeys.forEach((k, idx) => {
    if (idx === otherKeys.length - 1) {
      result[k] = Math.max(0, remaining - assigned);
    } else {
      const share = Math.round((current[k] / otherSum) * remaining);
      const clamped = Math.min(remaining - assigned, Math.max(0, share));
      result[k] = clamped;
      assigned += clamped;
    }
  });
  return result;
}

const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  reviewMode: 'muse_review',
  planApprovalMode: 'adaptive',
  modelRoutingMode: 'muse_ask',
  decisionWeights: DEFAULT_DECISION_WEIGHTS,
  userHabits: [],
  maxAutoRounds: 3,
  tokenBudget: 150000,
  stallLimit: 2,
  autoWakeMuse: true
};

interface SettingsViewProps {
  state: FmcState;
  availableUpdate?: AppUpdateCheckResult | null;
  onUpdateDetected?: (res: AppUpdateCheckResult) => void;
  onShowWhatsNew?: () => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  onUpdateControlApi: (patch: { autoStartTunnel?: boolean; autoSyncToMuse?: boolean }) => Promise<void>;
  onUpdateWorkflowConfig: (patch: Partial<WorkflowConfig>) => Promise<void>;
}

const FONT_SIZE_OPTIONS: Array<{ id: AppSettings['fontSize']; label: string; desc: string }> = [
  { id: 'small', label: '紧凑', desc: '92%' },
  { id: 'normal', label: '标准', desc: '100%' },
  { id: 'large', label: '偏大', desc: '108%' },
  { id: 'xlarge', label: '超大', desc: '116%' }
];

const FONT_FAMILY_OPTIONS: Array<{ id: AppSettings['fontFamily']; label: string }> = [
  { id: 'system', label: '系统默认（推荐）' },
  { id: 'yahei', label: '微软雅黑 (Microsoft YaHei)' },
  { id: 'inter', label: 'Inter / 苹方 (PingFang SC)' },
  { id: 'mono', label: '等宽极客风 (Monospace)' }
];

const MONO_FONT_OPTIONS: Array<{ id: AppSettings['monoFont']; label: string }> = [
  { id: 'system', label: '系统默认等宽' },
  { id: 'cascadia', label: 'Cascadia Code' },
  { id: 'jetbrains', label: 'JetBrains Mono' },
  { id: 'consolas', label: 'Consolas' }
];

const CLOSE_OPTIONS: Array<{ id: CloseBehavior; label: string; desc: string }> = [
  { id: 'ask', label: '每次询问', desc: '点击关闭按钮时弹窗选择' },
  { id: 'tray', label: '最小化到系统托盘', desc: '后台保持飞书与隧道在线' },
  { id: 'quit', label: '直接完全退出', desc: '关闭窗口时同时停止后台服务' }
];

const MUSE_MODE_OPTIONS: Array<{ id: MuseDisplayMode; label: string; desc: string }> = [
  { id: 'avatar', label: '展示 Muse 虚拟形象', desc: '读取已登录 Muse 账号的自定义动态形象' },
  { id: 'compact', label: '精简模式（省内存）', desc: '仅保留单行文字按钮，节省空间与内存' }
];

const REVIEW_MODE_OPTIONS: Array<{ id: WorkflowReviewMode; label: string; desc: string }> = [
  { id: 'muse_review', label: 'Muse 先审阅再问我', desc: '推荐：先自审打回明显缺陷，通过后再汇报验收' },
  { id: 'direct_user', label: '跑完直接凝练问我', desc: '省额度：跳过自动返工，直接汇总要点向你汇报' },
  { id: 'auto_sprint', label: '自动闭环冲刺', desc: '多轮自审迭代直至完全达标或触发预算熔断' }
];

const PLAN_APPROVAL_OPTIONS: Array<{ id: PlanApprovalMode; label: string; desc: string }> = [
  {
    id: 'adaptive',
    label: '用户习惯（自适应学习）',
    desc: '推荐：Muse 结合已沉淀的个人习惯与任务复杂度自主决定先报方案还是直接执行，越用越懂你'
  },
  {
    id: 'always',
    label: '总是先报方案等批准',
    desc: '硬门控：每次派单前必须先发分工与审阅方案到桌面端与飞书，经你批准后才开工'
  },
  {
    id: 'never',
    label: '直接执行（跳过前置审批）',
    desc: '全自动推进：收到任务直接拆单派发，仅在完工验收或触发预算熔断时打扰你'
  }
];

const MODEL_ROUTING_OPTIONS: Array<{ id: ModelRoutingMode; label: string; desc: string }> = [
  {
    id: 'muse_ask',
    label: 'Muse 问询决策',
    desc: '推荐：读取所有已开 CLI 的全量模型池并按榜单细分能力拆分分工（允许同 CLI 用不同模型），对比默认与推荐方案请你选择'
  },
  {
    id: 'muse_auto',
    label: 'Muse 智能决策',
    desc: '全自动最优分工：按子任务类型与权威榜单细分能力自动匹配最擅长的 CLI + 模型 + 思考等级，不达标时递进升档'
  },
  {
    id: 'user_default',
    label: '用户默认设定',
    desc: '严格按你在 CLI 管理页设置的各 CLI 默认模型、思考等级与权重执行，禁止 Muse 覆盖模型'
  }
];

export const SettingsView: React.FC<SettingsViewProps> = ({
  state,
  availableUpdate,
  onUpdateDetected,
  onShowWhatsNew,
  onUpdateSettings,
  onUpdateControlApi,
  onUpdateWorkflowConfig
}) => {
  const [syncingAvatar, setSyncingAvatar] = useState(false);
  const [avatarMsg, setAvatarMsg] = useState('');
  const [applyingIcon, setApplyingIcon] = useState(false);
  const [iconMsg, setIconMsg] = useState('');
  const [newHabit, setNewHabit] = useState('');
  const [benchCache, setBenchCache] = useState<BenchmarkCache | null>(null);
  const [refreshingBench, setRefreshingBench] = useState(false);
  const [extStatus, setExtStatus] = useState<MuseExtensionStatus | null>(null);
  const [extMsg, setExtMsg] = useState('');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateResult, setUpdateResult] = useState<AppUpdateCheckResult | null>(availableUpdate || null);
  const [downloadingUpd, setDownloadingUpd] = useState(false);
  const [dlProgress, setDlProgress] = useState<{ percent: number; transferredMB: string; totalMB: string } | null>(null);
  const [dlError, setDlError] = useState('');
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewImgRef = useRef<HTMLImageElement | null>(null);

  React.useEffect(() => {
    void window.fmc.getBenchmarks().then(setBenchCache).catch(() => {});
    void window.fmc.getMuseExtensionStatus().then(setExtStatus).catch(() => {});
    const offProg = window.fmc.onEvent('app:updateProgress', (payload) => {
      setDlProgress(payload as { percent: number; transferredMB: string; totalMB: string });
    });
    return () => offProg();
  }, []);

  const settings: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
    ...(state.settings || {})
  };
  const workflow: WorkflowConfig = {
    ...DEFAULT_WORKFLOW_CONFIG,
    ...(state.workflow || {})
  };

  const handleSyncAvatar = async () => {
    setSyncingAvatar(true);
    setAvatarMsg('');
    try {
      const res = await window.fmc.fetchMuseAvatar();
      setAvatarMsg(res.ok ? '已同步最新 Muse 形象' : res.message || '未检测到形象');
    } finally {
      setSyncingAvatar(false);
    }
  };

  const renderSquirclePngFromMedia = async (
    url: string,
    kind?: 'image' | 'video'
  ): Promise<string | undefined> => {
    try {
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return undefined;

      const drawClipped = (el: HTMLImageElement | HTMLVideoElement, sw: number, sh: number) => {
        if (!sw || !sh) return undefined;
        ctx.clearRect(0, 0, size, size);
        const r = 56;
        ctx.beginPath();
        ctx.moveTo(r, 0);
        ctx.arcTo(size, 0, size, size, r);
        ctx.arcTo(size, size, 0, size, r);
        ctx.arcTo(0, size, 0, 0, r);
        ctx.arcTo(0, 0, size, 0, r);
        ctx.closePath();
        ctx.clip();
        // Clean warm-white squircle backdrop so transparent Muse characters never render on black
        ctx.fillStyle = '#FAF9F6';
        ctx.fillRect(0, 0, size, size);
        // Center-crop square with gentle 1.06x zoom for full-bleed look
        const minSide = Math.min(sw, sh) / 1.06;
        const sx = (sw - minSide) / 2;
        const sy = (sh - minSide) / 2;
        ctx.drawImage(el, sx, sy, minSide, minSide, 0, 0, size, size);
        return canvas.toDataURL('image/png');
      };

      // Prefer capturing directly from the already-playing mounted preview element!
      if (kind === 'video' && previewVideoRef.current && previewVideoRef.current.readyState >= 2) {
        const v = previewVideoRef.current;
        const captured = drawClipped(v, v.videoWidth || 256, v.videoHeight || 256);
        if (captured) return captured;
      }
      if (kind !== 'video' && previewImgRef.current && previewImgRef.current.complete && previewImgRef.current.naturalWidth > 0) {
        const im = previewImgRef.current;
        const captured = drawClipped(im, im.naturalWidth, im.naturalHeight);
        if (captured) return captured;
      }

      if (kind === 'video') {
        return await new Promise<string | undefined>((resolve) => {
          const video = document.createElement('video');
          video.crossOrigin = 'anonymous';
          video.muted = true;
          video.playsInline = true;
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            try {
              resolve(drawClipped(video, video.videoWidth || 256, video.videoHeight || 256));
            } catch {
              resolve(undefined);
            }
          };
          video.onseeked = finish;
          video.onloadeddata = () => {
            try {
              video.currentTime = Math.min(0.2, (video.duration || 1) * 0.1);
            } catch {
              setTimeout(finish, 120);
            }
          };
          video.onerror = () => {
            if (!done) {
              done = true;
              resolve(undefined);
            }
          };
          setTimeout(() => {
            if (!done) {
              done = true;
              resolve(undefined);
            }
          }, 4000);
          video.src = url;
          void video.play().catch(() => {});
        });
      }

      return await new Promise<string | undefined>((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            resolve(drawClipped(img, img.naturalWidth || 256, img.naturalHeight || 256));
          } catch {
            resolve(undefined);
          }
        };
        img.onerror = () => resolve(undefined);
        img.src = url;
      });
    } catch {
      return undefined;
    }
  };

  const handleApplyMuseIcon = async () => {
    setApplyingIcon(true);
    setIconMsg('');
    try {
      let avatarUrl = state.muse.avatarUrl;
      let avatarKind = state.muse.avatarKind;
      if (!avatarUrl) {
        const fetched = await window.fmc.fetchMuseAvatar();
        if (fetched.ok && fetched.url) {
          avatarUrl = fetched.url;
          avatarKind = fetched.kind;
        }
      }
      if (!avatarUrl) {
        setIconMsg('尚未检测到 Muse 形象，请先登录 Meta Muse 并点击「同步账号形象」');
        return;
      }
      const pngDataUrl = await renderSquirclePngFromMedia(avatarUrl, avatarKind);
      const res = await window.fmc.applyMuseDesktopIcon({ pngDataUrl, avatarUrl });
      setIconMsg(res.message);
    } finally {
      setApplyingIcon(false);
    }
  };

  const handleResetDesktopIcon = async () => {
    setApplyingIcon(true);
    setIconMsg('');
    try {
      const res = await window.fmc.resetDesktopIcon();
      setIconMsg(res.message);
    } finally {
      setApplyingIcon(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      {/* Slim Top Header */}
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[#eaecef] bg-white px-5">
        <div className="flex items-center gap-2">
          <Sliders className="h-4 w-4 text-[#52525b]" />
          <h2 className="text-[13.5px] font-semibold text-[#111827]">软件设置</h2>
        </div>
        <span className="font-mono text-[11px] text-[#8a8f98]">MuseDeck v0.7.2</span>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-[760px] space-y-6 text-[13px]">
          {/* Section 1: Typography & Appearance */}
          <section className="overflow-hidden rounded-2xl border border-[#eaecef] bg-white">
            <div className="flex items-center gap-2 border-b border-[#eaecef] bg-[#fafafa] px-5 py-3 text-[12px] font-semibold text-[#3f3f46]">
              <Type className="h-3.5 w-3.5" />
              外观与字体
            </div>

            <div className="divide-y divide-[#f1f1f3]">
              {/* Muse Display Mode */}
              <div className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium text-[#111827]">左上角 Muse 展示模式</div>
                    <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                      也可随时点击左上角「MuseDeck ⌄」下拉菜单一键收回或展开
                    </div>
                  </div>
                  <button
                    onClick={() => void handleSyncAvatar()}
                    disabled={syncingAvatar}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[#e4e4e7] bg-white px-2.5 py-1 text-[11.5px] font-medium text-[#3f3f46] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827] disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3 w-3 ${syncingAvatar ? 'animate-spin' : ''}`} />
                    {syncingAvatar ? '读取中...' : '同步账号形象'}
                  </button>
                </div>
                {avatarMsg && <p className="mt-1.5 text-[11.5px] text-[#71717a]">{avatarMsg}</p>}
                <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {MUSE_MODE_OPTIONS.map((opt) => {
                    const selected = settings.museDisplayMode === opt.id;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => void onUpdateSettings({ museDisplayMode: opt.id })}
                        className={`rounded-xl border p-3 text-left transition-colors ${
                          selected
                            ? 'border-[#18181b] bg-[#fafafa]'
                            : 'border-[#eaecef] bg-white hover:bg-[#fafafa]'
                        }`}
                      >
                        <div className="text-[12.5px] font-medium text-[#111827]">{opt.label}</div>
                        <div className="mt-0.5 text-[11px] text-[#71717a]">{opt.desc}</div>
                      </button>
                    );
                  })}
                </div>

              </div>

              {/* One-click Desktop Icon from Muse Avatar */}
              <div className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-[12px] border border-[#e4e4e7] bg-[#fafafa] shadow-2xs">
                      {state.muse.avatarUrl ? (
                        state.muse.avatarKind === 'video' ? (
                          <video
                            ref={previewVideoRef}
                            crossOrigin="anonymous"
                            src={state.muse.avatarUrl}
                            autoPlay
                            loop
                            muted
                            playsInline
                            className="h-full w-full scale-110 object-cover"
                          />
                        ) : (
                          <img
                            ref={previewImgRef}
                            crossOrigin="anonymous"
                            src={state.muse.avatarUrl}
                            alt="Muse"
                            className="h-full w-full scale-110 object-cover"
                          />
                        )
                      ) : (
                        <Monitor className="h-5 w-5 text-[#71717a]" />
                      )}
                    </div>
                    <div>
                      <div className="font-medium text-[#111827]">桌面与任务栏应用图标</div>
                      <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                        自动将当前 Muse 形象紧裁为无留白圆角图标，一键替换桌面快捷方式、任务栏与托盘图标
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void handleApplyMuseIcon()}
                      disabled={applyingIcon}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-[#18181b] px-3 py-1.5 text-[11.5px] font-medium text-white transition-colors hover:bg-[#27272a] disabled:opacity-50"
                    >
                      {applyingIcon ? '生成中...' : '一键设为桌面图标'}
                    </button>
                    <button
                      onClick={() => void handleResetDesktopIcon()}
                      disabled={applyingIcon}
                      className="inline-flex items-center gap-1 rounded-xl border border-[#e4e4e7] bg-white px-2.5 py-1.5 text-[11.5px] font-medium text-[#52525b] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827] disabled:opacity-50"
                    >
                      恢复默认
                    </button>
                  </div>
                </div>
                {iconMsg && <p className="mt-2 text-[11.5px] text-[#52525b]">{iconMsg}</p>}
              </div>

              {/* Font Size */}
              <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                <div>
                  <div className="font-medium text-[#111827]">界面字号大小</div>
                  <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                    实时缩放整体界面与对话正文尺寸
                  </div>
                </div>
                <div className="flex items-center rounded-xl bg-[#f4f4f5] p-1">
                  {FONT_SIZE_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      onClick={() => void onUpdateSettings({ fontSize: opt.id })}
                      className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors ${
                        settings.fontSize === opt.id
                          ? 'bg-white text-[#111827] shadow-2xs'
                          : 'text-[#71717a] hover:text-[#111827]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* UI Font Family */}
              <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                <div>
                  <div className="font-medium text-[#111827]">界面字体</div>
                  <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                    应用于侧边栏、菜单及对话内容
                  </div>
                </div>
                <select
                  value={settings.fontFamily}
                  onChange={(e) =>
                    void onUpdateSettings({
                      fontFamily: e.target.value as AppSettings['fontFamily']
                    })
                  }
                  className="w-56 rounded-xl border border-[#e4e4e7] bg-white px-3 py-1.5 text-[12.5px] text-[#111827] outline-none focus:border-[#18181b]"
                >
                  {FONT_FAMILY_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Code / Terminal Font */}
              <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                <div>
                  <div className="font-medium text-[#111827]">代码与终端日志字体</div>
                  <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                    应用于 Diff 摘要、原始终端日志和协议文本
                  </div>
                </div>
                <select
                  value={settings.monoFont}
                  onChange={(e) =>
                    void onUpdateSettings({
                      monoFont: e.target.value as AppSettings['monoFont']
                    })
                  }
                  className="w-56 rounded-xl border border-[#e4e4e7] bg-white px-3 py-1.5 text-[12.5px] text-[#111827] outline-none focus:border-[#18181b]"
                >
                  {MONO_FONT_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          {/* Section 2: Multi-Agent Workflow & Budget Guardrails */}
          <section className="overflow-hidden rounded-2xl border border-[#eaecef] bg-white">
            <div className="flex items-center gap-2 border-b border-[#eaecef] bg-[#fafafa] px-5 py-3 text-[12px] font-semibold text-[#3f3f46]">
              <GitBranch className="h-3.5 w-3.5" />
              多智能体自治工作流与预算护栏
            </div>

            <div className="divide-y divide-[#f1f1f3]">
              <div className="px-5 py-4">
                <div className="font-medium text-[#111827]">执行前方案审批策略</div>
                <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                  控制 Muse 在真正派单给本地 CLI 之前，是否先将职能划分、审阅要求发给你确认批准
                </div>
                <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  {PLAN_APPROVAL_OPTIONS.map((opt) => {
                    const selected = (workflow.planApprovalMode || 'adaptive') === opt.id;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => void onUpdateWorkflowConfig({ planApprovalMode: opt.id })}
                        className={`rounded-xl border p-3 text-left transition-colors ${
                          selected
                            ? 'border-[#18181b] bg-[#fafafa]'
                            : 'border-[#eaecef] bg-white hover:bg-[#fafafa]'
                        }`}
                      >
                        <div className="text-[12.5px] font-medium text-[#111827]">{opt.label}</div>
                        <div className="mt-0.5 text-[11px] text-[#71717a]">{opt.desc}</div>
                      </button>
                    );
                  })}
                </div>

                {/* Learned User Habits Memory */}
                <div className="mt-4 rounded-xl border border-[#eaecef] bg-[#fafafa] p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[12px] font-medium text-[#111827]">
                      Muse 已学习的用户习惯记忆（{(workflow.userHabits || []).length} 条）
                    </div>
                    <span className="text-[11px] text-[#8a8f98]">自动随协议同步，跨会话保留</span>
                  </div>
                  {(workflow.userHabits || []).length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {(workflow.userHabits || []).map((habit, idx) => (
                        <span
                          key={idx}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-[#e4e4e7] bg-white px-2.5 py-1 text-[11.5px] text-[#3f3f46]"
                        >
                          <span>{habit}</span>
                          <button
                            type="button"
                            onClick={() => {
                              const next = (workflow.userHabits || []).filter((_, i) => i !== idx);
                              void onUpdateWorkflowConfig({ userHabits: next });
                            }}
                            className="text-[#a1a1aa] hover:text-[#111827]"
                            title="删除这条习惯"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1.5 text-[11.5px] text-[#8a8f98]">
                      暂无记录。Muse 会在后续协作中自动总结你的偏好，你也可以直接手动添加一条习惯规则。
                    </p>
                  )}
                  <div className="mt-2.5 flex items-center gap-2">
                    <input
                      value={newHabit}
                      onChange={(e) => setNewHabit(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newHabit.trim()) {
                          e.preventDefault();
                          const next = [...(workflow.userHabits || []), newHabit.trim()].slice(-20);
                          setNewHabit('');
                          void onUpdateWorkflowConfig({ userHabits: next });
                        }
                      }}
                      placeholder="例如：前端 UI 优先给 Antigravity；改核心逻辑前必须先报方案"
                      className="flex-1 rounded-lg border border-[#e4e4e7] bg-white px-2.5 py-1.5 text-[12px] text-[#111827] placeholder-[#a1a1aa] outline-none focus:border-[#18181b]"
                    />
                    <button
                      type="button"
                      disabled={!newHabit.trim()}
                      onClick={() => {
                        if (!newHabit.trim()) return;
                        const next = [...(workflow.userHabits || []), newHabit.trim()].slice(-20);
                        setNewHabit('');
                        void onUpdateWorkflowConfig({ userHabits: next });
                      }}
                      className="rounded-lg bg-[#18181b] px-3 py-1.5 text-[11.5px] font-medium text-white transition-colors hover:bg-[#27272a] disabled:opacity-40"
                    >
                      添加习惯
                    </button>
                  </div>
                </div>
              </div>

              <div className="px-5 py-4">
                <div className="font-medium text-[#111827]">项目模型与分工决策</div>
                <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                  决定 Muse 是否读取所有已启用 CLI 的全量模型池，结合权威榜单细分能力进行「子任务 → 最擅长模型」精细分工（支持同 CLI 下不同模型处理不同任务）
                </div>
                <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  {MODEL_ROUTING_OPTIONS.map((opt) => {
                    const selected = (workflow.modelRoutingMode || 'muse_ask') === opt.id;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => void onUpdateWorkflowConfig({ modelRoutingMode: opt.id })}
                        className={`rounded-xl border p-3 text-left transition-colors ${
                          selected
                            ? 'border-[#18181b] bg-[#fafafa]'
                            : 'border-[#eaecef] bg-white hover:bg-[#fafafa]'
                        }`}
                      >
                        <div className="text-[12.5px] font-medium text-[#111827]">{opt.label}</div>
                        <div className="mt-0.5 text-[11px] text-[#71717a]">{opt.desc}</div>
                      </button>
                    );
                  })}
                </div>

                {/* 100% Exact-Integer Decision Priority Weights */}
                {(() => {
                  const weights: DecisionPriorityWeights = {
                    ...DEFAULT_DECISION_WEIGHTS,
                    ...(workflow.decisionWeights || {})
                  };
                  const totalPct =
                    weights.capability + weights.price + weights.quota + weights.speed;
                  return (
                    <div className="mt-4 rounded-xl border border-[#eaecef] bg-[#fafafa] p-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-[12px] font-medium text-[#111827]">
                            Muse 决策优先级权重（总计{' '}
                            <span className="font-mono text-emerald-700">{totalPct}%</span>，精确到 1%）
                          </div>
                          <div className="mt-0.5 text-[11px] text-[#71717a]">
                            拖动任意一项时其余三项自动按比例配平至 100%，指导 Muse 结合榜单与实时余额/限额做最优分工
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-1">
                          {[
                            { label: '均衡推荐', w: { capability: 45, price: 25, quota: 20, speed: 10 } },
                            { label: '质量优先', w: { capability: 65, price: 10, quota: 15, speed: 10 } },
                            { label: '极致省钱', w: { capability: 25, price: 40, quota: 25, speed: 10 } }
                          ].map((preset) => (
                            <button
                              key={preset.label}
                              type="button"
                              onClick={() => void onUpdateWorkflowConfig({ decisionWeights: preset.w })}
                              className="rounded-lg border border-[#e4e4e7] bg-white px-2 py-0.5 text-[10.5px] font-medium text-[#52525b] transition-colors hover:border-[#18181b] hover:text-[#111827]"
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Live stacked 100% distribution bar */}
                      <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-[#e4e4e7]">
                        {DECISION_WEIGHT_META.map((item) => (
                          <div
                            key={item.key}
                            style={{ width: `${weights[item.key]}%` }}
                            className={`${item.barColor} transition-all duration-150`}
                            title={`${item.label}: ${weights[item.key]}%`}
                          />
                        ))}
                      </div>

                      <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                        {DECISION_WEIGHT_META.map((item) => (
                          <div
                            key={item.key}
                            className="rounded-lg border border-[#eaecef] bg-white px-3 py-2"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[#111827]">
                                <span className={`h-2 w-2 rounded-full ${item.barColor}`} />
                                {item.label}
                              </span>
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  min={0}
                                  max={100}
                                  step={1}
                                  value={weights[item.key]}
                                  onChange={(e) => {
                                    const val = Number.parseInt(e.target.value || '0', 10);
                                    if (!Number.isFinite(val)) return;
                                    const next = rebalanceDecisionWeights(weights, item.key, val);
                                    void onUpdateWorkflowConfig({ decisionWeights: next });
                                  }}
                                  className="w-12 rounded-md border border-[#e4e4e7] bg-[#fafafa] px-1.5 py-0.5 text-right font-mono text-[11.5px] font-semibold text-[#111827] outline-none focus:border-[#18181b]"
                                />
                                <span className="font-mono text-[11px] text-[#71717a]">%</span>
                              </div>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={100}
                              step={1}
                              value={weights[item.key]}
                              onChange={(e) => {
                                const val = Number.parseInt(e.target.value, 10);
                                const next = rebalanceDecisionWeights(weights, item.key, val);
                                void onUpdateWorkflowConfig({ decisionWeights: next });
                              }}
                              className="mt-1.5 h-1.5 w-full cursor-pointer accent-[#18181b]"
                            />
                            <div className="mt-0.5 text-[10.5px] text-[#8a8f98]">{item.desc}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>

              <div className="px-5 py-4">
                <div className="font-medium text-[#111827]">审阅与验收策略</div>
                <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                  决定本地 CLI 跑完子任务后，由 Muse 先审阅返工还是直接向你汇报
                </div>
                <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  {REVIEW_MODE_OPTIONS.map((opt) => {
                    const selected = workflow.reviewMode === opt.id;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => void onUpdateWorkflowConfig({ reviewMode: opt.id })}
                        className={`rounded-xl border p-3 text-left transition-colors ${
                          selected
                            ? 'border-[#18181b] bg-[#fafafa]'
                            : 'border-[#eaecef] bg-white hover:bg-[#fafafa]'
                        }`}
                      >
                        <div className="text-[12.5px] font-medium text-[#111827]">{opt.label}</div>
                        <div className="mt-0.5 text-[11px] text-[#71717a]">{opt.desc}</div>
                      </button>
                    );
                  })}
                </div>

              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                <div>
                  <div className="font-medium text-[#111827]">最大自动返工轮次</div>
                  <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                    达到轮次上限后强制停止派单并由 Muse 凝练汇报（防死循环）
                  </div>
                </div>
                <div className="flex items-center rounded-xl bg-[#f4f4f5] p-1">
                  {[1, 2, 3, 5].map((n) => (
                    <button
                      key={n}
                      onClick={() => void onUpdateWorkflowConfig({ maxAutoRounds: n })}
                      className={`rounded-lg px-3 py-1 text-[12px] font-medium transition-colors ${
                        workflow.maxAutoRounds === n
                          ? 'bg-white text-[#111827] shadow-2xs'
                          : 'text-[#71717a] hover:text-[#111827]'
                      }`}
                    >
                      {n} 轮
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                <div>
                  <div className="font-medium text-[#111827]">单次需求 Token 预算上限</div>
                  <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                    达 75% 提醒收尾，达 100% 自动熔断暂停并推送飞书询问是否追加预算
                  </div>
                </div>
                <div className="flex items-center rounded-xl bg-[#f4f4f5] p-1">
                  {[
                    { val: 50000, label: '50k' },
                    { val: 150000, label: '150k' },
                    { val: 300000, label: '300k' },
                    { val: 500000, label: '500k' },
                    { val: 0, label: '不限' }
                  ].map((opt) => (
                    <button
                      key={opt.val}
                      onClick={() => void onUpdateWorkflowConfig({ tokenBudget: opt.val })}
                      className={`rounded-lg px-2.5 py-1 font-mono text-[11.5px] font-medium transition-colors ${
                        workflow.tokenBudget === opt.val
                          ? 'bg-white text-[#111827] shadow-2xs'
                          : 'text-[#71717a] hover:text-[#111827]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div>
                  <div className="font-medium text-[#111827]">子任务完工后自动叫醒 Muse 继续推进</div>
                  <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                    自动把清洗后的 CLI 回复与 Git Diff 推回 Muse 对话框，让工作流持续自主运行
                  </div>
                </div>
                <button
                  onClick={() => void onUpdateWorkflowConfig({ autoWakeMuse: !workflow.autoWakeMuse })}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                    workflow.autoWakeMuse ? 'bg-[#18181b]' : 'bg-[#e4e4e7]'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-2xs transition-transform ${
                      workflow.autoWakeMuse ? 'translate-x-[18px]' : 'translate-x-[3px]'
                    }`}
                  />
                </button>
              </div>

              {/* Cloud Scout + Proactive Muse Push & Quiet Hours */}
              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div>
                  <div className="font-medium text-[#111827]">
                    「云端探路 + 本地施工」协同（发挥 Muse 云端网页与联网优势）
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                    联网检索、查最新官方文档与网页操作优先由云端 Muse 完成（零本地 CLI 额度消耗），并将核验情报落盘到项目 <code className="font-mono">.musedeck/research/</code> 供本地 CLI 施工
                  </div>
                </div>
                <button
                  onClick={() =>
                    void onUpdateWorkflowConfig({
                      cloudResearchFirst: workflow.cloudResearchFirst === false
                    })
                  }
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                    workflow.cloudResearchFirst !== false ? 'bg-[#18181b]' : 'bg-[#e4e4e7]'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-2xs transition-transform ${
                      workflow.cloudResearchFirst !== false
                        ? 'translate-x-[18px]'
                        : 'translate-x-[3px]'
                    }`}
                  />
                </button>
              </div>

              <div className="space-y-3 px-5 py-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="font-medium text-[#111827]">
                      捕捉 Muse 不定时「主动思考追问」并推送到飞书与桌面通知
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                      当 Muse 针对未决议题在后台完成思考并主动向你发问时，即使软件缩在托盘也会实时推送桌面通知与手机飞书
                    </div>
                  </div>
                  <button
                    onClick={() =>
                      void onUpdateWorkflowConfig({
                        proactivePushEnabled: workflow.proactivePushEnabled === false
                      })
                    }
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      workflow.proactivePushEnabled !== false ? 'bg-[#18181b]' : 'bg-[#e4e4e7]'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-2xs transition-transform ${
                        workflow.proactivePushEnabled !== false
                          ? 'translate-x-[18px]'
                          : 'translate-x-[3px]'
                      }`}
                    />
                  </button>
                </div>

                {workflow.proactivePushEnabled !== false && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#eaecef] bg-[#fafafa] px-3.5 py-2.5 text-[12px]">
                    <label className="inline-flex cursor-pointer items-center gap-2 font-medium text-[#3f3f46]">
                      <input
                        type="checkbox"
                        checked={workflow.quietHoursEnabled !== false}
                        onChange={(e) =>
                          void onUpdateWorkflowConfig({ quietHoursEnabled: e.target.checked })
                        }
                        className="accent-[#18181b]"
                      />
                      开启夜间免打扰（时段内仅留桌面灵感角标，静音不推手机飞书）
                    </label>
                    <div className="flex items-center gap-1.5 font-mono text-[11.5px] text-[#3f3f46]">
                      <input
                        type="time"
                        value={workflow.quietHoursStart || '23:00'}
                        disabled={workflow.quietHoursEnabled === false}
                        onChange={(e) =>
                          void onUpdateWorkflowConfig({ quietHoursStart: e.target.value })
                        }
                        className="rounded-lg border border-[#e4e4e7] bg-white px-2 py-1 outline-none focus:border-[#18181b] disabled:opacity-50"
                      />
                      <span>至</span>
                      <input
                        type="time"
                        value={workflow.quietHoursEnd || '08:00'}
                        disabled={workflow.quietHoursEnabled === false}
                        onChange={(e) =>
                          void onUpdateWorkflowConfig({ quietHoursEnd: e.target.value })
                        }
                        className="rounded-lg border border-[#e4e4e7] bg-white px-2 py-1 outline-none focus:border-[#18181b] disabled:opacity-50"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Daily LLM Benchmark Auto-Fetch */}
              <div className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-medium text-[#111827]">每日自动拉取大模型权威评测榜单</div>
                    <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                      每天后台抓取 LMArena、Artificial Analysis、SWE-bench 参考，辅助 Muse 推荐高性价比模型与递进升档
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      disabled={refreshingBench}
                      onClick={async () => {
                        setRefreshingBench(true);
                        try {
                          const data = await window.fmc.refreshBenchmarks();
                          setBenchCache(data);
                        } finally {
                          setRefreshingBench(false);
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded-xl border border-[#e4e4e7] bg-white px-2.5 py-1 text-[11.5px] font-medium text-[#3f3f46] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827] disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3 w-3 ${refreshingBench ? 'animate-spin' : ''}`} />
                      {refreshingBench ? '拉取中...' : '立即刷新榜单'}
                    </button>
                    <button
                      onClick={() =>
                        void onUpdateWorkflowConfig({
                          autoFetchBenchmarks: workflow.autoFetchBenchmarks === false
                        })
                      }
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                        workflow.autoFetchBenchmarks !== false ? 'bg-[#18181b]' : 'bg-[#e4e4e7]'
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-2xs transition-transform ${
                          workflow.autoFetchBenchmarks !== false ? 'translate-x-[18px]' : 'translate-x-[3px]'
                        }`}
                      />
                    </button>
                  </div>
                </div>
                {benchCache?.updatedAt && (
                  <div className="mt-2 rounded-xl border border-[#eaecef] bg-[#fafafa] px-3 py-2 text-[11.5px] leading-relaxed text-[#52525b]">
                    <div className="font-medium text-[#111827]">
                      上次同步：{new Date(benchCache.updatedAt).toLocaleString('zh-CN')}
                    </div>
                    <div className="mt-1 space-y-0.5">
                      {benchCache.sources.map((s) => (
                        <div key={s.id} className="truncate">
                          · {s.name}：{s.ok ? s.highlights[0] || '已同步' : `暂不可达 (${s.error})`}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Section 3: Window & Exit Behavior */}
          <section className="overflow-hidden rounded-2xl border border-[#eaecef] bg-white">
            <div className="flex items-center gap-2 border-b border-[#eaecef] bg-[#fafafa] px-5 py-3 text-[12px] font-semibold text-[#3f3f46]">
              <Power className="h-3.5 w-3.5" />
              退出与系统托盘
            </div>

            <div className="divide-y divide-[#f1f1f3]">
              <div className="px-5 py-4">
                <div className="font-medium text-[#111827]">点击右上角关闭按钮（×）时</div>
                <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                  可设为后台静默托盘运行，防止误关导致手机飞书无法远程调度
                </div>
                <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  {CLOSE_OPTIONS.map((opt) => {
                    const selected = settings.closeBehavior === opt.id;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => void onUpdateSettings({ closeBehavior: opt.id })}
                        className={`rounded-xl border p-3 text-left transition-colors ${
                          selected
                            ? 'border-[#18181b] bg-[#fafafa]'
                            : 'border-[#eaecef] bg-white hover:bg-[#fafafa]'
                        }`}
                      >
                        <div className="text-[12.5px] font-medium text-[#111827]">{opt.label}</div>
                        <div className="mt-0.5 text-[11px] text-[#71717a]">{opt.desc}</div>
                      </button>
                    );
                  })}
                </div>

              </div>

              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div>
                  <div className="font-medium text-[#111827]">开机自动启动</div>
                  <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                    系统登录后自动启动 Feishu Muse Commander（默认关闭）
                  </div>
                </div>
                <button
                  onClick={() => void onUpdateSettings({ launchAtLogin: !settings.launchAtLogin })}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                    settings.launchAtLogin ? 'bg-[#18181b]' : 'bg-[#e4e4e7]'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-2xs transition-transform ${
                      settings.launchAtLogin ? 'translate-x-[18px]' : 'translate-x-[3px]'
                    }`}
                  />
                </button>
              </div>
            </div>
          </section>

          {/* Section 3: Updates, Background Services & Maintenance */}
          <section className="overflow-hidden rounded-2xl border border-[#eaecef] bg-white">
            <div className="flex items-center gap-2 border-b border-[#eaecef] bg-[#fafafa] px-5 py-3 text-[12px] font-semibold text-[#3f3f46]">
              <Monitor className="h-3.5 w-3.5" />
              软件更新、后台服务与数据管理
            </div>

            <div className="divide-y divide-[#f1f1f3]">
              {/* Software Version Check & One-Click Update */}
              <div className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 font-medium text-[#111827]">
                      <span>软件版本与在线更新</span>
                      <span className="rounded-md bg-[#f4f4f5] px-2 py-0.5 font-mono text-[11px] text-[#52525b]">
                        v0.7.2
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                      检测 GitHub 最新发行版，支持一键下载安装包自动升级并查看本版更新说明
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {onShowWhatsNew && (
                      <button
                        type="button"
                        onClick={onShowWhatsNew}
                        className="inline-flex items-center gap-1 rounded-xl border border-[#e4e4e7] bg-white px-3 py-1.5 text-[12px] font-medium text-[#3f3f46] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
                      >
                        <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                        本版更新内容
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={checkingUpdate || downloadingUpd}
                      onClick={async () => {
                        setCheckingUpdate(true);
                        setDlError('');
                        try {
                          const res = await window.fmc.checkAppUpdate();
                          setUpdateResult(res);
                          onUpdateDetected?.(res);
                        } finally {
                          setCheckingUpdate(false);
                        }
                      }}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-[#18181b] px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[#27272a] disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${checkingUpdate ? 'animate-spin' : ''}`} />
                      {checkingUpdate ? '正在检测...' : '检查更新'}
                    </button>
                  </div>
                </div>

                {updateResult && (
                  <div
                    className={`mt-3 rounded-xl border p-3 text-[12px] ${
                      updateResult.hasUpdate
                        ? 'border-emerald-200 bg-emerald-50/60 text-emerald-950'
                        : updateResult.ok
                          ? 'border-[#eaecef] bg-[#fafafa] text-[#3f3f46]'
                          : 'border-red-200 bg-red-50/60 text-red-900'
                    }`}
                  >
                    {updateResult.hasUpdate ? (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold">
                            🎉 发现新版本 v{updateResult.latestVersion}（{updateResult.releaseTitle || '可升级'}）
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void window.fmc.openExternal(updateResult.htmlUrl)}
                              className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-white px-2.5 py-1 text-[11px] font-medium text-emerald-900 hover:bg-emerald-100"
                            >
                              <ExternalLink className="h-3 w-3" />
                              GitHub 页面
                            </button>
                            {updateResult.downloadUrl && (
                              <button
                                type="button"
                                disabled={downloadingUpd}
                                onClick={async () => {
                                  setDownloadingUpd(true);
                                  setDlError('');
                                  const r = await window.fmc.downloadAppUpdate({
                                    downloadUrl: updateResult.downloadUrl!,
                                    version: updateResult.latestVersion,
                                    highlights: updateResult.highlights
                                  });
                                  if (!r.ok) {
                                    setDownloadingUpd(false);
                                    setDlError(r.message);
                                  }
                                }}
                                className="inline-flex items-center gap-1 rounded-lg bg-[#18181b] px-3 py-1 text-[11.5px] font-medium text-white hover:bg-[#27272a] disabled:opacity-50"
                              >
                                {downloadingUpd ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Download className="h-3 w-3" />
                                )}
                                {downloadingUpd ? '下载中...' : '一键下载并安装'}
                              </button>
                            )}
                          </div>
                        </div>
                        {updateResult.highlights.length > 0 && (
                          <ul className="list-disc space-y-1 pl-4 text-[11.5px] text-emerald-900">
                            {updateResult.highlights.map((h, i) => (
                              <li key={i}>{h}</li>
                            ))}
                          </ul>
                        )}
                        {downloadingUpd && dlProgress && (
                          <div className="space-y-1 pt-1">
                            <div className="flex justify-between font-mono text-[10.5px]">
                              <span>下载进度 {dlProgress.percent}%</span>
                              <span>
                                {dlProgress.transferredMB} / {dlProgress.totalMB} MB
                              </span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/80">
                              <div
                                className="h-full rounded-full bg-emerald-600 transition-all"
                                style={{ width: `${dlProgress.percent}%` }}
                              />
                            </div>
                          </div>
                        )}
                        {dlError && <p className="text-[11px] text-red-600">{dlError}</p>}
                      </div>
                    ) : updateResult.ok ? (
                      <span>✓ 当前已是最新版本（v{updateResult.currentVersion}），无需更新。</span>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>{updateResult.error || '检查更新失败'}</span>
                        <button
                          type="button"
                          onClick={() => void window.fmc.openExternal(updateResult.htmlUrl)}
                          className="underline"
                        >
                          前往 GitHub 查看
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Startup Automatic Update Check Switch */}
              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div>
                  <div className="font-medium text-[#111827]">启动软件时自动检测一次更新</div>
                  <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                    每次启动后后台静默检查一次 GitHub 新版本；发现更新时弹窗提醒，无更新时不打扰
                  </div>
                </div>
                <button
                  onClick={() =>
                    void onUpdateSettings({
                      checkUpdateOnStartup: settings.checkUpdateOnStartup === false
                    })
                  }
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                    settings.checkUpdateOnStartup !== false ? 'bg-[#18181b]' : 'bg-[#e4e4e7]'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-2xs transition-transform ${
                      settings.checkUpdateOnStartup !== false
                        ? 'translate-x-[18px]'
                        : 'translate-x-[3px]'
                    }`}
                  />
                </button>
              </div>

              {/* Official Chrome Extension + Built-in Local Browser */}
              <div className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2 font-medium text-[#111827]">
                      <span>本机真实 IP 浏览器双通道（官方 Chrome 插件 + 内置浏览器）</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${
                          extStatus?.installed
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-[#f4f4f5] text-[#52525b]'
                        }`}
                      >
                        {extStatus?.installed
                          ? `已检测到 ${extStatus.browser === 'edge' ? 'Edge' : 'Chrome'} 插件 v${extStatus.version}`
                          : '内置本地浏览器已就绪'}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                      防止云端机房 IP 风控：唤醒本机 Chrome 官方「Muse from Meta」插件或使用内置受控本地浏览器（<code className="font-mono">/api/v1/browser/*</code>），全程走本机网络与登录态
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        const r = await window.fmc.launchMuseExtensionHost(!extStatus?.installed);
                        setExtStatus(r.status);
                        setExtMsg(r.message);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-[#18181b] px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[#27272a]"
                    >
                      {extStatus?.installed ? '唤醒本机 Chrome 插件' : '安装官方 Muse 插件'}
                    </button>
                    {extStatus?.installed && (
                      <button
                        type="button"
                        onClick={async () => {
                          const r = await window.fmc.launchMuseExtensionHost(true);
                          setExtMsg(r.message);
                        }}
                        className="rounded-xl border border-[#e4e4e7] bg-white px-2.5 py-1.5 text-[11.5px] font-medium text-[#52525b] hover:bg-[#f4f4f5]"
                      >
                        插件商店页
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void window.fmc.openLocalControlledBrowser()}
                      className="rounded-xl border border-[#e4e4e7] bg-white px-3 py-1.5 text-[12px] font-medium text-[#3f3f46] hover:bg-[#f4f4f5]"
                    >
                      打开内置本地浏览器
                    </button>
                  </div>
                </div>
                {extMsg && <p className="mt-2 text-[11.5px] text-[#52525b]">{extMsg}</p>}
              </div>

              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div>
                  <div className="font-medium text-[#111827]">启动软件时自动挂起内嵌 Tailscale 永久域名</div>
                  <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                    纯用户态运行，完全退出 MuseDeck 时自动停止，不驻留系统服务
                  </div>
                </div>
                <button
                  onClick={() =>
                    void onUpdateControlApi({
                      autoStartTunnel: state.controlApi.autoStartTunnel === false
                    })
                  }
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                    state.controlApi.autoStartTunnel !== false ? 'bg-[#18181b]' : 'bg-[#e4e4e7]'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-2xs transition-transform ${
                      state.controlApi.autoStartTunnel !== false
                        ? 'translate-x-[18px]'
                        : 'translate-x-[3px]'
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div>
                  <div className="font-medium text-[#111827]">协议或地址变更时自动同步给 Muse</div>
                  <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                    当 CLI 权重、工作流策略、Token 或公网域名变化时，自动发送带版本号的最新协议并声明覆盖旧记忆
                  </div>
                </div>
                <button
                  onClick={() =>
                    void onUpdateControlApi({
                      autoSyncToMuse: state.controlApi.autoSyncToMuse === false
                    })
                  }
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                    state.controlApi.autoSyncToMuse !== false ? 'bg-[#18181b]' : 'bg-[#e4e4e7]'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-2xs transition-transform ${
                      state.controlApi.autoSyncToMuse !== false
                        ? 'translate-x-[18px]'
                        : 'translate-x-[3px]'
                    }`}
                  />
                </button>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div>
                  <div className="font-medium text-[#111827]">配置数据与初始向导</div>
                  <div className="mt-0.5 text-[11.5px] text-[#71717a]">
                    所有配置均保存在本地应用数据目录，绝不修改本机 CLI 原配置
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void window.fmc.openDataDir()}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[#e4e4e7] bg-white px-3 py-1.5 text-[12px] font-medium text-[#3f3f46] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    打开数据目录
                  </button>
                  <button
                    onClick={() => void window.fmc.resetOnboarding()}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[#e4e4e7] bg-white px-3 py-1.5 text-[12px] font-medium text-[#3f3f46] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    重新打开向导
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
