import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowUpCircle,
  BookmarkPlus,
  Check,
  CheckCircle2,
  Download,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  Wand2,
  X,
  XCircle
} from 'lucide-react';
import {
  ApiProtocol,
  CliPresetGroup,
  CliUpdateInfo,
  CliUserConfig,
  DetectedCli,
  ReasoningEffort,
  UserProfileConfig
} from '../types';
import { CliBrandIcon } from './CliBrandIcon';
import { PROFESSION_OPTIONS, PURPOSE_OPTIONS } from './OnboardingWizard';

const EFFORT_OPTIONS: Array<{ id: ReasoningEffort; label: string }> = [
  { id: 'default', label: '默认' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'XHigh' }
];

const ROLE_TAG_OPTIONS = [
  '架构规划',
  '核心编码',
  '修 Bug / 单测',
  '前端 UI',
  '代码审查',
  '复杂重构',
  '文档调研',
  '全栈开发'
];

const API_PROTOCOLS: Array<{ id: ApiProtocol; label: string; desc: string }> = [
  { id: 'openai_chat', label: 'OpenAI Chat 兼容 (/v1)', desc: '通用中转站 / OpenAI / DeepSeek / Kimi' },
  { id: 'openai_responses', label: 'OpenAI Responses (/v1)', desc: 'Codex CLI 推荐协议' },
  { id: 'anthropic', label: 'Anthropic Messages (/v1)', desc: 'Claude Code / Pi 推荐协议' },
  { id: 'gemini_native', label: 'Gemini 原生 (/v1beta)', desc: 'Gemini CLI / Antigravity 原生协议' },
  { id: 'custom_raw', label: '原样 URL（不自动补全）', desc: '完全按你输入的地址请求' }
];

