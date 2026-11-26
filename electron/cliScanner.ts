import { execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { ApiProtocol, CliUserConfig, FmcState } from './store';

const execFileAsync = promisify(execFile);

export interface CliDefinition {
  id: string;
  name: string;
  command: string;
  installHint: string;
  installCmd: string;
  updateCmd?: string;
  psCommand?: string;
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

export const CLI_REGISTRY: CliDefinition[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    installHint: '通过 npm 安装 @anthropic-ai/claude-code',
    installCmd: 'npm install -g @anthropic-ai/claude-code',
    updateCmd: 'npm install -g @anthropic-ai/claude-code@latest',
    npmPackage: '@anthropic-ai/claude-code',
    canAutoInstall: true,
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-3-5'],
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    badgeColor: '#ea580c'
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    installHint: '通过 npm 安装 @openai/codex',
    installCmd: 'npm install -g @openai/codex',
    updateCmd: 'npm install -g @openai/codex@latest',
    npmPackage: '@openai/codex',
    canAutoInstall: true,
    models: ['gpt-5.3-codex', 'gpt-5.2-codex', 'o4-mini'],
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    badgeColor: '#10b981'
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    installHint: '通过 npm 安装 @google/gemini-cli',
    installCmd: 'npm install -g @google/gemini-cli',
    updateCmd: 'npm install -g @google/gemini-cli@latest',
    npmPackage: '@google/gemini-cli',
    canAutoInstall: true,
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    apiKeyEnv: 'GEMINI_API_KEY',
    badgeColor: '#3b82f6'
  },
  {
    id: 'pi',
    name: 'Pi / Pi Desktop',
    command: 'pi',
    installHint: '通过 npm 安装 @earendil-works/pi-coding-agent',
    installCmd: 'npm install -g @earendil-works/pi-coding-agent',
    updateCmd: 'npm install -g @earendil-works/pi-coding-agent@latest',
    npmPackage: '@earendil-works/pi-coding-agent',
    canAutoInstall: true,
    models: ['claude-sonnet-4-5', 'gpt-5.2-codex', 'gemini-2.5-pro'],
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    badgeColor: '#8b5cf6'
  },
  {
    id: 'antigravity',
    name: 'Antigravity CLI',
    command: 'agy',
    installHint: '通过官方脚本安装 Google Antigravity CLI (agy)',
    installCmd: 'irm https://antigravity.google/cli/install.ps1 | iex',
    updateCmd: 'agy update',
    psCommand: 'irm https://antigravity.google/cli/install.ps1 | iex',
    canAutoInstall: true,
    models: [],
    apiKeyEnv: 'GEMINI_API_KEY',
    baseUrlEnv: 'GEMINI_API_BASE_URL',
    badgeColor: '#06b6d4'
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    installHint: '通过 npm 安装 opencode-ai',
    installCmd: 'npm install -g opencode-ai',
    updateCmd: 'npm install -g opencode-ai@latest',
    npmPackage: 'opencode-ai',
    canAutoInstall: true,
    models: ['claude-sonnet-4-5', 'gpt-5.2-codex', 'deepseek-reasoner'],
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    badgeColor: '#0f172a'
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    command: 'openclaw',
    installHint: '通过 npm 安装 openclaw',
    installCmd: 'npm install -g openclaw',
    updateCmd: 'npm install -g openclaw@latest',
    npmPackage: 'openclaw',
    canAutoInstall: true,
    models: ['default'],
    apiKeyEnv: 'OPENAI_API_KEY',
    badgeColor: '#ef4444'
  },
  {
    id: 'grok',
    name: 'Grok Build',
    command: 'grok',
    installHint: '通过 npm 安装 grok-cli',
    installCmd: 'npm install -g grok-cli',
    updateCmd: 'npm install -g grok-cli@latest',
    npmPackage: 'grok-cli',
    canAutoInstall: true,
    models: ['grok-4', 'grok-3-mini'],
    apiKeyEnv: 'XAI_API_KEY',
    badgeColor: '#334155'
  },
  {
    id: 'kimi',
    name: 'Kimi Code',
    command: 'kimi',
    installHint: '通过 pip 安装 kimi-cli',
    installCmd: 'pip install kimi-cli',
    updateCmd: 'pip install -U kimi-cli',
    pypiPackage: 'kimi-cli',
    canAutoInstall: true,
    models: ['kimi-k2', 'kimi-k2-thinking'],
    apiKeyEnv: 'MOONSHOT_API_KEY',
    badgeColor: '#2563eb'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek Harness',
    command: 'deepseek',
    installHint: '通过 npm 安装 deepseek-cli',
    installCmd: 'npm install -g deepseek-cli',
    updateCmd: 'npm install -g deepseek-cli@latest',
    npmPackage: 'deepseek-cli',
    canAutoInstall: true,
    models: ['deepseek-reasoner', 'deepseek-chat'],
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    badgeColor: '#4f46e5'
  }
];

export async function locateCommand(cmd: string): Promise<string> {
  const isWin = process.platform === 'win32';
  const finder = isWin ? 'where.exe' : 'which';
  try {
    const { stdout } = await execFileAsync(finder, [cmd], { timeout: 2500 });
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 0) {
      if (isWin) {
        const preferred = lines.find((l) => /\.(cmd|exe|bat)$/i.test(l));
        return preferred || lines[0];
      }
      return lines[0];
    }
  } catch {
    // fallback to common user bin paths below
  }

  if (isWin) {
    const home = os.homedir();
    const localAppData = process.env.LOCALAPPDATA || '';
    const appData = process.env.APPDATA || '';
    const candidates = [
      path.join(appData, 'npm', `${cmd}.cmd`),
      path.join(localAppData, 'agy', 'bin', `${cmd}.exe`),
      path.join(home, '.local', 'bin', `${cmd}.exe`),
      path.join(home, '.local', 'bin', `${cmd}.cmd`),
      path.join(home, '.antigravity', 'bin', `${cmd}.exe`),
      path.join(localAppData, 'antigravity', 'bin', `${cmd}.exe`),
      path.join(localAppData, 'Programs', 'antigravity', 'bin', `${cmd}.exe`),
      path.join(localAppData, 'Programs', 'Antigravity', 'bin', `${cmd}.cmd`)
    ];
    for (const p of candidates) {
      if (p && fs.existsSync(p)) return p;
    }
  }
  return '';
}

