import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('fmc', {
  // State & onboarding
  getState: () => ipcRenderer.invoke('state:get'),
  completeOnboarding: () => ipcRenderer.invoke('onboarding:complete'),
  resetOnboarding: () => ipcRenderer.invoke('onboarding:reset'),
  updateMuseConfig: (patch: { webUrl?: string; autoBriefSynced?: boolean }) =>
    ipcRenderer.invoke('muse:updateConfig', patch),
  updateControlApi: (patch: {
    tunnelUrl?: string;
    regenerateToken?: boolean;
    autoStartTunnel?: boolean;
    autoSyncToMuse?: boolean;
  }) => ipcRenderer.invoke('controlApi:update', patch),
  setPermissionLevel: (level: 'ask_review' | 'default' | 'auto' | 'turbo') =>
    ipcRenderer.invoke('permission:set', level),
  updateSettings: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke('settings:update', patch),
  updateWorkflowConfig: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke('workflow:updateConfig', patch),
  getWorkflowStatus: () => ipcRenderer.invoke('workflow:status'),
  approveProject: () => ipcRenderer.invoke('workflow:approveProject'),
  approvePlan: () => ipcRenderer.invoke('workflow:approvePlan'),
  approveWorkflow: () => ipcRenderer.invoke('workflow:approve'),
  resumeWorkflowBudget: (extraTokens?: number) =>
    ipcRenderer.invoke('workflow:addBudget', extraTokens),
  retryWorkflowQuota: () => ipcRenderer.invoke('workflow:retryQuota'),
  sendWorkflowFeedback: (text: string) => ipcRenderer.invoke('workflow:feedback', text),
  resetWorkflow: () => ipcRenderer.invoke('workflow:reset'),
  performCloseAction: (action: 'tray' | 'quit', remember: boolean) =>
    ipcRenderer.invoke('window:closeAction', action, remember),
  openDataDir: () => ipcRenderer.invoke('shell:openDataDir'),
  sendMuseChat: (text: string) => ipcRenderer.invoke('muse:sendChat', text),
  readMuseMessages: () => ipcRenderer.invoke('muse:readMessages'),
  clickMuseAction: (actionId: string) => ipcRenderer.invoke('muse:clickAction', actionId),
  saveMediaFile: (url: string, suggestedName?: string) =>
    ipcRenderer.invoke('muse:saveMediaFile', url, suggestedName),
  syncTunnelToMuse: () => ipcRenderer.invoke('muse:syncTunnel'),
  testMuseSitePermission: () => ipcRenderer.invoke('muse:testSitePermission'),
  autoClickMuseAlwaysAllow: () => ipcRenderer.invoke('muse:autoClickAlwaysAllow'),
  fetchMuseAvatar: () => ipcRenderer.invoke('muse:fetchAvatar'),
  applyMuseDesktopIcon: (payload?: { pngDataUrl?: string; avatarUrl?: string }) =>
    ipcRenderer.invoke('app:applyMuseDesktopIcon', payload),
  resetDesktopIcon: () => ipcRenderer.invoke('app:resetDesktopIcon'),

  // CLI scanner & configuration
  scanClis: () => ipcRenderer.invoke('cli:scan'),
  checkCliUpdates: () => ipcRenderer.invoke('cli:checkUpdates'),
  installCli: (cliId: string) => ipcRenderer.invoke('cli:install', cliId),
  updateCli: (cliId: string) => ipcRenderer.invoke('cli:update', cliId),
  uninstallCli: (cliId: string) => ipcRenderer.invoke('cli:uninstall', cliId),
  testCliEndpoint: (cliId: string, draft: Record<string, unknown>) =>
    ipcRenderer.invoke('cli:testEndpoint', cliId, draft),
  getCliQuota: (cliId: string, force?: boolean) => ipcRenderer.invoke('cli:getQuota', cliId, force),
  scanCliModels: (cliId: string, draft?: Record<string, unknown>) =>
    ipcRenderer.invoke('cli:scanModels', cliId, draft),
  saveCliConfig: (cliId: string, config: Record<string, unknown>) =>
    ipcRenderer.invoke('cli:saveConfig', cliId, config),

  // Projects & tasks
  createProject: (input: { name: string; description?: string; repoPath?: string; createdBy?: 'user' | 'muse' }) =>
    ipcRenderer.invoke('project:create', input),
  updateProject: (
    id: string,
    patch: { name?: string; description?: string; repoPath?: string; allowedClis?: string[] | null }
  ) => ipcRenderer.invoke('project:update', id, patch),
  deleteProject: (id: string) => ipcRenderer.invoke('project:delete', id),
  scanLocalSessions: (repoPath?: string) => ipcRenderer.invoke('sessions:scanLocal', repoPath),
  importLocalSessions: (
    items: Array<{ cliId: string; externalSessionId: string; filePath: string; cwd: string; title: string }>,
    targetProjectId?: string
  ) => ipcRenderer.invoke('sessions:importLocal', items, targetProjectId),
  createSessionThread: (projectId: string, cliId: string, title?: string) =>
    ipcRenderer.invoke('sessions:create', projectId, cliId, title),
  getBenchmarks: () => ipcRenderer.invoke('benchmarks:get'),
  refreshBenchmarks: () => ipcRenderer.invoke('benchmarks:refresh'),
  openPath: (targetPath: string) => ipcRenderer.invoke('shell:openPath', targetPath),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  dispatchTask: (req: Record<string, unknown>) => ipcRenderer.invoke('task:dispatch', req),
  cancelTask: (taskId: string) => ipcRenderer.invoke('task:cancel', taskId),
  getMuseBrief: () => ipcRenderer.invoke('muse:getBrief'),

  // Feishu bridge
  getFeishuStatus: () => ipcRenderer.invoke('feishu:status'),
  checkFeishuSetup: (appId?: string, appSecret?: string) =>
    ipcRenderer.invoke('feishu:checkSetup', appId, appSecret),
  connectFeishu: (appId: string, appSecret: string) =>
    ipcRenderer.invoke('feishu:connect', appId, appSecret),
  disconnectFeishu: () => ipcRenderer.invoke('feishu:disconnect'),
  resetFeishuVerification: () => ipcRenderer.invoke('feishu:resetVerification'),
  sendFeishuTest: (text: string) => ipcRenderer.invoke('feishu:sendTest', text),
  clearProactiveUnread: () => ipcRenderer.invoke('muse:clearProactiveUnread'),
  mutateOpenQuestion: (payload: Record<string, unknown>) =>
    ipcRenderer.invoke('questions:mutate', payload),
  deleteResearchNote: (id: string) => ipcRenderer.invoke('research:delete', id),
  getMuseExtensionStatus: () => ipcRenderer.invoke('browser:getExtensionStatus'),
  launchMuseExtensionHost: (openStore?: boolean) =>
    ipcRenderer.invoke('browser:launchExtensionHost', openStore),
  openLocalControlledBrowser: (url?: string) =>
    ipcRenderer.invoke('browser:openLocalControlled', url),
  runFeishuAutoPilot: (params?: { botName?: string; botDesc?: string; existingAppId?: string }) =>
    ipcRenderer.invoke('autopilot:feishu', params),
  runMuseFeishuCoPilot: (params?: { botName?: string; botDesc?: string }) =>
    ipcRenderer.invoke('autopilot:museFeishu', params),
  getWhatsNew: () => ipcRenderer.invoke('app:getWhatsNew'),
  ackWhatsNew: () => ipcRenderer.invoke('app:ackWhatsNew'),
  checkAppUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  downloadAppUpdate: (payload: { downloadUrl: string; version: string; highlights?: string[] }) =>
    ipcRenderer.invoke('app:downloadUpdate', payload),

  // Built-in Embedded Tailscale, Serveo 443, Cloudflare & SSH Reverse Tunnel
  getTunnelStatus: () => ipcRenderer.invoke('tunnel:status'),
  startTailscaleTunnel: () => ipcRenderer.invoke('tunnel:startTailscale'),
  startServeoTunnel: () => ipcRenderer.invoke('tunnel:startServeo'),
  startTunnel: () => ipcRenderer.invoke('tunnel:start'),
  startSshTunnel: (cfg?: Record<string, unknown>) => ipcRenderer.invoke('tunnel:startSsh', cfg),
  stopTunnel: () => ipcRenderer.invoke('tunnel:stop'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // Embedded Chromium WebContentsView controls (persist:feishu & persist:muse)
  showEmbeddedView: (
    target: 'feishu' | 'muse',
    bounds: { x: number; y: number; width: number; height: number },
    url?: string
  ) => ipcRenderer.invoke('browser:show', target, bounds, url),
  hideEmbeddedViews: () => ipcRenderer.invoke('browser:hideAll'),
  navigateEmbeddedView: (target: 'feishu' | 'muse', url: string) =>
    ipcRenderer.invoke('browser:navigate', target, url),
  reloadEmbeddedView: (target: 'feishu' | 'muse') =>
    ipcRenderer.invoke('browser:reload', target),
  goBackEmbeddedView: (target: 'feishu' | 'muse') =>
    ipcRenderer.invoke('browser:goBack', target),

  // Event subscriptions from Main Process
  onEvent: (channel: string, cb: (payload: unknown) => void) => {
    const listener = (_ev: Electron.IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  }
});
