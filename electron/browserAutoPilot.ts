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
  disabled?: boolean;
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

export function redactSnapshotPrivacy(snap: LocalBrowserSnapshot): LocalBrowserSnapshot {
  const isFeishuConsole = /open\.feishu\.cn|open\.larksuite\.com/i.test(snap.url || '');
  const scrubText = (raw: string): string => {
    if (!raw) return '';
    let out = raw
      // Mask App Secret / Encrypt Key / Verification Token adjacent text
      .replace(
        /(App\s*Secret|Encrypt\s*Key|Verification\s*Token)\s*[:：]?\s*[A-Za-z0-9_*•-]{6,64}/gi,
        '$1: [已由本地隐私护盾自动托管]'
      )
      // Mask Bearer tokens
      .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [REDACTED]')
      // Mask standalone 26-48 char alphanumeric secrets (preserve cli_xxxx public App ID)
      .replace(/\b(?!cli_)[A-Za-z0-9]{26,48}\b/g, (m) =>
        /[A-Za-z]/.test(m) && /\d/.test(m) ? '[REDACTED_SECRET]' : m
      )
      // Mask phone numbers & emails
      .replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/g, '$1****$2')
      .replace(/\b([A-Za-z0-9._%+-]{1,2})[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1***@$2');

    if (isFeishuConsole && /\/baseinfo\b/i.test(snap.url)) {
      out = `[MuseDeck 本地隐私护盾：凭证页敏感字段已脱敏屏蔽，无需读取任何密钥；需要连接长连接时直接调用 feishu-assist {"op":"sync_local_bridge"} 即可] ` + out;
    }
    return out;
  };

  const safeElements = (snap.elements || [])
    .filter((el) => {
      if (isFeishuConsole) {
        const lbl = `${el.label || ''} ${el.value || ''}`;
        if (/App\s*Secret|重置|Reset|Encrypt\s*Key|Verification\s*Token|退出登录|注销/i.test(lbl)) {
          return false;
        }
        const href = (el.href || '').toLowerCase();
        if (href.includes('/document/') || href.includes('/hc/') || href.includes('feishu.cn/docx')) {
          return false;
        }
      }
      return true;
    })
    .map((el) => ({
      ...el,
      label: scrubText(el.label),
      value: el.value ? scrubText(el.value) : undefined
    }));

  return {
    url: snap.url,
    title: scrubText(snap.title),
    textExcerpt: scrubText(snap.textExcerpt),
    elements: safeElements
  };
}

export class LocalBrowserController {
  private localWin: BrowserWindow | null = null;
  private tailscaleWin: BrowserWindow | null = null;
  private tailscaleTimer: NodeJS.Timeout | null = null;
  private feishuWc: WebContents | null = null;
  private onFeishuCredentialsSynced?: (appId: string, appSecret: string) => Promise<boolean>;
  private onFeishuAppIdDetected?: (appId: string) => void;
  private onFeishuProgress?: (msg: string) => void;

  bindFeishuWebContents(
    wc: WebContents | null,
    onCredentialsSynced?: (appId: string, appSecret: string) => Promise<boolean>,
    onProgress?: (msg: string) => void,
    onAppIdDetected?: (appId: string) => void
  ): void {
    this.feishuWc = wc;
    if (onCredentialsSynced) this.onFeishuCredentialsSynced = onCredentialsSynced;
    if (onProgress) this.onFeishuProgress = onProgress;
    if (onAppIdDetected) this.onFeishuAppIdDetected = onAppIdDetected;
  }

  private resolveTargetWc(target?: 'default' | 'feishu', urlHint?: string): WebContents {
    const wantsFeishu =
      target === 'feishu' ||
      Boolean(urlHint && /open\.feishu\.cn|open\.larksuite\.com/i.test(urlHint));
    if (wantsFeishu && this.feishuWc && !this.feishuWc.isDestroyed()) {
      return this.feishuWc;
    }
    return this.ensureLocalWindow(false).webContents;
  }

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

  async openUrl(
    rawUrl: string,
    waitMs = 1800,
    target?: 'default' | 'feishu'
  ): Promise<LocalBrowserSnapshot> {
    const normalized = /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;
    if (!isSafePublicBrowserUrl(normalized)) {
      throw new Error('Blocked unsafe or private network URL');
    }
    const wc = this.resolveTargetWc(target, normalized);
    try {
      await Promise.race([
        wc.loadURL(normalized),
        new Promise((r) => setTimeout(r, 12000))
      ]);
    } catch {
      // partial load still inspectable
    }
    await new Promise((r) => setTimeout(r, Math.min(6000, Math.max(400, waitMs))));
    return this.snapshot(target || (/open\.feishu\.cn/i.test(normalized) ? 'feishu' : 'default'));
  }

  private async execJsSafe<T>(wc: WebContents, code: string, timeoutMs = 6500): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return (await Promise.race([
        wc.executeJavaScript(code, true),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Browser script timed out')), timeoutMs);
        })
      ])) as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async snapshot(target?: 'default' | 'feishu'): Promise<LocalBrowserSnapshot> {
    const wc = this.resolveTargetWc(target);
    const js = `
      (() => {
        window.__fmcBidSeq = window.__fmcBidSeq || 1;
        const textExcerpt = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 4000);
        const modals = Array.from(
          document.querySelectorAll('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal')
        ).filter((m) => {
          if (!(m instanceof HTMLElement)) return false;
          const r = m.getBoundingClientRect();
          const st = window.getComputedStyle(m);
          return r.width > 120 && r.height > 80 && st.display !== 'none' && st.visibility !== 'hidden';
        });
        const topModal = modals.length > 0 ? modals[modals.length - 1] : null;

        const selector = 'a[href], button, [role="button"], input, textarea, select';
        const modalNodes = topModal ? Array.from(topModal.querySelectorAll(selector)) : [];
        const bgNodes = Array.from(document.querySelectorAll(selector)).filter(
          (n) => !topModal || !topModal.contains(n)
        );
        const orderedNodes = [...modalNodes, ...bgNodes];

        const elements = [];
        for (const el of orderedNodes) {
          if (elements.length >= 80) break;
          if (!(el instanceof HTMLElement)) continue;
          const tag = el.tagName.toLowerCase();
          const inpType = (el.getAttribute('type') || '').toLowerCase();
          if (tag === 'input' && (inpType === 'file' || inpType === 'hidden')) continue;
          if (tag === 'a' && el.getAttribute('target') === '_blank' && (el.getAttribute('href') || '').includes('/document/')) {
            continue;
          }
          const cls = String(el.className || '').toLowerCase();
          if (cls.includes('clearbtn') || cls.includes('input-clear') || el.getAttribute('aria-label') === 'clear') {
            continue;
          }
          const rect = el.getBoundingClientRect();
          if (rect.width < 10 || rect.height < 10) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') continue;

          // Persistent stable ID across snapshots so dynamic icons/validation never shift IDs!
          let bid = el.getAttribute('data-fmc-bid');
          if (!bid) {
            bid = 'b' + (window.__fmcBidSeq++);
            el.setAttribute('data-fmc-bid', bid);
          }

          let fieldHint = '';
          if (tag === 'input' || tag === 'textarea') {
            const fieldRow = el.closest('[class*="form-item"], [class*="field"], [class*="item"], tr');
            const lblNode = fieldRow ? fieldRow.querySelector('label, [class*="label"]') : null;
            if (lblNode && lblNode instanceof HTMLElement) {
              fieldHint = (lblNode.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 32);
            }
          }
          const rawLabel = (
            el.innerText ||
            el.getAttribute('placeholder') ||
            el.getAttribute('aria-label') ||
            el.getAttribute('title') ||
            el.getAttribute('name') ||
            ''
          ).replace(/\\s+/g, ' ').trim().slice(0, 64);

          const inModal = Boolean(topModal && topModal.contains(el));
          const combinedLabel = [
            inModal ? '[弹窗]' : '',
            fieldHint && fieldHint !== rawLabel ? fieldHint : '',
            rawLabel
          ].filter(Boolean).join(' ').slice(0, 90);

          // Skip unlabeled tiny icon wrappers
          if (!combinedLabel && tag !== 'input' && tag !== 'textarea') continue;

          const isDisabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
          elements.push({
            id: bid,
            tag,
            type: inpType || undefined,
            label: combinedLabel,
            value: inpType === 'password'
              ? '[MASKED]'
              : (('value' in el && typeof el.value === 'string') ? el.value.slice(0, 80) : undefined),
            disabled: isDisabled || undefined,
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
    const rawSnap = await this.execJsSafe<LocalBrowserSnapshot>(wc, js, 6000);
    return redactSnapshotPrivacy(rawSnap);
  }

  async act(req: {
    action: 'click' | 'fill' | 'press' | 'scroll';
    target?: 'default' | 'feishu';
    targetId?: string;
    text?: string;
    key?: string;
    direction?: 'down' | 'up' | 'top' | 'bottom';
  }): Promise<{ ok: boolean; detail: string; snapshot: LocalBrowserSnapshot }> {
    const wc = this.resolveTargetWc(req.target);
    const isFeishu =
      req.target === 'feishu' || /open\.feishu\.cn|open\.larksuite\.com/i.test(wc.getURL());
    if (isFeishu && req.targetId) {
      const msg = `🤖 Muse 正在执行页面操作：${req.action} (${req.targetId})`;
      this.onFeishuProgress?.(msg);
      await setFeishuHud(wc, msg, 'running');
    }

    if (req.action === 'fill') {
      const val = String(req.text ?? '');
      // Step 1: Locate & unwrap input/textarea, highlight briefly, and focus without scrolling modal
      const prep = await this.execJsSafe<{
        ok: boolean;
        detail: string;
        resolvedBid?: string;
      }>(
        wc,
        `(async () => {
          const tid = ${JSON.stringify(req.targetId || '')};
          let target = tid ? document.querySelector('[data-fmc-bid=' + JSON.stringify(tid) + ']') : null;
          if (!target && tid) {
            const kw = tid.toLowerCase();
            target = Array.from(document.querySelectorAll('input:not([type="file"]):not([type="hidden"]), textarea'))
              .find((el) => ((el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').toLowerCase()).includes(kw)) || null;
          }
          if (target && target instanceof HTMLElement && target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA' && !target.isContentEditable) {
            const inner =
              target.querySelector('input:not([type="file"]):not([type="hidden"]), textarea, [contenteditable="true"]') ||
              (target.closest('[class*="input"], [class*="textarea"], [class*="form-item"]') &&
                target.closest('[class*="input"], [class*="textarea"], [class*="form-item"]').querySelector('input:not([type="file"]):not([type="hidden"]), textarea'));
            if (inner instanceof HTMLElement) target = inner;
          }
          if (!target || !(target instanceof HTMLElement)) {
            return { ok: false, detail: 'Input target not found: ' + tid };
          }
          if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA' && !target.isContentEditable) {
            return { ok: false, detail: 'Element ' + tid + ' is <' + target.tagName.toLowerCase() + '>, not an input or textarea. Choose an element with tag="input" or "textarea".' };
          }
          if (target.tagName === 'INPUT' && (target.getAttribute('type') || '').toLowerCase() === 'file') {
            return { ok: false, detail: 'Skipping file input ' + tid };
          }
          const inModal = Boolean(target.closest('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal'));
          const r = target.getBoundingClientRect();
          if (!inModal && (r.top < 32 || r.bottom > window.innerHeight - 32)) {
            target.scrollIntoView({ behavior: 'instant', block: 'nearest' });
          }
          window.__fmcBidSeq = window.__fmcBidSeq || 1;
          let rbid = target.getAttribute('data-fmc-bid');
          if (!rbid) {
            rbid = 'b' + (window.__fmcBidSeq++);
            target.setAttribute('data-fmc-bid', rbid);
          }
          const prevOutline = target.style.outline;
          target.style.outline = '2.5px solid #10b981';
          target.focus({ preventScroll: true });
          await new Promise((res) => setTimeout(res, 180));
          target.style.outline = prevOutline;
          return { ok: true, detail: 'focused', resolvedBid: rbid };
        })()`,
        5000
      );

      if (!prep.ok) {
        const snap = await this.snapshot(isFeishu ? 'feishu' : req.target);
        return { ok: false, detail: prep.detail, snapshot: snap };
      }

      // Step 2: Native Chromium C++ input pipeline (SelectAll + Backspace + insertText)
      await typeNativeIntoFocusedElement(wc, val, false);

      // Step 3: Verify & enforce React 18 _valueTracker + synthetic InputEvent sync so controlled inputs ALWAYS update!
      const verifiedVal = await this.execJsSafe<string>(
        wc,
        `(() => {
          const el = document.querySelector('[data-fmc-bid=' + JSON.stringify(${JSON.stringify(prep.resolvedBid || req.targetId || '')}) + ']');
          if (!el || !(el instanceof HTMLElement)) return '';
          const desired = ${JSON.stringify(val)};
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            const cur = el.value || '';
            if (cur !== desired) {
              const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(el, desired);
              else el.value = desired;
              const tracker = el._valueTracker;
              if (tracker && typeof tracker.setValue === 'function') {
                tracker.setValue(cur);
              }
            }
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: desired, inputType: 'insertText' }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return el.value || '';
          }
          if ((el.textContent || '') !== desired) {
            el.textContent = desired;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: desired, inputType: 'insertText' }));
          }
          return el.textContent || '';
        })()`,
        4000
      );

      await sleep(350);
      const snap = await this.snapshot(isFeishu ? 'feishu' : req.target);
      return {
        ok: true,
        detail: `filled ${req.targetId || prep.resolvedBid} => value=${JSON.stringify(verifiedVal.slice(0, 60))}`,
        snapshot: snap
      };
    }

    const js = `
      (async () => {
        const req = ${JSON.stringify(req)};
        if (req.action === 'scroll') {
          if (req.direction === 'top') window.scrollTo(0, 0);
          else if (req.direction === 'bottom') window.scrollTo(0, document.body.scrollHeight);
          else if (req.direction === 'up') window.scrollBy(0, -480);
          else window.scrollBy(0, 480);
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
          target = Array.from(document.querySelectorAll('button, a, [role="button"], input:not([type="file"]), textarea'))
            .filter((el) => {
              const a = el.closest('a');
              if (a && ((a.getAttribute('href') || '').includes('/document/') || a.getAttribute('target') === '_blank')) return false;
              const t = (el.innerText || '').trim();
              if (/App\\s*Secret|重置|Reset/i.test(t)) return false;
              return true;
            })
            .find((el) => ((el.innerText || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').toLowerCase()).includes(kw)) || null;
        }
        if (!target || !(target instanceof HTMLElement)) {
          return { ok: false, detail: 'Target element not found: ' + (req.targetId || '') };
        }
        if (target.tagName === 'INPUT' && (target.getAttribute('type') || '').toLowerCase() === 'file') {
          return { ok: false, detail: 'Refused clicking file chooser input' };
        }
        const inModal = Boolean(target.closest('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal'));
        const r = target.getBoundingClientRect();
        if (!inModal && (r.top < 32 || r.bottom > window.innerHeight - 32)) {
          target.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        }
        const prevOutline = target.style.outline;
        target.style.outline = '2.5px solid #10b981';
        await new Promise((res) => setTimeout(res, 220));
        target.style.outline = prevOutline;

        if (req.action === 'click') {
          target.focus({ preventScroll: true });
          target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          target.click();
          return { ok: true, detail: 'clicked ' + (target.innerText || req.targetId || '').trim().slice(0, 40) };
        }
        return { ok: false, detail: 'Unsupported action' };
      })()
    `;
    const res = await this.execJsSafe<{ ok: boolean; detail: string }>(wc, js, 6000);
    await new Promise((r) => setTimeout(r, 600));
    const snap = await this.snapshot(isFeishu ? 'feishu' : req.target);
    return { ok: Boolean(res?.ok), detail: res?.detail || '', snapshot: snap };
  }

  /**
   * Privacy-Shielded Local Feishu Helper for Muse Co-Pilot:
   * Supports high-level step helpers + Monaco JSON injection + 100% local credential binding
   * so Muse NEVER reads, sees, or touches App Secret or any private key!
   */
  async feishuAssist(
    op:
      | 'status'
      | 'create_or_enter_app'
      | 'add_bot_capability'
      | 'fill_permission_json'
      | 'sync_local_bridge'
      | 'configure_events'
      | 'prepare_version',
    params?: { botName?: string; botDesc?: string }
  ): Promise<Record<string, unknown>> {
    const wc = this.resolveTargetWc('feishu');
    const curUrl = wc.getURL();
    if (!curUrl || !/open\.feishu\.cn|open\.larksuite\.com/i.test(curUrl)) {
      await wc.loadURL('https://open.feishu.cn/app');
      await waitPageSettled(wc, 1400);
    }

    const readCurrentAppId = () => wc.getURL().match(/\/app\/(cli_[a-zA-Z0-9]+)/)?.[1] || '';

    if (op === 'status') {
      const stateInfo = await this.execJsSafe<Record<string, unknown>>(
        wc,
        `(() => {
          const href = location.href;
          const txt = document.body?.innerText || '';
          const onLogin = href.includes('accounts.feishu.cn') || href.includes('passport.feishu.cn');
          const loggedIn = !onLogin && (txt.includes('企业自建应用') || txt.includes('凭证与基础信息') || /\\/app\\/cli_[a-zA-Z0-9]+/.test(href));
          const menuItems = Array.from(document.querySelectorAll('aside *, nav *, [class*="menu"] *'))
            .map((el) => (el instanceof HTMLElement ? (el.innerText || '').trim() : ''));
          return {
            loggedIn,
            insideAppConsole: /\\/app\\/cli_[a-zA-Z0-9]+/.test(href),
            hasBotCapabilityInMenu: menuItems.includes('机器人'),
            hasReceiveEventOnPage: txt.includes('im.message.receive_v1')
          };
        })()`,
        5000
      );
      const snap = await this.snapshot('feishu');
      return { ok: true, ...stateInfo, snapshot: snap };
    }

    if (op === 'create_or_enter_app') {
      let appId = readCurrentAppId();
      if (!appId) {
        const botName = (params?.botName || 'MuseDeck').trim() || 'MuseDeck';
        const botDesc = (params?.botDesc || 'MuseDeck 本地多智能体调度助手').trim();
        this.onFeishuProgress?.(`🤖 Muse 正在创建企业自建应用「${botName}」...`);
        await setFeishuHud(wc, `🤖 Muse 正在创建企业自建应用「${botName}」...`, 'running');

        // Open create modal if not already open
        const hasModalOpen = await this.execJsSafe<boolean>(
          wc,
          `(() => Boolean(document.querySelector('[role="dialog"] input, .ud__modal input, .semi-modal-content input, .arco-modal input')))()`,
          4000
        );
        if (!hasModalOpen) {
          await findAndHighlightClick(wc, '创建企业自建应用', { buttonsOnly: true, pauseAfterMs: 1000 });
        }

        // Fill Name & Description natively + sync React _valueTracker
        for (let idx = 0; idx < 2; idx++) {
          const textVal = idx === 0 ? botName : botDesc;
          const focused = await this.execJsSafe<boolean>(
            wc,
            `(() => {
              const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal') || document.body;
              const fields = Array.from(modal.querySelectorAll('input:not([type="file"]):not([type="hidden"]), textarea'))
                .filter((el) => el.getBoundingClientRect().width > 80 && el.getBoundingClientRect().height > 20);
              const el = fields[${idx}];
              if (!el || !(el instanceof HTMLElement)) return false;
              el.focus({ preventScroll: true });
              return true;
            })()`,
            4000
          );
          if (focused) {
            await typeNativeIntoFocusedElement(wc, textVal, false);
            await this.execJsSafe(
              wc,
              `(() => {
                const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal') || document.body;
                const fields = Array.from(modal.querySelectorAll('input:not([type="file"]):not([type="hidden"]), textarea'))
                  .filter((el) => el.getBoundingClientRect().width > 80 && el.getBoundingClientRect().height > 20);
                const el = fields[${idx}];
                if (!el) return;
                const desired = ${JSON.stringify(textVal)};
                if ((el.value || '') !== desired) {
                  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                  if (setter) setter.call(el, desired);
                  if (el._valueTracker) el._valueTracker.setValue('');
                  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: desired, inputType: 'insertText' }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
              })()`,
              4000
            );
          }
        }
        await sleep(350);
        await findAndHighlightClick(wc, '^(创建|确定|确认)$', {
          insideModal: true,
          buttonsOnly: true,
          pauseAfterMs: 1200
        });
        for (let i = 0; i < 16; i++) {
          appId = readCurrentAppId();
          if (appId) break;
          await sleep(450);
        }
      }
      if (appId) {
        this.onFeishuAppIdDetected?.(appId);
      }
      const snap = await this.snapshot('feishu');
      return {
        ok: Boolean(appId),
        insideAppConsole: Boolean(appId),
        note: appId
          ? 'Entered app console successfully. Proceed to add_bot_capability.'
          : 'Create modal is open; inspect snapshot.elements if an extra confirmation or org selection is needed.',
        snapshot: snap
      };
    }

    if (op === 'add_bot_capability') {
      const appId = readCurrentAppId();
      this.onFeishuProgress?.('🤖 Muse 正在开启应用「机器人」能力...');
      await setFeishuHud(wc, '🤖 Muse 正在开启应用「机器人」能力...', 'running');
      let hasBot = await this.execJsSafe<boolean>(
        wc,
        `(() => Array.from(document.querySelectorAll('aside *, nav *, [class*="menu"] *')).some((el) => el instanceof HTMLElement && (el.innerText || '').trim() === '机器人'))()`,
        4000
      );
      if (!hasBot && appId) {
        await navigateFeishuSection(wc, ['添加应用能力'], ['按能力添加', '机器人'], `https://open.feishu.cn/app/${appId}`);
        await sleep(600);
        await this.execJsSafe(
          wc,
          `(async () => {
            const cards = Array.from(document.querySelectorAll('div, section, li')).filter((el) => {
              if (!(el instanceof HTMLElement)) return false;
              const t = (el.innerText || '').trim();
              const r = el.getBoundingClientRect();
              return t.includes('机器人') && !(t.includes('网页应用') && t.includes('小程序')) && r.width >= 180 && r.width <= 720 && r.height >= 70 && r.height <= 400;
            }).sort((a, b) => a.innerText.length - b.innerText.length);
            for (const card of cards) {
              if ((card.innerText || '').includes('已添加')) return true;
              const btn = Array.from(card.querySelectorAll('button')).find((b) => {
                const bt = (b.innerText || '').replace(/\\s+/g, '').trim();
                return !/了解|文档|详情/.test(bt) && /^(\\+?添加|添加机器人|启用)$/.test(bt) && !b.hasAttribute('disabled');
              });
              if (btn instanceof HTMLElement) {
                btn.click();
                return true;
              }
            }
            return false;
          })()`,
          5000
        );
        await sleep(900);
        await findAndHighlightClick(wc, '^(添加|确定|确认|保存)$', { insideModal: true, buttonsOnly: true, pauseAfterMs: 900 });
        hasBot = await this.execJsSafe<boolean>(
          wc,
          `(() => Array.from(document.querySelectorAll('aside *, nav *, [class*="menu"] *')).some((el) => el instanceof HTMLElement && (el.innerText || '').trim() === '机器人') || (document.body?.innerText || '').includes('已添加'))()`,
          4000
        );
      }
      const snap = await this.snapshot('feishu');
      return { ok: hasBot, hasBotCapabilityInMenu: hasBot, snapshot: snap };
    }

    if (op === 'fill_permission_json') {
      const appId = readCurrentAppId();
      this.onFeishuProgress?.('🔒 本地助手正在导入并开通 7 项飞书消息与表情权限...');
      await setFeishuHud(wc, '🔒 本地助手正在导入 7 项飞书权限 JSON...', 'running');

      if (appId && !wc.getURL().includes('/auth')) {
        await navigateFeishuSection(wc, ['权限管理'], ['批量导入', '开通权限'], `https://open.feishu.cn/app/${appId}/auth`);
        await sleep(700);
      }
      const modalAlreadyOpen = await this.execJsSafe<boolean>(
        wc,
        `(() => Boolean(document.querySelector('[role="dialog"] .monaco-editor, .ud__modal .monaco-editor, .semi-modal-content .monaco-editor, .arco-modal .monaco-editor')))()`,
        4000
      );
      if (!modalAlreadyOpen) {
        await findAndHighlightClick(wc, '批量导入', { buttonsOnly: true, pauseAfterMs: 1000 });
        await findAndHighlightClick(wc, '^导入权限$', { insideModal: true, pauseAfterMs: 500 });
      }

      await this.execJsSafe(
        wc,
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
              if (inst && inst.editor && typeof inst.editor.setValue === 'function') inst.editor.setValue(jsonStr);
              if (cur.ref && cur.ref.current && cur.ref.current.editor && typeof cur.ref.current.editor.setValue === 'function') cur.ref.current.editor.setValue(jsonStr);
            }
          }
        })()`,
        5000
      );
      await sleep(300);

      let hasScopes = await this.execJsSafe<boolean>(
        wc,
        `(() => {
          const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal');
          const txt = ((modal && modal.innerText) || '').replace(/\\u00a0/g, ' ');
          return txt.includes('im:message:send_as_bot') && txt.includes('im:resource');
        })()`,
        4000
      );

      if (!hasScopes) {
        const prevClip = clipboard.readText();
        try {
          clipboard.writeText(FEISHU_REQUIRED_SCOPES_JSON);
          const rect = await this.execJsSafe<{ x: number; y: number; width: number; height: number } | null>(
            wc,
            `(() => {
              const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal');
              if (!modal) return null;
              const inputArea = modal.querySelector('.monaco-editor textarea.inputarea, .monaco-editor textarea, textarea');
              if (inputArea instanceof HTMLElement) inputArea.focus({ preventScroll: true });
              const ed = modal.querySelector('.monaco-editor .view-lines, .monaco-editor, textarea');
              if (!ed) return null;
              const r = ed.getBoundingClientRect();
              return { x: r.left, y: r.top, width: r.width, height: r.height };
            })()`,
            4000
          );
          if (rect && rect.width > 40) {
            await clickHardwareAt(wc, rect.x + Math.min(120, rect.width / 2), rect.y + Math.min(60, rect.height / 2));
          }
          await sleep(180);
          await sendSelectAllAndBackspace(wc);
          wc.paste();
          await sleep(550);
          hasScopes = await this.execJsSafe<boolean>(
            wc,
            `(() => {
              const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal');
              const txt = ((modal && modal.innerText) || '').replace(/\\u00a0/g, ' ');
              return txt.includes('im:message') && txt.includes('im:resource');
            })()`,
            4000
          );
        } finally {
          clipboard.writeText(prevClip);
        }
      }

      let applied = false;
      if (hasScopes) {
        const nextClick = await findAndHighlightClick(wc, '下一步|确认新增权限|确定导入', {
          insideModal: true,
          buttonsOnly: true,
          pauseAfterMs: 1100
        });
        const allGranted = await this.execJsSafe<boolean>(
          wc,
          `(() => /暂无新增权限|没有新增权限|已全部开通/.test(document.body?.innerText || ''))()`,
          4000
        );
        if (allGranted) {
          applied = true;
          await findAndHighlightClick(wc, '^(取消|关闭|知道了)$', { insideModal: true, buttonsOnly: true, pauseAfterMs: 400 });
        } else if (nextClick.clicked) {
          const sub = await findAndHighlightClick(wc, '申请开通|确认开通|批量开通|提交申请', {
            insideModal: true,
            buttonsOnly: true,
            pauseAfterMs: 1200
          });
          applied = sub.clicked;
          await findAndHighlightClick(wc, '^(确定|完成|关闭|知道了)$', { insideModal: true, buttonsOnly: true, pauseAfterMs: 500 });
        }
      }

      const snap = await this.snapshot('feishu');
      return {
        ok: hasScopes,
        scopesInjected: hasScopes,
        scopesSubmitted: applied,
        note: applied
          ? 'All 7 Feishu permissions injected and submitted! Proceed to sync_local_bridge.'
          : 'Scopes injected into modal; check snapshot.elements if any confirmation button remains in modal.',
        snapshot: snap
      };
    }

    if (op === 'configure_events') {
      const appId = readCurrentAppId();
      if (appId) this.onFeishuAppIdDetected?.(appId);
      this.onFeishuProgress?.('🤖 Muse 正在配置「长连接接收事件」与 im.message.receive_v1...');
      await setFeishuHud(wc, '🤖 Muse 正在配置长连接模式与接收消息事件...', 'running');
      const wsModeRes = await enableFeishuLongConnectionOnPage(wc, appId);

      let eventAdded = await this.execJsSafe<boolean>(
        wc,
        `(() => (document.body?.innerText || '').includes('im.message.receive_v1'))()`,
        4000
      );
      if (!eventAdded) {
        const addEv = await findAndHighlightClick(wc, '添加事件', { buttonsOnly: true, pauseAfterMs: 950 });
        if (addEv.clicked) {
          const focused = await this.execJsSafe<boolean>(
            wc,
            `(() => {
              const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal') || document;
              const inp = Array.from(modal.querySelectorAll('input')).find((i) => i.type !== 'checkbox' && i.type !== 'radio' && i.getBoundingClientRect().width > 80);
              if (inp instanceof HTMLElement) { inp.focus({ preventScroll: true }); return true; }
              return false;
            })()`,
            4000
          );
          if (focused) {
            await typeNativeIntoFocusedElement(wc, 'im.message.receive_v1', true);
            await sleep(900);
          }
          await this.execJsSafe(
            wc,
            `(() => {
              const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal');
              if (!modal) return;
              const rows = Array.from(modal.querySelectorAll('label, tr, li, div')).filter((el) => el instanceof HTMLElement && ((el.innerText || '').includes('接收消息') || (el.innerText || '').includes('im.message.receive_v1')) && el.getBoundingClientRect().height < 95).sort((a, b) => a.innerText.length - b.innerText.length);
              const t = (rows[0] && rows[0].querySelector('input[type="checkbox"], .ud__checkbox, .semi-checkbox, .arco-checkbox')) || rows[0];
              if (t instanceof HTMLElement) t.click();
            })()`,
            4000
          );
          await sleep(450);
          await findAndHighlightClick(wc, '确认添加|确定', { insideModal: true, buttonsOnly: true, pauseAfterMs: 1100 });
          eventAdded = await this.execJsSafe<boolean>(
            wc,
            `(() => /im\\.message\\.receive_v1|接收消息\\s*v2\\.0/.test(document.body?.innerText || ''))()`,
            4000
          );
        }
      }
      const snap = await this.snapshot('feishu');
      return {
        ok: wsModeRes.modeSaved && eventAdded,
        longConnectionModeSaved: wsModeRes.modeSaved,
        wsErrorToast: wsModeRes.wsErrorToast,
        eventSubscribed: eventAdded,
        note:
          wsModeRes.modeSaved && eventAdded
            ? 'Long-connection event mode and im.message.receive_v1 are both configured! Proceed to prepare_version.'
            : wsModeRes.wsErrorToast
              ? 'Feishu reported local WebSocket not detected yet. Call sync_local_bridge once more, wait 2s, then retry configure_events.'
              : 'Inspect snapshot.elements if an extra Save or confirm click is needed.',
        snapshot: snap
      };
    }

    if (op === 'prepare_version') {
      const appId = readCurrentAppId();
      this.onFeishuProgress?.('🤖 Muse 正在准备 1.0.0 版本草稿（若密钥未自动填入，请先核对右侧凭证与长连接）...');
      await setFeishuHud(wc, '👉 请核对右侧密钥连接与事件长连接已开启后，点击「保存 → 申请线上发布」', 'warn');
      if (appId) {
        await navigateFeishuSection(wc, ['版本管理与发布'], ['创建版本', '版本管理与发布'], `https://open.feishu.cn/app/${appId}/version`);
        await sleep(800);
      }
      const clickedVer = await findAndHighlightClick(wc, '创建版本', { buttonsOnly: true, pauseAfterMs: 1100 });
      if (clickedVer.clicked) {
        const fVer = await this.execJsSafe<boolean>(
          wc,
          `(() => {
            const inp = Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).find((el) => el.getBoundingClientRect().width > 80 && !el.value);
            if (inp instanceof HTMLElement) { inp.focus({ preventScroll: true }); return true; }
            return false;
          })()`,
          4000
        );
        if (fVer) await typeNativeIntoFocusedElement(wc, '1.0.0', false);

        const fNote = await this.execJsSafe<boolean>(
          wc,
          `(() => {
            const ta = Array.from(document.querySelectorAll('textarea')).find((el) => el.getBoundingClientRect().width > 120 && !el.value);
            if (ta instanceof HTMLElement) { ta.focus({ preventScroll: true }); return true; }
            return false;
          })()`,
          4000
        );
        if (fNote) await typeNativeIntoFocusedElement(wc, 'MuseDeck 自动配置发布', false);
      }
      const snap = await this.snapshot('feishu');
      return {
        ok: true,
        readyForUserPublish: true,
        note: 'Version 1.0.0 form prepared. Stop here and ask the user to click 保存 -> 申请线上发布 on the Feishu window!',
        snapshot: snap
      };
    }

    if (op === 'sync_local_bridge') {
      const m = wc.getURL().match(/\/app\/(cli_[a-zA-Z0-9]+)/);
      if (!m) {
        const snap = await this.snapshot('feishu');
        return {
          ok: false,
          localWebSocketConnected: false,
          note: 'Not inside a specific /app/cli_xxxx console page yet. Open or create the app first.',
          snapshot: snap
        };
      }
      const appId = m[1];
      this.onFeishuAppIdDetected?.(appId);
      this.onFeishuProgress?.(
        `🔒 本地隐私护盾正在读取新应用 (${appId}) 凭证并连接飞书 WebSocket（密钥零外泄）...`
      );
      await setFeishuHud(wc, '🔒 本地隐私护盾正在自动提取凭证并连接飞书长连接...', 'running');

      const secret = await extractFeishuAppSecretLocally(wc, appId);

      let connected = false;
      if (secret && this.onFeishuCredentialsSynced) {
        connected = await this.onFeishuCredentialsSynced(appId, secret);
        // Give Feishu cloud 2s to register our active WebSocket client before Step 5 clicks Save!
        await sleep(2000);
      }

      if (connected) {
        this.onFeishuProgress?.(`✅ 已自动填入新机器人 (${appId}) 凭证并成功建立飞书 WebSocket 长连接！`);
        await setFeishuHud(wc, `✅ 新机器人 (${appId}) 本地长连接已在线！`, 'ok');
      } else {
        this.onFeishuProgress?.(
          `⚠️ 已定位新应用 (${appId})，但尚未连上长连接，请在凭证页点复制 App Secret 粘贴连接`
        );
      }

      const snap = await this.snapshot('feishu');
      // ZERO secret / credential returned to Muse!
      return {
        ok: connected,
        localWebSocketConnected: connected,
        privacyShield: 'ACTIVE_ZERO_SECRET_EXPOSED',
        note: connected
          ? 'Local Feishu WebSocket bridge is now ONLINE for this new app! Proceed immediately to configure_events.'
          : 'Could not auto-connect local WebSocket yet; remind user to copy App Secret into MuseDeck and click Connect before saving long-connection mode.',
        snapshot: snap
      };
    }

    return { ok: false, error: 'Unsupported feishuAssist op' };
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

