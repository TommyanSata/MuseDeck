import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BrowserWindow, shell, WebContents } from 'electron';

export const MUSE_CHROME_EXTENSION_ID = 'jnakhhjmpmoohbjgfccbccfoifnmbdjd';
export const MUSE_CHROME_STORE_URL =
  'https://chromewebstore.google.com/detail/muse-from-meta/jnakhhjmpmoohbjgfccbccfoifnmbdjd';

export const FEISHU_REQUIRED_SCOPES_JSON = JSON.stringify(
  {
    scopes: {
      tenant: [
        'im:message',
        'im:message:send_as_bot',
        'im:message.p2p_msg:readonly',
        'im:message.group_at_msg:readonly',
        'im:message.reactions:write_only',
        'im:chat:readonly',
        'im:resource'
      ],
      user: []
    }
  },
  null,
  2
);

export interface MuseExtensionStatus {
  installed: boolean;
  extensionId: string;
  storeUrl: string;
  browser?: 'chrome' | 'edge';
  profileDir?: string;
  version?: string;
  executablePath?: string;
}

export interface BrowserElementSnapshot {
  id: string;
  tag: string;
  type?: string;
  label: string;
  value?: string;
  href?: string;
}

export interface LocalBrowserSnapshot {
  url: string;
  title: string;
  textExcerpt: string;
  elements: BrowserElementSnapshot[];
}

export interface FeishuAutoPilotResult {
  ok: boolean;
  needLogin?: boolean;
  appId?: string;
  appSecret?: string;
  completedSteps: string[];
  nextManualHint?: string;
  message: string;
}

