import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  History,
  Loader2,
  Minimize2,
  Plus,
  Power,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  Terminal,
  Trash2,
  X
} from 'lucide-react';
import { BridgeView } from './components/BridgeView';
import { CliBrandIcon } from './components/CliBrandIcon';
import { CliManagerView } from './components/CliManagerView';
import { MuseChatView } from './components/MuseChatView';
import { OnboardingWizard } from './components/OnboardingWizard';
import { DEFAULT_APP_SETTINGS, SettingsView } from './components/SettingsView';
import { WorkspaceView } from './components/WorkspaceView';
import {
  AppSettings,
  AppUpdateCheckResult,
  CliUserConfig,
  DetectedCli,
  FeishuStatusEvent,
  FmcState,
  MuseLiveStateEvent,
  PermissionLevel,
  ProjectGroup,
  ScannedLocalSession,
  TunnelStatusEvent,
  WhatsNewInfo,
  WorkflowRunState
} from './types';

type NavTab = 'muse' | 'workspace' | 'clis' | 'bridge' | 'settings';

const FONT_SIZE_ZOOM: Record<AppSettings['fontSize'], string> = {
  small: '0.92',
  normal: '1',
  large: '1.08',
  xlarge: '1.16'
};

const FONT_FAMILY_MAP: Record<AppSettings['fontFamily'], string> = {
  system: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  yahei: "'Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI', sans-serif",
  inter: "'Inter', 'PingFang SC', -apple-system, BlinkMacSystemFont, sans-serif",
  mono: "ui-monospace, SFMono-Regular, 'Cascadia Code', Consolas, 'Microsoft YaHei', monospace"
};

const MONO_FONT_MAP: Record<AppSettings['monoFont'], string> = {
  system: "ui-monospace, SFMono-Regular, 'Cascadia Code', Consolas, monospace",
  cascadia: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace",
  jetbrains: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  consolas: "Consolas, 'Courier New', monospace"
};

function cleanThreadTitle(raw: string, fallback: string): string {
  const firstLine = (raw || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!firstLine) return fallback;
  return firstLine.length > 26 ? `${firstLine.slice(0, 26)}…` : firstLine;
}

