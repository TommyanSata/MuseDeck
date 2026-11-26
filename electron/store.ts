import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { app } from 'electron';

export type CliId = string;

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

export interface CliUserConfig {
  enabled: boolean;
  authMode: 'oauth' | 'api_key';
  apiProtocol?: ApiProtocol;
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

export interface ModelCapabilityProfile {
  summary: string;
  strengths?: string[];
  costLevel?: 'low' | 'medium' | 'high' | 'flagship';
  updatedAt: string;
}

export interface MuseConfig {
  webUrl: string;
  autoBriefSynced: boolean;
  tunnelVerified?: boolean;
  avatarUrl?: string;
  avatarKind?: 'image' | 'video';
  lastBriefHash?: string;
  lastSyncedEndpointSig?: string;
  briefRevision?: number;
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

export interface AggregatedMessage {
  id: string;
  projectId: string;
  sessionId?: string;
  source: 'user' | 'muse' | 'feishu' | 'cli' | 'system';
  agentId?: string;
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
  museDisplayMode: MuseDisplayMode;
}

export interface FmcState {
  onboardingCompleted: boolean;
  permissionLevel: PermissionLevel;
  settings: AppSettings;
  workflow: WorkflowConfig;
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

function defaultState(): FmcState {
  const now = new Date().toISOString();
  return {
    onboardingCompleted: false,
    permissionLevel: 'auto',
    settings: {
      fontSize: 'normal',
      fontFamily: 'system',
      monoFont: 'system',
      closeBehavior: 'ask',
      launchAtLogin: false,
      museDisplayMode: 'avatar'
    },
    workflow: {
      reviewMode: 'muse_review',
      planApprovalMode: 'adaptive',
      modelRoutingMode: 'muse_ask',
      decisionWeights: { capability: 45, price: 25, quota: 20, speed: 10 },
      userHabits: [],
      autoFetchBenchmarks: true,
      cloudResearchFirst: true,
      proactivePushEnabled: true,
      quietHoursEnabled: true,
      quietHoursStart: '23:00',
      quietHoursEnd: '08:00',
      maxAutoRounds: 3,
      tokenBudget: 150000,
      stallLimit: 2,
      autoWakeMuse: true
    },
    feishu: {
      appId: '',
      appSecret: '',
      verified: false,
      allowOpenIds: []
    },
    muse: {
      webUrl: 'https://muse.ai',
      autoBriefSynced: false
    },
    controlApi: {
      port: 18787,
      token: crypto.randomBytes(16).toString('hex'),
      tunnelUrl: '',
      autoStartTunnel: true,
      autoSyncToMuse: true,
      sshTunnel: {
        host: '',
        user: '',
        keyPath: '',
        remotePort: 18787
      }
    },
    cliConfigs: {},
    projects: [
      {
        id: 'proj-default',
        name: '默认总控台',
        description: '所有未归类任务与首次测试对话会汇总于此；Muse 发现新项目时会自动创建独立分组。',
        repoPath: process.cwd(),
        createdBy: 'user',
        createdAt: now,
        updatedAt: now
      }
    ],
    messages: [
      {
        id: 'msg-welcome',
        projectId: 'proj-default',
        source: 'system',
        role: 'summary',
        title: '欢迎使用 Feishu Muse Commander (FMC)',
        content:
          '点击左上角 Muse 形象可直接唤出内嵌 Muse 网页对话；Muse 调用本地 Control API 派单时，会自动按项目分组并在此实时流式聚合各家 CLI 的执行记录与代码 Diff。',
        status: 'done',
        createdAt: now
      }
    ]
  };
}

export class FmcStore {
  private filePath: string;
  private state: FmcState;

  constructor() {
    const dir = path.join(app.getPath('userData'), 'fmc-data');
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, 'state.json');
    this.state = this.load();
  }

