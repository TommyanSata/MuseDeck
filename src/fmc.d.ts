import {
  CliPackageActionResult,
  CliUpdateInfo,
  CliUserConfig,
  DetectedCli,
  EmbeddedBrowserBounds,
  FeishuStatusEvent,
  FmcState,
  ModelScanResult,
  ProjectGroup,
  TunnelStatusEvent
} from './types';

export interface FmcApi {
  getState: () => Promise<FmcState>;
  completeOnboarding: () => Promise<FmcState>;
  resetOnboarding: () => Promise<FmcState>;
  updateMuseConfig: (patch: { webUrl?: string; autoBriefSynced?: boolean }) => Promise<FmcState>;
  updateControlApi: (patch: {
    tunnelUrl?: string;
    regenerateToken?: boolean;
    autoStartTunnel?: boolean;
    autoSyncToMuse?: boolean;
  }) => Promise<FmcState>;
  setPermissionLevel: (level: import('./types').PermissionLevel) => Promise<FmcState>;
  updateSettings: (patch: Partial<import('./types').AppSettings>) => Promise<FmcState>;
  updateWorkflowConfig: (patch: Partial<import('./types').WorkflowConfig>) => Promise<FmcState>;
  getWorkflowStatus: () => Promise<import('./types').WorkflowRunState>;
  approveProject: () => Promise<import('./types').WorkflowRunState>;
  approvePlan: () => Promise<import('./types').WorkflowRunState>;
  approveWorkflow: () => Promise<import('./types').WorkflowRunState>;
  resumeWorkflowBudget: (extraTokens?: number) => Promise<import('./types').WorkflowRunState>;
  sendWorkflowFeedback: (text: string) => Promise<import('./types').WorkflowRunState>;
  resetWorkflow: () => Promise<import('./types').WorkflowRunState>;
  performCloseAction: (action: 'tray' | 'quit', remember: boolean) => Promise<boolean>;
  openDataDir: () => Promise<boolean>;
  sendMuseChat: (text: string) => Promise<{ ok: boolean; message: string }>;
  readMuseMessages: () => Promise<{
    messages: import('./types').MuseChatMessage[];
    hasPendingPermission: boolean;
  }>;
  clickMuseAction: (actionId: string) => Promise<{ ok: boolean; message: string }>;
  saveMediaFile: (
    url: string,
    suggestedName?: string
  ) => Promise<{ ok: boolean; savedPath?: string; message: string }>;
  syncTunnelToMuse: () => Promise<{ ok: boolean; message: string }>;
  testMuseSitePermission: () => Promise<{ ok: boolean; message: string }>;
  autoClickMuseAlwaysAllow: () => Promise<{ ok: boolean; message: string }>;
  fetchMuseAvatar: () => Promise<{
    ok: boolean;
    kind?: 'image' | 'video';
    url?: string;
    message?: string;
  }>;
  applyMuseDesktopIcon: (payload?: { pngDataUrl?: string; avatarUrl?: string }) => Promise<{
    ok: boolean;
    message: string;
  }>;
  resetDesktopIcon: () => Promise<{
    ok: boolean;
    message: string;
  }>;

  scanClis: () => Promise<DetectedCli[]>;
  checkCliUpdates: () => Promise<Record<string, CliUpdateInfo>>;
  installCli: (cliId: string) => Promise<CliPackageActionResult>;
  updateCli: (cliId: string) => Promise<CliPackageActionResult>;
  uninstallCli: (cliId: string) => Promise<CliPackageActionResult>;
  testCliEndpoint: (
    cliId: string,
    draft: Partial<CliUserConfig>
  ) => Promise<{ ok: boolean; latencyMs: number; status?: number; modelCount?: number; message: string }>;
  getCliQuota: (cliId: string, force?: boolean) => Promise<import('./types').CliQuotaSnapshot>;
  scanCliModels: (cliId: string, draft?: Partial<CliUserConfig>) => Promise<ModelScanResult>;
  saveCliConfig: (cliId: string, config: CliUserConfig) => Promise<FmcState>;