export const App: React.FC = () => {
  const [state, setState] = useState<FmcState | null>(null);
  const [clis, setClis] = useState<DetectedCli[]>([]);
  const [scanning, setScanning] = useState(false);
  const [feishuStatus, setFeishuStatus] = useState<FeishuStatusEvent>({ state: 'disconnected' });
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatusEvent>({ state: 'stopped' });
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowRunState | null>(null);
  const [museLive, setMuseLive] = useState<MuseLiveStateEvent>({
    isBusy: false,
    statusText: '',
    hasPendingPermission: false
  });
  const [activeTab, setActiveTab] = useState<NavTab>('muse');
  const [activeProjectId, setActiveProjectId] = useState<string>('proj-default');
  const [activeCliId, setActiveCliId] = useState<string>('codex');
  const [copiedBrief, setCopiedBrief] = useState(false);

  // Sidebar interactions: collapsible folders & quick search
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Create project modal state
  const [showNewProj, setShowNewProj] = useState(false);
  const [newProjName, setNewProjName] = useState('');
  const [newProjDesc, setNewProjDesc] = useState('');
  const [newProjPath, setNewProjPath] = useState('');

  // Close confirmation modal state
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [closeChoice, setCloseChoice] = useState<'tray' | 'quit'>('tray');
  const [rememberClose, setRememberClose] = useState(false);

  // What's New (post-upgrade first open) & Auto-Update states
  const [whatsNewModal, setWhatsNewModal] = useState<WhatsNewInfo | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<AppUpdateCheckResult | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [downloadingUpdate, setDownloadingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<{
    percent: number;
    transferredMB: string;
    totalMB: string;
  } | null>(null);
  const [updateModalErr, setUpdateModalErr] = useState('');
  const whatsNewCheckedRef = useRef(false);

  // FMC top-left dropdown & Muse avatar refresh state
  const [showFmcMenu, setShowFmcMenu] = useState(false);
  const [refreshingAvatar, setRefreshingAvatar] = useState(false);
  const fmcMenuRef = useRef<HTMLDivElement | null>(null);

  // Project right-click context menu & edit modal
  const [projectMenu, setProjectMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);
  const [editingProject, setEditingProject] = useState<ProjectGroup | null>(null);
  const [editProjName, setEditProjName] = useState('');
  const [editProjDesc, setEditProjDesc] = useState('');
  const [editProjPath, setEditProjPath] = useState('');
  const [activeSessionId, setActiveSessionId] = useState('');
  const [expandedCliNodes, setExpandedCliNodes] = useState<Record<string, boolean>>({});
  const [cliConfigProject, setCliConfigProject] = useState<ProjectGroup | null>(null);
  const [cliConfigUseGlobal, setCliConfigUseGlobal] = useState(true);
  const [cliConfigSelected, setCliConfigSelected] = useState<string[]>([]);

  const openProjectCliConfig = (proj: ProjectGroup) => {
    setProjectMenu(null);
    setCliConfigProject(proj);
    const hasCustom = Array.isArray(proj.allowedClis) && proj.allowedClis.length > 0;
    setCliConfigUseGlobal(!hasCustom);
    setCliConfigSelected(
      hasCustom
        ? proj.allowedClis!
        : clis.filter((c) => c.config.enabled).map((c) => c.id)
    );
  };

  const handleSaveProjectCliConfig = async () => {
    if (!cliConfigProject) return;
    const next = await window.fmc.updateProject(cliConfigProject.id, {
      allowedClis: cliConfigUseGlobal ? null : cliConfigSelected
    });
    setState(next);
    setCliConfigProject(null);
  };

  // Scan & Import Local CLI History modal
  const [importModal, setImportModal] = useState<{
    open: boolean;
    targetProjectId?: string;
    targetProjectName?: string;
    loading: boolean;
    importing: boolean;
    items: ScannedLocalSession[];
    selected: Record<string, boolean>;
    tip: string;
  }>({
    open: false,
    loading: false,
    importing: false,
    items: [],
    selected: {},
    tip: ''
  });

  const openScanSessionsModal = async (proj?: ProjectGroup) => {
    setProjectMenu(null);
    setImportModal({
      open: true,
      targetProjectId: proj?.id,
      targetProjectName: proj?.name,
      loading: true,
      importing: false,
      items: [],
      selected: {},
      tip: ''
    });
    try {
      const items = await window.fmc.scanLocalSessions(proj?.repoPath || undefined);
      const selected: Record<string, boolean> = {};
      items.slice(0, 8).forEach((it) => {
        selected[it.key] = true;
      });
      setImportModal((prev) => ({
        ...prev,
        loading: false,
        items,
        selected,
        tip: items.length === 0 ? '未在该目录扫描到 Codex / Claude 本地历史会话' : ''
      }));
    } catch {
      setImportModal((prev) => ({
        ...prev,
        loading: false,
        tip: '扫描本地 CLI 会话失败'
      }));
    }
  };

  const handleImportSelectedSessions = async () => {
    const picked = importModal.items.filter((it) => importModal.selected[it.key]);
    if (picked.length === 0) return;
    setImportModal((prev) => ({ ...prev, importing: true, tip: '' }));
    try {
      const res = await window.fmc.importLocalSessions(
        picked.map((p) => ({
          cliId: p.cliId,
          externalSessionId: p.externalSessionId,
          filePath: p.filePath,
          cwd: p.cwd,
          title: p.title
        })),
        importModal.targetProjectId
      );
      setState(res.state);
      setImportModal((prev) => ({
        ...prev,
        open: false,
        importing: false
      }));
      // Automatically focus the first imported session if imported into a specific project
      const newest = (res.state.sessions || [])[0];
      if (newest && res.importedCount > 0) {
        setActiveProjectId(newest.projectId);
        setActiveCliId(newest.cliId);
        setActiveSessionId(newest.id);
        switchTab('workspace');
      }
    } finally {
      setImportModal((prev) => ({ ...prev, importing: false }));
    }
  };

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (fmcMenuRef.current && !fmcMenuRef.current.contains(e.target as Node)) {
        setShowFmcMenu(false);
      }
      setProjectMenu(null);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const openEditProject = (proj: ProjectGroup) => {
    setProjectMenu(null);
    setEditingProject(proj);
    setEditProjName(proj.name);
    setEditProjDesc(proj.description || '');
    setEditProjPath(proj.repoPath || '');
  };

  const handleSaveEditProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProject || !editProjName.trim()) return;
    const next = await window.fmc.updateProject(editingProject.id, {
      name: editProjName.trim(),
      description: editProjDesc.trim(),
      repoPath: editProjPath.trim()
    });
    setState(next);
    setEditingProject(null);
  };

  const handleDeleteProject = async (proj: ProjectGroup) => {
    setProjectMenu(null);
    if (proj.id === 'proj-default') return;
    const ok = window.confirm(`确定要删除项目「${proj.name}」及其会话记录吗？（不会删除你磁盘上的代码文件）`);
    if (!ok) return;
    const next = await window.fmc.deleteProject(proj.id);
    setState(next);
    if (activeProjectId === proj.id) {
      setActiveProjectId(next.projects[0]?.id || 'proj-default');
    }
  };

  const loadAll = async () => {
    const [st, fs, ts, wf] = await Promise.all([
      window.fmc.getState(),
      window.fmc.getFeishuStatus(),
      window.fmc.getTunnelStatus(),
      window.fmc.getWorkflowStatus()
    ]);
    setState(st);
    setFeishuStatus(fs);
    setTunnelStatus(ts);
    setWorkflowStatus(wf);
    if (st.projects.length > 0 && !st.projects.some((p) => p.id === activeProjectId)) {
      setActiveProjectId(st.projects[0].id);
    }
  };

  const rescanClis = async () => {
    setScanning(true);
    try {
      const detected = await window.fmc.scanClis();
      setClis(detected);
      const firstEnabled = detected.find((c) => c.config.enabled);
      if (firstEnabled) {
        setActiveCliId((prev) =>
          detected.some((c) => c.id === prev) ? prev : firstEnabled.id
        );
      }
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    void loadAll();
    void rescanClis();

    const offState = window.fmc.onEvent('state:changed', (payload) => {
      const next = payload as FmcState;
      setState(next);
      setClis((prev) =>
        prev.map((c) =>
          next.cliConfigs[c.id]
            ? { ...c, config: { ...c.config, ...next.cliConfigs[c.id] } }
            : c
        )
      );
    });
    const offFeishu = window.fmc.onEvent('feishu:status', (payload) => {
      setFeishuStatus(payload as FeishuStatusEvent);
    });
    const offTunnel = window.fmc.onEvent('tunnel:status', (payload) => {
      setTunnelStatus(payload as TunnelStatusEvent);
    });
    const offWorkflow = window.fmc.onEvent('workflow:status', (payload) => {
      setWorkflowStatus(payload as WorkflowRunState);
    });
    const offMuseLive = window.fmc.onEvent('muse:liveState', (payload) => {
      setMuseLive(payload as MuseLiveStateEvent);
    });
    const offCloseReq = window.fmc.onEvent('window:closeRequested', () => {
      setCloseChoice('tray');
      setRememberClose(false);
      setShowCloseModal(true);
    });
    const offUpdateAvail = window.fmc.onEvent('app:updateAvailable', (payload) => {
      const upd = payload as AppUpdateCheckResult;
      if (upd?.hasUpdate) {
        setAvailableUpdate(upd);
        void window.fmc.hideEmbeddedViews();
        setShowUpdateModal(true);
      }
    });
    const offUpdateProg = window.fmc.onEvent('app:updateProgress', (payload) => {
      setUpdateProgress(payload as { percent: number; transferredMB: string; totalMB: string });
    });
    return () => {
      offState();
      offFeishu();
      offTunnel();
      offWorkflow();
      offMuseLive();
      offCloseReq();
      offUpdateAvail();
      offUpdateProg();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show concise What's New summary once on first launch after upgrading to a new version
  useEffect(() => {
    if (!state?.onboardingCompleted || whatsNewCheckedRef.current) return;
    whatsNewCheckedRef.current = true;
    void window.fmc.getWhatsNew().then((info) => {
      if (info.shouldShow) {
        void window.fmc.hideEmbeddedViews();
        setWhatsNewModal(info);
      }
    });
  }, [state?.onboardingCompleted]);

  // Auto-fetch Muse custom avatar once if in avatar mode and not yet cached
  const avatarAutoFetched = useRef(false);
  useEffect(() => {
    const mode = state?.settings?.museDisplayMode || 'avatar';
    if (
      state?.onboardingCompleted &&
      mode === 'avatar' &&
      !state.muse.avatarUrl &&
      !avatarAutoFetched.current
    ) {
      avatarAutoFetched.current = true;
      void window.fmc.fetchMuseAvatar();
    }
  }, [state?.onboardingCompleted, state?.settings?.museDisplayMode, state?.muse.avatarUrl]);

  const handleToggleMuseDisplayMode = async () => {
    const current = state?.settings?.museDisplayMode || 'avatar';
    const nextMode = current === 'avatar' ? 'compact' : 'avatar';
    const next = await window.fmc.updateSettings({ museDisplayMode: nextMode });
    setState(next);
    setShowFmcMenu(false);
  };

  const handleRefreshMuseAvatar = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (refreshingAvatar) return;
    setRefreshingAvatar(true);
    try {
      await window.fmc.fetchMuseAvatar();
    } finally {
      setRefreshingAvatar(false);
      setShowFmcMenu(false);
    }
  };

  // Apply font size & font family settings in real time
  useEffect(() => {
    const s: AppSettings = { ...DEFAULT_APP_SETTINGS, ...(state?.settings || {}) };
    const root = document.documentElement;
    root.style.setProperty('--app-font-family', FONT_FAMILY_MAP[s.fontFamily] || FONT_FAMILY_MAP.system);
    root.style.setProperty('--app-mono-font', MONO_FONT_MAP[s.monoFont] || MONO_FONT_MAP.system);
    (root.style as unknown as { zoom: string }).zoom = FONT_SIZE_ZOOM[s.fontSize] || '1';
  }, [state?.settings]);

  const switchTab = (next: NavTab) => {
    if (next !== 'muse') {
      void window.fmc.hideEmbeddedViews();
    }
    setActiveTab(next);
  };

  const openCliThread = (projId: string, cliId: string) => {
    void window.fmc.hideEmbeddedViews();
    setActiveProjectId(projId);
    setActiveCliId(cliId);
    setActiveTab('workspace');
  };

  const toggleProjectCollapse = (projId: string) => {
    setCollapsedProjects((prev) => ({ ...prev, [projId]: !prev[projId] }));
  };

  const handleSaveCliConfig = async (cliId: string, config: CliUserConfig) => {
    const nextState = await window.fmc.saveCliConfig(cliId, config);
    setState(nextState);
    setClis((prev) => prev.map((c) => (c.id === cliId ? { ...c, config } : c)));
  };

  const handleCopyBrief = async () => {
    const text = await window.fmc.getMuseBrief();
    await navigator.clipboard.writeText(text);
    setCopiedBrief(true);
    setTimeout(() => setCopiedBrief(false), 2000);
  };

  const handlePickFolder = async () => {
    const dir = await window.fmc.pickDirectory();
    if (dir) setNewProjPath(dir);
  };

  const handleCreateProjSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjName.trim()) return;
    const proj = await window.fmc.createProject({
      name: newProjName.trim(),
      description: newProjDesc.trim(),
      repoPath: newProjPath.trim(),
      createdBy: 'user'
    });
    setNewProjName('');
    setNewProjDesc('');
    setNewProjPath('');
    setShowNewProj(false);
    const defaultCli = clis.find((c) => c.config.enabled)?.id || activeCliId || 'codex';
    openCliThread(proj.id, defaultCli);
  };

  // Build "最近" (recent active per-CLI threads across all projects)
  const recentThreads = useMemo(() => {
    if (!state) return [];
    const map = new Map<
      string,
      {
        key: string;
        projectId: string;
        cliId: string;
        title: string;
        updatedAt: string;
        running: boolean;
      }
    >();

    for (const msg of state.messages) {
      if (!msg.agentId) continue;
      const key = `${msg.projectId}::${msg.agentId}`;
      const existing = map.get(key);
      const cliName = clis.find((c) => c.id === msg.agentId)?.name || msg.agentId;
      const candidateTitle =
        msg.role === 'directive'
          ? cleanThreadTitle(msg.content, `${cliName} 对话`)
          : existing?.title || cleanThreadTitle(msg.title || msg.content, `${cliName} 对话`);

      if (!existing || msg.createdAt >= existing.updatedAt) {
        map.set(key, {
          key,
          projectId: msg.projectId,
          cliId: msg.agentId,
          title: candidateTitle,
          updatedAt: msg.createdAt,
          running: msg.status === 'running' || Boolean(existing?.running)
        });
      }
    }

    const q = searchQuery.trim().toLowerCase();
    return Array.from(map.values())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .filter((t) => !q || t.title.toLowerCase().includes(q) || t.cliId.toLowerCase().includes(q))
      .slice(0, 6);
  }, [state, clis, searchQuery]);

  if (!state) {
    return (
      <div className="flex h-screen items-center justify-center bg-white text-[13px] text-[#71717a]">
        正在启动 MuseDeck...
      </div>
    );
  }

  const closeModalNode = showCloseModal ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[1px]">
      <div className="w-full max-w-sm rounded-2xl border border-[#e4e4e7] bg-white p-5 shadow-popover">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-[#111827]">关闭 MuseDeck</h3>
          <button
            onClick={() => setShowCloseModal(false)}
            className="rounded-lg p-1 text-[#8a8f98] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2 text-[12.5px]">
          <button
            type="button"
            onClick={() => setCloseChoice('tray')}
            className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
              closeChoice === 'tray'
                ? 'border-[#18181b] bg-[#fafafa]'
                : 'border-[#eaecef] hover:bg-[#fafafa]'
            }`}
          >
            <Minimize2 className="mt-0.5 h-4 w-4 shrink-0 text-[#111827]" />
            <div>
              <div className="font-medium text-[#111827]">最小化到系统托盘</div>
              <p className="mt-0.5 text-[11.5px] text-[#71717a]">
                后台保持飞书长连接与 Tailscale 永久域名在线，随时可从右下角托盘恢复窗口。
              </p>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setCloseChoice('quit')}
            className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
              closeChoice === 'quit'
                ? 'border-[#18181b] bg-[#fafafa]'
                : 'border-[#eaecef] hover:bg-[#fafafa]'
            }`}
          >
            <Power className="mt-0.5 h-4 w-4 shrink-0 text-[#52525b]" />
            <div>
              <div className="font-medium text-[#111827]">完全退出程序</div>
              <p className="mt-0.5 text-[11.5px] text-[#71717a]">
                关闭主窗口并彻底停止本地 API、飞书桥接及内嵌隧道进程。
              </p>
            </div>
          </button>
        </div>

        <label className="mt-4 flex cursor-pointer items-center gap-2 text-[12px] text-[#52525b]">
          <input
            type="checkbox"
            checked={rememberClose}
            onChange={(e) => setRememberClose(e.target.checked)}
            className="accent-[#18181b]"
          />
          总是如此，不再询问（可在「软件设置」中随时更改）
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setShowCloseModal(false)}
            className="rounded-xl border border-[#e4e4e7] px-3.5 py-1.5 text-[12.5px] font-medium text-[#52525b] transition-colors hover:bg-[#f4f4f5]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => {
              setShowCloseModal(false);
              void window.fmc.performCloseAction(closeChoice, rememberClose);
            }}
            className="rounded-xl bg-[#18181b] px-4 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-[#27272a]"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  ) : null;

  // First-run Onboarding Wizard (also mounts closeModalNode so clicking X works during onboarding!)
  if (!state.onboardingCompleted) {
    return (
      <>
        <OnboardingWizard
          state={state}
          clis={clis}
          scanning={scanning}
          feishuStatus={feishuStatus}
          onRescanClis={() => void rescanClis()}
          onSaveCliConfig={handleSaveCliConfig}
          onComplete={async () => {
            const next = await window.fmc.completeOnboarding();
            setState(next);
          }}
        />
        {closeModalNode}
      </>
    );
  }

  const enabledClis = clis.filter((c) => c.config.enabled);
  const q = searchQuery.trim().toLowerCase();

  return (
    <div className="flex h-screen bg-white text-[#111827] select-none">
      {/* Codex-Host Style Left Sidebar */}
      <aside className="flex w-[264px] shrink-0 flex-col border-r border-[#eaecef] bg-[#f9f9fa]">
        {/* Top Title & Action Icons (matches codex-host screenshot) */}
        <div className="flex h-11 shrink-0 items-center justify-between px-4">
          <div ref={fmcMenuRef} className="relative">
            <button
              onClick={() => setShowFmcMenu((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg px-1 py-0.5 text-[15px] font-semibold tracking-tight text-[#111827] transition-colors hover:bg-[#f0f0f2]"
              title="切换 Muse 形象展示 / 精简模式"
            >
              <span>MuseDeck</span>
              <ChevronDown
                className={`h-3.5 w-3.5 text-[#8a8f98] transition-transform ${
                  showFmcMenu ? 'rotate-180' : ''
                }`}
              />
            </button>

            {showFmcMenu && (
              <div className="absolute top-full left-0 z-50 mt-1.5 w-52 overflow-hidden rounded-xl border border-[#e4e4e7] bg-white p-1.5 text-[12.5px] shadow-popover">
                <button
                  onClick={() => void handleToggleMuseDisplayMode()}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[#111827] transition-colors hover:bg-[#f4f4f5]"
                >
                  {(state.settings?.museDisplayMode || 'avatar') === 'avatar' ? (
                    <>
                      <EyeOff className="h-3.5 w-3.5 text-[#71717a]" />
                      <span>收回 Muse 形象（精简）</span>
                    </>
                  ) : (
                    <>
                      <Eye className="h-3.5 w-3.5 text-[#71717a]" />
                      <span>展开 Muse 虚拟形象</span>
                    </>
                  )}
                </button>
                <button
                  onClick={() => void handleRefreshMuseAvatar()}
                  disabled={refreshingAvatar}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[#111827] transition-colors hover:bg-[#f4f4f5] disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 text-[#71717a] ${refreshingAvatar ? 'animate-spin' : ''}`} />
                  <span>{refreshingAvatar ? '正在读取形象...' : '刷新 Muse 账号形象'}</span>
                </button>
                <div className="my-1 border-t border-[#f1f1f3]" />
                <button
                  onClick={() => {
                    setShowFmcMenu(false);
                    switchTab('settings');
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[#52525b] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
                >
                  <Settings className="h-3.5 w-3.5 text-[#71717a]" />
                  <span>软件设置</span>
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-0.5">
            <button
              onClick={() => {
                setShowSearch((v) => !v);
                if (showSearch) setSearchQuery('');
              }}
              className={`rounded-lg p-1.5 transition-colors ${
                showSearch
                  ? 'bg-[#ececef] text-[#111827]'
                  : 'text-[#71717a] hover:bg-[#f0f0f2] hover:text-[#111827]'
              }`}
              title="搜索项目或 CLI 会话"
            >
              <Search className="h-4 w-4" />
            </button>
            <button
              onClick={() => switchTab('bridge')}
              className="relative rounded-lg p-1.5 text-[#71717a] transition-colors hover:bg-[#f0f0f2] hover:text-[#111827]"
              title={
                tunnelStatus.state === 'running'
                  ? 'Tailscale 永久域名在线'
                  : '查看飞书 & 隧道状态'
              }
            >
              <Radio className="h-4 w-4" />
              <span
                className={`absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full ${
                  tunnelStatus.state === 'running'
                    ? 'bg-emerald-500'
                    : tunnelStatus.state === 'starting'
                      ? 'animate-pulse bg-amber-400'
                      : 'bg-[#d4d4d8]'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Optional Quick Search Input */}
        {showSearch && (
          <div className="px-3 pb-2">
            <input
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="筛选项目或 CLI 对话..."
              className="w-full rounded-lg border border-[#e4e4e7] bg-white px-2.5 py-1.5 text-[12px] text-[#111827] placeholder-[#a1a1aa] outline-none focus:border-[#18181b]"
            />
          </div>
        )}

        {/* Primary Action: Muse Custom Avatar Card OR Compact Text Button */}
        <div className="px-2.5 pb-2">
          {(state.settings?.museDisplayMode || 'avatar') === 'avatar' ? (
            <div
              onClick={() => switchTab('muse')}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') switchTab('muse');
              }}
              className={`group relative flex w-full cursor-pointer flex-col items-center rounded-2xl border px-3 py-3.5 transition-all ${
                activeTab === 'muse'
                  ? 'border-[#d4d4d8] bg-white shadow-2xs'
                  : 'border-[#eaecef] bg-white/80 hover:border-[#d4d4d8] hover:bg-white'
              }`}
              title="点击进入 Muse 总管对话"
            >
              <div className="relative h-[68px] w-[68px]">
                <div
                  className={`flex h-full w-full items-center justify-center overflow-hidden rounded-full border bg-[#fafafa] transition-all ${
                    museLive.hasPendingPermission
                      ? 'border-amber-400 ring-2 ring-amber-300/70'
                      : museLive.isBusy
                        ? 'border-emerald-400 ring-2 ring-emerald-300/60 animate-pulse'
                        : 'border-[#eaecef]'
                  }`}
                >
                  {(museLive.avatarUrl || state.muse.avatarUrl) ? (
                    (museLive.avatarKind || state.muse.avatarKind) === 'video' ? (
                      <video
                        key={museLive.avatarUrl || state.muse.avatarUrl}
                        src={museLive.avatarUrl || state.muse.avatarUrl}
                        autoPlay
                        loop
                        muted
                        playsInline
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <img
                        src={museLive.avatarUrl || state.muse.avatarUrl}
                        alt="Muse"
                        className="h-full w-full object-cover"
                      />
                    )
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-[#f4f4f5] text-[#52525b]">
                      <Sparkles className="h-6 w-6" />
                    </div>
                  )}
                </div>

                {/* Tiny Refresh Badge on bottom-right of avatar circle */}
                <button
                  type="button"
                  onClick={(e) => void handleRefreshMuseAvatar(e)}
                  disabled={refreshingAvatar}
                  className="absolute -right-0.5 -bottom-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-[#eaecef] bg-white text-[#52525b] shadow-2xs transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
                  title="重新从已登录 Muse 页面读取形象"
                >
                  <RefreshCw className={`h-3 w-3 ${refreshingAvatar ? 'animate-spin' : ''}`} />
                </button>
              </div>

              <div className="mt-2 text-[13.5px] font-semibold text-[#111827]">Muse</div>
              <div className="mt-0.5 inline-flex max-w-full items-center gap-1 px-1 text-[11px] text-[#71717a]">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    museLive.hasPendingPermission
                      ? 'animate-pulse bg-amber-500'
                      : museLive.isBusy
                        ? 'animate-pulse bg-emerald-500'
                        : tunnelStatus.state === 'running'
                          ? 'bg-emerald-500'
                          : 'bg-[#a1a1aa]'
                  }`}
                />
                <span className="truncate">
                  {museLive.statusText
                    ? museLive.statusText
                    : tunnelStatus.state === 'running'
                      ? '已连接'
                      : '点击对话'}
                </span>
              </div>
            </div>
          ) : (
            <button
              onClick={() => switchTab('muse')}
              className={`flex h-9 w-full items-center justify-between rounded-xl px-2.5 text-[13.5px] transition-colors ${
                activeTab === 'muse'
                  ? 'bg-[#ececef] font-medium text-[#111827]'
                  : 'text-[#27272a] hover:bg-[#f0f0f2]'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <SquarePen className="h-4 w-4 text-[#52525b]" />
                <span>Muse 总管对话</span>
              </span>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </button>
          )}
        </div>

        {/* Scrollable Middle: 项目 (with per-CLI child rows) + 最近 */}
        <div className="flex-1 overflow-y-auto px-2.5 pb-3">
          {/* 项目 Section */}
          <div className="mt-2">
            <div className="mb-1 flex items-center justify-between px-2">
              <span className="text-[12px] font-medium text-[#8a8f98]">项目</span>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => void openScanSessionsModal(undefined)}
                  className="rounded-md p-1 text-[#71717a] transition-colors hover:bg-[#ececef] hover:text-[#111827]"
                  title="全局扫描本地 CLI 历史对话并按项目自动归类导入"
                >
                  <History className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setShowNewProj(true)}
                  className="rounded-md p-1 text-[#71717a] transition-colors hover:bg-[#ececef] hover:text-[#111827]"
                  title="新建项目组"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              {state.projects.map((proj) => {
                const isCollapsed = Boolean(collapsedProjects[proj.id]);
                const projMsgs = state.messages.filter((m) => m.projectId === proj.id);

                // Collect CLIs for this project: per-project allowedClis (if configured) OR globally enabled CLIs + any CLI with history
                const cliIdSet = new Set<string>();
                const hasCustomClis = Array.isArray(proj.allowedClis) && proj.allowedClis.length > 0;
                if (hasCustomClis) {
                  proj.allowedClis!.forEach((id) => cliIdSet.add(id));
                } else {
                  enabledClis.forEach((c) => cliIdSet.add(c.id));
                }
                projMsgs.forEach((m) => {
                  if (m.agentId) cliIdSet.add(m.agentId);
                });
                if (cliIdSet.size === 0 && clis.length > 0) {
                  cliIdSet.add(clis[0].id);
                }

                const cliRows = Array.from(cliIdSet)
                  .map((cliId) => {
                    const cliDef = clis.find((c) => c.id === cliId);
                    const cliName = cliDef?.name || cliId;
                    const msgs = projMsgs.filter((m) => m.agentId === cliId);
                    const lastDirective = [...msgs].reverse().find((m) => m.role === 'directive');
                    const lastMsg = msgs[msgs.length - 1];
                    const isRunning = msgs.some((m) => m.status === 'running');
                    const label = lastDirective
                      ? cleanThreadTitle(lastDirective.content, `${cliName} 对话`)
                      : `${cliName}`;
                    return {
                      cliId,
                      cliName,
                      label,
                      hasHistory: msgs.length > 0,
                      isRunning,
                      lastAt: lastMsg?.createdAt || ''
                    };
                  })
                  .filter(
                    (row) =>
                      !q ||
                      proj.name.toLowerCase().includes(q) ||
                      row.label.toLowerCase().includes(q) ||
                      row.cliName.toLowerCase().includes(q)
                  );

                if (q && cliRows.length === 0 && !proj.name.toLowerCase().includes(q)) {
                  return null;
                }

                return (
                  <div key={proj.id}>
                    {/* Folder Header Row (Right-click for rename / description / directory / delete) */}
                    <button
                      onClick={() => toggleProjectCollapse(proj.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setProjectMenu({
                          projectId: proj.id,
                          x: Math.min(e.clientX, window.innerWidth - 210),
                          y: Math.min(e.clientY, window.innerHeight - 180)
                        });
                      }}
                      className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] font-medium text-[#3f3f46] transition-colors hover:bg-[#f0f0f2] hover:text-[#111827]"
                      title={`${proj.name}${proj.description ? `\n简介：${proj.description}` : ''}${proj.repoPath ? `\n目录：${proj.repoPath}` : ''}\n（右键管理项目）`}
                    >
                      <Folder className="h-4 w-4 shrink-0 text-[#71717a]" />
                      <span className="min-w-0 flex-1 truncate">{proj.name}</span>
                      {Array.isArray(proj.allowedClis) && proj.allowedClis.length > 0 && (
                        <span
                          className="shrink-0 rounded bg-[#f4f4f5] px-1.5 py-0.2 text-[10px] font-medium text-[#71717a]"
                          title={`该项目限定使用 ${proj.allowedClis.length} 个 CLI`}
                        >
                          {proj.allowedClis.length} CLI
                        </span>
                      )}
                      {proj.createdBy === 'muse' && (
                        <span className="shrink-0 rounded bg-[#ececef] px-1 py-0.2 text-[10px] font-medium text-[#52525b]">
                          Muse
                        </span>
                      )}
                    </button>

                    {/* Per-CLI Independent Conversation Rows (multiple tasks/sessions tucked inside each CLI) */}
                    {!isCollapsed && (
                      <div className="mt-0.5 space-y-0.5 pl-4">
                        {cliRows.map((row) => {
                          const nodeKey = `${proj.id}::${row.cliId}`;
                          const cliSessions = (state.sessions || [])
                            .filter((s) => s.projectId === proj.id && s.cliId === row.cliId)
                            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
                          const isNodeExpanded = Boolean(expandedCliNodes[nodeKey]);
                          const isSelected =
                            activeTab === 'workspace' &&
                            activeProjectId === proj.id &&
                            activeCliId === row.cliId;
                          return (
                            <div key={`${proj.id}-${row.cliId}`}>
                              <div
                                className={`flex h-8 w-full items-center gap-1 rounded-xl px-2 text-left text-[13px] transition-colors ${
                                  isSelected && !activeSessionId
                                    ? 'bg-[#ececef] font-medium text-[#111827]'
                                    : 'text-[#3f3f46] hover:bg-[#f0f0f2] hover:text-[#111827]'
                                }`}
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    setActiveSessionId('');
                                    openCliThread(proj.id, row.cliId);
                                  }}
                                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                                  title={`${proj.name} / ${row.cliName}`}
                                >
                                  <CliBrandIcon
                                    cliId={row.cliId}
                                    avatarUrl={clis.find((c) => c.id === row.cliId)?.config.avatarUrl}
                                    className="h-4 w-4 shrink-0"
                                  />
                                  <span
                                    className={`min-w-0 flex-1 truncate ${
                                      row.hasHistory ? '' : 'text-[#71717a]'
                                    }`}
                                  >
                                    {row.label}
                                  </span>
                                </button>
                                {row.isRunning && (
                                  <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
                                )}
                                {cliSessions.length > 0 && (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setExpandedCliNodes((prev) => ({
                                        ...prev,
                                        [nodeKey]: !prev[nodeKey]
                                      }));
                                    }}
                                    className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 text-[10px] font-medium text-[#71717a] transition-colors hover:bg-[#e4e4e7] hover:text-[#111827]"
                                    title={isNodeExpanded ? '收起该 CLI 下的子任务/会话' : `展开收纳的 ${cliSessions.length + 1} 组任务会话`}
                                  >
                                    <span>{cliSessions.length + 1}</span>
                                    <ChevronDown
                                      className={`h-3 w-3 transition-transform ${
                                        isNodeExpanded ? 'rotate-180' : ''
                                      }`}
                                    />
                                  </button>
                                )}
                              </div>

                              {/* Collapsible nested sub-sessions tucked neatly inside this CLI */}
                              {cliSessions.length > 0 && isNodeExpanded && (
                                <div className="mt-0.5 ml-3.5 space-y-0.5 border-l border-[#e4e4e7] pl-2">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setActiveSessionId('');
                                      openCliThread(proj.id, row.cliId);
                                    }}
                                    className={`flex h-7 w-full items-center gap-1.5 rounded-lg px-2 text-left text-[11.5px] transition-colors ${
                                      isSelected && !activeSessionId
                                        ? 'bg-[#ececef] font-medium text-[#111827]'
                                        : 'text-[#52525b] hover:bg-[#f0f0f2] hover:text-[#111827]'
                                    }`}
                                  >
                                    <span className="truncate">默认主会话</span>
                                  </button>
                                  {cliSessions.map((sess) => {
                                    const sessSelected = isSelected && activeSessionId === sess.id;
                                    return (
                                      <button
                                        key={sess.id}
                                        type="button"
                                        onClick={() => {
                                          setActiveSessionId(sess.id);
                                          openCliThread(proj.id, row.cliId);
                                        }}
                                        className={`flex h-7 w-full items-center justify-between gap-1.5 rounded-lg px-2 text-left text-[11.5px] transition-colors ${
                                          sessSelected
                                            ? 'bg-[#ececef] font-medium text-[#111827]'
                                            : 'text-[#52525b] hover:bg-[#f0f0f2] hover:text-[#111827]'
                                        }`}
                                        title={sess.title}
                                      >
                                        <span className="min-w-0 flex-1 truncate">{sess.title}</span>
                                        {sess.source === 'imported' && (
                                          <span className="shrink-0 rounded bg-[#f4f4f5] px-1 text-[9.5px] text-[#71717a]">
                                            历史
                                          </span>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 最近 Section (Exact Codex-host layout) */}
          {recentThreads.length > 0 && (
            <div className="mt-5">
              <div className="mb-1 px-2 text-[12px] font-medium text-[#8a8f98]">最近</div>
              <div className="space-y-0.5">
                {recentThreads.map((item) => {
                  const isSelected =
                    activeTab === 'workspace' &&
                    activeProjectId === item.projectId &&
                    activeCliId === item.cliId;
                  return (
                    <button
                      key={item.key}
                      onClick={() => openCliThread(item.projectId, item.cliId)}
                      className={`flex h-8 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-[13px] transition-colors ${
                        isSelected
                          ? 'bg-[#ececef] font-medium text-[#111827]'
                          : 'text-[#3f3f46] hover:bg-[#f0f0f2] hover:text-[#111827]'
                      }`}
                    >
                      <CliBrandIcon
                        cliId={item.cliId}
                        avatarUrl={clis.find((c) => c.id === item.cliId)?.config.avatarUrl}
                        className="h-4 w-4 shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                      {item.running && (
                        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Bottom Utility Links & Status Footer */}
        <div className="space-y-0.5 border-t border-[#eaecef] p-2">
          <button
            onClick={() => switchTab('clis')}
            className={`flex h-8 w-full items-center justify-between rounded-lg px-2.5 text-[12.5px] transition-colors ${
              activeTab === 'clis'
                ? 'bg-[#ececef] font-medium text-[#111827]'
                : 'text-[#52525b] hover:bg-[#f0f0f2] hover:text-[#111827]'
            }`}
          >
            <span className="flex items-center gap-2">
              <Terminal className="h-3.5 w-3.5" />
              <span>应用 / CLI 雷达</span>
            </span>
            <span className="rounded bg-[#e4e4e7]/80 px-1.5 py-0.2 text-[10.5px] font-medium text-[#52525b]">
              {enabledClis.length}
            </span>
          </button>

          <button
            onClick={() => switchTab('bridge')}
            className={`flex h-8 w-full items-center justify-between rounded-lg px-2.5 text-[12.5px] transition-colors ${
              activeTab === 'bridge'
                ? 'bg-[#ececef] font-medium text-[#111827]'
                : 'text-[#52525b] hover:bg-[#f0f0f2] hover:text-[#111827]'
            }`}
          >
            <span className="flex items-center gap-2">
              <Radio className="h-3.5 w-3.5" />
              <span>飞书 & Muse 桥接</span>
            </span>
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                feishuStatus.state === 'connected' ? 'bg-emerald-500' : 'bg-[#d4d4d8]'
              }`}
            />
          </button>

          <button
            onClick={() => switchTab('settings')}
            className={`flex h-8 w-full items-center justify-between rounded-lg px-2.5 text-[12.5px] transition-colors ${
              activeTab === 'settings'
                ? 'bg-[#ececef] font-medium text-[#111827]'
                : 'text-[#52525b] hover:bg-[#f0f0f2] hover:text-[#111827]'
            }`}
          >
            <span className="flex items-center gap-2">
              <Settings className="h-3.5 w-3.5" />
              <span>软件设置</span>
            </span>
            {availableUpdate?.hasUpdate && (
              <span className="rounded-full bg-emerald-500 px-1.5 py-0.5 text-[9.5px] font-semibold text-white">
                新版本
              </span>
            )}
          </button>

          <div className="mt-1 flex items-center justify-between px-2 pt-1 text-[11px] text-[#8a8f98]">
            <span className="truncate font-mono">
              :{state.controlApi.port} · {tunnelStatus.state === 'running' ? '443 在线' : '本地'}
            </span>
            <button
              onClick={() => void window.fmc.resetOnboarding()}
              className="rounded-md p-1 text-[#8a8f98] transition-colors hover:bg-[#e4e4e7] hover:text-[#111827]"
              title="重新打开初始向导"
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-white select-text">
        {activeTab === 'muse' && (
          <MuseChatView
            state={state}
            clis={clis}
            feishuStatus={feishuStatus}
            tunnelStatus={tunnelStatus}
            workflowStatus={workflowStatus}
            onChangePermission={async (level: PermissionLevel) => {
              const next = await window.fmc.setPermissionLevel(level);
              setState(next);
            }}
            onCopyBrief={handleCopyBrief}
            copiedBrief={copiedBrief}
            onNavigateBridge={() => switchTab('bridge')}
            onNavigateClis={() => switchTab('clis')}
          />
        )}

        {activeTab === 'workspace' && (
          <WorkspaceView
            projects={state.projects}
            sessions={state.sessions || []}
            messages={state.messages}
            clis={clis}
            activeProjectId={activeProjectId}
            activeCliId={activeCliId}
            activeSessionId={activeSessionId}
            onSelectSession={(sid) => setActiveSessionId(sid)}
            onCreateSession={async () => {
              const res = await window.fmc.createSessionThread(activeProjectId, activeCliId);
              setState(res.state);
              setActiveSessionId(res.session.id);
            }}
            museAvatarUrl={museLive.avatarUrl || state.muse.avatarUrl}
            museAvatarKind={museLive.avatarKind || state.muse.avatarKind}
            permissionLevel={state.permissionLevel || 'auto'}
            onChangePermission={async (level: PermissionLevel) => {
              const next = await window.fmc.setPermissionLevel(level);
              setState(next);
            }}
            onOpenNewProject={() => setShowNewProj(true)}
            onSaveCliConfig={handleSaveCliConfig}
            onDispatch={async (req) => {
              await window.fmc.dispatchTask({ ...req, source: 'user' });
            }}
            onCancelTask={async (taskId) => {
              await window.fmc.cancelTask(taskId);
            }}
          />
        )}

        {activeTab === 'clis' && (
          <CliManagerView
            clis={clis}
            scanning={scanning}
            userProfile={state.userProfile}
            onRescan={() => void rescanClis()}
            onSaveConfig={handleSaveCliConfig}
          />
        )}

        {activeTab === 'bridge' && <BridgeView state={state} feishuStatus={feishuStatus} />}

        {activeTab === 'settings' && (
          <SettingsView
            state={state}
            availableUpdate={availableUpdate}
            onUpdateDetected={(upd) => setAvailableUpdate(upd.hasUpdate ? upd : null)}
            onShowWhatsNew={async () => {
              const info = await window.fmc.getWhatsNew();
              setWhatsNewModal({ ...info, shouldShow: true });
            }}
            onUpdateSettings={async (patch) => {
              const next = await window.fmc.updateSettings(patch);
              setState(next);
            }}
            onUpdateControlApi={async (patch) => {
              const next = await window.fmc.updateControlApi(patch);
              setState(next);
            }}
            onUpdateWorkflowConfig={async (patch) => {
              const next = await window.fmc.updateWorkflowConfig(patch);
              setState(next);
            }}
          />
        )}
      </main>

      {/* Close Confirmation Modal (Minimize to Tray vs Quit + Remember Choice) */}
      {closeModalNode}

      {/* Post-Upgrade First Open "What's New" Concise Summary Modal */}
      {whatsNewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[1px]">
          <div className="w-full max-w-[440px] rounded-2xl border border-[#e4e4e7] bg-white p-5 shadow-popover">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[#18181b] text-white">
                  <Sparkles className="h-3.5 w-3.5" />
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-[14px] font-semibold text-[#111827]">本次版本更新内容</h3>
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-mono text-[10.5px] font-semibold text-emerald-800">
                      v{whatsNewModal.currentVersion}
                    </span>
                  </div>
                  <p className="text-[11.5px] text-[#71717a]">{whatsNewModal.title}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={async () => {
                  const next = await window.fmc.ackWhatsNew();
                  setState(next);
                  setWhatsNewModal(null);
                }}
                className="rounded-lg p-1 text-[#8a8f98] hover:bg-[#f4f4f5] hover:text-[#111827]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <ul className="mt-4 space-y-2 rounded-xl border border-[#f1f1f3] bg-[#fafafa] p-3.5 text-[12.5px] leading-relaxed text-[#3f3f46]">
              {whatsNewModal.highlights.map((line, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#18181b]" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={async () => {
                  const next = await window.fmc.ackWhatsNew();
                  setState(next);
                  setWhatsNewModal(null);
                }}
                className="rounded-xl bg-[#18181b] px-4 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-[#27272a]"
              >
                我知道了
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Startup Auto-Detected New Release Modal */}
      {showUpdateModal && availableUpdate?.hasUpdate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[1px]">
          <div className="w-full max-w-[450px] rounded-2xl border border-[#e4e4e7] bg-white p-5 shadow-popover">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-[14px] font-semibold text-[#111827]">
                    发现新版本 v{availableUpdate.latestVersion}
                  </h3>
                  <span className="rounded-md bg-[#f4f4f5] px-1.5 py-0.5 font-mono text-[10.5px] text-[#71717a]">
                    当前 v{availableUpdate.currentVersion}
                  </span>
                </div>
                <p className="mt-0.5 text-[11.5px] text-[#71717a]">
                  {availableUpdate.releaseTitle || '已发布最新安装包，支持一键下载并自动覆盖升级'}
                </p>
              </div>
              <button
                type="button"
                disabled={downloadingUpdate}
                onClick={() => setShowUpdateModal(false)}
                className="rounded-lg p-1 text-[#8a8f98] hover:bg-[#f4f4f5] hover:text-[#111827] disabled:opacity-40"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {availableUpdate.highlights.length > 0 && (
              <ul className="mt-3.5 max-h-48 space-y-1.5 overflow-y-auto rounded-xl border border-[#f1f1f3] bg-[#fafafa] p-3 text-[12px] leading-relaxed text-[#3f3f46]">
                {availableUpdate.highlights.map((h, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-600" />
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
            )}

            {downloadingUpdate && updateProgress && (
              <div className="mt-3.5 space-y-1">
                <div className="flex justify-between font-mono text-[11px] text-[#52525b]">
                  <span>正在下载更新包... {updateProgress.percent}%</span>
                  <span>
                    {updateProgress.transferredMB} / {updateProgress.totalMB} MB
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-[#f1f1f3]">
                  <div
                    className="h-full rounded-full bg-[#18181b] transition-all"
                    style={{ width: `${updateProgress.percent}%` }}
                  />
                </div>
              </div>
            )}

            {updateModalErr && (
              <p className="mt-2.5 text-[11.5px] text-red-600">{updateModalErr}</p>
            )}

            <div className="mt-4 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => void window.fmc.openExternal(availableUpdate.htmlUrl)}
                className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[#71717a] hover:text-[#111827]"
              >
                <ExternalLink className="h-3 w-3" />
                前往 GitHub 查看
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={downloadingUpdate}
                  onClick={() => setShowUpdateModal(false)}
                  className="rounded-xl border border-[#e4e4e7] px-3 py-1.5 text-[12px] font-medium text-[#52525b] hover:bg-[#f4f4f5] disabled:opacity-40"
                >
                  稍后提醒
                </button>
                {availableUpdate.downloadUrl && (
                  <button
                    type="button"
                    disabled={downloadingUpdate}
                    onClick={async () => {
                      setDownloadingUpdate(true);
                      setUpdateModalErr('');
                      const res = await window.fmc.downloadAppUpdate({
                        downloadUrl: availableUpdate.downloadUrl!,
                        version: availableUpdate.latestVersion,
                        highlights: availableUpdate.highlights
                      });
                      if (!res.ok) {
                        setDownloadingUpdate(false);
                        setUpdateModalErr(res.message);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-[#18181b] px-4 py-1.5 text-[12px] font-medium text-white hover:bg-[#27272a] disabled:opacity-50"
                  >
                    {downloadingUpdate ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {downloadingUpdate ? '正在下载...' : '立即下载并安装'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Right-Click Context Menu for Sidebar Projects */}
      {projectMenu && (() => {
        const targetProj = state.projects.find((p) => p.id === projectMenu.projectId);
        if (!targetProj) return null;
        return (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{ top: projectMenu.y, left: projectMenu.x }}
            className="fixed z-50 w-48 overflow-hidden rounded-xl border border-[#e4e4e7] bg-white p-1.5 text-[12.5px] shadow-popover"
          >
            <button
              type="button"
              onClick={() => openProjectCliConfig(targetProj)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[#111827] transition-colors hover:bg-[#f4f4f5]"
            >
              <Terminal className="h-3.5 w-3.5 text-[#71717a]" />
              <span>配置该项目可用 CLI</span>
            </button>
            <button
              type="button"
              onClick={() => void openScanSessionsModal(targetProj)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[#111827] transition-colors hover:bg-[#f4f4f5]"
            >
              <History className="h-3.5 w-3.5 text-[#71717a]" />
              <span>导入本地 CLI 历史</span>
            </button>
            <button
              type="button"
              onClick={() => openEditProject(targetProj)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[#111827] transition-colors hover:bg-[#f4f4f5]"
            >
              <SquarePen className="h-3.5 w-3.5 text-[#71717a]" />
              <span>重命名 / 编辑简介</span>
            </button>
            {targetProj.repoPath && (
              <button
                type="button"
                onClick={() => {
                  setProjectMenu(null);
                  void window.fmc.openPath(targetProj.repoPath);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[#111827] transition-colors hover:bg-[#f4f4f5]"
              >
                <FolderOpen className="h-3.5 w-3.5 text-[#71717a]" />
                <span>打开项目目录</span>
              </button>
            )}
            {targetProj.id !== 'proj-default' && (
              <>
                <div className="my-1 border-t border-[#f1f1f3]" />
                <button
                  type="button"
                  onClick={() => void handleDeleteProject(targetProj)}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-red-600 transition-colors hover:bg-red-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>删除项目</span>
                </button>
              </>
            )}
          </div>
        );
      })()}

      {/* Edit Project Info Modal */}
      {editingProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[1px]">
          <form
            onSubmit={(e) => void handleSaveEditProject(e)}
            className="w-full max-w-md rounded-2xl border border-[#e4e4e7] bg-white p-5 shadow-popover"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-[14px] font-semibold text-[#111827]">项目信息与简介</h3>
              <button
                type="button"
                onClick={() => setEditingProject(null)}
                className="rounded-lg p-1 text-[#8a8f98] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3.5 text-[12.5px]">
              <div>
                <label className="mb-1.5 block font-medium text-[#3f3f46]">项目名称</label>
                <input
                  required
                  value={editProjName}
                  onChange={(e) => setEditProjName(e.target.value)}
                  className="w-full rounded-xl border border-[#e4e4e7] bg-white px-3 py-2 text-[#111827] outline-none focus:border-[#18181b]"
                />
              </div>
              <div>
                <label className="mb-1.5 block font-medium text-[#3f3f46]">项目简介</label>
                <textarea
                  rows={3}
                  value={editProjDesc}
                  onChange={(e) => setEditProjDesc(e.target.value)}
                  placeholder="记录项目背景、目标或注意事项，Muse 调度时会参考此简介"
                  className="w-full resize-none rounded-xl border border-[#e4e4e7] bg-white px-3 py-2 text-[#111827] placeholder-[#a1a1aa] outline-none focus:border-[#18181b]"
                />
              </div>
              <div>
                <label className="mb-1.5 block font-medium text-[#3f3f46]">绑定本地代码目录</label>
                <div className="flex gap-2">
                  <input
                    value={editProjPath}
                    onChange={(e) => setEditProjPath(e.target.value)}
                    placeholder="例如 D:\Projects\my-app"
                    className="flex-1 rounded-xl border border-[#e4e4e7] bg-white px-3 py-2 font-mono text-[12px] text-[#111827] placeholder-[#a1a1aa] outline-none focus:border-[#18181b]"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const dir = await window.fmc.pickDirectory();
                      if (dir) setEditProjPath(dir);
                    }}
                    className="rounded-xl border border-[#e4e4e7] bg-[#fafafa] px-3 py-2 text-[#3f3f46] transition-colors hover:bg-[#f4f4f5]"
                  >
                    选择
                  </button>
                </div>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingProject(null)}
                className="rounded-xl border border-[#e4e4e7] px-3.5 py-1.5 text-[12.5px] font-medium text-[#52525b] transition-colors hover:bg-[#f4f4f5]"
              >
                取消
              </button>
              <button
                type="submit"
                className="rounded-xl bg-[#18181b] px-4 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-[#27272a]"
              >
                保存修改
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Per-Project Allowed CLIs Configuration Modal */}
      {cliConfigProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[1px]">
          <div className="w-full max-w-md rounded-2xl border border-[#e4e4e7] bg-white p-5 shadow-popover">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-[14px] font-semibold text-[#111827]">
                  配置「{cliConfigProject.name}」可用 CLI
                </h3>
                <p className="mt-0.5 text-[11.5px] text-[#71717a]">
                  仅从全局已开启的 CLI 中挑选；保存后侧边栏与 Muse 派单都会严格遵循
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCliConfigProject(null)}
                className="rounded-lg p-1 text-[#8a8f98] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 text-[12.5px]">
              <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-[#eaecef] bg-[#fafafa] px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={cliConfigUseGlobal}
                  onChange={(e) => setCliConfigUseGlobal(e.target.checked)}
                  className="accent-[#18181b]"
                />
                <div>
                  <div className="font-medium text-[#111827]">跟随全局全部已启用 CLI（默认）</div>
                  <div className="text-[11px] text-[#71717a]">
                    取消勾选后，可为当前项目单独指定允许使用的 CLI 子集
                  </div>
                </div>
              </label>

              {!cliConfigUseGlobal && (
                <div className="max-h-56 space-y-1.5 overflow-y-auto">
                  {enabledClis.length === 0 ? (
                    <p className="py-4 text-center text-[12px] text-[#8a8f98]">
                      当前全局尚未启用任何 CLI，请先前往「应用 / CLI 雷达」开启。
                    </p>
                  ) : (
                    enabledClis.map((cli) => {
                      const checked = cliConfigSelected.includes(cli.id);
                      return (
                        <label
                          key={cli.id}
                          className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 transition-colors ${
                            checked
                              ? 'border-[#18181b] bg-[#fafafa]'
                              : 'border-[#eaecef] bg-white hover:bg-[#fafafa]'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setCliConfigSelected((prev) =>
                                e.target.checked
                                  ? Array.from(new Set([...prev, cli.id]))
                                  : prev.filter((id) => id !== cli.id)
                              );
                            }}
                            className="accent-[#18181b]"
                          />
                          <CliBrandIcon
                            cliId={cli.id}
                            avatarUrl={cli.config.avatarUrl}
                            className="h-4 w-4 shrink-0"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium text-[#111827]">{cli.name}</div>
                            {cli.config.defaultModel && (
                              <div className="truncate font-mono text-[10.5px] text-[#71717a]">
                                {cli.config.defaultModel}
                              </div>
                            )}
                          </div>
                        </label>
                      );
                    })
                  )}
                </div>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCliConfigProject(null)}
                className="rounded-xl border border-[#e4e4e7] px-3.5 py-1.5 text-[12.5px] font-medium text-[#52525b] hover:bg-[#f4f4f5]"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!cliConfigUseGlobal && cliConfigSelected.length === 0}
                onClick={() => void handleSaveProjectCliConfig()}
                className="rounded-xl bg-[#18181b] px-4 py-1.5 text-[12.5px] font-medium text-white hover:bg-[#27272a] disabled:opacity-40"
              >
                保存配置
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scan & Import Local CLI Sessions Modal */}
      {importModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[1px]">
          <div className="flex max-h-[82vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[#e4e4e7] bg-white shadow-popover">
            <div className="flex items-center justify-between border-b border-[#eaecef] px-5 py-3.5">
              <div>
                <h3 className="text-[14px] font-semibold text-[#111827]">
                  {importModal.targetProjectName
                    ? `导入「${importModal.targetProjectName}」本地 CLI 历史对话`
                    : '全局扫描本地 CLI 历史对话（按目录自动归类）'}
                </h3>
                <p className="mt-0.5 text-[11.5px] text-[#71717a]">
                  支持 Codex / Claude 保留原 sessionId，导入后可在顶栏切换会话并直接 --resume 接续原上下文
                </p>
              </div>
              <button
                type="button"
                onClick={() => setImportModal((prev) => ({ ...prev, open: false }))}
                className="rounded-lg p-1 text-[#8a8f98] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-3.5">
              {importModal.loading ? (
                <div className="py-12 text-center text-[12.5px] text-[#71717a]">
                  正在扫描本地 ~/.codex 与 ~/.claude 历史会话...
                </div>
              ) : importModal.items.length === 0 ? (
                <div className="py-12 text-center text-[12.5px] text-[#71717a]">
                  {importModal.tip || '未扫描到匹配的本地历史对话'}
                </div>
              ) : (
                <div className="space-y-2">
                  {importModal.items.map((item) => {
                    const checked = Boolean(importModal.selected[item.key]);
                    return (
                      <label
                        key={item.key}
                        className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
                          checked
                            ? 'border-[#18181b] bg-[#fafafa]'
                            : 'border-[#eaecef] bg-white hover:bg-[#fafafa]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setImportModal((prev) => ({
                              ...prev,
                              selected: { ...prev.selected, [item.key]: e.target.checked }
                            }))
                          }
                          className="mt-1 accent-[#18181b]"
                        />
                        <CliBrandIcon cliId={item.cliId} className="mt-0.5 h-4 w-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12.5px] font-medium text-[#111827]">
                            {item.title}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[#71717a]">
                            <span className="rounded bg-[#f4f4f5] px-1.5 py-0.5 font-mono text-[10.5px] text-[#3f3f46]">
                              {item.projectGuessName}
                            </span>
                            <span>{item.messageCount} 条消息</span>
                            <span>{new Date(item.updatedAt).toLocaleString('zh-CN')}</span>
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-[#eaecef] bg-[#fafafa] px-5 py-3">
              <span className="text-[11.5px] text-[#71717a]">
                已勾选 {Object.values(importModal.selected).filter(Boolean).length} 组对话
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setImportModal((prev) => ({ ...prev, open: false }))}
                  className="rounded-xl border border-[#e4e4e7] bg-white px-3.5 py-1.5 text-[12px] font-medium text-[#52525b] hover:bg-[#f4f4f5]"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={
                    importModal.importing ||
                    Object.values(importModal.selected).filter(Boolean).length === 0
                  }
                  onClick={() => void handleImportSelectedSessions()}
                  className="rounded-xl bg-[#18181b] px-4 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[#27272a] disabled:opacity-40"
                >
                  {importModal.importing ? '导入中...' : '导入并续聊'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Global Create Project Modal */}
      {showNewProj && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[1px]">
          <form
            onSubmit={(e) => void handleCreateProjSubmit(e)}
            className="w-full max-w-md rounded-2xl border border-[#e4e4e7] bg-white p-5 shadow-popover"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-[14px] font-semibold text-[#111827]">新建项目组</h3>
              <button
                type="button"
                onClick={() => setShowNewProj(false)}
                className="rounded-lg p-1 text-[#8a8f98] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3.5 text-[12.5px]">
              <div>
                <label className="mb-1.5 block font-medium text-[#3f3f46]">项目名称</label>
                <input
                  required
                  value={newProjName}
                  onChange={(e) => setNewProjName(e.target.value)}
                  placeholder="例如：shop-app"
                  className="w-full rounded-xl border border-[#e4e4e7] bg-white px-3 py-2 text-[#111827] outline-none transition-colors focus:border-[#18181b]"
                />
              </div>
              <div>
                <label className="mb-1.5 block font-medium text-[#3f3f46]">本地代码目录</label>
                <div className="flex gap-2">
                  <input
                    value={newProjPath}
                    onChange={(e) => setNewProjPath(e.target.value)}
                    placeholder="D:\Projects\shop-app"
                    className="flex-1 rounded-xl border border-[#e4e4e7] bg-white px-3 py-2 text-[#111827] outline-none transition-colors focus:border-[#18181b]"
                  />
                  <button
                    type="button"
                    onClick={() => void handlePickFolder()}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[#e4e4e7] bg-white px-3 py-2 text-[#3f3f46] transition-colors hover:bg-[#f4f4f5]"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    选择
                  </button>
                </div>
              </div>
              <div>
                <label className="mb-1.5 block font-medium text-[#3f3f46]">
                  项目简介（辅助 Muse 自动归类）
                </label>
                <textarea
                  rows={2}
                  value={newProjDesc}
                  onChange={(e) => setNewProjDesc(e.target.value)}
                  placeholder="简要说明技术栈或目标，Muse 看到后会自动把相关任务归入此组"
                  className="w-full rounded-xl border border-[#e4e4e7] bg-white px-3 py-2 text-[#111827] outline-none transition-colors focus:border-[#18181b]"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowNewProj(false)}
                className="rounded-xl border border-[#e4e4e7] px-3.5 py-2 text-[12.5px] font-medium text-[#52525b] transition-colors hover:bg-[#f4f4f5]"
              >
                取消
              </button>
              <button
                type="submit"
                className="rounded-xl bg-[#18181b] px-4 py-2 text-[12.5px] font-medium text-white transition-colors hover:bg-[#27272a]"
              >
                创建项目组
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

export default App;
