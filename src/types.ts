export type CliId =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'pi'
  | 'antigravity'
  | 'opencode'
  | 'openclaw'
  | 'grok'
  | 'kimi'
  | 'deepseek';

export interface CliDefinition {
  id: CliId;
  name: string;
  command: string;
  installHint: string;
  installCmd: string;
  updateCmd?: string;
  npmPackage?: string;
  pypiPackage?: string;
  canAutoInstall?: boolean;
  models: string[];
  apiKeyEnv: string;
  baseUrlEnv?: string;
  badgeColor: string;
}

export interface DetectedCli extends CliDefinition {
  installed: boolean;
  executablePath: string;
  version: string;
  config: CliUserConfig;
}

export interface CliUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  checkedAt: string;
  error?: string;
}

export interface CliPackageActionResult {
  ok: boolean;
  exitCode: number;
  message: string;
  command: string;
  clis: DetectedCli[];
}

export type ApiProtocol =
  | 'openai_chat'
  | 'openai_responses'
  | 'anthropic'
  | 'gemini_native'
  | 'custom_raw';

export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh';

export type WorkflowReviewMode = 'muse_review' | 'direct_user' | 'auto_sprint';

export type PlanApprovalMode = 'always' | 'adaptive' | 'never';

export type ModelRoutingMode = 'user_default' | 'muse_auto' | 'muse_ask';

export interface DecisionPriorityWeights {
  capability: number;
  price: number;
  quota: number;
  speed: number;
}

export interface CliQuotaSnapshot {
  cliId: string;
  costTier: 'subscription' | 'metered';
  balanceText?: string;
  balanceNumeric?: number;
  currency?: string;
  window5hUsedPct?: number;
  window7dUsedPct?: number;
  window30dUsedPct?: number;
  local5hTokens: number;
  local7dTokens: number;
  local30dTokens: number;
  health: 'healthy' | 'tight' | 'exhausted' | 'unknown';
  source: string;
  checkedAt: string;
  error?: string;
}

export interface WorkflowConfig {
  reviewMode: WorkflowReviewMode;
  planApprovalMode?: PlanApprovalMode;
  modelRoutingMode?: ModelRoutingMode;
  decisionWeights?: DecisionPriorityWeights;
  userHabits?: string[];
  autoFetchBenchmarks?: boolean;
  cloudResearchFirst?: boolean;
  proactivePushEnabled?: boolean;
  quietHoursEnabled?: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  maxAutoRounds: number;
  tokenBudget: number;
  stallLimit: number;
  autoWakeMuse: boolean;
}

export interface OpenQuestionItem {
  id: string;
  projectId?: string;
  projectName?: string;
  question: string;
  context?: string;
  options?: string[];
  status: 'open' | 'resolved';
  resolution?: string;
  source: 'muse' | 'user' | 'cli';
  createdAt: string;
  updatedAt: string;
  lastAskedAt?: string;
}

export interface ResearchNoteItem {
  id: string;
  projectId?: string;
  projectName?: string;
  title: string;
  summary: string;
  sources?: string[];
  savedFilePath?: string;
  createdAt: string;
}

export type WorkflowPhase =
  | 'idle'
  | 'awaiting_project_approval'
  | 'awaiting_plan_approval'
  | 'running'
  | 'reviewing'
  | 'awaiting_user'
  | 'paused_quota'
  | 'paused_budget'
  | 'completed';

export interface PendingProjectProposal {
  action: 'use_existing' | 'create_new';
  projectName: string;
  projectId?: string;
  description?: string;
  repoPath?: string;
  reason?: string;
}

export interface WorkflowRunState {
  id: string;
  phase: WorkflowPhase;
  goal: string;
  round: number;
  maxRounds: number;
  tokensUsed: number;
  tokenBudget: number;
  consecutiveStalls: number;
  activeTaskIds: string[];
  completedTaskCount: number;
  pendingProjectProposal?: PendingProjectProposal;
  projectApproved?: boolean;
  approvedProjectName?: string;
  pendingPlan?: string;
  planApproved?: boolean;
  lastSummary?: string;
  pauseReason?: string;
  quotaRetryAt?: string;
  lastHandoffFrom?: string;
  updatedAt: string;
}