  createProject: (input: {
    name: string;
    description?: string;
    repoPath?: string;
    createdBy?: 'user' | 'muse';
  }) => Promise<ProjectGroup>;
  updateProject: (
    id: string,
    patch: { name?: string; description?: string; repoPath?: string; allowedClis?: string[] | null }
  ) => Promise<FmcState>;
  deleteProject: (id: string) => Promise<FmcState>;
  scanLocalSessions: (repoPath?: string) => Promise<import('./types').ScannedLocalSession[]>;
  importLocalSessions: (
    items: Array<{
      cliId: string;
      externalSessionId: string;
      filePath: string;
      cwd: string;
      title: string;
    }>,
    targetProjectId?: string
  ) => Promise<{ state: FmcState; importedCount: number }>;
  createSessionThread: (
    projectId: string,
    cliId: string,
    title?: string
  ) => Promise<{ state: FmcState; session: import('./types').CliSessionThread }>;
  getBenchmarks: () => Promise<import('./types').BenchmarkCache>;
  refreshBenchmarks: () => Promise<import('./types').BenchmarkCache>;
  openPath: (targetPath: string) => Promise<boolean>;
  pickDirectory: () => Promise<string>;
  dispatchTask: (req: {
    projectId: string;
    agentId: string;
    prompt: string;
    source: 'user' | 'muse' | 'feishu';
    model?: string;
    repoPath?: string;
    useWorktree?: boolean;
  }) => Promise<unknown>;
  cancelTask: (taskId: string) => Promise<boolean>;
  getMuseBrief: () => Promise<string>;

  getFeishuStatus: () => Promise<FeishuStatusEvent>;
  checkFeishuSetup: (
    appId?: string,
    appSecret?: string
  ) => Promise<import('./types').FeishuSetupCheckResult>;
  connectFeishu: (appId: string, appSecret: string) => Promise<FeishuStatusEvent>;
  disconnectFeishu: () => Promise<FeishuStatusEvent>;
  resetFeishuVerification: () => Promise<FeishuStatusEvent>;
  sendFeishuTest: (text: string) => Promise<boolean>;
  clearProactiveUnread: () => Promise<FmcState>;
  mutateOpenQuestion: (payload: {
    action: 'add' | 'resolve' | 'reopen' | 'delete' | 'ask_muse';
    id?: string;
    question?: string;
    context?: string;
    projectId?: string;
    projectName?: string;
    resolution?: string;
  }) => Promise<FmcState>;
  deleteResearchNote: (id: string) => Promise<FmcState>;
  getMuseExtensionStatus: () => Promise<import('./types').MuseExtensionStatus>;
  launchMuseExtensionHost: (openStore?: boolean) => Promise<{
    ok: boolean;
    message: string;
    status: import('./types').MuseExtensionStatus;
  }>;
  openLocalControlledBrowser: (url?: string) => Promise<{ ok: boolean; url: string }>;
  runFeishuAutoPilot: (params?: {
    botName?: string;
    botDesc?: string;
    existingAppId?: string;
  }) => Promise<import('./types').FeishuAutoPilotResult>;
  getWhatsNew: () => Promise<import('./types').WhatsNewInfo>;
  ackWhatsNew: () => Promise<FmcState>;
  checkAppUpdate: () => Promise<import('./types').AppUpdateCheckResult>;
  downloadAppUpdate: (payload: {
    downloadUrl: string;
    version: string;
    highlights?: string[];
  }) => Promise<{ ok: boolean; message: string }>;

  getTunnelStatus: () => Promise<TunnelStatusEvent>;
  startTailscaleTunnel: () => Promise<TunnelStatusEvent>;
  startServeoTunnel: () => Promise<TunnelStatusEvent>;
  startTunnel: () => Promise<TunnelStatusEvent>;
  startSshTunnel: (cfg?: Record<string, unknown>) => Promise<TunnelStatusEvent>;
  stopTunnel: () => Promise<TunnelStatusEvent>;
  openExternal: (url: string) => Promise<boolean>;

  showEmbeddedView: (
    target: 'feishu' | 'muse',
    bounds: EmbeddedBrowserBounds,
    url?: string
  ) => Promise<boolean>;
  hideEmbeddedViews: () => Promise<boolean>;
  navigateEmbeddedView: (target: 'feishu' | 'muse', url: string) => Promise<boolean>;
  reloadEmbeddedView: (target: 'feishu' | 'muse') => Promise<boolean>;
  goBackEmbeddedView: (target: 'feishu' | 'muse') => Promise<boolean>;

  onEvent: (channel: string, cb: (payload: unknown) => void) => () => void;
}

declare global {
  interface Window {
    fmc: FmcApi;
  }
}