function parseSemverTuple(ver: string): number[] | null {
  const m = ver.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isNewerVersion(current: string, latest: string): boolean {
  const a = parseSemverTuple(current);
  const b = parseSemverTuple(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

async function fetchLatestRegistryVersion(def: CliDefinition): Promise<string> {
  if (def.npmPackage) {
    const url = `https://registry.npmjs.org/${encodeURIComponent(def.npmPackage).replace('%2F', '/')}/latest`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`npm HTTP ${res.status}`);
    const data = (await res.json()) as { version?: string };
    if (data.version) return data.version;
  }
  if (def.pypiPackage) {
    const url = `https://pypi.org/pypi/${encodeURIComponent(def.pypiPackage)}/json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`PyPI HTTP ${res.status}`);
    const data = (await res.json()) as { info?: { version?: string } };
    if (data.info?.version) return data.info.version;
  }
  return '';
}

export async function checkCliUpdates(
  clis: DetectedCli[]
): Promise<Record<string, CliUpdateInfo>> {
  const out: Record<string, CliUpdateInfo> = {};
  const now = new Date().toISOString();

  await Promise.all(
    clis
      .filter((c) => c.installed && (c.npmPackage || c.pypiPackage))
      .map(async (cli) => {
        try {
          const latestVersion = await fetchLatestRegistryVersion(cli);
          out[cli.id] = {
            currentVersion: cli.version,
            latestVersion,
            hasUpdate: Boolean(latestVersion && isNewerVersion(cli.version, latestVersion)),
            checkedAt: now
          };
        } catch (err) {
          out[cli.id] = {
            currentVersion: cli.version,
            latestVersion: '',
            hasUpdate: false,
            checkedAt: now,
            error: err instanceof Error ? err.message : String(err)
          };
        }
      })
  );

  return out;
}

export async function testCliEndpoint(
  cliId: string,
  draft: Partial<CliUserConfig>
): Promise<{ ok: boolean; latencyMs: number; status?: number; modelCount?: number; message: string }> {
  const start = Date.now();
  const apiKey = (draft.apiKey || '').trim();
  if (!apiKey) {
    return { ok: false, latencyMs: 0, message: '请先填写 API Key' };
  }
  const protocol = draft.apiProtocol || defaultProtocolForCli(cliId);
  const { modelsUrl } = resolveProtocolEndpoints(protocol, draft.baseUrl || '', cliId);

  try {
    const headers: Record<string, string> = {};
    let targetUrl = modelsUrl;
    if (protocol === 'gemini_native') {
      targetUrl = modelsUrl.includes('?')
        ? `${modelsUrl}&key=${encodeURIComponent(apiKey)}`
        : `${modelsUrl}?key=${encodeURIComponent(apiKey)}`;
    } else if (protocol === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const res = await fetch(targetUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(8000)
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      const body = (await res.text()).slice(0, 160);
      return {
        ok: false,
        latencyMs,
        status: res.status,
        message: `HTTP ${res.status}${body ? `：${body}` : ''}`
      };
    }
    const json = (await res.json()) as { data?: unknown[]; models?: unknown[] };
    const count = Array.isArray(json.data)
      ? json.data.length
      : Array.isArray(json.models)
        ? json.models.length
        : undefined;
    return {
      ok: true,
      latencyMs,
      status: res.status,
      modelCount: count,
      message: count !== undefined ? `连通正常 · ${latencyMs}ms (${count} 个模型)` : `连通正常 · ${latencyMs}ms`
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : String(err)
    };
  }
}

export function runCliPackageCommand(
  cliId: string,
  action: 'install' | 'update' | 'uninstall',
  onLog: (chunk: string) => void
): Promise<{ ok: boolean; exitCode: number; message: string; command: string }> {
  const def = CLI_REGISTRY.find((c) => c.id === cliId);
  if (!def) {
    return Promise.resolve({
      ok: false,
      exitCode: 1,
      message: `未知的 CLI: ${cliId}`,
      command: ''
    });
  }
  if (def.canAutoInstall === false) {
    return Promise.resolve({
      ok: false,
      exitCode: 1,
      message: `${def.name} 为独立桌面客户端，请通过官方安装包管理。`,
      command: def.installCmd
    });
  }

  let cmdStr = action === 'update' ? def.updateCmd || def.installCmd : def.installCmd;
  let psScript = action === 'install' ? def.psCommand : undefined;

  if (action === 'uninstall') {
    if (def.npmPackage) {
      cmdStr = `npm uninstall -g ${def.npmPackage}`;
    } else if (def.pypiPackage) {
      cmdStr = `pip uninstall -y ${def.pypiPackage}`;
    } else if (def.id === 'antigravity') {
      cmdStr = 'Remove-Item "$env:LOCALAPPDATA\\agy\\bin\\agy.exe" -Force -ErrorAction SilentlyContinue';
      psScript = cmdStr;
    }
  }

  onLog(`$ ${cmdStr}\n`);

  const actionLabel = action === 'install' ? '安装' : action === 'update' ? '更新' : '卸载';

  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child =
      isWin && psScript
        ? spawn(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
            {
              windowsHide: true,
              env: { ...process.env }
            }
          )
        : spawn(isWin ? 'cmd.exe' : 'sh', isWin ? ['/c', cmdStr] : ['-c', cmdStr], {
            windowsHide: true,
            env: { ...process.env }
          });

    child.stdout?.on('data', (buf: Buffer) => onLog(buf.toString('utf-8')));
    child.stderr?.on('data', (buf: Buffer) => onLog(buf.toString('utf-8')));

    child.on('error', (err) => {
      onLog(`\n[Error] ${err.message}\n`);
      resolve({
        ok: false,
        exitCode: 1,
        message: `执行失败：${err.message}`,
        command: cmdStr
      });
    });

    child.on('close', (code) => {
      void (async () => {
        const exitCode = code ?? 1;
        if (exitCode !== 0) {
          resolve({
            ok: false,
            exitCode,
            message: `${def.name} ${actionLabel}失败（退出码 ${exitCode}）`,
            command: cmdStr
          });
          return;
        }
        const located = await locateCommand(def.command);
        if (action === 'install' && !located) {
          resolve({
            ok: false,
            exitCode: 1,
            message: `命令已退出但未检测到 ${def.command} 可执行文件，请检查网络或代理设置后重试。`,
            command: cmdStr
          });
          return;
        }
        resolve({
          ok: true,
          exitCode: 0,
          message: `${def.name} ${actionLabel}成功！${located && action !== 'uninstall' ? ` (${located})` : ''}`,
          command: cmdStr
        });
      })();
    });
  });
}

async function readVersion(execPath: string, def?: CliDefinition): Promise<string> {
  if (!execPath) return '';
  // Fast path (<1ms): read version directly from global npm package.json if available
  if (def?.npmPackage) {
    const appData = process.env.APPDATA || '';
    const pkgCandidates = [
      path.join(appData, 'npm', 'node_modules', ...def.npmPackage.split('/'), 'package.json'),
      path.join(path.dirname(execPath), 'node_modules', ...def.npmPackage.split('/'), 'package.json')
    ];
    for (const pkgPath of pkgCandidates) {
      try {
        if (fs.existsSync(pkgPath)) {
          const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
          if (parsed.version) return parsed.version;
        }
      } catch {
        // fallback to --version
      }
    }
  }
  try {
    const isWin = process.platform === 'win32';
    const isScript = isWin && /\.(cmd|bat)$/i.test(execPath);
    const { stdout, stderr } = await execFileAsync(
      isScript ? 'cmd.exe' : execPath,
      isScript ? ['/c', execPath, '--version'] : ['--version'],
      { timeout: 7000, windowsHide: true }
    );
    const combined = `${stdout}\n${stderr}`.trim();
    const match = combined.match(/\d+\.\d+\.\d+([-\w.]*)?/);
    return match ? match[0] : combined.split(/\r?\n/)[0]?.slice(0, 32) || 'installed';
  } catch {
    return 'installed';
  }
}

export async function scanLocalClis(state: FmcState): Promise<DetectedCli[]> {
  const results = await Promise.all(
    CLI_REGISTRY.map(async (def) => {
      const execPath = await locateCommand(def.command);
      let version = '';

      const installed = Boolean(execPath);
      if (installed && !version) {
        version = await readVersion(execPath, def);
      }

      const saved = state.cliConfigs[def.id];
      const config: CliUserConfig = saved
        ? {
            ...saved,
            apiProtocol: saved.apiProtocol || defaultProtocolForCli(def.id)
          }
        : {
            enabled: installed,
            authMode: 'oauth',
            apiProtocol: defaultProtocolForCli(def.id),
            apiKey: '',
            baseUrl: '',
            defaultModel: def.models[0] || '',
            extraArgs: ''
          };

      const localHints = installed ? readLocalCliHints(def.id) : { models: [] };
      const initialModels =
        localHints.models.length > 0 ? localHints.models : def.models;

      return {
        ...def,
        models: initialModels,
        installed,
        executablePath: execPath,
        version,
        config
      };
    })
  );

  // Installed first, then alphabetical/registry order
  return results.sort((a, b) => Number(b.installed) - Number(a.installed));
}

export function defaultProtocolForCli(cliId: string): ApiProtocol {
  switch (cliId) {
    case 'claude':
    case 'pi':
      return 'anthropic';
    case 'codex':
      return 'openai_responses';
    case 'gemini':
    case 'antigravity':
      return 'gemini_native';
    default:
      return 'openai_chat';
  }
}

export function resolveProtocolEndpoints(
  protocol: ApiProtocol,
  rawBaseUrl: string,
  cliId: string
): { baseUrl: string; modelsUrl: string } {
  const defaultBaseMap: Record<string, string> = {
    claude: 'https://api.anthropic.com',
    codex: 'https://api.openai.com',
    gemini: 'https://generativelanguage.googleapis.com',
    antigravity: 'https://generativelanguage.googleapis.com',
    pi: 'https://api.anthropic.com',
    grok: 'https://api.x.ai',
    kimi: 'https://api.moonshot.cn',
    deepseek: 'https://api.deepseek.com'
  };
  const trimmed = (rawBaseUrl || defaultBaseMap[cliId] || 'https://api.openai.com')
    .trim()
    .replace(/\/+$/, '');

  if (protocol === 'custom_raw') {
    return {
      baseUrl: trimmed,
      modelsUrl: trimmed.endsWith('/models') ? trimmed : `${trimmed}/models`
    };
  }
  if (protocol === 'gemini_native') {
    const base = /\/v1(beta)?$/i.test(trimmed) ? trimmed : `${trimmed}/v1beta`;
    return {
      baseUrl: base,
      modelsUrl: `${base}/models`
    };
  }
  if (protocol === 'anthropic') {
    const root = trimmed.replace(/\/v1$/i, '');
    return {
      baseUrl: root,
      modelsUrl: `${root}/v1/models`
    };
  }
  // openai_chat or openai_responses
  const v1Base = /\/v\d+$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
  return {
    baseUrl: v1Base,
    modelsUrl: `${v1Base}/models`
  };
}

export interface ModelScanResult {
  models: string[];
  sources: string[];
  error?: string;
}

async function fetchJsonWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 8000
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'FMC-Desktop/0.1',
        ...headers
      },
      signal: controller.signal
    });
    if (!resp.ok) {
      let detail = '';
      try {
        const bodyText = (await resp.text()).trim();
        if (bodyText) detail = ` - ${bodyText.slice(0, 140)}`;
      } catch {
        // ignore
      }
      throw new Error(`HTTP ${resp.status}${detail}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readLocalCliHints(cliId: string): {
  models: string[];
  apiKey?: string;
  baseUrl?: string;
  source?: string;
} {
  const home = os.homedir();
  const models: string[] = [];
  const sources: string[] = [];
  let apiKey: string | undefined;
  let baseUrl: string | undefined;

  try {
    if (cliId === 'codex') {
      const cfgPath = path.join(home, '.codex', 'config.toml');
      if (fs.existsSync(cfgPath)) {
        const raw = fs.readFileSync(cfgPath, 'utf-8').replace(/^\uFEFF/, '');
        const mMatches = raw.matchAll(/^\s*model\s*=\s*"([^"]+)"/gm);
        for (const m of mMatches) models.push(m[1]);
        const bMatch = raw.match(/^\s*base_url\s*=\s*"([^"]+)"/m);
        if (bMatch) baseUrl = bMatch[1];
        sources.push('~/.codex/config.toml');
      }
      const auth = readJsonSafe<{ OPENAI_API_KEY?: string }>(path.join(home, '.codex', 'auth.json'));
      if (auth?.OPENAI_API_KEY) apiKey = auth.OPENAI_API_KEY;

      const cache = readJsonSafe<{
        models?: Array<{ slug?: string; id?: string; visibility?: string }>;
      }>(path.join(home, '.codex', 'models_cache.json'));
      if (cache?.models?.length) {
        for (const item of cache.models) {
          if (item.visibility === 'hide') continue;
          if (item.slug) models.push(item.slug);
          else if (item.id) models.push(item.id);
        }
        sources.push('~/.codex/models_cache.json');
      }

      const catalogsDir = path.join(home, '.codex', 'model-catalogs');
      if (fs.existsSync(catalogsDir)) {
        for (const f of fs.readdirSync(catalogsDir).filter((n) => n.endsWith('.json')).slice(0, 4)) {
          const cat = readJsonSafe<{ models?: Array<{ slug?: string; id?: string; visibility?: string }> }>(
            path.join(catalogsDir, f)
          );
          for (const item of cat?.models || []) {
            if (item.visibility === 'hide') continue;
            if (item.slug) models.push(item.slug);
            else if (item.id) models.push(item.id);
          }
        }
      }
    } else if (cliId === 'claude') {
      const parsed = readJsonSafe<{
        model?: string;
        env?: Record<string, string>;
      }>(path.join(home, '.claude', 'settings.json'));
      if (parsed) {
        if (parsed.model) models.push(parsed.model);
        if (parsed.env?.ANTHROPIC_MODEL) models.push(parsed.env.ANTHROPIC_MODEL);
        if (parsed.env?.ANTHROPIC_DEFAULT_SONNET_MODEL) models.push(parsed.env.ANTHROPIC_DEFAULT_SONNET_MODEL);
        if (parsed.env?.ANTHROPIC_DEFAULT_OPUS_MODEL) models.push(parsed.env.ANTHROPIC_DEFAULT_OPUS_MODEL);
        if (parsed.env?.ANTHROPIC_SMALL_FAST_MODEL) models.push(parsed.env.ANTHROPIC_SMALL_FAST_MODEL);
        if (parsed.env?.ANTHROPIC_BASE_URL) baseUrl = parsed.env.ANTHROPIC_BASE_URL;
        if (parsed.env?.ANTHROPIC_API_KEY) apiKey = parsed.env.ANTHROPIC_API_KEY;
        else if (parsed.env?.ANTHROPIC_AUTH_TOKEN) apiKey = parsed.env.ANTHROPIC_AUTH_TOKEN;
        sources.push('~/.claude/settings.json');
      }
    } else if (cliId === 'gemini') {
      const candidates = [
        path.join(home, '.gemini', 'settings.json'),
        path.join(home, '.gemini', 'config', 'settings.json')
      ];
      for (const p of candidates) {
        const parsed = readJsonSafe<{ model?: { name?: string } | string }>(p);
        if (parsed) {
          if (typeof parsed.model === 'string') models.push(parsed.model);
          else if (parsed.model?.name) models.push(parsed.model.name);
          sources.push(p.includes('config') ? '~/.gemini/config/settings.json' : '~/.gemini/settings.json');
        }
      }
    } else if (cliId === 'antigravity') {
      const parsed = readJsonSafe<{ model?: string | { name?: string } }>(
        path.join(home, '.gemini', 'antigravity-cli', 'settings.json')
      );
      if (parsed) {
        if (typeof parsed.model === 'string') models.push(parsed.model);
        else if (parsed.model?.name) models.push(parsed.model.name);
        sources.push('~/.gemini/antigravity-cli/settings.json');
      }
    } else if (cliId === 'pi') {
      const parsed = readJsonSafe<Record<string, unknown>>(path.join(home, '.pi', 'agent', 'models.json'));
      if (parsed) {
        const text = JSON.stringify(parsed);
        const ids = text.matchAll(/"id"\s*:\s*"([^"]+)"/g);
        for (const m of ids) models.push(m[1]);
        sources.push('~/.pi/agent/models.json');
      }
    }
  } catch {
    // ignore malformed user configs
  }

  return {
    models: Array.from(new Set(models.filter(Boolean))),
    apiKey,
    baseUrl,
    source: sources.join(' + ') || undefined
  };
}

export async function scanCliModels(
  cliId: string,
  draft?: Partial<CliUserConfig>
): Promise<ModelScanResult> {
  const def = CLI_REGISTRY.find((c) => c.id === cliId);
  const mode = draft?.authMode || 'oauth';

  // === Mode A: Strictly scan remote API /models using user-supplied API Key & Base URL ===
  if (mode === 'api_key') {
    const apiKey = (draft?.apiKey || '').trim();
    const baseUrl = (draft?.baseUrl || '').trim();
    if (!apiKey) {
      return {
        models: [],
        sources: [],
        error: '请先填写 API Key，再点击从 API 拉取模型'
      };
    }

    try {
      const protocol: ApiProtocol = draft?.apiProtocol || defaultProtocolForCli(cliId);
      const { modelsUrl } = resolveProtocolEndpoints(protocol, baseUrl, cliId);

      if (protocol === 'gemini_native') {
        const urlWithKey = `${modelsUrl}${modelsUrl.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;
        const data = (await fetchJsonWithTimeout(urlWithKey, {})) as {
          models?: Array<{ name?: string }>;
        };
        const names = (data.models || [])
          .map((m) => (m.name || '').replace(/^models\//, ''))
          .filter(Boolean);
        if (names.length === 0) {
          return { models: [], sources: [], error: `接口 ${modelsUrl} 返回模型列表为空` };
        }
        return {
          models: Array.from(new Set(names)).slice(0, 100),
          sources: [`Gemini 原生协议 (${modelsUrl})`]
        };
      }

      const headers: Record<string, string> =
        protocol === 'anthropic'
          ? {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01'
            }
          : {
              Authorization: `Bearer ${apiKey}`
            };

      const data = (await fetchJsonWithTimeout(modelsUrl, headers, 8000)) as {
        data?: Array<{ id?: string }>;
        models?: Array<{ id?: string; name?: string }>;
      };
      const ids = [
        ...(data.data || []).map((m) => m.id || ''),
        ...(data.models || []).map((m) => (m.id || m.name || '').replace(/^models\//, ''))
      ].filter(Boolean);

      if (ids.length === 0) {
        return {
          models: [],
          sources: [],
          error: `接口 ${modelsUrl} 返回成功但模型列表为空`
        };
      }
      return {
        models: Array.from(new Set(ids)).slice(0, 100),
        sources: [`${protocol} (${modelsUrl})`]
      };
    } catch (err) {
      return {
        models: [],
        sources: [],
        error: `API 拉取失败：${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  // === Mode B: Strictly scan LOCAL CLI config / cache / local Ollama ===
  const discovered = new Set<string>();
  const sources: string[] = [];

  const localHints = readLocalCliHints(cliId);
  if (localHints.models.length > 0) {
    localHints.models.forEach((m) => discovered.add(m));
    if (localHints.source) sources.push(`本机配置 (${localHints.source})`);
  }

  // Live query `agy models` for Antigravity CLI
  if (cliId === 'antigravity') {
    const agyPath = await locateCommand('agy');
    if (agyPath) {
      try {
        const { stdout } = await execFileAsync(agyPath, ['models'], {
          timeout: 20000,
          windowsHide: true
        });
        const lines = stdout.split(/\r?\n/);
        let foundCount = 0;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || /^fetching\b/i.test(trimmed)) continue;
          const rawId = trimmed.split(/\t|\s{2,}/)[0]?.trim();
          if (rawId && /^[a-z0-9._-]+$/i.test(rawId)) {
            // Strip trailing effort tier suffix (-low/-medium/-high/-xhigh/-max) since FMC has a dedicated Reasoning Effort slider
            const baseId = rawId.replace(/-(xhigh|high|medium|low|max)$/i, '');
            discovered.add(baseId || rawId);
            foundCount++;
          }
        }
        if (foundCount > 0) {
          sources.push('agy models (实时检测)');
        }
      } catch (err) {
        if (discovered.size === 0) {
          return {
            models: [],
            sources: [],
            error: `调用 agy models 失败（请确认已在终端运行 agy 登录账号）：${err instanceof Error ? err.message : String(err)}`
          };
        }
      }
    } else if (discovered.size === 0) {
      return {
        models: [],
        sources: [],
        error: '未检测到本地 agy 可执行文件，请先点击「一键安装」'
      };
    }
  }

  // Also check if local CLI config itself points to a local/configured relay (e.g. CC Switch wrote settings.json)
  if (localHints.apiKey && localHints.baseUrl) {
    try {
      const rawBase = localHints.baseUrl.replace(/\/+$/, '');
      const endpoint = rawBase.endsWith('/models')
        ? rawBase
        : rawBase.endsWith('/v1')
          ? `${rawBase}/models`
          : `${rawBase}/v1/models`;
      const data = (await fetchJsonWithTimeout(
        endpoint,
        {
          Authorization: `Bearer ${localHints.apiKey}`,
          'x-api-key': localHints.apiKey,
          'anthropic-version': '2023-06-01'
        },
        4000
      )) as { data?: Array<{ id?: string }> };
      const ids = (data.data || []).map((m) => m.id || '').filter(Boolean);
      if (ids.length > 0) {
        ids.forEach((id) => discovered.add(id));
        sources.push('本机配置关联接口');
      }
    } catch {
      // ignore if local config relay doesn't expose /models
    }
  }

  // Check local Ollama if running
  try {
    const ollama = (await fetchJsonWithTimeout('http://127.0.0.1:11434/api/tags', {}, 600)) as {
      models?: Array<{ name?: string }>;
    };
    const localModels = (ollama.models || []).map((m) => m.name || '').filter(Boolean);
    if (localModels.length > 0) {
      localModels.forEach((m) => discovered.add(m));
      sources.push('本地 Ollama');
    }
  } catch {
    // ignore
  }

  if (discovered.size === 0) {
    if (cliId === 'antigravity') {
      return {
        models: [],
        sources: [],
        error: '未检测到 Antigravity 可用模型，请先在终端运行 agy 完成登录后再点扫描'
      };
    }
    return {
      models: def?.models || [],
      sources: ['未检测到本机模型缓存，暂显示参考列表']
    };
  }

  return {
    models: Array.from(discovered).slice(0, 80),
    sources
  };
}