  private load(): FmcState {
    if (!fs.existsSync(this.filePath)) {
      const init = defaultState();
      this.saveState(init);
      return init;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<FmcState>;
      const base = defaultState();
      return {
        ...base,
        ...parsed,
        settings: { ...base.settings, ...(parsed.settings || {}) },
        workflow: { ...base.workflow, ...(parsed.workflow || {}) },
        feishu: { ...base.feishu, ...(parsed.feishu || {}) },
        muse: { ...base.muse, ...(parsed.muse || {}) },
        controlApi: { ...base.controlApi, ...(parsed.controlApi || {}) },
        cliConfigs: { ...base.cliConfigs, ...(parsed.cliConfigs || {}) },
        projects: parsed.projects && parsed.projects.length > 0 ? parsed.projects : base.projects,
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [],
        researchNotes: Array.isArray(parsed.researchNotes) ? parsed.researchNotes : [],
        modelProfiles: parsed.modelProfiles || {},
        cliUpdatesCache: parsed.cliUpdatesCache || {},
        messages: parsed.messages && parsed.messages.length > 0 ? parsed.messages : base.messages
      };
    } catch {
      const init = defaultState();
      this.saveState(init);
      return init;
    }
  }

  private saveState(st: FmcState): void {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  getState(): FmcState {
    return this.state;
  }

  update(mutator: (draft: FmcState) => void): FmcState {
    mutator(this.state);
    this.saveState(this.state);
    return this.state;
  }

  addProject(input: {
    name: string;
    description?: string;
    repoPath?: string;
    createdBy: 'user' | 'muse';
  }): ProjectGroup {
    const existing = this.state.projects.find(
      (p) => p.name.trim().toLowerCase() === input.name.trim().toLowerCase()
    );
    if (existing) {
      if (input.repoPath) existing.repoPath = input.repoPath;
      if (input.description) existing.description = input.description;
      existing.updatedAt = new Date().toISOString();
      this.saveState(this.state);
      return existing;
    }
    const now = new Date().toISOString();
    const proj: ProjectGroup = {
      id: `proj-${crypto.randomBytes(4).toString('hex')}`,
      name: input.name.trim(),
      description: input.description?.trim() || '',
      repoPath: input.repoPath?.trim() || process.cwd(),
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now
    };
    this.state.projects.unshift(proj);
    this.saveState(this.state);
    return proj;
  }

  updateProject(
    id: string,
    patch: { name?: string; description?: string; repoPath?: string; allowedClis?: string[] | null }
  ): ProjectGroup | null {
    const target = this.state.projects.find((p) => p.id === id);
    if (!target) return null;
    if (patch.name !== undefined && patch.name.trim()) {
      target.name = patch.name.trim();
    }
    if (patch.description !== undefined) {
      target.description = patch.description.trim();
    }
    if (patch.repoPath !== undefined && patch.repoPath.trim()) {
      target.repoPath = patch.repoPath.trim();
    }
    if (patch.allowedClis === null) {
      delete target.allowedClis;
    } else if (Array.isArray(patch.allowedClis)) {
      target.allowedClis = Array.from(new Set(patch.allowedClis.map((x) => x.trim()).filter(Boolean)));
    }
    target.updatedAt = new Date().toISOString();
    this.saveState(this.state);
    return target;
  }

  deleteProject(id: string): boolean {
    if (!id || id === 'proj-default') return false;
    const before = this.state.projects.length;
    this.state.projects = this.state.projects.filter((p) => p.id !== id);
    if (this.state.projects.length === before) return false;
    this.state.messages = this.state.messages.filter((m) => m.projectId !== id);
    this.saveState(this.state);
    return true;
  }

  addMessage(msg: Omit<AggregatedMessage, 'id' | 'createdAt'>): AggregatedMessage {
    const full: AggregatedMessage = {
      ...msg,
      id: `msg-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      createdAt: new Date().toISOString()
    };
    this.state.messages.push(full);
    if (this.state.messages.length > 800) {
      this.state.messages = this.state.messages.slice(-800);
    }
    const proj = this.state.projects.find((p) => p.id === full.projectId);
    if (proj) proj.updatedAt = full.createdAt;
    this.saveState(this.state);
    return full;
  }

  updateMessage(id: string, patch: Partial<AggregatedMessage>): AggregatedMessage | undefined {
    const target = this.state.messages.find((m) => m.id === id);
    if (!target) return undefined;
    Object.assign(target, patch);
    this.saveState(this.state);
    return target;
  }
}