export interface CliUserConfig {
  enabled: boolean;
  authMode: 'oauth' | 'api_key';
  apiProtocol: ApiProtocol;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  reasoningEffort?: ReasoningEffort;
  roles?: string[];
  roleWeights?: Record<string, number>;
  weight?: number;
  costTier?: 'subscription' | 'metered';
  balanceUrl?: string;
  limit5hTokens?: number;
  limit7dTokens?: number;
  limit30dTokens?: number;
  avatarUrl?: string;
  extraArgs: string;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verified: boolean;
  verifiedAppId?: string;
  verifiedAt?: string;
  lastChatId?: string;
  lastSenderOpenId?: string;
  lastPingMessage?: string;
  allowOpenIds: string[];
}

export interface MuseConfig {
  webUrl: string;
  autoBriefSynced: boolean;
  tunnelVerified?: boolean;
  avatarUrl?: string;
  avatarKind?: 'image' | 'video';
  unreadProactiveCount?: number;
  lastProactiveText?: string;
  lastProactiveAt?: string;
}

export interface SshTunnelConfig {
  host: string;
  user: string;
  keyPath: string;
  remotePort: number;
}

export interface ControlApiConfig {
  port: number;
  token: string;
  tunnelUrl: string;
  preferredTunnelMode?: 'tailscale' | 'serveo' | 'cloudflared' | 'ssh';
  autoStartTunnel?: boolean;
  autoSyncToMuse?: boolean;
  sshTunnel?: SshTunnelConfig;
}

export interface ProjectGroup {
  id: string;
  name: string;
  description: string;
  repoPath: string;
  allowedClis?: string[];
  createdBy: 'user' | 'muse';
  createdAt: string;
  updatedAt: string;
}

export interface CliSessionThread {
  id: string;
  projectId: string;
  cliId: CliId;
  title: string;
  externalSessionId?: string;
  source: 'local' | 'imported';
  createdAt: string;
  updatedAt: string;
}

export interface ScannedLocalSession {
  key: string;
  cliId: CliId;
  externalSessionId: string;
  cwd: string;
  projectGuessName: string;
  title: string;
  messageCount: number;
  updatedAt: string;
  filePath: string;
}

export interface BenchmarkCache {
  updatedAt: string;
  sources: Array<{
    id: string;
    name: string;
    url: string;
    ok: boolean;
    fetchedAt: string;
    highlights: string[];
    error?: string;
  }>;
  digest: string;
}

export interface AggregatedMessage {
  id: string;
  projectId: string;
  sessionId?: string;
  source: 'user' | 'muse' | 'feishu' | 'cli' | 'system';
  agentId?: CliId;
  model?: string;
  role: 'directive' | 'output' | 'error' | 'summary';
  title?: string;
  content: string;
  status?: 'running' | 'done' | 'error' | 'cancelled';
  worktreeBranch?: string;
  diffStat?: string;
  taskId?: string;
  createdAt: string;
}

export type PermissionLevel = 'ask_review' | 'default' | 'auto' | 'turbo';

export type CloseBehavior = 'ask' | 'tray' | 'quit';

export type MuseDisplayMode = 'avatar' | 'compact';

export interface AppSettings {
  fontSize: 'small' | 'normal' | 'large' | 'xlarge';
  fontFamily: 'system' | 'yahei' | 'inter' | 'mono';
  monoFont: 'system' | 'cascadia' | 'jetbrains' | 'consolas';
  closeBehavior: CloseBehavior;
  launchAtLogin: boolean;
  checkUpdateOnStartup?: boolean;
  museDisplayMode: MuseDisplayMode;
}

export interface ModelCapabilityProfile {
  summary: string;
  strengths?: string[];
  costLevel?: 'low' | 'medium' | 'high' | 'flagship';
  updatedAt: string;
}

export interface UserProfileConfig {
  profession: string;
  purposes: string[];
  customNote?: string;
  recommendedAt?: string;
  lastRecommendationSummary?: string;
  lastRecommendationSource?: 'muse' | 'preset';
  cliReasons?: Record<string, string>;
}

export interface CliPresetCliSnapshot {
  enabled: boolean;
  defaultModel: string;
  reasoningEffort?: ReasoningEffort;
  roleWeights?: Record<string, number>;
  roles?: string[];
}

export interface CliPresetGroup {
  id: string;
  name: string;
  kind: 'smart' | 'custom';
  dispatchPolicy: 'muse_decide' | 'strict_custom';
  description?: string;
  decisionWeights?: DecisionPriorityWeights;
  cliSnapshots: Record<string, CliPresetCliSnapshot>;
  updatedAt: string;
}