function resolveBrowserExecutable(kind: 'chrome' | 'edge'): string | undefined {
  if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA || '';
    const prog = process.env.PROGRAMFILES || 'C:\\Program Files';
    const prog86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const candidates =
      kind === 'chrome'
        ? [
            path.join(prog, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(prog86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(localApp, 'Google', 'Chrome', 'Application', 'chrome.exe')
          ]
        : [
            path.join(prog, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(prog86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(localApp, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
          ];
    return candidates.find((p) => p && fs.existsSync(p));
  }
  if (process.platform === 'darwin') {
    const macPath =
      kind === 'chrome'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
    return fs.existsSync(macPath) ? macPath : undefined;
  }
  return undefined;
}

export function detectMuseChromeExtension(): MuseExtensionStatus {
  const home = os.homedir();
  const localApp = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

  const userDataRoots: Array<{ browser: 'chrome' | 'edge'; dir: string }> =
    process.platform === 'win32'
      ? [
          { browser: 'chrome', dir: path.join(localApp, 'Google', 'Chrome', 'User Data') },
          { browser: 'edge', dir: path.join(localApp, 'Microsoft', 'Edge', 'User Data') }
        ]
      : process.platform === 'darwin'
        ? [
            {
              browser: 'chrome',
              dir: path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')
            },
            {
              browser: 'edge',
              dir: path.join(home, 'Library', 'Application Support', 'Microsoft Edge')
            }
          ]
        : [
            { browser: 'chrome', dir: path.join(home, '.config', 'google-chrome') },
            { browser: 'edge', dir: path.join(home, '.config', 'microsoft-edge') }
          ];

  for (const root of userDataRoots) {
    if (!fs.existsSync(root.dir)) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const profileDirs = entries
      .filter((e) => e.isDirectory() && (e.name === 'Default' || /^Profile \d+$/i.test(e.name)))
      .map((e) => e.name);

    for (const prof of profileDirs) {
      const extDir = path.join(root.dir, prof, 'Extensions', MUSE_CHROME_EXTENSION_ID);
      if (!fs.existsSync(extDir)) continue;
      try {
        const verDirs = fs
          .readdirSync(extDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort()
          .reverse();
        for (const ver of verDirs) {
          const manifestPath = path.join(extDir, ver, 'manifest.json');
          if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
              version?: string;
            };
            return {
              installed: true,
              extensionId: MUSE_CHROME_EXTENSION_ID,
              storeUrl: MUSE_CHROME_STORE_URL,
              browser: root.browser,
              profileDir: prof,
              version: manifest.version || ver,
              executablePath: resolveBrowserExecutable(root.browser)
            };
          }
        }
      } catch {
        // ignore broken profile folder
      }
    }
  }

  return {
    installed: false,
    extensionId: MUSE_CHROME_EXTENSION_ID,
    storeUrl: MUSE_CHROME_STORE_URL,
    executablePath: resolveBrowserExecutable('chrome') || resolveBrowserExecutable('edge')
  };
}

export async function launchMuseExtensionHost(openStore = false): Promise<{
  ok: boolean;
  message: string;
  status: MuseExtensionStatus;
}> {
  const status = detectMuseChromeExtension();
  const targetUrl = openStore || !status.installed ? MUSE_CHROME_STORE_URL : 'https://muse.ai';

  if (status.executablePath) {
    const args: string[] = [];
    if (status.installed && status.profileDir) {
      args.push(`--profile-directory=${status.profileDir}`);
    }
    args.push(targetUrl);
    try {
      const child = spawn(status.executablePath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      child.unref();
      return {
        ok: true,
        status,
        message: status.installed
          ? `已唤醒本机 ${status.browser === 'edge' ? 'Edge' : 'Chrome'}（配置：${status.profileDir}，官方 Muse 插件 v${status.version}），保持该浏览器开启即可让 Muse 直接使用本机 IP 操作网页！`
          : '已打开本机浏览器前往 Chrome 应用商店，点击「添加至 Chrome」安装官方 Muse from Meta 插件即可！'
      };
    } catch {
      // fallback to shell.openExternal
    }
  }

  await shell.openExternal(targetUrl);
  return {
    ok: true,
    status,
    message: status.installed
      ? '已唤起默认浏览器打开 muse.ai 连接本地插件'
      : '已在浏览器打开官方 Muse from Meta 插件商店页'
  };
}

export function isSafePublicBrowserUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '[::1]' ||
      host.endsWith('.local') ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export class LocalBrowserController {
  private localWin: BrowserWindow | null = null;
  private tailscaleWin: BrowserWindow | null = null;
  private tailscaleTimer: NodeJS.Timeout | null = null;

  private ensureLocalWindow(show = false): BrowserWindow {
    if (this.localWin && !this.localWin.isDestroyed()) {
      if (show) {
        this.localWin.show();
        this.localWin.focus();
      }
      return this.localWin;
    }
    const win = new BrowserWindow({
      width: 1120,
      height: 760,
      show,
      title: 'MuseDeck 本地受控浏览器（走本机 IP 与持久化登录态）',
      autoHideMenuBar: true,
      webPreferences: {
        partition: 'persist:localbrowser',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    win.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    win.on('close', (e) => {
      // Hide instead of destroy so Muse session state stays warm unless app quits
      if ((win as unknown as { __forceClose?: boolean }).__forceClose) return;
      e.preventDefault();
      win.hide();
    });
    this.localWin = win;
    return win;
  }

  showWindow(url?: string): { ok: boolean; url: string } {
    const win = this.ensureLocalWindow(true);
    if (url && isSafePublicBrowserUrl(url)) {
      void win.loadURL(url.trim());
    } else if (!win.webContents.getURL() || win.webContents.getURL() === 'about:blank') {
      void win.loadURL('https://www.google.com');
    }
    return { ok: true, url: win.webContents.getURL() };
  }

  getStatus(): {
    ready: boolean;
    visible: boolean;
    currentUrl: string;
    title: string;
    chromeExtension: MuseExtensionStatus;
  } {
    const ext = detectMuseChromeExtension();
    const alive = Boolean(this.localWin && !this.localWin.isDestroyed());
    return {
      ready: true,
      visible: alive ? Boolean(this.localWin?.isVisible()) : false,
      currentUrl: alive ? this.localWin!.webContents.getURL() : '',
      title: alive ? this.localWin!.webContents.getTitle() : '',
      chromeExtension: ext
    };
  }

  async openUrl(rawUrl: string, waitMs = 1800): Promise<LocalBrowserSnapshot> {
    const normalized = /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;
    if (!isSafePublicBrowserUrl(normalized)) {
      throw new Error('Blocked unsafe or private network URL');
    }
    const win = this.ensureLocalWindow(false);
    try {
      await Promise.race([
        win.webContents.loadURL(normalized),
        new Promise((r) => setTimeout(r, 12000))
      ]);
    } catch {
      // partial load still inspectable
    }
    await new Promise((r) => setTimeout(r, Math.min(6000, Math.max(400, waitMs))));
    return this.snapshot();
  }

  async snapshot(): Promise<LocalBrowserSnapshot> {
    const win = this.ensureLocalWindow(false);
    const wc = win.webContents;
    const js = `
      (() => {
        const textExcerpt = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 4000);
        const nodes = Array.from(
          document.querySelectorAll('a[href], button, [role="button"], input, textarea, select')
        );
        const elements = [];
        let seq = 1;
        for (const el of nodes) {
          if (elements.length >= 60) break;
          const rect = el.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const bid = 'b' + (seq++);
          el.setAttribute('data-fmc-bid', bid);
          const tag = el.tagName.toLowerCase();
          const label = (
            el.innerText ||
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            el.getAttribute('title') ||
            el.getAttribute('name') ||
            ''
          ).replace(/\\s+/g, ' ').trim().slice(0, 80);
          elements.push({
            id: bid,
            tag,
            type: el.getAttribute('type') || undefined,
            label,
            value: ('value' in el && typeof el.value === 'string') ? el.value.slice(0, 80) : undefined,
            href: ('href' in el && typeof el.href === 'string') ? el.href.slice(0, 160) : undefined
          });
        }
        return {
          url: location.href,
          title: document.title || '',
          textExcerpt,
          elements
        };
      })()
    `;
    return (await wc.executeJavaScript(js, true)) as LocalBrowserSnapshot;
  }

  async act(req: {
    action: 'click' | 'fill' | 'press' | 'scroll';
    targetId?: string;
    text?: string;
    key?: string;
    direction?: 'down' | 'up' | 'top' | 'bottom';
  }): Promise<{ ok: boolean; detail: string; snapshot: LocalBrowserSnapshot }> {
    const win = this.ensureLocalWindow(false);
    const wc = win.webContents;
    const js = `
      (async () => {
        const req = ${JSON.stringify(req)};
        if (req.action === 'scroll') {
          if (req.direction === 'top') window.scrollTo(0, 0);
          else if (req.direction === 'bottom') window.scrollTo(0, document.body.scrollHeight);
          else if (req.direction === 'up') window.scrollBy(0, -520);
          else window.scrollBy(0, 520);
          return { ok: true, detail: 'scrolled ' + (req.direction || 'down') };
        }
        if (req.action === 'press') {
          const k = req.key || 'Enter';
          const active = document.activeElement || document.body;
          active.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true }));
          active.dispatchEvent(new KeyboardEvent('keyup', { key: k, code: k, bubbles: true }));
          return { ok: true, detail: 'pressed ' + k };
        }
        let target = req.targetId
          ? document.querySelector('[data-fmc-bid=' + JSON.stringify(req.targetId) + ']')
          : null;
        if (!target && req.targetId) {
          const kw = String(req.targetId).toLowerCase();
          target = Array.from(document.querySelectorAll('button, a, [role="button"], input, textarea'))
            .find((el) => ((el.innerText || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').toLowerCase()).includes(kw)) || null;
        }
        if (!target || !(target instanceof HTMLElement)) {
          return { ok: false, detail: 'Target element not found: ' + (req.targetId || '') };
        }
        target.scrollIntoView({ block: 'center' });
        if (req.action === 'click') {
          target.click();
          return { ok: true, detail: 'clicked ' + (req.targetId || '') };
        }
        if (req.action === 'fill') {
          const val = String(req.text || '');
          target.focus();
          if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
            const proto = target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(target, val);
            else target.value = val;
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            target.textContent = val;
            target.dispatchEvent(new InputEvent('input', { bubbles: true, data: val }));
          }
          return { ok: true, detail: 'filled ' + (req.targetId || '') };
        }
        return { ok: false, detail: 'Unsupported action' };
      })()
    `;
    const res = (await wc.executeJavaScript(js, true)) as { ok: boolean; detail: string };
    await new Promise((r) => setTimeout(r, 750));
    const snap = await this.snapshot();
    return { ok: Boolean(res?.ok), detail: res?.detail || '', snapshot: snap };
  }

  /**
   * Opens Tailscale auth / funnel URL inside a local-IP helper window and automatically clicks
   * "Connect" / "Enable Funnel" once the user signs in (closing itself automatically when tunnel is ready).
   */
  openTailscaleAutoAuthWindow(authUrl: string, onLog?: (msg: string) => void): void {
    if (!authUrl || !/^https:\/\/login\.tailscale\.com\//i.test(authUrl)) {
      void shell.openExternal(authUrl);
      return;
    }

    if (!this.tailscaleWin || this.tailscaleWin.isDestroyed()) {
      this.tailscaleWin = new BrowserWindow({
        width: 880,
        height: 700,
        title: 'MuseDeck · Tailscale 自动授权助手（登录账号后将自动点击 Connect / Enable Funnel）',
        autoHideMenuBar: true,
        webPreferences: {
          partition: 'persist:tailscale',
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });
      this.tailscaleWin.on('closed', () => {
        this.tailscaleWin = null;
        if (this.tailscaleTimer) {
          clearInterval(this.tailscaleTimer);
          this.tailscaleTimer = null;
        }
      });
    }

    this.tailscaleWin.show();
    this.tailscaleWin.focus();
    void this.tailscaleWin.loadURL(authUrl);

    if (this.tailscaleTimer) clearInterval(this.tailscaleTimer);
    this.tailscaleTimer = setInterval(async () => {
      if (!this.tailscaleWin || this.tailscaleWin.isDestroyed()) {
        if (this.tailscaleTimer) clearInterval(this.tailscaleTimer);
        this.tailscaleTimer = null;
        return;
      }
      const wc = this.tailscaleWin.webContents;
      if (wc.isLoading()) return;
      const curUrl = wc.getURL();
      // Only auto-click on Tailscale's own device-connect or funnel-enable pages (never on Google/GitHub login!)
      if (!curUrl.includes('login.tailscale.com')) return;

      try {
        const clicked = (await wc.executeJavaScript(
          `(() => {
            const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'));
            for (const btn of buttons) {
              if (!(btn instanceof HTMLElement) || btn.hasAttribute('disabled')) continue;
              if (btn.getAttribute('data-fmc-ts-clicked') === '1') continue;
              const txt = (btn.innerText || btn.getAttribute('value') || '').trim();
              if (/^(Connect|Enable Funnel|Enable HTTPS|Approve|Authorize|连接|开启 Funnel)$/i.test(txt)) {
                btn.setAttribute('data-fmc-ts-clicked', '1');
                btn.click();
                return txt;
              }
            }
            return '';
          })()`,
          true
        )) as string;
        if (clicked) {
          onLog?.(`已自动为你点击 Tailscale 页面按钮：「${clicked}」`);
        }
      } catch {
        // ignore transient navigation error
      }
    }, 950);
  }

  closeTailscaleWindowSoon(): void {
    if (this.tailscaleTimer) {
      clearInterval(this.tailscaleTimer);
      this.tailscaleTimer = null;
    }
    if (this.tailscaleWin && !this.tailscaleWin.isDestroyed()) {
      const win = this.tailscaleWin;
      setTimeout(() => {
        if (!win.isDestroyed()) win.close();
      }, 1200);
    }
  }

  destroyAll(): void {
    if (this.tailscaleTimer) {
      clearInterval(this.tailscaleTimer);
      this.tailscaleTimer = null;
    }
    if (this.tailscaleWin && !this.tailscaleWin.isDestroyed()) {
      this.tailscaleWin.destroy();
      this.tailscaleWin = null;
    }
    if (this.localWin && !this.localWin.isDestroyed()) {
      (this.localWin as unknown as { __forceClose?: boolean }).__forceClose = true;
      this.localWin.destroy();
      this.localWin = null;
    }
  }
}

async function waitPageSettled(wc: WebContents, extraMs = 900): Promise<void> {
  const deadline = Date.now() + 8000;
  while (wc.isLoading() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 180));
  }
  await new Promise((r) => setTimeout(r, extraMs));
}

/**
 * Local-IP One-Click Feishu Bot Auto-Configurator driving the embedded `open.feishu.cn` view.
 * Requires the user to have scanned the Feishu QR code once on local IP; automates app creation,
 * credential extraction + immediate WebSocket connection, Bot capability, 7-scope batch JSON import,
 * WebSocket event subscription (`im.message.receive_v1`), and version `1.0.0` draft creation.
 */
export async function runFeishuLocalAutoPilot(params: {
  wc: WebContents;
  botName?: string;
  botDesc?: string;
  existingAppId?: string;
  onProgress: (msg: string) => void;
  onCredentialsReady: (appId: string, appSecret: string) => Promise<boolean>;
}): Promise<FeishuAutoPilotResult> {
  const { wc, onProgress, onCredentialsReady } = params;
  const botName = (params.botName || 'MuseDeck').trim() || 'MuseDeck';
  const botDesc = (params.botDesc || 'MuseDeck 本地多 AI 编程工具调度总控助手').trim();
  const completedSteps: string[] = [];

  try {
    const curUrl = wc.getURL();
    if (!curUrl.includes('open.feishu.cn')) {
      onProgress('正在打开飞书开放平台后台...');
      await wc.loadURL('https://open.feishu.cn/app');
      await waitPageSettled(wc, 1400);
    }

    // 0. Check if user is logged into open.feishu.cn
    const loginCheck = (await wc.executeJavaScript(
      `(() => {
        const href = location.href;
        const txt = (document.body?.innerText || '');
        const onPassport = href.includes('accounts.feishu.cn') || href.includes('passport.feishu.cn');
        const hasConsole = txt.includes('企业自建应用') || txt.includes('凭证与基础信息') || /\\/app\\/cli_[a-zA-Z0-9]+/.test(href);
        return { href, onPassport, hasConsole };
      })()`,
      true
    )) as { href: string; onPassport: boolean; hasConsole: boolean };

    if (loginCheck.onPassport || !loginCheck.hasConsole) {
      return {
        ok: false,
        needLogin: true,
        completedSteps,
        message:
          '请先在左侧飞书开放平台网页用手机飞书扫码登录（走本机 IP 安全无风控）。扫码进入开发者后台后，再点一次「⚡ 一键自动代配」即可自动完成后续配置！'
      };
    }

    // 1. Reuse open cli_xxxx app page or create a new enterprise custom app
    let appId = '';
    const urlMatch = wc.getURL().match(/\/app\/(cli_[a-zA-Z0-9]+)/);
    if (urlMatch) {
      appId = urlMatch[1];
      completedSteps.push(`已识别当前打开的应用 (${appId})`);
    } else if (params.existingAppId && /^cli_[a-zA-Z0-9]+$/.test(params.existingAppId.trim())) {
      appId = params.existingAppId.trim();
      await wc.loadURL(`https://open.feishu.cn/app/${appId}/baseinfo`);
      await waitPageSettled(wc, 1300);
      completedSteps.push(`已定位到应用 (${appId})`);
    } else {
      onProgress(`第 1/6 步：正在自动创建企业自建应用「${botName}」...`);
      await wc.executeJavaScript(
        `(async () => {
          const setVal = (el, val) => {
            if (!el) return false;
            el.focus();
            const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, val);
            else el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          };
          const createBtn = Array.from(document.querySelectorAll('button, [role="button"], span'))
            .find((el) => /创建企业自建应用/.test((el.innerText || '').trim()));
          if (createBtn && createBtn instanceof HTMLElement) {
            (createBtn.closest('button') || createBtn).click();
            await new Promise((r) => setTimeout(r, 700));
          }
          const dialog = document.querySelector('[role="dialog"], .ud__modal, .arco-modal, .semi-modal') || document;
          const inputs = Array.from(dialog.querySelectorAll('input[type="text"], input:not([type]), textarea'));
          if (inputs[0]) setVal(inputs[0], ${JSON.stringify(botName)});
          if (inputs[1]) setVal(inputs[1], ${JSON.stringify(botDesc)});
          await new Promise((r) => setTimeout(r, 350));
          const submitBtn = Array.from(dialog.querySelectorAll('button'))
            .find((b) => /^(创建|确定|确认)$/.test((b.innerText || '').trim()) && !b.disabled);
          if (submitBtn) submitBtn.click();
        })()`,
        true
      );

      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const m = wc.getURL().match(/\/app\/(cli_[a-zA-Z0-9]+)/);
        if (m) {
          appId = m[1];
          break;
        }
      }
      if (!appId) {
        return {
          ok: false,
          completedSteps,
          message:
            '已在左侧打开创建应用弹窗并填入名称，请点一下弹窗右下角的「创建」进入应用详情页后，再点一次「⚡ 一键自动代配」继续！'
        };
      }
      completedSteps.push(`已自动创建企业自建应用「${botName}」(${appId})`);
    }

    // 2. Navigate to Credentials (/baseinfo), unmask & extract App ID + App Secret, and connect WS!
    onProgress('第 2/6 步：正在读取 App ID 与 App Secret 并建立本地长连接...');
    await wc.loadURL(`https://open.feishu.cn/app/${appId}/baseinfo`);
    await waitPageSettled(wc, 1400);

    const extractedSecret = (await wc.executeJavaScript(
      `(async () => {
        // Click eye/show icon near App Secret if masked with asterisks
        const allEls = Array.from(document.querySelectorAll('div, span, td, label'));
        const secretLabel = allEls.find((el) => (el.innerText || '').trim() === 'App Secret');
        const row = secretLabel?.closest('tr, [class*="row"], [class*="item"], [class*="field"]') || document.body;
        const icons = Array.from(row.querySelectorAll('button, [role="button"], svg, span[class*="icon"]'));
        for (const ic of icons.slice(0, 6)) {
          const btn = ic.closest('button, [role="button"]') || ic;
          if (btn instanceof HTMLElement && !/重置|Reset/i.test(btn.innerText || '')) {
            btn.click();
            await new Promise((r) => setTimeout(r, 350));
          }
        }
        const rowText = (row.innerText || '') + ' ' + (document.body?.innerText || '');
        const candidates = rowText.match(/\\b[a-zA-Z0-9]{28,40}\\b/g) || [];
        const secret = candidates.find((s) => !s.startsWith('cli_') && /[a-zA-Z]/.test(s) && /\\d/.test(s));
        return secret || '';
      })()`,
      true
    )) as string;

    if (extractedSecret) {
      const wsOk = await onCredentialsReady(appId, extractedSecret);
      completedSteps.push(
        wsOk
          ? '已自动提取凭证并成功连上飞书 WebSocket 长连接'
          : '已自动提取并填入 App ID 与 App Secret'
      );
    }

    // 3. Add Bot capability (/bot)
    onProgress('第 3/6 步：正在自动启用「机器人」应用能力...');
    await wc.loadURL(`https://open.feishu.cn/app/${appId}/bot`);
    await waitPageSettled(wc, 1300);
    await wc.executeJavaScript(
      `(async () => {
        const addBotBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
          .find((b) => /(添加机器人|启用机器人|^\\+?\\s*添加$)/.test((b.innerText || '').trim()));
        if (addBotBtn && addBotBtn instanceof HTMLElement) {
          addBotBtn.click();
          await new Promise((r) => setTimeout(r, 600));
        }
      })()`,
      true
    );
    completedSteps.push('已检查/开启「机器人」能力');

    // 4. Batch import 7 scopes (/auth)
    onProgress('第 4/6 步：正在批量导入 7 项消息与文件权限...');
    await wc.loadURL(`https://open.feishu.cn/app/${appId}/auth`);
    await waitPageSettled(wc, 1500);
    const scopeImported = (await wc.executeJavaScript(
      `(async () => {
        const batchBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
          .find((b) => /批量导入/.test((b.innerText || '').trim()));
        if (!batchBtn || !(batchBtn instanceof HTMLElement)) return false;
        batchBtn.click();
        await new Promise((r) => setTimeout(r, 700));

        const importTab = Array.from(document.querySelectorAll('[role="tab"], div, span'))
          .find((el) => (el.innerText || '').trim() === '导入权限');
        if (importTab && importTab instanceof HTMLElement) {
          importTab.click();
          await new Promise((r) => setTimeout(r, 350));
        }

        const jsonStr = ${JSON.stringify(FEISHU_REQUIRED_SCOPES_JSON)};
        // Support Monaco editor, CodeMirror, or textarea inside modal
        let filled = false;
        const monacoModels = window.monaco?.editor?.getModels?.();
        if (monacoModels && monacoModels.length > 0) {
          monacoModels[monacoModels.length - 1].setValue(jsonStr);
          filled = true;
        }
        if (!filled) {
          const ta = document.querySelector('[role="dialog"] textarea, .ud__modal textarea, textarea');
          if (ta && ta instanceof HTMLTextAreaElement) {
            ta.focus();
            ta.select();
            document.execCommand('insertText', false, jsonStr);
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
            if (setter) setter.call(ta, jsonStr);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            filled = true;
          }
        }
        await new Promise((r) => setTimeout(r, 500));
        const nextBtn = Array.from(document.querySelectorAll('button'))
          .find((b) => /下一步|确认新增权限/.test((b.innerText || '').trim()) && !b.disabled);
        if (nextBtn) {
          nextBtn.click();
          await new Promise((r) => setTimeout(r, 650));
          const applyBtn = Array.from(document.querySelectorAll('button'))
            .find((b) => /申请开通|确认开通|确定/.test((b.innerText || '').trim()) && !b.disabled);
          if (applyBtn) {
            applyBtn.click();
            await new Promise((r) => setTimeout(r, 650));
            return true;
          }
        }
        return filled;
      })()`,
      true
    )) as boolean;
    if (scopeImported) {
      completedSteps.push('已自动批量导入并开通 7 项飞书权限');
    }

    // 5. Configure WebSocket Long Connection + subscribe im.message.receive_v1 (/event)
    onProgress('第 5/6 步：正在配置「长连接接收事件」并订阅接收消息事件...');
    await wc.loadURL(`https://open.feishu.cn/app/${appId}/event`);
    await waitPageSettled(wc, 1500);
    await wc.executeJavaScript(
      `(async () => {
        // Click edit icon/button for event subscription mode if needed
        const editBtns = Array.from(document.querySelectorAll('button, [role="button"], span'))
          .filter((b) => /^(编辑|修改订阅方式)$/.test((b.innerText || '').trim()));
        if (editBtns[0] && editBtns[0] instanceof HTMLElement) {
          editBtns[0].click();
          await new Promise((r) => setTimeout(r, 400));
        }
        const wsRadio = Array.from(document.querySelectorAll('label, span, div'))
          .find((el) => /使用长连接接收事件/.test((el.innerText || '').trim()));
        if (wsRadio && wsRadio instanceof HTMLElement) {
          wsRadio.click();
          await new Promise((r) => setTimeout(r, 350));
        }
        const saveBtn = Array.from(document.querySelectorAll('button'))
          .find((b) => /^(保存)$/.test((b.innerText || '').trim()) && !b.disabled);
        if (saveBtn) {
          saveBtn.click();
          await new Promise((r) => setTimeout(r, 800));
        }

        // Click Add Event -> search im.message.receive_v1
        const addEvBtn = Array.from(document.querySelectorAll('button'))
          .find((b) => /添加事件/.test((b.innerText || '').trim()));
        if (addEvBtn) {
          addEvBtn.click();
          await new Promise((r) => setTimeout(r, 650));
          const searchInput = document.querySelector('[role="dialog"] input, input[placeholder*="搜索"], input[placeholder*="事件"]');
          if (searchInput && searchInput instanceof HTMLInputElement) {
            searchInput.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(searchInput, 'im.message.receive_v1');
            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise((r) => setTimeout(r, 700));
          }
          const cb = document.querySelector('[role="dialog"] input[type="checkbox"], [role="dialog"] .ud__checkbox, [role="dialog"] .arco-checkbox');
          if (cb && cb instanceof HTMLElement) {
            cb.click();
            await new Promise((r) => setTimeout(r, 350));
          }
          const confirmAdd = Array.from(document.querySelectorAll('[role="dialog"] button, button'))
            .find((b) => /确认添加|确定/.test((b.innerText || '').trim()) && !b.disabled);
          if (confirmAdd) {
            confirmAdd.click();
            await new Promise((r) => setTimeout(r, 650));
          }
        }
      })()`,
      true
    );
    completedSteps.push('已尝试保存长连接订阅并添加 im.message.receive_v1');

    // 6. Navigate to Version Management & Create Version 1.0.0 (/version)
    onProgress('第 6/6 步：正在打开版本发布页并预填 1.0.0 版本信息...');
    await wc.loadURL(`https://open.feishu.cn/app/${appId}/version`);
    await waitPageSettled(wc, 1400);
    await wc.executeJavaScript(
      `(async () => {
        const createVerBtn = Array.from(document.querySelectorAll('button, a'))
          .find((b) => /创建版本/.test((b.innerText || '').trim()));
        if (createVerBtn && createVerBtn instanceof HTMLElement) {
          createVerBtn.click();
          await new Promise((r) => setTimeout(r, 900));
        }
        const setVal = (el, val) => {
          if (!el) return;
          el.focus();
          const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, val);
          else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const verInput = document.querySelector('input[placeholder*="1.0.0"], input[placeholder*="版本"]');
        if (verInput) setVal(verInput, '1.0.0');
        const noteInput = document.querySelector('textarea');
        if (noteInput) setVal(noteInput, 'MuseDeck 自动初始化版本发布');
      })()`,
      true
    );
    completedSteps.push('已打开「创建版本」并预填 1.0.0 版本说明');

    return {
      ok: true,
      appId,
      appSecret: extractedSecret || undefined,
      completedSteps,
      nextManualHint:
        '请在左侧已打开的版本页面底部点「保存」→ 右上角「申请线上发布」，然后点右侧「唤起机器人对话」发一句「你好」即可！',
      message: extractedSecret
        ? `⚡ 自动代配已完成 ${completedSteps.length} 步！凭证已自动填入并连上长连接，最后只需在左侧点击「保存 → 申请线上发布」即可使用！`
        : `⚡ 已自动引导至应用 (${appId}) 版本发布页；若上方 App Secret 尚未填入，可在左侧「凭证与基础信息」复制粘贴后点击连接。`
    };
  } catch (err) {
    return {
      ok: false,
      completedSteps,
      message: `自动代配中断：${err instanceof Error ? err.message : String(err)}（你仍可继续手动完成剩余步骤）`
    };
  }
}
