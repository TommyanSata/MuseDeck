import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BrowserWindow, clipboard, shell, WebContents } from 'electron';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitPageSettled(wc: WebContents, extraMs = 1100): Promise<void> {
  const deadline = Date.now() + 10000;
  while (wc.isLoading() && Date.now() < deadline) {
    await sleep(200);
  }
  await sleep(extraMs);
}

async function setFeishuHud(
  wc: WebContents,
  text: string,
  tone: 'running' | 'ok' | 'warn' = 'running'
): Promise<void> {
  try {
    await wc.executeJavaScript(
      `(() => {
        let el = document.getElementById('fmc-autopilot-hud');
        if (!el) {
          el = document.createElement('div');
          el.id = 'fmc-autopilot-hud';
          el.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:8px 16px;border-radius:999px;font-size:13px;font-weight:600;font-family:system-ui,-apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.18);pointer-events:none;transition:all 0.25s ease;';
          document.body.appendChild(el);
        }
        const tone = ${JSON.stringify(tone)};
        el.style.background = tone === 'ok' ? '#065f46' : tone === 'warn' ? '#92400e' : '#18181b';
        el.style.color = '#ffffff';
        el.textContent = ${JSON.stringify(text)};
      })()`,
      true
    );
  } catch {
    // ignore HUD errors during navigation
  }
}

async function highlightRectOnPage(
  wc: WebContents,
  rect: { x: number; y: number; width: number; height: number },
  ms = 650
): Promise<void> {
  try {
    await wc.executeJavaScript(
      `(() => {
        let box = document.getElementById('fmc-autopilot-ring');
        if (!box) {
          box = document.createElement('div');
          box.id = 'fmc-autopilot-ring';
          box.style.cssText = 'position:fixed;z-index:2147483646;border:2.5px solid #10b981;border-radius:8px;background:rgba(16,185,129,0.12);box-shadow:0 0 0 4px rgba(16,185,129,0.22);pointer-events:none;transition:all 0.2s ease;';
          document.body.appendChild(box);
        }
        const r = ${JSON.stringify(rect)};
        box.style.display = 'block';
        box.style.left = Math.max(0, r.x - 3) + 'px';
        box.style.top = Math.max(0, r.y - 3) + 'px';
        box.style.width = (r.width + 6) + 'px';
        box.style.height = (r.height + 6) + 'px';
        setTimeout(() => { if (box) box.style.display = 'none'; }, ${ms});
      })()`,
      true
    );
  } catch {
    // ignore
  }
  await sleep(ms);
}

async function clickHardwareAt(wc: WebContents, x: number, y: number): Promise<void> {
  const rx = Math.max(2, Math.round(x));
  const ry = Math.max(2, Math.round(y));
  wc.focus();
  wc.sendInputEvent({ type: 'mouseMove', x: rx, y: ry });
  await sleep(70);
  wc.sendInputEvent({ type: 'mouseDown', x: rx, y: ry, button: 'left', clickCount: 1 });
  await sleep(70);
  wc.sendInputEvent({ type: 'mouseUp', x: rx, y: ry, button: 'left', clickCount: 1 });
}

async function sendSelectAllAndBackspace(wc: WebContents): Promise<void> {
  wc.focus();
  const mod = process.platform === 'darwin' ? 'meta' : 'control';
  wc.sendInputEvent({ type: 'keyDown', keyCode: mod === 'meta' ? 'Meta' : 'Control' });
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: [mod] });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: [mod] });
  wc.sendInputEvent({ type: 'keyUp', keyCode: mod === 'meta' ? 'Meta' : 'Control' });
  wc.selectAll();
  await sleep(160);
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
  await sleep(160);
}

async function typeNativeIntoRect(
  wc: WebContents,
  rect: { x: number; y: number; width: number; height: number },
  value: string,
  pressEnter = false
): Promise<void> {
  await highlightRectOnPage(wc, rect, 450);
  await clickHardwareAt(wc, rect.x + Math.min(40, rect.width / 2), rect.y + rect.height / 2);
  await sleep(180);
  await sendSelectAllAndBackspace(wc);
  await wc.insertText(value);
  await sleep(220);
  if (pressEnter) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await sleep(250);
  }
}

async function waitForPageKeyword(
  wc: WebContents,
  keywords: string[],
  timeoutMs = 10000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const matched = (await wc.executeJavaScript(
        `(() => {
          const txt = document.body?.innerText || '';
          const kws = ${JSON.stringify(keywords)};
          return kws.some((k) => txt.includes(k));
        })()`,
        true
      )) as boolean;
      if (matched) return true;
    } catch {
      // ignore while loading
    }
    await sleep(350);
  }
  return false;
}