export interface FeishuLiveGuideState {
  url: string;
  loggedIn: boolean;
  detectedAppId: string;
  hasBotCapability: boolean;
  onAuthPage: boolean;
  onBaseInfoPage: boolean;
  onEventPage: boolean;
  subscriptionEditExpanded: boolean;
  longConnectionSaved: boolean;
  receiveEventAdded: boolean;
  onVersionPage: boolean;
  versionPublished: boolean;
  openModalKind?: 'create_app' | 'import_json' | 'create_version' | null;
  activeTargetHint: string;
  spotlightEnabled: boolean;
}

export interface FmcState {
  onboardingCompleted: boolean;
  lastSeenAppVersion?: string;
  permissionLevel: PermissionLevel;
  userProfile?: UserProfileConfig;
  activePresetId?: string;
  cliPresets?: CliPresetGroup[];
  settings?: AppSettings;
  workflow?: WorkflowConfig;
  feishu: FeishuConfig;
  muse: MuseConfig;
  controlApi: ControlApiConfig;
  cliConfigs: Record<string, CliUserConfig>;
  projects: ProjectGroup[];
  sessions?: CliSessionThread[];
  openQuestions?: OpenQuestionItem[];
  researchNotes?: ResearchNoteItem[];
  modelProfiles?: Record<string, ModelCapabilityProfile>;
  cliUpdatesCache?: Record<string, { latestVersion: string; checkedAt: string }>;
  messages: AggregatedMessage[];
}

export interface FeishuStatusEvent {
  state: 'disconnected' | 'connecting' | 'connected' | 'error';
  connectedAppId?: string;
  message?: string;
  verified?: boolean;
  lastPing?: {
    text: string;
    senderOpenId: string;
    chatId: string;
    receivedAt: string;
  };
}

export interface EmbeddedBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TunnelStatusEvent {
  state: 'stopped' | 'starting' | 'running' | 'error';
  mode?: 'tailscale' | 'serveo' | 'cloudflared' | 'ssh';
  url?: string;
  authUrl?: string;
  message?: string;
}

export interface MuseLiveStateEvent {
  isBusy: boolean;
  statusText: string;
  hasPendingPermission: boolean;
  avatarUrl?: string;
  avatarKind?: 'image' | 'video';
}

export interface FeishuSetupCheckResult {
  hasCredentials: boolean;
  credentialsValid: boolean;
  botEnabled: boolean;
  botName?: string;
  wsConnected: boolean;
  messageVerified: boolean;
  error?: string;
}

export interface MuseChatAction {
  id: string;
  label: string;
  thumb?: string;
  kind: 'option' | 'approve' | 'danger' | 'action';
}

export interface MuseChatMessage {
  role: 'user' | 'muse';
  text: string;
  time?: string;
  images?: Array<{ src: string; alt?: string }>;
  videos?: Array<{ src: string; poster?: string }>;
  audios?: Array<{ src: string }>;
  links?: Array<{ href: string; label: string }>;
  actions?: MuseChatAction[];
  hasInteractiveCard?: boolean;
}

export interface ModelScanResult {
  models: string[];
  sources: string[];
  error?: string;
}

export interface MuseExtensionStatus {
  installed: boolean;
  extensionId: string;
  storeUrl: string;
  browser?: 'chrome' | 'edge';
  profileDir?: string;
  version?: string;
  executablePath?: string;
}

export interface FeishuAutoStepReport {
  step: string;
  status: 'ok' | 'warn' | 'manual';
  detail: string;
}

export interface FeishuAutoPilotResult {
  ok: boolean;
  needLogin?: boolean;
  appId?: string;
  appSecret?: string;
  completedSteps: string[];
  stepReport?: FeishuAutoStepReport[];
  nextManualHint?: string;
  message: string;
}

export interface AppUpdateCheckResult {
  ok: boolean;
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseTitle?: string;
  highlights: string[];
  rawNotes?: string;
  downloadUrl?: string;
  htmlUrl: string;
  publishedAt?: string;
  checkedAt: string;
  error?: string;
}

export interface WhatsNewInfo {
  currentVersion: string;
  shouldShow: boolean;
  title: string;
  highlights: string[];
}