const PROVIDER_PRESETS: Array<{
  label: string;
  baseUrl: string;
  protocol?: ApiProtocol;
}> = [
  { label: '官方直连', baseUrl: '' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', protocol: 'openai_chat' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', protocol: 'openai_chat' },
  { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn', protocol: 'openai_chat' },
  { label: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn', protocol: 'openai_chat' }
];

function previewCompletedUrls(protocol: ApiProtocol, rawBase: string, cliId: string) {
  const defaults: Record<string, string> = {
    claude: 'https://api.anthropic.com',
    codex: 'https://api.openai.com',
    gemini: 'https://generativelanguage.googleapis.com',
    antigravity: 'https://generativelanguage.googleapis.com',
    pi: 'https://api.anthropic.com',
    grok: 'https://api.x.ai',
    kimi: 'https://api.moonshot.cn',
    deepseek: 'https://api.deepseek.com'
  };
  const trimmed = (rawBase || defaults[cliId] || 'https://api.openai.com').trim().replace(/\/+$/, '');
  if (protocol === 'custom_raw') {
    return {
      baseUrl: trimmed,
      modelsUrl: trimmed.endsWith('/models') ? trimmed : `${trimmed}/models`
    };
  }
  if (protocol === 'gemini_native') {
    const base = /\/v1(beta)?$/i.test(trimmed) ? trimmed : `${trimmed}/v1beta`;
    return { baseUrl: base, modelsUrl: `${base}/models` };
  }
  if (protocol === 'anthropic') {
    const root = trimmed.replace(/\/v1$/i, '');
    return { baseUrl: root, modelsUrl: `${root}/v1/models` };
  }
  const v1Base = /\/v\d+$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
  return { baseUrl: v1Base, modelsUrl: `${v1Base}/models` };
}

interface CliManagerViewProps {
  clis: DetectedCli[];
  scanning: boolean;
  userProfile?: UserProfileConfig;
  activePresetId?: string;
  cliPresets?: CliPresetGroup[];
  onRescan: () => void;
  onSaveConfig: (cliId: string, config: CliUserConfig) => Promise<void>;
  compact?: boolean;
}

interface PkgTaskModal {
  cliId: string;
  cliName: string;
  action: 'install' | 'update' | 'uninstall';
  running: boolean;
  ok?: boolean;
  message?: string;
  logs: string;
}

export const CliManagerView: React.FC<CliManagerViewProps> = ({
  clis,
  scanning,
  userProfile,
  activePresetId = 'preset-smart-default',
  cliPresets = [],
  onRescan,
  onSaveConfig,
  compact = false
}) => {
  const [editingCli, setEditingCli] = useState<DetectedCli | null>(null);
  const [draft, setDraft] = useState<CliUserConfig | null>(null);
  const [openedModel, setOpenedModel] = useState('');
  const [singleModelRecBusy, setSingleModelRecBusy] = useState<'muse' | 'preset' | null>(null);
  const [singleModelRecTip, setSingleModelRecTip] = useState('');
  const [saving, setSaving] = useState(false);
  const [scanningModels, setScanningModels] = useState(false);
  const [scannedModels, setScannedModels] = useState<string[]>([]);
  const [scanHint, setScanHint] = useState('');

  // Preset Squad Saver Modal state
  const [showSavePresetModal, setShowSavePresetModal] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [newPresetPolicy, setNewPresetPolicy] = useState<'strict_custom' | 'muse_decide'>('strict_custom');
  const [presetToast, setPresetToast] = useState('');

  // Smart Role Recommendation Modal state (available anytime in CLI Manager!)
  const [showRecommendModal, setShowRecommendModal] = useState(false);
  const [profDraft, setProfDraft] = useState(userProfile?.profession || '');
  const [purpDraft, setPurpDraft] = useState<string[]>(userProfile?.purposes || []);
  const [noteDraft, setNoteDraft] = useState(userProfile?.customNote || '');
  const [recommending, setRecommending] = useState<'muse' | 'preset' | null>(null);
  const [recommendMsg, setRecommendMsg] = useState('');

  useEffect(() => {
    setProfDraft(userProfile?.profession || '');
    setPurpDraft(userProfile?.purposes || []);
    setNoteDraft(userProfile?.customNote || '');
  }, [userProfile?.profession, userProfile?.customNote, userProfile?.recommendedAt]);

  // If Muse asynchronously applies single-CLI role recommendations while editor modal is open, sync them into draft!
  useEffect(() => {
    if (!editingCli) return;
    const latest = clis.find((c) => c.id === editingCli.id);
    if (!latest || !latest.config.roleWeights) return;
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            roleWeights: { ...latest.config.roleWeights },
            roles: latest.config.roles ? [...latest.config.roles] : prev.roles,
            reasoningEffort: latest.config.reasoningEffort || prev.reasoningEffort
          }
        : null
    );
    const museReason = userProfile?.cliReasons?.[editingCli.id];
    if (museReason && singleModelRecBusy === null && userProfile?.lastRecommendationSource === 'muse') {
      setSingleModelRecTip(`✨ Muse 推荐：${museReason}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userProfile?.recommendedAt]);

  // Endpoint latency test & quota/balance probe state (CC-Switch style)
  const [testingEndpoint, setTestingEndpoint] = useState(false);
  const [endpointResult, setEndpointResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [checkingQuota, setCheckingQuota] = useState(false);
  const [quotaPreview, setQuotaPreview] = useState<import('../types').CliQuotaSnapshot | null>(null);

  // Per-role 0-5 weight floating popover + custom role input
  const [activeRolePopover, setActiveRolePopover] = useState<{
    role: string;
    left: number;
    bottom: number;
  } | null>(null);
  const [addingCustomRole, setAddingCustomRole] = useState(false);
  const [customRoleInput, setCustomRoleInput] = useState('');
  const rolePopoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!activeRolePopover) return;
    const onDocDown = (e: MouseEvent) => {
      if (rolePopoverRef.current && !rolePopoverRef.current.contains(e.target as Node)) {
        setActiveRolePopover(null);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [activeRolePopover]);

  // CLI update check & one-click install/update/uninstall state
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateMap, setUpdateMap] = useState<Record<string, CliUpdateInfo>>({});
  const [updateSummary, setUpdateSummary] = useState('');
  const [pkgTask, setPkgTask] = useState<PkgTaskModal | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const off = window.fmc.onEvent('cli:pkgLog', (payload) => {
      const ev = payload as { cliId: string; action: 'install' | 'update' | 'uninstall'; text: string };
      setPkgTask((prev) => {
        if (!prev || prev.cliId !== ev.cliId) return prev;
        return { ...prev, logs: prev.logs + ev.text };
      });
    });
    return () => off();
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [pkgTask?.logs]);

  const installedClis = clis.filter((c) => c.installed);
  const uninstalledClis = clis.filter((c) => !c.installed);

  const handleCheckUpdates = async () => {
    setCheckingUpdates(true);
    setUpdateSummary('');
    try {
      const res = await window.fmc.checkCliUpdates();
      setUpdateMap(res);
      const count = Object.values(res).filter((u) => u.hasUpdate).length;
      setUpdateSummary(count > 0 ? `发现 ${count} 个 CLI 有新版本` : '已检测，当前均为最新版本');
    } finally {
      setCheckingUpdates(false);
    }
  };

  const handlePackageAction = async (cli: DetectedCli, action: 'install' | 'update' | 'uninstall') => {
    if (action === 'uninstall') {
      const ok = window.confirm(`确定要卸载 ${cli.name} (${cli.command}) 吗？`);
      if (!ok) return;
    }
    setPkgTask({
      cliId: cli.id,
      cliName: cli.name,
      action,
      running: true,
      logs: ''
    });
    try {
      const res =
        action === 'install'
          ? await window.fmc.installCli(cli.id)
          : action === 'update'
            ? await window.fmc.updateCli(cli.id)
            : await window.fmc.uninstallCli(cli.id);
      setPkgTask((prev) =>
        prev
          ? {
              ...prev,
              running: false,
              ok: res.ok,
              message: res.message
            }
          : null
      );
      if (res.ok) {
        onRescan();
        if (action === 'update' || action === 'uninstall') {
          setUpdateMap((prev) => {
            const next = { ...prev };
            delete next[cli.id];
            return next;
          });
        }
      }
    } catch (err) {
      setPkgTask((prev) =>
        prev
          ? {
              ...prev,
              running: false,
              ok: false,
              message: err instanceof Error ? err.message : String(err)
            }
          : null
      );
    }
  };

  const openEditor = (cli: DetectedCli) => {
    // Normalize initial roleWeights from existing config
    const initRoleWeights: Record<string, number> = { ...(cli.config.roleWeights || {}) };
    if (Object.keys(initRoleWeights).length === 0 && cli.config.roles && cli.config.roles.length > 0) {
      const w = cli.config.weight ?? 4;
      for (const r of cli.config.roles) initRoleWeights[r] = w;
    }
    setEditingCli(cli);
    setDraft({ ...cli.config, roleWeights: initRoleWeights });
    setOpenedModel(cli.config.defaultModel || '');
    setSingleModelRecTip('');
    setScannedModels(cli.models);
    setScanHint('');
    setEndpointResult(null);
    setActiveRolePopover(null);
    setAddingCustomRole(false);
    setCustomRoleInput('');
  };

  const setRoleWeight = (role: string, weight: number) => {
    if (!draft) return;
    const nextWeights = { ...(draft.roleWeights || {}), [role]: weight };
    if (weight === 0 && !ROLE_TAG_OPTIONS.includes(role)) {
      // Keep custom role visible at weight 0 until explicitly deleted
      nextWeights[role] = 0;
    }
    const activeRoles = Object.entries(nextWeights)
      .filter(([, w]) => w > 0)
      .map(([r]) => r);
    setDraft({ ...draft, roleWeights: nextWeights, roles: activeRoles });
  };

  const removeCustomRole = (role: string) => {
    if (!draft) return;
    const nextWeights = { ...(draft.roleWeights || {}) };
    delete nextWeights[role];
    const activeRoles = Object.entries(nextWeights)
      .filter(([, w]) => w > 0)
      .map(([r]) => r);
    setDraft({ ...draft, roleWeights: nextWeights, roles: activeRoles });
    setActiveRolePopover(null);
  };

  const openRolePopoverFromEl = (role: string, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const popWidth = 224;
    const left = Math.max(12, Math.min(window.innerWidth - popWidth - 12, rect.left + rect.width / 2 - popWidth / 2));
    const bottom = Math.max(12, window.innerHeight - rect.top + 8);
    setActiveRolePopover((prev) => (prev?.role === role ? null : { role, left, bottom }));
  };

  const handleAddCustomRole = () => {
    const trimmed = customRoleInput.trim();
    if (!trimmed || !draft) return;
    setRoleWeight(trimmed, 4);
    setCustomRoleInput('');
    setAddingCustomRole(false);
  };

  const handleTestEndpoint = async () => {
    if (!editingCli || !draft || testingEndpoint) return;
    setTestingEndpoint(true);
    setEndpointResult(null);
    try {
      const res = await window.fmc.testCliEndpoint(editingCli.id, draft);
      setEndpointResult({ ok: res.ok, message: res.message });
    } finally {
      setTestingEndpoint(false);
    }
  };

  const handleScanModels = async () => {
    if (!editingCli || !draft) return;
    setScanningModels(true);
    setScanHint(
      draft.authMode === 'api_key' ? '正在从你填写的 API 拉取模型列表...' : '正在扫描本机 CLI 配置与本地模型...'
    );
    try {
      const res = await window.fmc.scanCliModels(editingCli.id, draft);
      setScannedModels(res.models);
      if (res.error) {
        setScanHint(`⚠️ ${res.error}`);
      } else {
        setScanHint(`已扫描到 ${res.models.length} 个模型（来源：${res.sources.join(' + ')}）`);
      }
    } finally {
      setScanningModels(false);
    }
  };

  const handleToggle = async (cli: DetectedCli) => {
    await onSaveConfig(cli.id, {
      ...cli.config,
      enabled: !cli.config.enabled
    });
  };

  const handleSaveDraft = async () => {
    if (!editingCli || !draft) return;
    setSaving(true);
    try {
      await onSaveConfig(editingCli.id, draft);
      setEditingCli(null);
      setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  const renderRow = (cli: DetectedCli) => {
    const upd = updateMap[cli.id];
    const canInstallOrUpdate = cli.canAutoInstall !== false;
    const isBusy = pkgTask?.running && pkgTask.cliId === cli.id;

    return (
      <div
        key={cli.id}
        className="flex items-center justify-between gap-4 border-b border-[#f1f1f3] px-4 py-3 last:border-b-0 transition-colors hover:bg-[#fafafa]"
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[#eaecef] bg-[#fafafa]">
            <CliBrandIcon cliId={cli.id} avatarUrl={cli.config.avatarUrl} className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[13px] font-medium text-[#111827]">{cli.name}</span>
              {cli.config.defaultModel && (
                <span className="rounded-md bg-[#f4f4f5] px-1.5 py-0.5 font-mono text-[11px] text-[#52525b]">
                  {cli.config.defaultModel}
                </span>
              )}
              {cli.config.authMode === 'api_key' && cli.config.apiKey && (
                <span className="rounded-md border border-[#eaecef] bg-white px-1.5 py-0.5 text-[10.5px] font-medium text-[#52525b]">
                  自定义 API
                </span>
              )}
              {upd?.hasUpdate && (
                <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-amber-800 ring-1 ring-amber-200/80">
                  新版本 v{upd.latestVersion}
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate font-mono text-[11px] text-[#8a8f98]">
              {cli.installed ? cli.executablePath : cli.installCmd}
            </p>
            {(() => {
              const rw = cli.config.roleWeights || {};
              const activePairs = Object.entries(rw)
                .filter(([, w]) => w > 0)
                .sort((a, b) => b[1] - a[1]);
              if (activePairs.length === 0) return null;
              return (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {activePairs.slice(0, 5).map(([role, w]) => (
                    <span
                      key={role}
                      className="rounded bg-[#f4f4f5] px-1.5 py-0.2 text-[10px] font-medium text-[#3f3f46]"
                    >
                      {role} {w}/5
                    </span>
                  ))}
                  {activePairs.length > 5 && (
                    <span className="text-[10px] text-[#8a8f98]">+{activePairs.length - 5}</span>
                  )}
                </div>
              );
            })()}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div className="mr-1 text-right">
            {cli.installed ? (
              <span className="inline-flex items-center gap-1 font-mono text-[11.5px] font-medium text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {cli.version && cli.version !== 'installed' ? `v${cli.version.replace(/^v/, '')}` : '已安装'}
              </span>
            ) : (
              <span className="text-[11.5px] text-[#a1a1aa]">未安装</span>
            )}
          </div>

          {/* One-click Install */}
          {!cli.installed && canInstallOrUpdate && (
            <button
              onClick={() => void handlePackageAction(cli, 'install')}
              disabled={Boolean(pkgTask?.running)}
              className="inline-flex items-center gap-1 rounded-lg bg-[#18181b] px-2.5 py-1 text-[11.5px] font-medium text-white transition-colors hover:bg-[#27272a] disabled:opacity-50"
              title={`运行：${cli.installCmd}`}
            >
              {isBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              一键安装
            </button>
          )}

          {/* One-click Update */}
          {cli.installed && canInstallOrUpdate && (
            <button
              onClick={() => void handlePackageAction(cli, 'update')}
              disabled={Boolean(pkgTask?.running)}
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-50 ${
                upd?.hasUpdate
                  ? 'bg-[#18181b] text-white hover:bg-[#27272a]'
                  : 'border border-[#e4e4e7] bg-white text-[#52525b] hover:bg-[#f4f4f5] hover:text-[#111827]'
              }`}
              title={`运行：${cli.updateCmd || cli.installCmd}`}
            >
              {isBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowUpCircle className="h-3.5 w-3.5" />
              )}
              更新
            </button>
          )}

          <button
            onClick={() => openEditor(cli)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#e4e4e7] bg-white px-2.5 py-1 text-[12px] font-medium text-[#3f3f46] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
          >
            <Settings2 className="h-3.5 w-3.5" />
            配置
          </button>

          {/* One-click Uninstall */}
          {cli.installed && canInstallOrUpdate && (
            <button
              onClick={() => void handlePackageAction(cli, 'uninstall')}
              disabled={Boolean(pkgTask?.running)}
              className="rounded-lg p-1.5 text-[#a1a1aa] transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
              title={`卸载 ${cli.name}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}

          <button
            onClick={() => void handleToggle(cli)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              cli.config.enabled ? 'bg-[#18181b]' : 'bg-[#e4e4e7]'
            }`}
            title={cli.config.enabled ? '已接入调度' : '未启用'}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-2xs transition-transform ${
                cli.config.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
              }`}
            />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      {!compact && (
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-[#eaecef] bg-white px-5">
          <div className="flex items-center gap-2.5">
            <h2 className="text-[13.5px] font-semibold text-[#111827]">应用 / CLI 雷达</h2>
            <span className="rounded-md bg-[#f4f4f5] px-2 py-0.5 text-[11px] font-medium text-[#52525b]">
              已启用 {clis.filter((c) => c.config.enabled).length} / {installedClis.length}
            </span>
            {updateSummary && (
              <span className="text-[11.5px] text-[#71717a]">{updateSummary}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setRecommendMsg('');
                setShowRecommendModal(true);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#18181b] px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-[#27272a]"
              title="根据你的职业与软件用途，让 Muse 智能推荐各 CLI 的职能分工与思考等级"
            >
              <Sparkles className="h-3.5 w-3.5 text-amber-400" />
              智能职能推荐
            </button>
            <button
              onClick={() => void handleCheckUpdates()}
              disabled={checkingUpdates}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#e4e4e7] bg-white px-2.5 py-1 text-[12px] font-medium text-[#3f3f46] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827] disabled:opacity-50"
            >
              <ArrowUpCircle className={`h-3.5 w-3.5 ${checkingUpdates ? 'animate-pulse' : ''}`} />
              {checkingUpdates ? '检测中...' : '检测更新'}
            </button>
            <button
              onClick={onRescan}
              disabled={scanning}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#e4e4e7] bg-white px-2.5 py-1 text-[12px] font-medium text-[#3f3f46] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827] disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} />
              {scanning ? '扫描中...' : '重新检测'}
            </button>
          </div>
        </header>
      )}

      <div className={`flex-1 overflow-y-auto ${compact ? '' : 'px-6 py-6'}`}>
        <div className={compact ? 'space-y-4' : 'mx-auto max-w-[940px] space-y-6'}>
          {!compact && (
            <div className="space-y-3">
              {/* CLI Squad Presets Switcher: Smart Group vs User Custom Combinations */}
              <section className="rounded-2xl border border-[#eaecef] bg-[#fafafa] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Layers className="h-4 w-4 text-[#18181b]" />
                    <span className="text-[13px] font-semibold text-[#111827]">
                      预设编队组合（支持一键切换「Muse 智能决策组」与「自定义分工组合」）
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setNewPresetName('');
                      setNewPresetPolicy('strict_custom');
                      setShowSavePresetModal(true);
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-[#18181b] bg-white px-2.5 py-1 text-[11.5px] font-medium text-[#111827] transition-colors hover:bg-[#18181b] hover:text-white"
                  >
                    <BookmarkPlus className="h-3.5 w-3.5" />
                    保存当前配置为新组合
                  </button>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {(cliPresets.length > 0
                    ? cliPresets
                    : [
                        {
                          id: 'preset-smart-default',
                          name: 'Muse 智能决策组',
                          kind: 'smart' as const,
                          dispatchPolicy: 'muse_decide' as const,
                          cliSnapshots: {},
                          updatedAt: ''
                        }
                      ]
                  ).map((preset) => {
                    const isActive = preset.id === activePresetId;
                    const isSmart = preset.kind === 'smart';
                    return (
                      <div
                        key={preset.id}
                        className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[12px] transition-all ${
                          isActive
                            ? 'border-[#18181b] bg-[#18181b] font-medium text-white shadow-2xs'
                            : 'border-[#e4e4e7] bg-white text-[#3f3f46] hover:border-[#a1a1aa] hover:text-[#111827]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={async () => {
                            await window.fmc.mutateCliPreset({
                              action: 'activate',
                              presetId: preset.id
                            });
                            setPresetToast(
                              preset.dispatchPolicy === 'strict_custom'
                                ? `已切换至「${preset.name}」：Muse 将严格按此自定义组合的模型与职能权重分工！`
                                : `已切换至「${preset.name}」：Muse 将根据子任务动态选择最优模型与分工！`
                            );
                            setTimeout(() => setPresetToast(''), 5000);
                          }}
                          className="inline-flex items-center gap-1.5 text-left"
                        >
                          <span>{isSmart ? '🤖' : '🛠️'}</span>
                          <span>{preset.name}</span>
                          <span
                            className={`rounded px-1.5 py-0.2 text-[10px] ${
                              isActive
                                ? 'bg-white/20 text-white'
                                : 'bg-[#f4f4f5] text-[#71717a]'
                            }`}
                          >
                            {preset.dispatchPolicy === 'strict_custom' ? '固定分工' : 'Muse 选模型'}
                          </span>
                        </button>
                        {!isSmart && (
                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (!window.confirm(`确定删除预设组合「${preset.name}」吗？`)) return;
                              await window.fmc.mutateCliPreset({
                                action: 'delete',
                                presetId: preset.id
                              });
                            }}
                            className={`ml-0.5 rounded p-0.5 transition-colors ${
                              isActive
                                ? 'text-white/70 hover:bg-white/20 hover:text-white'
                                : 'text-[#a1a1aa] hover:bg-red-50 hover:text-red-600'
                            }`}
                            title="删除此预设组合"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Active Preset Policy Toggle */}
                {(() => {
                  const curPreset = cliPresets.find((p) => p.id === activePresetId);
                  if (!curPreset) return null;
                  return (
                    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-[#e4e4e7]/70 pt-2.5 text-[11.5px] text-[#52525b]">
                      <span>
                        当前生效：<strong>{curPreset.name}</strong> —{' '}
                        {curPreset.dispatchPolicy === 'strict_custom'
                          ? 'Muse 严格按下方各 CLI 设定的模型与职能权重派单（适合精细固定分工）'
                          : 'Muse 结合下方职能倾向，按子任务难度从可用模型池动态选模型（适合智能省心）'}
                      </span>
                      <button
                        type="button"
                        onClick={async () => {
                          const nextPol =
                            curPreset.dispatchPolicy === 'strict_custom'
                              ? 'muse_decide'
                              : 'strict_custom';
                          await window.fmc.mutateCliPreset({
                            action: 'update_current',
                            presetId: curPreset.id,
                            dispatchPolicy: nextPol
                          });
                        }}
                        className="rounded-lg border border-[#e4e4e7] bg-white px-2.5 py-0.5 text-[11px] font-medium text-[#111827] hover:bg-[#f4f4f5]"
                      >
                        切换为：{curPreset.dispatchPolicy === 'strict_custom' ? '允许 Muse 动态选模型' : '固定按我设定的模型分工'}
                      </button>
                    </div>
                  );
                })()}

                {presetToast && (
                  <div className="mt-2 rounded-lg bg-emerald-50 px-3 py-1.5 text-[11px] font-medium text-emerald-900 ring-1 ring-emerald-200">
                    {presetToast}
                  </div>
                )}
              </section>

              {userProfile?.lastRecommendationSummary && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200/80 bg-emerald-50/60 px-3.5 py-2 text-[11.5px] text-emerald-950">
                  <span>✨ {userProfile.lastRecommendationSummary}</span>
                  <button
                    type="button"
                    onClick={() => setShowRecommendModal(true)}
                    className="shrink-0 rounded-md bg-white px-2 py-0.5 text-[11px] font-medium text-emerald-900 ring-1 ring-emerald-200 hover:bg-emerald-100"
                  >
                    修改画像 / 重新推荐
                  </button>
                </div>
              )}
            </div>
          )}

          <section className="overflow-hidden rounded-2xl border border-[#eaecef] bg-white">
            <div className="flex items-center justify-between border-b border-[#eaecef] bg-[#fafafa] px-4 py-2 text-[11.5px] font-medium text-[#71717a]">
              <span>已安装 · {installedClis.length}</span>
              <span>版本 / 更新 / 配置 / 卸载 / 调度开关</span>
            </div>
            {installedClis.length === 0 ? (
              <div className="p-6 text-center text-[12px] text-[#8a8f98]">
                未在系统 PATH 检测到已安装的 CLI，可直接点击下方「一键安装」完成部署。
              </div>
            ) : (
              installedClis.map(renderRow)
            )}
          </section>

          <section className="overflow-hidden rounded-2xl border border-[#eaecef] bg-white">
            <div className="flex items-center justify-between border-b border-[#eaecef] bg-[#fafafa] px-4 py-2 text-[11.5px] font-medium text-[#71717a]">
              <span>未安装 · {uninstalledClis.length}</span>
              <span>支持一键命令行安装（自动扫描生效）</span>
            </div>
            {uninstalledClis.map(renderRow)}
          </section>
        </div>
      </div>

      {/* Live CLI Install / Update / Uninstall Terminal Modal */}
      {pkgTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[1px]">
          <div className="flex w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[#e4e4e7] bg-white shadow-popover">
            <div className="flex items-center justify-between border-b border-[#eaecef] px-5 py-3.5">
              <div className="flex items-center gap-2">
                {pkgTask.running ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[#111827]" />
                ) : pkgTask.ok ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : (
                  <XCircle className="h-4 w-4 text-red-500" />
                )}
                <h3 className="text-[13.5px] font-semibold text-[#111827]">
                  {pkgTask.action === 'install'
                    ? '正在安装'
                    : pkgTask.action === 'update'
                      ? '正在更新'
                      : '正在卸载'}{' '}
                  {pkgTask.cliName}
                </h3>
              </div>
              {!pkgTask.running && (
                <button
                  onClick={() => setPkgTask(null)}
                  className="rounded-lg p-1 text-[#8a8f98] hover:bg-[#f4f4f5] hover:text-[#111827]"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            <div className="p-4">
              <pre className="h-64 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-[#18181b] p-3.5 font-mono text-[11.5px] leading-relaxed text-[#e4e4e7]">
                {pkgTask.logs || '正在初始化命令行环境...'}
                <div ref={logEndRef} />
              </pre>

              {pkgTask.message && (
                <p
                  className={`mt-3 text-[12px] font-medium ${
                    pkgTask.ok ? 'text-emerald-700' : 'text-red-600'
                  }`}
                >
                  {pkgTask.message}
                </p>
              )}
            </div>

            <div className="flex justify-end border-t border-[#eaecef] px-5 py-3">
              <button
                onClick={() => setPkgTask(null)}
                disabled={pkgTask.running}
                className="rounded-xl bg-[#18181b] px-4 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[#27272a] disabled:opacity-40"
              >
                {pkgTask.running ? '执行中，请稍候...' : '完成关闭'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CLI Config Modal (CC-Switch Style Presets + Speed Test) */}
      {editingCli && draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[1px]">
          <div className="flex max-h-[88vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-[#e4e4e7] bg-white shadow-popover">
            <div className="flex items-center justify-between border-b border-[#eaecef] px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg border border-[#eaecef] bg-[#fafafa]">
                  <CliBrandIcon cliId={editingCli.id} avatarUrl={draft.avatarUrl} className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-[14px] font-semibold text-[#111827]">{editingCli.name} 配置</h3>
                  <p className="font-mono text-[11px] text-[#8a8f98]">{editingCli.command}</p>
                </div>
              </div>
              <button
                onClick={() => setEditingCli(null)}
                className="rounded-lg p-1 text-[#8a8f98] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 space-y-3.5 overflow-y-auto p-5 text-[12.5px]">
              <div>
                <label className="mb-1.5 block font-medium text-[#3f3f46]">认证方式</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => {
                      setDraft({ ...draft, authMode: 'oauth' });
                      setScannedModels([]);
                      setScanHint('');
                      setEndpointResult(null);
                    }}
                    className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                      draft.authMode === 'oauth'
                        ? 'border-[#18181b] bg-[#fafafa] text-[#111827]'
                        : 'border-[#e4e4e7] text-[#52525b] hover:bg-[#fafafa]'
                    }`}
                  >
                    <div className="font-medium">本机账号 / OAuth</div>
                    <span className="mt-0.5 block text-[10.5px] text-[#8a8f98]">
                      复用 CLI 自身登录态
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      setDraft({ ...draft, authMode: 'api_key' });
                      setScannedModels([]);
                      setScanHint('');
                      setEndpointResult(null);
                    }}
                    className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                      draft.authMode === 'api_key'
                        ? 'border-[#18181b] bg-[#fafafa] text-[#111827]'
                        : 'border-[#e4e4e7] text-[#52525b] hover:bg-[#fafafa]'
                    }`}
                  >
                    <div className="font-medium">自定义 API Key</div>
                    <span className="mt-0.5 block text-[10.5px] text-[#8a8f98]">
                      注入 {editingCli.apiKeyEnv}
                    </span>
                  </button>
                </div>
              </div>

              {draft.authMode === 'api_key' && (
                <>
                  {/* CC-Switch Quick Provider Presets */}
                  <div>
                    <label className="mb-1.5 block font-medium text-[#3f3f46]">常用供应商预设</label>
                    <div className="flex flex-wrap gap-1.5">
                      {PROVIDER_PRESETS.map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() => {
                            setDraft({
                              ...draft,
                              baseUrl: p.baseUrl,
                              apiProtocol: p.protocol || draft.apiProtocol
                            });
                            setEndpointResult(null);
                          }}
                          className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors ${
                            draft.baseUrl === p.baseUrl
                              ? 'bg-[#18181b] text-white'
                              : 'border border-[#e4e4e7] bg-white text-[#52525b] hover:bg-[#f4f4f5] hover:text-[#111827]'
                          }`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block font-medium text-[#3f3f46]">API 协议类型</label>
                    <select
                      value={draft.apiProtocol || 'openai_chat'}
                      onChange={(e) => {
                        setDraft({ ...draft, apiProtocol: e.target.value as ApiProtocol });
                        setScannedModels([]);
                        setScanHint('');
                        setEndpointResult(null);
                      }}
                      className="w-full rounded-xl border border-[#e4e4e7] bg-white px-3 py-2 text-[#111827] outline-none focus:border-[#18181b]"
                    >
                      {API_PROTOCOLS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label} — {p.desc}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block font-medium text-[#3f3f46]">
                      API Key ({editingCli.apiKeyEnv})
                    </label>
                    <input
                      type="password"
                      value={draft.apiKey}
                      onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                      placeholder="sk-..."
                      className="w-full rounded-xl border border-[#e4e4e7] px-3 py-2 text-[#111827] outline-none focus:border-[#18181b]"
                    />
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <label className="font-medium text-[#3f3f46]">
                        Base URL {editingCli.baseUrlEnv ? `(${editingCli.baseUrlEnv})` : '（可选）'}
                      </label>
                      <button
                        type="button"
                        onClick={() => void handleTestEndpoint()}
                        disabled={testingEndpoint}
                        className="inline-flex items-center gap-1 rounded-lg bg-[#f4f4f5] px-2 py-0.5 text-[11px] font-medium text-[#3f3f46] transition-colors hover:bg-[#e4e4e7] hover:text-[#111827] disabled:opacity-50"
                      >
                        <Activity className={`h-3 w-3 ${testingEndpoint ? 'animate-pulse' : ''}`} />
                        {testingEndpoint ? '测速中...' : '测速 / 验活'}
                      </button>
                    </div>
                    <input
                      value={draft.baseUrl}
                      onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                      placeholder="填域名即可，如 https://api.example.com"
                      className="w-full rounded-xl border border-[#e4e4e7] px-3 py-2 text-[#111827] outline-none focus:border-[#18181b]"
                    />
                    {endpointResult && (
                      <p
                        className={`mt-1.5 text-[11.5px] font-medium ${
                          endpointResult.ok ? 'text-emerald-700' : 'text-red-600'
                        }`}
                      >
                        {endpointResult.ok ? '🟢 ' : '🔴 '}
                        {endpointResult.message}
                      </p>
                    )}
                    {(() => {
                      const prev = previewCompletedUrls(
                        draft.apiProtocol || 'openai_chat',
                        draft.baseUrl,
                        editingCli.id
                      );
                      return (
                        <div className="mt-1.5 rounded-xl bg-[#fafafa] px-3 py-2 font-mono text-[10.5px] text-[#71717a] ring-1 ring-[#f1f1f3]">
                          <div className="truncate">Base: {prev.baseUrl}</div>
                          <div className="truncate">Models: {prev.modelsUrl}</div>
                        </div>
                      );
                    })()}
                  </div>
                </>
              )}

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="font-medium text-[#3f3f46]">调度时默认模型</label>
                  <button
                    type="button"
                    onClick={() => void handleScanModels()}
                    disabled={scanningModels}
                    className="inline-flex items-center gap-1 rounded-lg bg-[#f4f4f5] px-2 py-0.5 text-[11px] font-medium text-[#3f3f46] transition-colors hover:bg-[#e4e4e7] hover:text-[#111827] disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3 w-3 ${scanningModels ? 'animate-spin' : ''}`} />
                    {scanningModels
                      ? '扫描中...'
                      : draft.authMode === 'api_key'
                        ? '从 API 拉取模型'
                        : '扫描本机模型'}
                  </button>
                </div>
                <input
                  list={`models-${editingCli.id}`}
                  value={draft.defaultModel}
                  onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}
                  placeholder="输入或点选下方扫描到的模型"
                  className="w-full rounded-xl border border-[#e4e4e7] px-3 py-2 text-[#111827] outline-none focus:border-[#18181b]"
                />
                <datalist id={`models-${editingCli.id}`}>
                  {scannedModels.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                {scanHint && <p className="mt-1 text-[11px] text-[#71717a]">{scanHint}</p>}
                {scannedModels.length > 0 && (
                  <div className="mt-2 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded-xl bg-[#fafafa] p-2 ring-1 ring-[#f1f1f3]">
                    {scannedModels.slice(0, 40).map((m) => (
                      <button
                        type="button"
                        key={m}
                        onClick={() => setDraft({ ...draft, defaultModel: m })}
                        className={`rounded-md px-2 py-0.5 font-mono text-[11px] transition-colors ${
                          draft.defaultModel === m
                            ? 'bg-[#18181b] font-medium text-white'
                            : 'bg-white text-[#52525b] ring-1 ring-[#e4e4e7] hover:text-[#111827]'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label className="mb-1.5 block font-medium text-[#3f3f46]">默认思考等级 (Reasoning Effort)</label>
                <div className="grid grid-cols-5 gap-1 rounded-xl bg-[#f4f4f5] p-1">
                  {EFFORT_OPTIONS.map((opt) => {
                    const active = (draft.reasoningEffort || 'default') === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setDraft({ ...draft, reasoningEffort: opt.id })}
                        className={`rounded-lg py-1.5 text-[11.5px] font-medium transition-colors ${
                          active
                            ? 'bg-white text-[#111827] shadow-2xs'
                            : 'text-[#71717a] hover:text-[#111827]'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1.5">
                  <label className="font-medium text-[#3f3f46]">
                    职能与独立权重（点击标签调节 0–5 权重）
                  </label>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={Boolean(singleModelRecBusy)}
                      onClick={async () => {
                        if (!editingCli || !draft) return;
                        setSingleModelRecBusy('preset');
                        try {
                          const targetModel =
                            draft.defaultModel.trim() || scannedModels[0] || editingCli.models[0] || '';
                          const res = await window.fmc.recommendSingleCliRoles(
                            editingCli.id,
                            editingCli.name,
                            targetModel,
                            'preset'
                          );
                          if (res.recommendation) {
                            const nextW = res.recommendation.roleWeights;
                            setDraft({
                              ...draft,
                              roleWeights: nextW,
                              roles: Object.entries(nextW)
                                .filter(([, w]) => w > 0)
                                .map(([r]) => r),
                              reasoningEffort:
                                res.recommendation.reasoningEffort || draft.reasoningEffort
                            });
                          }
                          setSingleModelRecTip(res.message);
                        } finally {
                          setSingleModelRecBusy(null);
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-[#e4e4e7] bg-[#fafafa] px-2 py-0.5 text-[10.5px] font-medium text-[#111827] hover:bg-[#f4f4f5] disabled:opacity-50"
                      title="根据上方当前所选模型的特性秒级生成推荐职能与思考等级（不满意可继续手动调整）"
                    >
                      <Wand2 className="h-3 w-3 text-amber-500" />
                      按此模型推荐
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(singleModelRecBusy)}
                      onClick={async () => {
                        if (!editingCli || !draft) return;
                        setSingleModelRecBusy('muse');
                        try {
                          const targetModel =
                            draft.defaultModel.trim() || scannedModels[0] || editingCli.models[0] || '';
                          const res = await window.fmc.recommendSingleCliRoles(
                            editingCli.id,
                            editingCli.name,
                            targetModel,
                            'muse'
                          );
                          setSingleModelRecTip(res.message);
                        } finally {
                          setSingleModelRecBusy(null);
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded-lg bg-[#18181b] px-2 py-0.5 text-[10.5px] font-medium text-white hover:bg-[#27272a] disabled:opacity-50"
                      title="让已连线的 Muse 评估当前所选模型并智能生成专属职能权重"
                    >
                      {singleModelRecBusy === 'muse' ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Sparkles className="h-3 w-3 text-amber-400" />
                      )}
                      让 Muse 推荐
                    </button>
                  </div>
                </div>

                {/* Gentle prompt when user manually switched model inside modal */}
                {draft.defaultModel.trim() !== openedModel.trim() && !singleModelRecTip && (
                  <div className="mb-2 rounded-xl border border-amber-200 bg-amber-50/80 px-2.5 py-1.5 text-[11px] text-amber-950">
                    💡 检测到你已将模型切换为 <code className="font-mono font-semibold">{draft.defaultModel.trim() || '默认'}</code>：可点击右上角「<strong>按此模型推荐</strong>」或「<strong>让 Muse 推荐</strong>」匹配新模型职能，也可直接在下方手动点选！
                  </div>
                )}

                {singleModelRecTip && (
                  <div className="mb-2 rounded-xl border border-emerald-200 bg-emerald-50/70 px-2.5 py-1.5 text-[11px] leading-relaxed text-emerald-950">
                    {singleModelRecTip}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-1.5">
                  {Array.from(
                    new Set([...ROLE_TAG_OPTIONS, ...Object.keys(draft.roleWeights || {})])
                  ).map((tag) => {
                    const weight = draft.roleWeights?.[tag] ?? 0;
                    const active = weight > 0;
                    const isOpen = activeRolePopover?.role === tag;
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={(e) => openRolePopoverFromEl(tag, e.currentTarget)}
                        className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors ${
                          isOpen
                            ? 'bg-[#18181b] text-white ring-2 ring-[#18181b]/20'
                            : active
                              ? 'bg-[#18181b] text-white hover:bg-[#27272a]'
                              : 'border border-[#e4e4e7] bg-white text-[#52525b] hover:bg-[#f4f4f5] hover:text-[#111827]'
                        }`}
                      >
                        <span>{tag}</span>
                        {active && (
                          <span className="rounded bg-white/20 px-1 font-mono text-[10px] text-white">
                            {weight}
                          </span>
                        )}
                      </button>
                    );
                  })}

                  {/* '+' Button to add custom role */}
                  {addingCustomRole ? (
                    <div className="inline-flex items-center gap-1 rounded-lg border border-[#18181b] bg-white px-1.5 py-0.5">
                      <input
                        autoFocus
                        value={customRoleInput}
                        onChange={(e) => setCustomRoleInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddCustomRole();
                          } else if (e.key === 'Escape') {
                            setAddingCustomRole(false);
                            setCustomRoleInput('');
                          }
                        }}
                        placeholder="如：科研绘图"
                        className="w-24 bg-transparent text-[11px] text-[#111827] outline-none"
                      />
                      <button
                        type="button"
                        onClick={handleAddCustomRole}
                        className="rounded bg-[#18181b] px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-[#27272a]"
                      >
                        添加
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAddingCustomRole(false);
                          setCustomRoleInput('');
                        }}
                        className="text-[#8a8f98] hover:text-[#111827]"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setActiveRolePopover(null);
                        setAddingCustomRole(true);
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-dashed border-[#d4d4d8] bg-[#fafafa] px-2 py-1 text-[11px] font-medium text-[#52525b] transition-colors hover:border-[#18181b] hover:text-[#111827]"
                      title="添加自定义职能标签"
                    >
                      <Plus className="h-3 w-3" />
                      自定义
                    </button>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="font-medium text-[#3f3f46]">计费类型与余额 / 限额监测</label>
                  <button
                    type="button"
                    disabled={checkingQuota}
                    onClick={async () => {
                      if (!editingCli || !draft) return;
                      setCheckingQuota(true);
                      try {
                        await onSaveConfig(editingCli.id, draft);
                        const q = await window.fmc.getCliQuota(editingCli.id, true);
                        setQuotaPreview(q);
                      } finally {
                        setCheckingQuota(false);
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-[#e4e4e7] bg-white px-2 py-0.5 text-[11px] font-medium text-[#3f3f46] hover:bg-[#f4f4f5] disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3 w-3 ${checkingQuota ? 'animate-spin' : ''}`} />
                    {checkingQuota ? '查询中...' : '立即探测余额/限额'}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-[#f4f4f5] p-1">
                  {(
                    [
                      { id: 'subscription', label: '订阅制（5h/周/月限额）' },
                      { id: 'metered', label: '按量付费（查剩余余额）' }
                    ] as const
                  ).map((tier) => (
                    <button
                      key={tier.id}
                      type="button"
                      onClick={() => setDraft({ ...draft, costTier: tier.id })}
                      className={`rounded-lg py-1.5 text-[11.5px] font-medium transition-colors ${
                        (draft.costTier || 'subscription') === tier.id
                          ? 'bg-white text-[#111827] shadow-2xs'
                          : 'text-[#71717a] hover:text-[#111827]'
                      }`}
                    >
                      {tier.label}
                    </button>
                  ))}
                </div>

                {(draft.costTier || 'subscription') === 'metered' ? (
                  <div className="mt-2">
                    <input
                      value={draft.balanceUrl || ''}
                      onChange={(e) => setDraft({ ...draft, balanceUrl: e.target.value })}
                      placeholder="可选：自定义余额查询 URL（留空自动探测 DeepSeek / OpenRouter / NewAPI / Kimi）"
                      className="w-full rounded-xl border border-[#e4e4e7] px-3 py-1.5 text-[11.5px] text-[#111827] placeholder-[#a1a1aa] outline-none focus:border-[#18181b]"
                    />
                  </div>
                ) : (
                  <div className="mt-2 grid grid-cols-3 gap-1.5">
                    <input
                      type="number"
                      min={0}
                      value={draft.limit5hTokens || ''}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          limit5hTokens: Number(e.target.value) || undefined
                        })
                      }
                      placeholder="5h参考上限(tokens)"
                      className="rounded-lg border border-[#e4e4e7] px-2 py-1 text-[11px] text-[#111827] placeholder-[#a1a1aa] outline-none focus:border-[#18181b]"
                    />
                    <input
                      type="number"
                      min={0}
                      value={draft.limit7dTokens || ''}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          limit7dTokens: Number(e.target.value) || undefined
                        })
                      }
                      placeholder="周参考上限(tokens)"
                      className="rounded-lg border border-[#e4e4e7] px-2 py-1 text-[11px] text-[#111827] placeholder-[#a1a1aa] outline-none focus:border-[#18181b]"
                    />
                    <input
                      type="number"
                      min={0}
                      value={draft.limit30dTokens || ''}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          limit30dTokens: Number(e.target.value) || undefined
                        })
                      }
                      placeholder="月参考上限(tokens)"
                      className="rounded-lg border border-[#e4e4e7] px-2 py-1 text-[11px] text-[#111827] placeholder-[#a1a1aa] outline-none focus:border-[#18181b]"
                    />
                  </div>
                )}

                {quotaPreview && quotaPreview.cliId === editingCli.id && (
                  <div className="mt-2 rounded-xl border border-[#eaecef] bg-[#fafafa] px-3 py-2 text-[11px] text-[#3f3f46]">
                    <div className="flex items-center justify-between font-medium">
                      <span>来源：{quotaPreview.source}</span>
                      <span
                        className={
                          quotaPreview.health === 'exhausted'
                            ? 'text-red-600'
                            : quotaPreview.health === 'tight'
                              ? 'text-amber-600'
                              : 'text-emerald-700'
                        }
                      >
                        {quotaPreview.balanceText ||
                          (quotaPreview.window5hUsedPct !== undefined
                            ? `5h 已用 ${quotaPreview.window5hUsedPct}%`
                            : `近5h约 ${Math.round(quotaPreview.local5hTokens / 1000)}k tokens`)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[#71717a]">
                      近5h: {Math.round(quotaPreview.local5hTokens / 1000)}k · 近7天:{' '}
                      {Math.round(quotaPreview.local7dTokens / 1000)}k · 近30天:{' '}
                      {Math.round(quotaPreview.local30dTokens / 1000)}k tokens
                      {quotaPreview.error ? ` · ${quotaPreview.error}` : ''}
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="mb-1.5 block font-medium text-[#3f3f46]">
                  CLI 头像（支持 Muse 通过 API 更换或本地上传）
                </label>
                <div className="flex items-center gap-2">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#eaecef] bg-[#fafafa]">
                    <CliBrandIcon cliId={editingCli.id} avatarUrl={draft.avatarUrl} className="h-6 w-6" />
                  </div>
                  <input
                    value={draft.avatarUrl || ''}
                    onChange={(e) => setDraft({ ...draft, avatarUrl: e.target.value })}
                    placeholder="粘贴头像图片 URL，或点右侧上传本地图片..."
                    className="min-w-0 flex-1 rounded-xl border border-[#e4e4e7] px-3 py-1.5 text-[12px] text-[#111827] outline-none focus:border-[#18181b]"
                  />
                  <label className="cursor-pointer rounded-xl border border-[#e4e4e7] bg-white px-2.5 py-1.5 text-[11.5px] font-medium text-[#3f3f46] hover:bg-[#f4f4f5]">
                    上传
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = () => {
                          if (typeof reader.result === 'string') {
                            setDraft({ ...draft, avatarUrl: reader.result });
                          }
                        };
                        reader.readAsDataURL(file);
                      }}
                    />
                  </label>
                  {draft.avatarUrl && (
                    <button
                      type="button"
                      onClick={() => setDraft({ ...draft, avatarUrl: '' })}
                      className="rounded-xl border border-[#e4e4e7] px-2 py-1.5 text-[11px] text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#111827]"
                    >
                      默认
                    </button>
                  )}
                </div>
              </div>

              <div>
                <label className="mb-1 block font-medium text-[#3f3f46]">附加 CLI 参数（可选）</label>
                <input
                  value={draft.extraArgs}
                  onChange={(e) => setDraft({ ...draft, extraArgs: e.target.value })}
                  placeholder="例如：--full-auto"
                  className="w-full rounded-xl border border-[#e4e4e7] px-3 py-2 text-[#111827] outline-none focus:border-[#18181b]"
                />
              </div>

              {!editingCli.installed && (
                <div className="rounded-xl bg-[#fafafa] p-2.5 text-[11px] text-[#52525b] ring-1 ring-[#f1f1f3]">
                  <div className="font-medium text-[#111827]">安装命令参考：</div>
                  <code className="mt-1 block break-all text-[#3f3f46]">{editingCli.installCmd}</code>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-[#eaecef] px-5 py-3">
              <button
                onClick={() => setEditingCli(null)}
                className="rounded-xl border border-[#e4e4e7] px-3.5 py-2 text-[12.5px] font-medium text-[#52525b] transition-colors hover:bg-[#f4f4f5]"
              >
                取消
              </button>
              <button
                onClick={() => void handleSaveDraft()}
                disabled={saving}
                className="rounded-xl bg-[#18181b] px-4 py-2 text-[12.5px] font-medium text-white transition-colors hover:bg-[#27272a] disabled:opacity-50"
              >
                {saving ? '保存中...' : '保存配置'}
              </button>
            </div>
          </div>

          {/* Fixed Floating 0-5 Weight Popover (never clips inside scrollable modal) */}
          {activeRolePopover && (
            <div
              ref={rolePopoverRef}
              style={{
                position: 'fixed',
                left: `${activeRolePopover.left}px`,
                bottom: `${activeRolePopover.bottom}px`
              }}
              className="z-[60] w-56 rounded-2xl border border-[#e4e4e7] bg-white p-3 shadow-popover"
            >
              <div className="mb-2 flex items-center justify-between gap-2 text-[11.5px]">
                <span className="truncate font-semibold text-[#111827]">
                  {activeRolePopover.role}
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[11px] font-semibold text-[#111827]">
                    {(draft.roleWeights?.[activeRolePopover.role] ?? 0) === 0
                      ? '不分配'
                      : `权重 ${draft.roleWeights?.[activeRolePopover.role]}/5`}
                  </span>
                  {!ROLE_TAG_OPTIONS.includes(activeRolePopover.role) && (
                    <button
                      type="button"
                      onClick={() => removeCustomRole(activeRolePopover.role)}
                      className="rounded p-0.5 text-[#a1a1aa] hover:bg-red-50 hover:text-red-600"
                      title="删除自定义职能"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>

              <input
                type="range"
                min={0}
                max={5}
                step={1}
                value={draft.roleWeights?.[activeRolePopover.role] ?? 0}
                onChange={(e) => setRoleWeight(activeRolePopover.role, Number(e.target.value))}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-[#e4e4e7] accent-[#18181b]"
              />
              <div className="mt-1.5 flex items-center justify-between font-mono text-[10.5px] text-[#8a8f98]">
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setRoleWeight(activeRolePopover.role, n)}
                    className={`rounded px-1 py-0.5 transition-colors ${
                      (draft.roleWeights?.[activeRolePopover.role] ?? 0) === n
                        ? 'bg-[#18181b] font-semibold text-white'
                        : 'hover:bg-[#f4f4f5] hover:text-[#111827]'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Save New Custom Preset Squad Modal */}
      {showSavePresetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[1px]">
          <div className="w-full max-w-md rounded-2xl border border-[#e4e4e7] bg-white p-5 shadow-popover">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[14px] font-semibold text-[#111827]">
                保存当前 CLI 配置为新预设组合
              </h3>
              <button
                onClick={() => setShowSavePresetModal(false)}
                className="rounded-lg p-1 text-[#8a8f98] hover:bg-[#f4f4f5] hover:text-[#111827]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 text-[12.5px]">
              <p className="text-[11.5px] text-[#52525b]">
                将保存当前所有 CLI 的启用开关、默认模型、思考等级与职能权重，方便你随时在「Muse 智能组」与多套自定义组合之间一键切换。
              </p>
              <div>
                <label className="mb-1 block font-medium text-[#3f3f46]">预设组合名称</label>
                <input
                  autoFocus
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  placeholder="例如：科研攻坚组 / 日常省钱组合 / 全栈主力分工"
                  className="w-full rounded-xl border border-[#e4e4e7] px-3 py-2 text-[12px] text-[#111827] outline-none focus:border-[#18181b]"
                />
              </div>
              <div>
                <label className="mb-1.5 block font-medium text-[#3f3f46]">该组合下的 Muse 调度方式</label>
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={() => setNewPresetPolicy('strict_custom')}
                    className={`w-full rounded-xl border p-2.5 text-left transition-colors ${
                      newPresetPolicy === 'strict_custom'
                        ? 'border-[#18181b] bg-[#fafafa]'
                        : 'border-[#eaecef] hover:bg-[#fafafa]'
                    }`}
                  >
                    <div className="text-[12px] font-semibold text-[#111827]">
                      🛠️ 严格按此自定义组合分工（推荐）
                    </div>
                    <div className="mt-0.5 text-[11px] text-[#71717a]">
                      锁定使用你在此组合里为每个 CLI 指定的模型、思考等级与职能权重进行拆单派发
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewPresetPolicy('muse_decide')}
                    className={`w-full rounded-xl border p-2.5 text-left transition-colors ${
                      newPresetPolicy === 'muse_decide'
                        ? 'border-[#18181b] bg-[#fafafa]'
                        : 'border-[#eaecef] hover:bg-[#fafafa]'
                    }`}
                  >
                    <div className="text-[12px] font-semibold text-[#111827]">
                      🤖 参考此组合职能 + 允许 Muse 动态选模型
                    </div>
                    <div className="mt-0.5 text-[11px] text-[#71717a]">
                      沿用此组合启用的 CLI 与职能倾向，但允许 Muse 按子任务难度从模型池动态选模型
                    </div>
                  </button>
                </div>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowSavePresetModal(false)}
                className="rounded-xl border border-[#e4e4e7] px-3.5 py-1.5 text-[12px] font-medium text-[#52525b] hover:bg-[#f4f4f5]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={async () => {
                  const name = newPresetName.trim() || `自定义组合 ${cliPresets.length}`;
                  await window.fmc.mutateCliPreset({
                    action: 'save_new',
                    name,
                    dispatchPolicy: newPresetPolicy
                  });
                  setShowSavePresetModal(false);
                  setPresetToast(`✅ 已保存并激活预设组合：「${name}」`);
                  setTimeout(() => setPresetToast(''), 4000);
                }}
                className="rounded-xl bg-[#18181b] px-4 py-1.5 text-[12px] font-medium text-white hover:bg-[#27272a]"
              >
                保存组合
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Smart Role Recommendation Modal (Profession + Purpose -> Muse / Preset) */}
      {showRecommendModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[1px]">
          <div className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[#e4e4e7] bg-white shadow-popover">
            <div className="flex items-center justify-between border-b border-[#eaecef] px-5 py-3.5">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-amber-500" />
                <h3 className="text-[14px] font-semibold text-[#111827]">
                  按职业与用途智能推荐 CLI 职能分工
                </h3>
              </div>
              <button
                onClick={() => setShowRecommendModal(false)}
                className="rounded-lg p-1 text-[#8a8f98] hover:bg-[#f4f4f5] hover:text-[#111827]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 space-y-3.5 overflow-y-auto p-5 text-[12.5px]">
              <p className="text-[12px] text-[#52525b]">
                填写你的大概职业与软件用途后，可让 Muse 结合本机已装模型池智能推荐各 CLI 的职能权重与思考等级；推荐生效后，你仍可随时点击任意 CLI 的「配置」按钮手动微调。
              </p>

              <div>
                <label className="mb-1.5 block font-medium text-[#3f3f46]">你的职业 / 身份</label>
                <div className="flex flex-wrap gap-1.5">
                  {PROFESSION_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setProfDraft(opt)}
                      className={`rounded-lg border px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                        profDraft === opt
                          ? 'border-[#18181b] bg-[#18181b] text-white'
                          : 'border-[#e4e4e7] bg-[#fafafa] text-[#3f3f46] hover:bg-[#f4f4f5]'
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
                <input
                  value={profDraft}
                  onChange={(e) => setProfDraft(e.target.value)}
                  placeholder="也可直接输入具体职业，如：科研博士 / 独立开发者..."
                  className="mt-2 w-full rounded-xl border border-[#e4e4e7] px-3 py-1.5 text-[12px] text-[#111827] outline-none focus:border-[#18181b]"
                />
              </div>

              <div>
                <label className="mb-1.5 block font-medium text-[#3f3f46]">
                  主要使用目的（可多选）
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {PURPOSE_OPTIONS.map((p) => {
                    const active = purpDraft.includes(p);
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() =>
                          setPurpDraft((prev) =>
                            prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
                          )
                        }
                        className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                          active
                            ? 'border-emerald-600 bg-emerald-50 text-emerald-900'
                            : 'border-[#e4e4e7] bg-white text-[#52525b] hover:bg-[#fafafa]'
                        }`}
                      >
                        {active && <Check className="h-3 w-3 text-emerald-600" />}
                        {p}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="mb-1 block font-medium text-[#3f3f46]">补充说明（可选）</label>
                <input
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder="例如：主要写 Python 数据处理与 React 前端"
                  className="w-full rounded-xl border border-[#e4e4e7] px-3 py-1.5 text-[12px] text-[#111827] outline-none focus:border-[#18181b]"
                />
              </div>

              {recommendMsg && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-[11.5px] leading-relaxed text-emerald-950">
                  {recommendMsg}
                </div>
              )}
            </div>

            <div className="flex flex-wrap justify-between gap-2 border-t border-[#eaecef] px-5 py-3">
              <button
                type="button"
                disabled={Boolean(recommending)}
                onClick={async () => {
                  setRecommending('preset');
                  try {
                    const r = await window.fmc.recommendCliRoles('preset', {
                      profession: profDraft.trim(),
                      purposes: purpDraft,
                      customNote: noteDraft.trim()
                    });
                    setRecommendMsg(r.message);
                  } finally {
                    setRecommending(null);
                  }
                }}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[#e4e4e7] bg-[#fafafa] px-3.5 py-2 text-[12px] font-medium text-[#111827] hover:bg-[#f4f4f5] disabled:opacity-50"
              >
                <Wand2 className="h-3.5 w-3.5 text-amber-500" />
                秒级套用预设推荐
              </button>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowRecommendModal(false)}
                  className="rounded-xl border border-[#e4e4e7] px-3.5 py-2 text-[12px] font-medium text-[#52525b] hover:bg-[#f4f4f5]"
                >
                  关闭
                </button>
                <button
                  type="button"
                  disabled={Boolean(recommending)}
                  onClick={async () => {
                    setRecommending('muse');
                    try {
                      const r = await window.fmc.recommendCliRoles('muse', {
                        profession: profDraft.trim(),
                        purposes: purpDraft,
                        customNote: noteDraft.trim()
                      });
                      setRecommendMsg(r.message);
                    } finally {
                      setRecommending(null);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[#18181b] px-4 py-2 text-[12px] font-medium text-white hover:bg-[#27272a] disabled:opacity-50"
                >
                  {recommending === 'muse' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                  )}
                  让 Muse 智能推荐配置
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