async function navigateFeishuSection(
  wc: WebContents,
  menuLabels: string[],
  readyKeywords: string[],
  fallbackUrl: string
): Promise<boolean> {
  try {
    const rect = (await wc.executeJavaScript(
      `(() => {
        const labels = ${JSON.stringify(menuLabels)};
        const candidates = Array.from(
          document.querySelectorAll('aside a, aside li, aside div, nav a, nav li, [class*="menu"] a, [class*="menu"] li, [class*="sider"] div, [class*="nav"] span')
        );
        for (const label of labels) {
          for (const el of candidates) {
            if (!(el instanceof HTMLElement)) continue;
            const txt = (el.innerText || '').trim();
            if (txt === label) {
              const r = el.getBoundingClientRect();
              if (r.width >= 20 && r.height >= 14 && r.height <= 64 && r.left < 340) {
                el.scrollIntoView({ block: 'nearest' });
                const nr = el.getBoundingClientRect();
                return { x: nr.left, y: nr.top, width: nr.width, height: nr.height };
              }
            }
          }
        }
        return null;
      })()`,
      true
    )) as { x: number; y: number; width: number; height: number } | null;

    if (rect) {
      await highlightRectOnPage(wc, rect, 500);
      await clickHardwareAt(wc, rect.x + rect.width / 2, rect.y + rect.height / 2);
      const ok = await waitForPageKeyword(wc, readyKeywords, 6500);
      if (ok) {
        await sleep(500);
        return true;
      }
    }
  } catch {
    // fallback to URL load
  }

  await wc.loadURL(fallbackUrl);
  await waitPageSettled(wc, 1400);
  return waitForPageKeyword(wc, readyKeywords, 9000);
}

async function findAndHighlightClick(
  wc: WebContents,
  regexSource: string,
  options?: { insideModal?: boolean; exact?: boolean; pauseAfterMs?: number }
): Promise<{ clicked: boolean; label: string }> {
  const rectInfo = (await wc.executeJavaScript(
    `(() => {
      const re = new RegExp(${JSON.stringify(regexSource)}, 'i');
      const scope = ${Boolean(options?.insideModal)}
        ? (document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal') || document)
        : document;
      const nodes = Array.from(scope.querySelectorAll('button, a, [role="button"], label, span'));
      for (const node of nodes) {
        const btn = node.closest('button, a, [role="button"], label') || node;
        if (!(btn instanceof HTMLElement)) continue;
        if (btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true') continue;
        const style = window.getComputedStyle(btn);
        if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') continue;
        const txt = (btn.innerText || '').replace(/\\s+/g, ' ').trim();
        if (!txt || txt.length > 40) continue;
        const matched = ${Boolean(options?.exact)} ? txt === ${JSON.stringify(regexSource)} : re.test(txt);
        if (!matched) continue;
        const r = btn.getBoundingClientRect();
        if (r.width < 16 || r.height < 14) continue;
        btn.scrollIntoView({ block: 'center' });
        const nr = btn.getBoundingClientRect();
        return { x: nr.left, y: nr.top, width: nr.width, height: nr.height, label: txt };
      }
      return null;
    })()`,
    true
  )) as { x: number; y: number; width: number; height: number; label: string } | null;

  if (!rectInfo) return { clicked: false, label: '' };
  await highlightRectOnPage(wc, rectInfo, 600);
  await clickHardwareAt(wc, rectInfo.x + rectInfo.width / 2, rectInfo.y + rectInfo.height / 2);
  await sleep(options?.pauseAfterMs ?? 950);
  return { clicked: true, label: rectInfo.label };
}