async function typeNativeIntoFocusedElement(
  wc: WebContents,
  value: string,
  pressEnter = false
): Promise<void> {
  await sleep(140);
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
    const clickedSidebar = (await wc.executeJavaScript(
      `(async () => {
        const labels = ${JSON.stringify(menuLabels)};
        const candidates = Array.from(
          document.querySelectorAll('aside a, aside li, aside div, nav a, nav li, [class*="menu"] a, [class*="menu"] li, [class*="sider"] div, [class*="nav"] span')
        );
        for (const label of labels) {
          for (const el of candidates) {
            if (!(el instanceof HTMLElement)) continue;
            if (el.tagName === 'A' && el.getAttribute('target') === '_blank') continue;
            const txt = (el.innerText || '').trim();
            if (txt === label) {
              const r = el.getBoundingClientRect();
              if (r.width >= 20 && r.height >= 14 && r.height <= 64 && r.left < 340) {
                if (r.top < 20 || r.bottom > window.innerHeight - 20) {
                  el.scrollIntoView({ behavior: 'instant', block: 'nearest' });
                }
                const prevOutline = el.style.outline;
                const prevOffset = el.style.outlineOffset;
                el.style.outline = '2.5px solid #10b981';
                el.style.outlineOffset = '2px';
                await new Promise((resolve) => setTimeout(resolve, 450));
                el.style.outline = prevOutline;
                el.style.outlineOffset = prevOffset;
                el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                el.click();
                return true;
              }
            }
          }
        }
        return false;
      })()`,
      true
    )) as boolean;

    if (clickedSidebar) {
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
  options?: { insideModal?: boolean; exact?: boolean; buttonsOnly?: boolean; pauseAfterMs?: number }
): Promise<{ clicked: boolean; label: string }> {
  const clickRes = (await wc.executeJavaScript(
    `(async () => {
      const re = new RegExp(${JSON.stringify(regexSource)}, 'i');
      const insideModal = ${Boolean(options?.insideModal)};
      const buttonsOnly = ${Boolean(options?.buttonsOnly)};
      const exact = ${Boolean(options?.exact)};
      const exactText = ${JSON.stringify(regexSource)};
      const scope = insideModal
        ? (document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal') || document)
        : document;
      const selector = buttonsOnly
        ? 'button, [role="button"]'
        : 'button, a, [role="button"], label, span';
      const nodes = Array.from(scope.querySelectorAll(selector));
      for (const node of nodes) {
        const btn = buttonsOnly
          ? (node.closest('button, [role="button"]') || node)
          : (node.closest('button, a, [role="button"], label') || node);
        if (!(btn instanceof HTMLElement)) continue;
        const anchor = btn.closest('a');
        if (anchor) {
          const href = (anchor.getAttribute('href') || '').toLowerCase();
          if (
            buttonsOnly ||
            anchor.getAttribute('target') === '_blank' ||
            href.includes('/document/') ||
            href.includes('feishu.cn/hc/')
          ) {
            continue;
          }
        }
        if (btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true') continue;
        const style = window.getComputedStyle(btn);
        if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') continue;
        const txt = (btn.innerText || '').replace(/\\s+/g, ' ').trim();
        if (!txt || txt.length > 160) continue;
        const matched = exact ? txt === exactText : re.test(txt);
        if (!matched) continue;
        const r = btn.getBoundingClientRect();
        if (r.width < 16 || r.height < 14) continue;
        if (!insideModal && (r.top < 36 || r.bottom > window.innerHeight - 36)) {
          btn.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        }
        const prevOutline = btn.style.outline;
        const prevOffset = btn.style.outlineOffset;
        const prevShadow = btn.style.boxShadow;
        btn.style.outline = '2.5px solid #10b981';
        btn.style.outlineOffset = '2px';
        btn.style.boxShadow = '0 0 0 4px rgba(16, 185, 129, 0.22)';
        await new Promise((resolve) => setTimeout(resolve, 420));
        btn.style.outline = prevOutline;
        btn.style.outlineOffset = prevOffset;
        btn.style.boxShadow = prevShadow;
        btn.focus({ preventScroll: true });
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        btn.click();
        return { clicked: true, label: txt.slice(0, 48) };
      }
      return null;
    })()`,
    true
  )) as { clicked: boolean; label: string } | null;

  if (!clickRes?.clicked) return { clicked: false, label: '' };
  await sleep(options?.pauseAfterMs ?? 950);
  return { clicked: true, label: clickRes.label };
}

/**
 * Reliably extracts App Secret on Feishu's /baseinfo page 100% locally in Electron:
 * Supports <svg> eye/copy icons (which are SVGElement, not HTMLElement!) and uses real
 * Chromium hardware clicks (isTrusted=true) so Feishu's navigator.clipboard.writeText & eye toggle succeed.
 */
async function extractFeishuAppSecretLocally(wc: WebContents, appId: string): Promise<string> {
  if (!wc.getURL().includes('/baseinfo')) {
    await navigateFeishuSection(
      wc,
      ['凭证与基础信息'],
      ['App ID', 'App Secret'],
      `https://open.feishu.cn/app/${appId}/baseinfo`
    );
  } else {
    await waitForPageKeyword(wc, ['App ID', 'App Secret'], 6500);
  }
  await sleep(700);

  const prevClip = clipboard.readText();
  try {
    const scanInfo = (await wc.executeJavaScript(
      `(() => {
        const all = Array.from(document.querySelectorAll('div, span, td, th, label, p'));
        const secretLabel = all.find(
          (el) => el instanceof HTMLElement && el.children.length === 0 && (el.innerText || '').trim() === 'App Secret'
        ) || all.find((el) => el instanceof HTMLElement && (el.innerText || '').trim() === 'App Secret');
        if (!secretLabel || !(secretLabel instanceof HTMLElement)) {
          return { direct: '', points: [] };
        }
        const lr = secretLabel.getBoundingClientRect();
        if (lr.top < 30 || lr.bottom > window.innerHeight - 60) {
          secretLabel.scrollIntoView({ behavior: 'instant', block: 'center' });
        }
        const lblRect = secretLabel.getBoundingClientRect();
        const container =
          secretLabel.closest('tr, [class*="row"], [class*="item"], [class*="field"], [class*="secret"], [class*="card"]') ||
          secretLabel.parentElement?.parentElement ||
          document.body;
        const cTxt = (container && container.innerText) || '';
        const directMatches = cTxt.match(/\\b([A-Za-z0-9]{26,44})\\b/g) || [];
        const validDirect =
          directMatches.find((s) => !s.startsWith('cli_') && /[A-Za-z]/.test(s) && /\\d/.test(s)) || '';

        // Collect all clickable icon candidates (including <svg>!) near App Secret
        const rawCandidates = Array.from(
          document.querySelectorAll('svg, button, [role="button"], span[class*="icon" i], i[class*="icon" i]')
        );
        const pts = [];
        for (const node of rawCandidates) {
          const boxEl = node.closest('button, [role="button"]') || (node instanceof HTMLElement ? node : node.parentElement);
          if (!boxEl || !(boxEl instanceof HTMLElement)) continue;
          const st = window.getComputedStyle(boxEl);
          if (st.display === 'none' || st.visibility === 'hidden') continue;
          const txt = (
            boxEl.innerText ||
            boxEl.getAttribute('title') ||
            boxEl.getAttribute('aria-label') ||
            (boxEl.parentElement && boxEl.parentElement.innerText) ||
            ''
          ).trim();
          if (/重置|Reset|刷新|Regenerate/i.test(txt)) continue;
          const r = boxEl.getBoundingClientRect();
          if (r.width < 10 || r.width > 76 || r.height < 10 || r.height > 48) continue;
          // Must lie within the App Secret horizontal/vertical zone (not left of App Secret label!)
          if (r.left < lblRect.left - 8) continue;
          if (r.top < lblRect.top - 24 || r.bottom > lblRect.bottom + 64) continue;
          const cx = Math.round(r.left + r.width / 2);
          const cy = Math.round(r.top + r.height / 2);
          if (!pts.some((p) => Math.hypot(p.x - cx, p.y - cy) < 10)) {
            pts.push({ x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height) });
          }
        }
        pts.sort((a, b) => a.x - b.x);
        return { direct: validDirect, points: pts.slice(0, 4) };
      })()`,
      true
    )) as { direct: string; points: Array<{ x: number; y: number; w: number; h: number }> };

    if (scanInfo.direct) {
      return scanInfo.direct;
    }

    for (const pt of scanInfo.points) {
      clipboard.writeText('');
      await highlightRectOnPage(
        wc,
        { x: pt.x - pt.w / 2, y: pt.y - pt.h / 2, width: pt.w, height: pt.h },
        320
      );
      await clickHardwareAt(wc, pt.x, pt.y);
      await sleep(550);

      const clipVal = clipboard.readText().trim();
      if (/^[A-Za-z0-9_-]{24,48}$/.test(clipVal) && !clipVal.startsWith('cli_')) {
        return clipVal;
      }

      const revealed = (await wc.executeJavaScript(
        `(() => {
          const all = Array.from(document.querySelectorAll('div, span, td, th, label, input'));
          const secretLabel = all.find((el) => el instanceof HTMLElement && (el.innerText || '').trim() === 'App Secret');
          const scope =
            (secretLabel && secretLabel.closest('tr, [class*="row"], [class*="item"], [class*="field"], [class*="card"]')) ||
            document.body;
          const inputVals = Array.from(scope.querySelectorAll('input')).map((i) => i.value || '').join(' ');
          const combined = ((scope && scope.innerText) || '') + ' ' + inputVals;
          const matches = combined.match(/\\b([A-Za-z0-9]{26,44})\\b/g) || [];
          return matches.find((s) => !s.startsWith('cli_') && /[A-Za-z]/.test(s) && /\\d/.test(s)) || '';
        })()`,
        true
      )) as string;
      if (revealed) {
        return revealed;
      }
    }
    return '';
  } finally {
    clipboard.writeText(prevClip);
  }
}

/**
 * Reliably switches Feishu's Event Subscription mode to WebSocket ("使用长连接接收事件") and saves it.
 */
async function enableFeishuLongConnectionOnPage(
  wc: WebContents,
  appId: string
): Promise<{ modeSaved: boolean; wsErrorToast: boolean }> {
  if (appId) {
    await navigateFeishuSection(
      wc,
      ['事件与回调'],
      ['事件配置', '订阅方式', '添加事件'],
      `https://open.feishu.cn/app/${appId}/event`
    );
    await sleep(900);
  }

  // Step 1: If radio inputs aren't visible yet, click Edit button or pencil <svg> near 订阅方式 / 事件配置
  const editTarget = (await wc.executeJavaScript(
    `(() => {
      const radios = Array.from(document.querySelectorAll('input[type="radio"], .ud__radio, .semi-radio, .arco-radio'))
        .filter((el) => el.getBoundingClientRect().width > 0);
      if (radios.length > 0) return { alreadyEditable: true, pt: null };

      const editBtn = Array.from(document.querySelectorAll('button, [role="button"], a, span'))
        .find((el) => el instanceof HTMLElement && /^(编辑|修改|修改订阅方式)$/.test((el.innerText || '').trim()) && el.getBoundingClientRect().width > 12);
      if (editBtn instanceof HTMLElement) {
        const r = editBtn.getBoundingClientRect();
        editBtn.click();
        return { alreadyEditable: false, pt: { x: r.left + r.width / 2, y: r.top + r.height / 2 } };
      }

      // Fallback: pencil <svg> icon on the same header row as 订阅方式 or 事件配置
      const hdr = Array.from(document.querySelectorAll('div, span, h3, h4'))
        .find((el) => el instanceof HTMLElement && el.children.length === 0 && /^(订阅方式|事件配置)$/.test((el.innerText || '').trim()));
      if (hdr instanceof HTMLElement) {
        const hr = hdr.getBoundingClientRect();
        const svg = Array.from(document.querySelectorAll('svg, button, [role="button"]')).find((s) => {
          const sr = s.getBoundingClientRect();
          return sr.width >= 10 && sr.width <= 44 && Math.abs(sr.top - hr.top) < 28 && sr.left >= hr.right - 6 && sr.left < hr.right + 140;
        });
        if (svg) {
          const sr = svg.getBoundingClientRect();
          const clickable = svg.closest('button, [role="button"], span') || svg;
          if (clickable instanceof HTMLElement) clickable.click();
          return { alreadyEditable: false, pt: { x: sr.left + sr.width / 2, y: sr.top + sr.height / 2 } };
        }
      }
      return { alreadyEditable: false, pt: null };
    })()`,
    true
  )) as { alreadyEditable: boolean; pt: { x: number; y: number } | null };

  if (!editTarget.alreadyEditable && editTarget.pt) {
    await clickHardwareAt(wc, editTarget.pt.x, editTarget.pt.y);
    await sleep(750);
  }

  // Step 2: Select the "使用长连接接收事件" radio option (ignoring long description text inside <label>!)
  const radioPt = (await wc.executeJavaScript(
    `(() => {
      const labels = Array.from(document.querySelectorAll('label, [class*="radio"], div, span'));
      const exactSpan = labels.find(
        (el) => el instanceof HTMLElement && el.children.length === 0 && (el.innerText || '').trim().includes('使用长连接接收事件')
      );
      const radioContainer =
        (exactSpan && exactSpan.closest('label, [class*="radio"]')) ||
        labels.find((el) => el instanceof HTMLElement && (el.innerText || '').includes('使用长连接接收事件') && el.getBoundingClientRect().height < 140);
      const target = radioContainer || exactSpan;
      if (!target || !(target instanceof HTMLElement)) return null;
      const r = target.getBoundingClientRect();
      if (r.top < 36 || r.bottom > window.innerHeight - 36) {
        target.scrollIntoView({ behavior: 'instant', block: 'center' });
      }
      const nr = target.getBoundingClientRect();
      const radioInp = target.querySelector('input[type="radio"], .ud__radio-inner, .semi-radio-inner');
      if (radioInp instanceof HTMLElement) radioInp.click();
      target.click();
      return { x: nr.left + Math.min(24, nr.width / 2), y: nr.top + Math.min(22, nr.height / 2), w: nr.width, h: nr.height };
    })()`,
    true
  )) as { x: number; y: number; w: number; h: number } | null;

  if (radioPt) {
    await highlightRectOnPage(wc, { x: radioPt.x - 12, y: radioPt.y - 12, width: 28, height: 28 }, 380);
    await clickHardwareAt(wc, radioPt.x, radioPt.y);
    await sleep(650);
  }

  // Step 3: Click Save button (with automatic 2.5s retry if Feishu cloud WS registration lagged slightly)
  const clickSaveOnce = async () => {
    const savePt = (await wc.executeJavaScript(
      `(() => {
        const btns = Array.from(document.querySelectorAll('button')).filter((b) => {
          if (b.hasAttribute('disabled')) return false;
          const t = (b.innerText || '').replace(/\\s+/g, '').trim();
          const r = b.getBoundingClientRect();
          return t === '保存' && r.width >= 36 && r.height >= 20;
        });
        if (btns.length === 0) return null;
        const btn = btns[0];
        const r = btn.getBoundingClientRect();
        if (r.top < 36 || r.bottom > window.innerHeight - 36) {
          btn.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        }
        const nr = btn.getBoundingClientRect();
        btn.click();
        return { x: nr.left + nr.width / 2, y: nr.top + nr.height / 2, w: nr.width, h: nr.height };
      })()`,
      true
    )) as { x: number; y: number; w: number; h: number } | null;
    if (savePt) {
      await highlightRectOnPage(
        wc,
        { x: savePt.x - savePt.w / 2, y: savePt.y - savePt.h / 2, width: savePt.w, height: savePt.h },
        380
      );
      await clickHardwareAt(wc, savePt.x, savePt.y);
    }
    await sleep(1800);
  };

  await clickSaveOnce();

  let check = (await wc.executeJavaScript(
    `(() => {
      const txt = document.body?.innerText || '';
      const wsErrorToast = txt.includes('未检测到应用连接信息') || txt.includes('请先建立长连接');
      const hasSaveBtnStill = Array.from(document.querySelectorAll('button')).some(
        (b) => (b.innerText || '').replace(/\\s+/g, '').trim() === '保存' && b.getBoundingClientRect().width > 0
      );
      return {
        wsErrorToast,
        modeSaved: !wsErrorToast && txt.includes('使用长连接接收事件') && !hasSaveBtnStill
      };
    })()`,
    true
  )) as { wsErrorToast: boolean; modeSaved: boolean };

  if (check.wsErrorToast) {
    await sleep(2500);
    await clickSaveOnce();
    check = (await wc.executeJavaScript(
      `(() => {
        const txt = document.body?.innerText || '';
        const wsErrorToast = txt.includes('未检测到应用连接信息') || txt.includes('请先建立长连接');
        return {
          wsErrorToast,
          modeSaved: !wsErrorToast && txt.includes('使用长连接接收事件')
        };
      })()`,
      true
    )) as { wsErrorToast: boolean; modeSaved: boolean };
  }

  return check;
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
      const createClick = await findAndHighlightClick(wc, '创建企业自建应用', {
        buttonsOnly: true,
        pauseAfterMs: 1100
      });
      if (createClick.clicked) {
        const fieldCount = (await wc.executeJavaScript(
          `(() => {
            const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal') || document.body;
            return Array.from(modal.querySelectorAll('input[type="text"], input:not([type]), textarea'))
              .filter((el) => el.getBoundingClientRect().width > 80 && el.getBoundingClientRect().height > 20).length;
          })()`,
          true
        )) as number;

        for (let fIdx = 0; fIdx < Math.min(2, fieldCount); fIdx++) {
          const focused = (await wc.executeJavaScript(
            `(async () => {
              const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal') || document.body;
              const fields = Array.from(modal.querySelectorAll('input[type="text"], input:not([type]), textarea'))
                .filter((el) => el.getBoundingClientRect().width > 80 && el.getBoundingClientRect().height > 20);
              const el = fields[${fIdx}];
              if (!el || !(el instanceof HTMLElement)) return false;
              const prev = el.style.outline;
              el.style.outline = '2.5px solid #10b981';
              el.focus({ preventScroll: true });
              await new Promise((r) => setTimeout(r, 380));
              el.style.outline = prev;
              return true;
            })()`,
            true
          )) as boolean;
          if (focused) {
            await typeNativeIntoFocusedElement(wc, fIdx === 0 ? botName : botDesc);
          }
        }
        await sleep(500);
        await findAndHighlightClick(wc, '^(创建|确定|确认)$', {
          insideModal: true,
          buttonsOnly: true,
          pauseAfterMs: 1300
        });

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
        `https://open.feishu.cn/app/${appId}`
      );
      await sleep(800);

      // Click the exact <button> "+ 添加" inside the "机器人" card directly on the DOM node (zero scroll drift, never clicks <a> doc links!)
      const botAddRes = (await wc.executeJavaScript(
        `(async () => {
          const allNodes = Array.from(document.querySelectorAll('div, section, li'));
          const botCards = allNodes.filter((el) => {
            if (!(el instanceof HTMLElement)) return false;
            const txt = (el.innerText || '').trim();
            if (!txt.includes('机器人')) return false;
            if (txt.includes('网页应用') && txt.includes('小程序')) return false;
            const r = el.getBoundingClientRect();
            return r.width >= 180 && r.width <= 720 && r.height >= 70 && r.height <= 400;
          });
          botCards.sort((a, b) => a.innerText.length - b.innerText.length);
          for (const card of botCards) {
            if ((card.innerText || '').includes('已添加')) {
              return { status: 'already_added' };
            }
            const btn = Array.from(card.querySelectorAll('button')).find((b) => {
              const t = (b.innerText || '').replace(/\\s+/g, '').trim();
              if (/了解|文档|详情|示例/.test(t)) return false;
              return /^(\\+?添加|添加机器人|启用)$/.test(t) && !b.hasAttribute('disabled');
            });
            if (btn && btn instanceof HTMLElement) {
              const r = btn.getBoundingClientRect();
              if (r.top < 36 || r.bottom > window.innerHeight - 36) {
                card.scrollIntoView({ behavior: 'instant', block: 'nearest' });
                await new Promise((res) => setTimeout(res, 150));
              }
              const prevOutline = btn.style.outline;
              btn.style.outline = '2.5px solid #10b981';
              btn.style.outlineOffset = '3px';
              await new Promise((res) => setTimeout(res, 650));
              btn.style.outline = prevOutline;
              btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
              btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
              btn.click();
              return { status: 'clicked' };
            }
          }
          return { status: 'not_found' };
        })()`,
        true
      )) as { status: 'already_added' | 'clicked' | 'not_found' };

      if (botAddRes.status === 'already_added') {
        completedSteps.push('「机器人」能力已处于添加状态');
        stepReport.push({ step: '2. 添加「机器人」能力', status: 'ok', detail: '已启用机器人能力' });
      } else if (botAddRes.status === 'clicked') {
        await sleep(1200);
        // Handle optional secondary confirmation button if Feishu opens a confirm modal
        await findAndHighlightClick(wc, '^(添加|确定|确认|保存)$', {
          insideModal: true,
          buttonsOnly: true,
          pauseAfterMs: 1200
        });
        await sleep(900);

        const verifiedBot = (await wc.executeJavaScript(
          `(() => {
            const menuItems = Array.from(document.querySelectorAll('aside *, nav *, [class*="menu"] *'))
              .map((el) => (el instanceof HTMLElement ? (el.innerText || '').trim() : ''));
            if (menuItems.includes('机器人')) return true;
            return (document.body?.innerText || '').includes('已添加') || location.href.includes('/bot');
          })()`,
          true
        )) as boolean;

        if (verifiedBot) {
          completedSteps.push('已自动添加并验证「机器人」能力');
          stepReport.push({ step: '2. 添加「机器人」能力', status: 'ok', detail: '成功为应用添加机器人能力' });
        } else {
          stepReport.push({
            step: '2. 添加「机器人」能力',
            status: 'warn',
            detail: '已点击机器人卡片「添加」，请确认左侧菜单「应用能力 → 机器人」已出现'
          });
        }
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

      // Layer 2: Focus Monaco's hidden inputarea directly with preventScroll + Native Clipboard wc.paste()!
      if (!editorCheck.hasScopes && editorCheck.rect && editorCheck.rect.width > 40) {
        const prevClipboard = clipboard.readText();
        try {
          clipboard.writeText(FEISHU_REQUIRED_SCOPES_JSON);
          // Focus Monaco's internal textarea directly WITHOUT triggering any page scroll!
          await wc.executeJavaScript(
            `(async () => {
              const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal');
              if (!modal) return;
              const edBox = modal.querySelector('.monaco-editor, .cm-content, textarea');
              if (edBox instanceof HTMLElement) {
                const prev = edBox.style.outline;
                edBox.style.outline = '2.5px solid #10b981';
                await new Promise((r) => setTimeout(r, 450));
                edBox.style.outline = prev;
              }
              const inputArea = modal.querySelector('.monaco-editor textarea.inputarea, .monaco-editor textarea, textarea');
              if (inputArea instanceof HTMLElement) {
                inputArea.focus({ preventScroll: true });
              }
            })()`,
            true
          );
          // Re-read stationary rect inside fixed modal without any scrollIntoView
          const freshRect = (await wc.executeJavaScript(
            `(() => {
              const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal');
              const ed = modal && modal.querySelector('.monaco-editor .view-lines, .monaco-editor, textarea');
              if (!ed) return null;
              const r = ed.getBoundingClientRect();
              return { x: r.left, y: r.top, width: r.width, height: r.height };
            })()`,
            true
          )) as { x: number; y: number; width: number; height: number } | null;

          if (freshRect && freshRect.width > 40) {
            await clickHardwareAt(
              wc,
              freshRect.x + Math.min(120, freshRect.width / 2),
              freshRect.y + Math.min(60, freshRect.height / 2)
            );
          }
          await sleep(240);
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
    await emitStep(`⚡ [4/6] 正在读取新应用 (${appId}) 的 App Secret 并建立本地飞书长连接...`);
    const extractedSecret = await extractFeishuAppSecretLocally(wc, appId);

    let wsConnectedOk = false;
    if (extractedSecret) {
      wsConnectedOk = await onCredentialsReady(appId, extractedSecret);
      await sleep(2000);
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
    const wsModeCheck = await enableFeishuLongConnectionOnPage(wc, appId);
    const wsErrorToast = wsModeCheck.wsErrorToast;
    const savedWsBtn = { clicked: wsModeCheck.modeSaved };

    let eventSubscribed = (await wc.executeJavaScript(
      `(() => (document.body?.innerText || '').includes('im.message.receive_v1'))()`,
      true
    )) as boolean;

    if (!eventSubscribed) {
      const addEv = await findAndHighlightClick(wc, '添加事件', {
        buttonsOnly: true,
        pauseAfterMs: 1100
      });
      if (addEv.clicked) {
        const searchFocused = (await wc.executeJavaScript(
          `(async () => {
            const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal') || document;
            const inp = Array.from(modal.querySelectorAll('input'))
              .find((i) => i.type !== 'checkbox' && i.type !== 'radio' && i.getBoundingClientRect().width > 80);
            if (!inp || !(inp instanceof HTMLElement)) return false;
            const prev = inp.style.outline;
            inp.style.outline = '2.5px solid #10b981';
            inp.focus({ preventScroll: true });
            await new Promise((r) => setTimeout(r, 400));
            inp.style.outline = prev;
            return true;
          })()`,
          true
        )) as boolean;

        if (searchFocused) {
          await typeNativeIntoFocusedElement(wc, 'im.message.receive_v1', true);
          await sleep(1100);
        }

        const cbClicked = (await wc.executeJavaScript(
          `(async () => {
            const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal');
            if (!modal) return false;
            const rows = Array.from(modal.querySelectorAll('label, tr, li, div')).filter((el) => {
              if (!(el instanceof HTMLElement)) return false;
              const t = el.innerText || '';
              return (t.includes('接收消息') || t.includes('im.message.receive_v1')) && el.getBoundingClientRect().height < 95;
            });
            rows.sort((a, b) => a.innerText.length - b.innerText.length);
            const target = (rows[0] && rows[0].querySelector('input[type="checkbox"], .ud__checkbox, .semi-checkbox, .arco-checkbox')) || rows[0];
            if (!target || !(target instanceof HTMLElement)) return false;
            const prev = target.style.outline;
            target.style.outline = '2.5px solid #10b981';
            await new Promise((r) => setTimeout(r, 500));
            target.style.outline = prev;
            target.click();
            return true;
          })()`,
          true
        )) as boolean;

        if (cbClicked) {
          await sleep(600);
          await findAndHighlightClick(wc, '确认添加|确定', {
            insideModal: true,
            buttonsOnly: true,
            pauseAfterMs: 1400
          });
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

    const createVerClicked = await findAndHighlightClick(wc, '创建版本', {
      buttonsOnly: true,
      pauseAfterMs: 1400
    });
    if (createVerClicked.clicked) {
      const focusedVer = (await wc.executeJavaScript(
        `(async () => {
          const verInp = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
            .find((el) => {
              const p = (el.getAttribute('placeholder') || '') + ((el.closest('[class*="item"], [class*="field"]') && el.closest('[class*="item"], [class*="field"]').innerText) || '');
              return el.getBoundingClientRect().width > 80 && /版本|1\\.0\\.0/.test(p) && !el.value;
            });
          if (!verInp || !(verInp instanceof HTMLElement)) return false;
          const prev = verInp.style.outline;
          verInp.style.outline = '2.5px solid #10b981';
          verInp.focus({ preventScroll: true });
          await new Promise((r) => setTimeout(r, 380));
          verInp.style.outline = prev;
          return true;
        })()`,
        true
      )) as boolean;
      if (focusedVer) {
        await typeNativeIntoFocusedElement(wc, '1.0.0');
      }

      const focusedNote = (await wc.executeJavaScript(
        `(async () => {
          const noteInp = Array.from(document.querySelectorAll('textarea'))
            .find((el) => el.getBoundingClientRect().width > 120 && !el.value);
          if (!noteInp || !(noteInp instanceof HTMLElement)) return false;
          const prev = noteInp.style.outline;
          noteInp.style.outline = '2.5px solid #10b981';
          noteInp.focus({ preventScroll: true });
          await new Promise((r) => setTimeout(r, 380));
          noteInp.style.outline = prev;
          return true;
        })()`,
        true
      )) as boolean;
      if (focusedNote) {
        await typeNativeIntoFocusedElement(wc, 'MuseDeck 自动配置发布');
      }
    }

    stepReport.push({
      step: '6. 版本检查与线上发布（需你最后确认点击）',
      status: 'manual',
      detail: '已停留在版本页：请确认「可用范围」包含你自己，点底部「保存」→ 右上角「申请线上发布」变为已发布！'
    });

    const secretMissing = !extractedSecret;
    const warnCount = stepReport.filter((s) => s.status === 'warn').length;
    await emitStep(
      warnCount === 0
        ? '✅ 前 5 步已全部自动完成并校验！请在当前页点「保存 → 申请线上发布」完成最后发布'
        : secretMissing
          ? '⚠️ 密钥未能自动粘入：请先点「凭证与基础信息」复制粘贴 App Secret 并连接，再保存长连接与发布版本'
          : `⚠️ 自动代配结束（有 ${warnCount} 项需留意右侧核对清单），最后请完成版本发布`,
      warnCount === 0 ? 'ok' : 'warn'
    );

    return {
      ok: warnCount === 0,
      appId,
      appSecret: extractedSecret || undefined,
      completedSteps,
      stepReport,
      nextManualHint: secretMissing
        ? '⚠️ 提醒：App Secret 密钥未能自动粘入！请点击左侧「凭证与基础信息」复制 App Secret 粘贴到上方输入框并点「连接飞书长连接」，随后在「事件与回调」点击铅笔图标→保存长连接，最后发布版本。'
        : '请在左侧版本页面点击底部「保存」→ 右上角「申请线上发布」（确认状态变为绿色「已发布」），然后点右侧「唤起机器人对话」发一句「你好」即可！',
      message:
        warnCount === 0
          ? '✅ 前 5 步全部自动配置并校验通过！最后只需在左侧点「保存 → 申请线上发布」，再点「唤起机器人对话」发一句「你好」即可！'
          : secretMissing
            ? '⚠️ 注意：App Secret 密钥未能自动粘入！请在左侧「凭证与基础信息」页点击复制 App Secret 粘贴到右侧输入框并点击「连接飞书长连接」，再去「事件与回调」点铅笔图标→保存开启长连接。'
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