/**
 * Local-IP Step-by-Step Verified Feishu Bot Auto-Configurator.
 * Uses smooth sidebar transitions, visible green highlight pacing, native Chromium hardware clicks,
 * native clipboard paste + React Fiber injection for Feishu's Monaco JSON editor, and strict per-step verification.
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
  const stepReport: FeishuAutoStepReport[] = [];

  const emitStep = async (msg: string, tone: 'running' | 'ok' | 'warn' = 'running') => {
    onProgress(msg);
    await setFeishuHud(wc, msg, tone);
  };

  try {
    const curUrl = wc.getURL();
    if (!curUrl.includes('open.feishu.cn')) {
      await emitStep('正在打开飞书开放平台开发者后台...');
      await wc.loadURL('https://open.feishu.cn/app');
      await waitPageSettled(wc, 1800);
    }

    await waitForPageKeyword(wc, ['企业自建应用', '凭证与基础信息', '扫码登录', '登录'], 6000);
    const loginCheck = (await wc.executeJavaScript(
      `(() => {
        const href = location.href;
        const txt = document.body?.innerText || '';
        const onPassport = href.includes('accounts.feishu.cn') || href.includes('passport.feishu.cn');
        const hasConsole =
          txt.includes('企业自建应用') ||
          txt.includes('凭证与基础信息') ||
          txt.includes('添加应用能力') ||
          /\\/app\\/cli_[a-zA-Z0-9]+/.test(href);
        return { onPassport, hasConsole };
      })()`,
      true
    )) as { onPassport: boolean; hasConsole: boolean };

    if (loginCheck.onPassport || !loginCheck.hasConsole) {
      await emitStep('请先用手机飞书扫码登录开放平台，登录成功后再点一次「⚡ 一键自动代配」', 'warn');
      return {
        ok: false,
        needLogin: true,
        completedSteps,
        stepReport,
        message:
          '请先在左侧飞书开放平台网页用手机飞书扫码登录（走本机 IP 安全无风控）。进入开发者后台后再点一次「⚡ 一键自动代配」即可自动完成！'
      };
    }

    // ==================== STEP 1: CREATE OR LOCATE APP ====================
    await emitStep(`⚡ [1/6] 正在定位或创建企业自建应用「${botName}」...`);
    let appId = '';
    const urlMatch = wc.getURL().match(/\/app\/(cli_[a-zA-Z0-9]+)/);
    if (urlMatch) {
      appId = urlMatch[1];
      completedSteps.push(`已识别当前打开的应用 (${appId})`);
      stepReport.push({ step: '1. 创建/定位自建应用', status: 'ok', detail: `正在配置当前应用 ${appId}` });
    } else if (params.existingAppId && /^cli_[a-zA-Z0-9]+$/.test(params.existingAppId.trim())) {
      appId = params.existingAppId.trim();
      await wc.loadURL(`https://open.feishu.cn/app/${appId}/baseinfo`);
      await waitPageSettled(wc, 1600);
      await waitForPageKeyword(wc, ['凭证与基础信息', 'App ID', '添加应用能力'], 8000);
      completedSteps.push(`已进入已填应用 (${appId})`);
      stepReport.push({ step: '1. 创建/定位自建应用', status: 'ok', detail: `已打开应用 ${appId}` });
    } else {
      const createClick = await findAndHighlightClick(wc, '创建企业自建应用', { pauseAfterMs: 1100 });
      if (createClick.clicked) {
        const modalInputs = (await wc.executeJavaScript(
          `(() => {
            const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal') || document.body;
            const fields = Array.from(modal.querySelectorAll('input[type="text"], input:not([type]), textarea'))
              .filter((el) => {
                const r = el.getBoundingClientRect();
                return r.width > 80 && r.height > 20;
              })
              .map((el) => {
                const r = el.getBoundingClientRect();
                return { x: r.left, y: r.top, width: r.width, height: r.height, tag: el.tagName };
              });
            return fields;
          })()`,
          true
        )) as Array<{ x: number; y: number; width: number; height: number; tag: string }>;

        if (modalInputs[0]) {
          await typeNativeIntoRect(wc, modalInputs[0], botName);
        }
        if (modalInputs[1]) {
          await typeNativeIntoRect(wc, modalInputs[1], botDesc);
        }
        await sleep(600);
        await findAndHighlightClick(wc, '^(创建|确定|确认)$', { insideModal: true, pauseAfterMs: 1200 });

        for (let i = 0; i < 20; i++) {
          await sleep(500);
          const m = wc.getURL().match(/\/app\/(cli_[a-zA-Z0-9]+)/);
          if (m) {
            appId = m[1];
            break;
          }
        }
      }

      if (!appId) {
        stepReport.push({
          step: '1. 创建企业自建应用',
          status: 'manual',
          detail: '请在左侧弹窗确认名称与描述并点击「创建」，进入应用后台后再点一次一键代配'
        });
        await emitStep('请在左侧点击「创建」进入应用详情页后，再点一次「⚡ 一键自动代配」', 'warn');
        return {
          ok: false,
          completedSteps,
          stepReport,
          message:
            '已在左侧打开创建窗口，请确认应用名称与描述后点击「创建」进入应用后台，再点一次「⚡ 一键自动代配」即可继续完成后续 5 步！'
        };
      }
      completedSteps.push(`已创建企业自建应用「${botName}」(${appId})`);
      stepReport.push({ step: '1. 创建企业自建应用', status: 'ok', detail: `成功创建 ${botName} (${appId})` });
    }

    // ==================== STEP 2: ADD BOT CAPABILITY ====================
    await emitStep('⚡ [2/6] 正在检查并开启「机器人」应用能力...');
    const alreadyHasBotInMenu = (await wc.executeJavaScript(
      `(() => {
        const menuItems = Array.from(document.querySelectorAll('aside *, nav *, [class*="menu"] *'))
          .map((el) => (el instanceof HTMLElement ? (el.innerText || '').trim() : ''));
        return menuItems.includes('机器人');
      })()`,
      true
    )) as boolean;

    if (alreadyHasBotInMenu) {
      completedSteps.push('应用已具备「机器人」能力');
      stepReport.push({ step: '2. 添加「机器人」能力', status: 'ok', detail: '左侧菜单已存在「机器人」能力' });
      await sleep(600);
    } else {
      await navigateFeishuSection(
        wc,
        ['添加应用能力'],
        ['按能力添加', '机器人', '网页应用'],
        `https://open.feishu.cn/app/${appId}/bot`
      );
      await sleep(700);

      const botCardBtn = (await wc.executeJavaScript(
        `(() => {
          const allNodes = Array.from(document.querySelectorAll('div, section, li'));
          const botCards = allNodes.filter((el) => {
            if (!(el instanceof HTMLElement)) return false;
            const txt = (el.innerText || '').trim();
            if (!txt.includes('机器人')) return false;
            if (txt.includes('网页应用') && txt.includes('小程序')) return false;
            const r = el.getBoundingClientRect();
            return r.width >= 180 && r.width <= 680 && r.height >= 80 && r.height <= 380;
          });
          botCards.sort((a, b) => a.innerText.length - b.innerText.length);
          for (const card of botCards) {
            if ((card.innerText || '').includes('已添加')) {
              return { alreadyAdded: true };
            }
            const btn = Array.from(card.querySelectorAll('button, [role="button"]')).find((b) => {
              const t = (b.innerText || '').replace(/\\s+/g, '').trim();
              return /^(\\+?添加|添加机器人|启用)$/.test(t) && !b.hasAttribute('disabled');
            });
            if (btn && btn instanceof HTMLElement) {
              btn.scrollIntoView({ block: 'center' });
              const r = btn.getBoundingClientRect();
              return { x: r.left, y: r.top, width: r.width, height: r.height };
            }
          }
          return null;
        })()`,
        true
      )) as { alreadyAdded?: boolean; x?: number; y?: number; width?: number; height?: number } | null;

      if (botCardBtn?.alreadyAdded) {
        completedSteps.push('「机器人」能力已处于添加状态');
        stepReport.push({ step: '2. 添加「机器人」能力', status: 'ok', detail: '已启用机器人能力' });
      } else if (botCardBtn && typeof botCardBtn.x === 'number') {
        await highlightRectOnPage(
          wc,
          { x: botCardBtn.x, y: botCardBtn.y!, width: botCardBtn.width!, height: botCardBtn.height! },
          700
        );
        await clickHardwareAt(
          wc,
          botCardBtn.x + botCardBtn.width! / 2,
          botCardBtn.y! + botCardBtn.height! / 2
        );
        await sleep(1800);
        completedSteps.push('已自动点击添加「机器人」能力');
        stepReport.push({ step: '2. 添加「机器人」能力', status: 'ok', detail: '成功为应用添加机器人能力' });
      } else {
        stepReport.push({
          step: '2. 添加「机器人」能力',
          status: 'warn',
          detail: '未定位到机器人卡片按钮，请检查左侧「添加应用能力 → 机器人」是否已添加'
        });
      }
    }

    // ==================== STEP 3: BATCH IMPORT 7 PERMISSION SCOPES (MONACO EDITOR) ====================
    await emitStep('⚡ [3/6] 正在进入「权限管理」并向编辑器写入 7 项消息与文件权限 JSON...');
    await navigateFeishuSection(
      wc,
      ['权限管理'],
      ['批量导入', '开通权限', 'API 权限'],
      `https://open.feishu.cn/app/${appId}/auth`
    );
    await sleep(900);

    const openBatchModal = await findAndHighlightClick(wc, '批量导入', { pauseAfterMs: 1200 });
    if (!openBatchModal.clicked) {
      stepReport.push({
        step: '3. 批量导入 7 项权限 JSON',
        status: 'warn',
        detail: '未找到「批量导入/导出权限」按钮，请在权限管理页手动点击并粘贴 JSON'
      });
    } else {
      await findAndHighlightClick(wc, '^导入权限$', { insideModal: true, pauseAfterMs: 650 });
      await sleep(500);

      // Layer 1: React Fiber / Monaco model direct setValue / onChange inside modal
      await wc.executeJavaScript(
        `(() => {
          const jsonStr = ${JSON.stringify(FEISHU_REQUIRED_SCOPES_JSON)};
          const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal') || document;
          if (window.monaco && window.monaco.editor && window.monaco.editor.getModels) {
            const models = window.monaco.editor.getModels();
            if (models.length > 0) models[models.length - 1].setValue(jsonStr);
          }
          const editorNodes = Array.from(modal.querySelectorAll('.monaco-editor, [class*="monaco"], [class*="editor"]'));
          for (const node of editorNodes) {
            const fiberKey = Object.keys(node).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
            let cur = fiberKey ? node[fiberKey] : null;
            for (let depth = 0; cur && depth < 15; depth++, cur = cur.return) {
              const inst = cur.stateNode;
              if (inst && inst.editor && typeof inst.editor.setValue === 'function') {
                inst.editor.setValue(jsonStr);
              }
              if (cur.ref && cur.ref.current && cur.ref.current.editor && typeof cur.ref.current.editor.setValue === 'function') {
                cur.ref.current.editor.setValue(jsonStr);
              }
              const props = cur.memoizedProps;
              if (props && typeof props.onChange === 'function' && typeof props.value === 'string') {
                try { props.onChange(jsonStr); } catch (e) {}
              }
            }
          }
        })()`,
        true
      );
      await sleep(450);

      let editorCheck = (await wc.executeJavaScript(
        `(() => {
          const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal');
          if (!modal) return { hasScopes: false, rect: null };
          const ed = modal.querySelector('.monaco-editor .view-lines, .monaco-editor, .cm-content, textarea');
          const txt = (modal.innerText || '').replace(/\\u00a0/g, ' ');
          const hasScopes = txt.includes('im:message:send_as_bot') && txt.includes('im:resource');
          if (!ed) return { hasScopes, rect: null };
          const r = ed.getBoundingClientRect();
          return { hasScopes, rect: { x: r.left, y: r.top, width: r.width, height: r.height } };
        })()`,
        true
      )) as {
        hasScopes: boolean;
        rect: { x: number; y: number; width: number; height: number } | null;
      };

      // Layer 2: Native Hardware Click + Ctrl+A + Backspace + Native Clipboard wc.paste()!
      if (!editorCheck.hasScopes && editorCheck.rect && editorCheck.rect.width > 40) {
        const prevClipboard = clipboard.readText();
        try {
          clipboard.writeText(FEISHU_REQUIRED_SCOPES_JSON);
          await highlightRectOnPage(wc, editorCheck.rect, 550);
          await clickHardwareAt(
            wc,
            editorCheck.rect.x + Math.min(120, editorCheck.rect.width / 2),
            editorCheck.rect.y + Math.min(60, editorCheck.rect.height / 2)
          );
          await sleep(260);
          await sendSelectAllAndBackspace(wc);
          wc.paste();
          await sleep(750);

          const afterPaste = (await wc.executeJavaScript(
            `(() => {
              const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal');
              const txt = ((modal && modal.innerText) || '').replace(/\\u00a0/g, ' ');
              return txt.includes('im:message') && txt.includes('im:resource');
            })()`,
            true
          )) as boolean;

          if (!afterPaste) {
            const mod = process.platform === 'darwin' ? 'meta' : 'control';
            wc.sendInputEvent({ type: 'keyDown', keyCode: mod === 'meta' ? 'Meta' : 'Control' });
            wc.sendInputEvent({ type: 'keyDown', keyCode: 'v', modifiers: [mod] });
            wc.sendInputEvent({ type: 'keyUp', keyCode: 'v', modifiers: [mod] });
            wc.sendInputEvent({ type: 'keyUp', keyCode: mod === 'meta' ? 'Meta' : 'Control' });
            await sleep(750);
          }
        } finally {
          clipboard.writeText(prevClipboard);
        }

        editorCheck = (await wc.executeJavaScript(
          `(() => {
            const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal');
            const txt = ((modal && modal.innerText) || '').replace(/\\u00a0/g, ' ');
            return {
              hasScopes: txt.includes('im:message') && txt.includes('im:resource'),
              rect: null
            };
          })()`,
          true
        )) as { hasScopes: boolean; rect: null };
      }

      // Pause 1s visibly so user clearly sees the JSON inside the Monaco editor!
      await sleep(1000);

      if (!editorCheck.hasScopes) {
        stepReport.push({
          step: '3. 批量导入 7 项权限 JSON',
          status: 'warn',
          detail: '未能自动写入权限编辑器，请点击下方指引中的「复制权限 JSON」手动粘贴导入'
        });
      } else {
        const stepNext = await findAndHighlightClick(wc, '下一步|确认新增权限|确定导入', {
          insideModal: true,
          pauseAfterMs: 1300
        });

        const modalStatus = (await wc.executeJavaScript(
          `(() => {
            const txt = document.body?.innerText || '';
            return {
              alreadyAllGranted: txt.includes('暂无新增权限') || txt.includes('没有新增权限') || txt.includes('已全部开通')
            };
          })()`,
          true
        )) as { alreadyAllGranted: boolean };

        if (modalStatus.alreadyAllGranted) {
          await findAndHighlightClick(wc, '^(取消|关闭|知道了)$', { insideModal: true, pauseAfterMs: 500 });
          completedSteps.push('7 项飞书权限此前已全部开通');
          stepReport.push({
            step: '3. 批量导入 7 项权限 JSON',
            status: 'ok',
            detail: '7 项权限均已处于已开通状态'
          });
        } else if (stepNext.clicked) {
          await sleep(600);
          const applyClick = await findAndHighlightClick(wc, '申请开通|确认开通|批量开通|提交申请', {
            insideModal: true,
            pauseAfterMs: 1600
          });
          await findAndHighlightClick(wc, '^(确定|完成|关闭|知道了)$', {
            insideModal: true,
            pauseAfterMs: 700
          });

          if (applyClick.clicked) {
            completedSteps.push('已成功导入 JSON 并点击「申请开通」7 项权限');
            stepReport.push({
              step: '3. 批量导入 7 项权限 JSON',
              status: 'ok',
              detail: '已成功写入 JSON 并提交开通全部 7 项消息与文件权限'
            });
          } else {
            stepReport.push({
              step: '3. 批量导入 7 项权限 JSON',
              status: 'warn',
              detail: 'JSON 已填入并进入确认页，请在左侧弹窗点一下「申请开通」'
            });
          }
        } else {
          stepReport.push({
            step: '3. 批量导入 7 项权限 JSON',
            status: 'warn',
            detail: 'JSON 已写入编辑器，若提示原先均已开通可直接关闭弹窗，否则请点「下一步 → 申请开通」'
          });
        }
      }
    }

    // ==================== STEP 4: EXTRACT CREDENTIALS & CONNECT WEBSOCKET ====================
    await emitStep('⚡ [4/6] 正在读取 App ID 与 App Secret 并建立本地飞书长连接...');
    await navigateFeishuSection(
      wc,
      ['凭证与基础信息'],
      ['App ID', 'App Secret'],
      `https://open.feishu.cn/app/${appId}/baseinfo`
    );
    await sleep(900);

    let extractedSecret = '';
    const prevClipForSecret = clipboard.readText();
    try {
      clipboard.writeText('');
      const secretIconRects = (await wc.executeJavaScript(
        `(() => {
          const labels = Array.from(document.querySelectorAll('div, span, td, th, label'));
          const secretLabel = labels.find((el) => (el.innerText || '').trim() === 'App Secret');
          const row =
            (secretLabel && secretLabel.closest('tr, [class*="row"], [class*="item"], [class*="field"], [class*="secret"]')) ||
            (secretLabel && secretLabel.parentElement && secretLabel.parentElement.parentElement);
          if (!row) return { directText: '', rects: [] };
          const rowTxt = (row.innerText || '');
          const directMatch = rowTxt.match(/\\b([a-zA-Z0-9]{28,40})\\b/g) || [];
          const validDirect = directMatch.find((s) => !s.startsWith('cli_') && /[a-zA-Z]/.test(s) && /\\d/.test(s)) || '';
          const btns = Array.from(row.querySelectorAll('button, [role="button"], span[class*="icon"], svg'))
            .map((el) => el.closest('button, [role="button"]') || el)
            .filter((el, idx, arr) => {
              if (!(el instanceof HTMLElement)) return false;
              if (arr.indexOf(el) !== idx) return false;
              const t = (el.innerText || el.getAttribute('title') || el.getAttribute('aria-label') || '').trim();
              if (/重置|Reset/i.test(t)) return false;
              const r = el.getBoundingClientRect();
              return r.width >= 12 && r.width <= 80 && r.height >= 12 && r.height <= 48;
            })
            .slice(0, 3)
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { x: r.left, y: r.top, width: r.width, height: r.height };
            });
          return { directText: validDirect, rects: btns };
        })()`,
        true
      )) as {
        directText: string;
        rects: Array<{ x: number; y: number; width: number; height: number }>;
      };

      if (secretIconRects.directText) {
        extractedSecret = secretIconRects.directText;
      } else {
        for (const r of secretIconRects.rects) {
          await highlightRectOnPage(wc, r, 450);
          await clickHardwareAt(wc, r.x + r.width / 2, r.y + r.height / 2);
          await sleep(550);

          const clipVal = clipboard.readText().trim();
          if (/^[a-zA-Z0-9]{24,44}$/.test(clipVal) && !clipVal.startsWith('cli_')) {
            extractedSecret = clipVal;
            break;
          }
          const domSecret = (await wc.executeJavaScript(
            `(() => {
              const txt = document.body?.innerText || '';
              const matches = txt.match(/\\b([a-zA-Z0-9]{28,40})\\b/g) || [];
              return matches.find((s) => !s.startsWith('cli_') && /[a-zA-Z]/.test(s) && /\\d/.test(s)) || '';
            })()`,
            true
          )) as string;
          if (domSecret) {
            extractedSecret = domSecret;
            break;
          }
        }
      }
    } finally {
      clipboard.writeText(prevClipForSecret);
    }

    let wsConnectedOk = false;
    if (extractedSecret) {
      wsConnectedOk = await onCredentialsReady(appId, extractedSecret);
      await sleep(1800);
      completedSteps.push(
        wsConnectedOk
          ? `已提取凭证并成功连上飞书长连接 (${appId})`
          : `已提取凭证 (${appId})`
      );
      stepReport.push({
        step: '4. 提取凭证并启动本地长连接',
        status: wsConnectedOk ? 'ok' : 'warn',
        detail: wsConnectedOk
          ? `App ID (${appId}) 与 Secret 已自动填入并连上 WebSocket 长连接`
          : '已提取填入凭证，但长连接暂未就绪，请点上方「连接飞书长连接」重试'
      });
    } else {
      stepReport.push({
        step: '4. 提取凭证并启动本地长连接',
        status: 'warn',
        detail: `已获取 App ID (${appId})，但未能自动读取 App Secret，请复制粘贴 Secret 并点连接`
      });
    }

    // ==================== STEP 5: WEBSOCKET EVENT MODE & im.message.receive_v1 ====================
    await emitStep('⚡ [5/6] 正在配置「使用长连接接收事件」并添加接收消息事件...');
    await navigateFeishuSection(
      wc,
      ['事件与回调'],
      ['事件配置', '订阅方式', '添加事件'],
      `https://open.feishu.cn/app/${appId}/event`
    );
    await sleep(1000);

    const wsModeState = (await wc.executeJavaScript(
      `(() => {
        const txt = document.body?.innerText || '';
        const hasRadioVisible = Array.from(document.querySelectorAll('input[type="radio"], .ud__radio, .semi-radio'))
          .some((el) => el.getBoundingClientRect().width > 0);
        return { txtHasWs: txt.includes('使用长连接接收事件'), hasRadioVisible };
      })()`,
      true
    )) as { txtHasWs: boolean; hasRadioVisible: boolean };

    if (!wsModeState.hasRadioVisible) {
      await findAndHighlightClick(wc, '^(编辑|修改|修改订阅方式)$', { pauseAfterMs: 700 });
    }
    await findAndHighlightClick(wc, '使用长连接接收事件', { pauseAfterMs: 700 });
    const savedWsBtn = await findAndHighlightClick(wc, '^保存$', { pauseAfterMs: 1800 });

    const wsErrorToast = (await wc.executeJavaScript(
      `(() => {
        const txt = document.body?.innerText || '';
        return txt.includes('未检测到应用连接信息') || txt.includes('请先建立长连接');
      })()`,
      true
    )) as boolean;

    let eventSubscribed = (await wc.executeJavaScript(
      `(() => (document.body?.innerText || '').includes('im.message.receive_v1'))()`,
      true
    )) as boolean;

    if (!eventSubscribed) {
      const addEv = await findAndHighlightClick(wc, '添加事件', { pauseAfterMs: 1100 });
      if (addEv.clicked) {
        const searchRect = (await wc.executeJavaScript(
          `(() => {
            const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal') || document;
            const inp = Array.from(modal.querySelectorAll('input'))
              .find((i) => i.type !== 'checkbox' && i.type !== 'radio' && i.getBoundingClientRect().width > 80);
            if (!inp) return null;
            const r = inp.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height };
          })()`,
          true
        )) as { x: number; y: number; width: number; height: number } | null;

        if (searchRect) {
          await typeNativeIntoRect(wc, searchRect, 'im.message.receive_v1', true);
          await sleep(1100);
        }

        const cbRect = (await wc.executeJavaScript(
          `(() => {
            const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal');
            if (!modal) return null;
            const rows = Array.from(modal.querySelectorAll('label, tr, li, div')).filter((el) => {
              if (!(el instanceof HTMLElement)) return false;
              const t = el.innerText || '';
              return (t.includes('接收消息') || t.includes('im.message.receive_v1')) && el.getBoundingClientRect().height < 90;
            });
            rows.sort((a, b) => a.innerText.length - b.innerText.length);
            const target = (rows[0] && rows[0].querySelector('input[type="checkbox"], .ud__checkbox, .semi-checkbox, .arco-checkbox')) || rows[0];
            if (!target || !(target instanceof HTMLElement)) return null;
            const r = target.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height };
          })()`,
          true
        )) as { x: number; y: number; width: number; height: number } | null;

        if (cbRect) {
          await highlightRectOnPage(wc, cbRect, 550);
          await clickHardwareAt(wc, cbRect.x + Math.min(14, cbRect.width / 2), cbRect.y + cbRect.height / 2);
          await sleep(600);
          await findAndHighlightClick(wc, '确认添加|确定', { insideModal: true, pauseAfterMs: 1400 });
        }

        eventSubscribed = (await wc.executeJavaScript(
          `(() => {
            const t = document.body?.innerText || '';
            return t.includes('im.message.receive_v1') || t.includes('接收消息 v2.0');
          })()`,
          true
        )) as boolean;
      }
    }

    if (!wsErrorToast && eventSubscribed) {
      completedSteps.push('已开启长连接订阅并添加接收消息事件 im.message.receive_v1');
      stepReport.push({
        step: '5. 长连接模式与接收消息事件',
        status: 'ok',
        detail: '已保存长连接模式并成功订阅 im.message.receive_v1'
      });
    } else {
      stepReport.push({
        step: '5. 长连接模式与接收消息事件',
        status: 'warn',
        detail: wsErrorToast
          ? '飞书提示尚未检测到长连接，请确认第 4 步连接在线后再点保存订阅方式'
          : savedWsBtn.clicked || eventSubscribed
            ? '已操作事件配置，请核对「使用长连接接收事件」与 im.message.receive_v1 是否均已保存'
            : '请在「事件与回调」页手动点选「使用长连接接收事件 → 保存」并添加 im.message.receive_v1'
      });
    }

    // ==================== STEP 6: CREATE VERSION 1.0.0 DRAFT ====================
    await emitStep('⚡ [6/6] 正在进入「版本管理与发布」并填写 1.0.0 版本信息...');
    await navigateFeishuSection(
      wc,
      ['版本管理与发布'],
      ['创建版本', '版本管理与发布'],
      `https://open.feishu.cn/app/${appId}/version`
    );
    await sleep(1000);

    const createVerClicked = await findAndHighlightClick(wc, '创建版本', { pauseAfterMs: 1400 });
    if (createVerClicked.clicked) {
      const verFields = (await wc.executeJavaScript(
        `(() => {
          const verInp = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
            .find((el) => {
              const p = (el.getAttribute('placeholder') || '') + ((el.closest('[class*="item"], [class*="field"]') && el.closest('[class*="item"], [class*="field"]').innerText) || '');
              const r = el.getBoundingClientRect();
              return r.width > 80 && /版本|1\\.0\\.0/.test(p) && !el.value;
            });
          const noteInp = Array.from(document.querySelectorAll('textarea'))
            .find((el) => el.getBoundingClientRect().width > 120 && !el.value);
          return {
            verRect: verInp ? (() => { const r = verInp.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })() : null,
            noteRect: noteInp ? (() => { const r = noteInp.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })() : null
          };
        })()`,
        true
      )) as {
        verRect: { x: number; y: number; width: number; height: number } | null;
        noteRect: { x: number; y: number; width: number; height: number } | null;
      };

      if (verFields.verRect) {
        await typeNativeIntoRect(wc, verFields.verRect, '1.0.0');
      }
      if (verFields.noteRect) {
        await typeNativeIntoRect(wc, verFields.noteRect, 'MuseDeck 自动配置发布');
      }
      await wc.executeJavaScript(`window.scrollBy({ top: 360, behavior: 'smooth' })`, true);
      await sleep(700);
    }

    stepReport.push({
      step: '6. 版本检查与线上发布（需你最后确认点击）',
      status: 'manual',
      detail: '已停留在版本页：请确认「可用范围」包含你自己，点底部「保存」→ 右上角「申请线上发布」变为已发布！'
    });

    const warnCount = stepReport.filter((s) => s.status === 'warn').length;
    await emitStep(
      warnCount === 0
        ? '✅ 前 5 步已全部自动完成并校验！请在当前页点「保存 → 申请线上发布」完成最后发布'
        : `⚠️ 自动代配结束（有 ${warnCount} 项需留意右侧核对清单），最后请完成版本发布`,
      warnCount === 0 ? 'ok' : 'warn'
    );

    return {
      ok: warnCount === 0,
      appId,
      appSecret: extractedSecret || undefined,
      completedSteps,
      stepReport,
      nextManualHint:
        '请在左侧版本页面点击底部「保存」→ 右上角「申请线上发布」（确认状态变为绿色「已发布」），然后点右侧「唤起机器人对话」发一句「你好」即可！',
      message:
        warnCount === 0
          ? '✅ 前 5 步全部自动配置并校验通过！最后只需在左侧点「保存 → 申请线上发布」，再点「唤起机器人对话」发一句「你好」即可！'
          : `已完成自动代配流程，其中有 ${warnCount} 个步骤需要你在下方清单核对确认，完成后发布版本即可。`
    };
  } catch (err) {
    return {
      ok: false,
      completedSteps,
      stepReport,
      message: `自动代配中断：${err instanceof Error ? err.message : String(err)}（你可对照下方 6 步清单继续完成剩余项）`
    };
  }
}
