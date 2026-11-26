import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
  WebContentsView
} from 'electron';
import { BenchmarkManager } from './benchmarkManager';
import { CliRunner, DispatchRequest, RunningTaskInfo } from './cliRunner';
import {
  checkCliUpdates,
  DetectedCli,
  runCliPackageCommand,
  scanCliModels,
  scanLocalClis,
  testCliEndpoint
} from './cliScanner';
import { buildMuseBrief, ControlServer } from './controlServer';
import { FeishuBridge } from './feishuBridge';
import { QuotaManager } from './quotaManager';
import { readLocalCliSessionMessages, scanLocalCliSessions } from './sessionScanner';
import { AppSettings, CliId, CliUserConfig, FmcStore, WorkflowConfig } from './store';
import { TunnelManager } from './tunnelManager';
import { WorkflowManager } from './workflowManager';

// Disable Chromium window occlusion & background throttling so hidden Muse SPA hydrates and loads chat history immediately on startup
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let store: FmcStore;
let runner: CliRunner;
let feishu: FeishuBridge;
let controlServer: ControlServer;
let tunnel: TunnelManager;
let workflow: WorkflowManager;
let benchmarks: BenchmarkManager;
let quotas: QuotaManager;
let cachedClis: DetectedCli[] | null = null;

const embeddedViews: Record<'feishu' | 'muse', WebContentsView | null> = {
  feishu: null,
  muse: null
};
interface MuseRichAction {
  id: string;
  label: string;
  thumb?: string;
  kind: 'option' | 'approve' | 'danger' | 'action';
}

interface MuseRichMessage {
  role: 'user' | 'muse';
  text: string;
  time?: string;
  images?: Array<{ src: string; alt?: string }>;
  videos?: Array<{ src: string; poster?: string }>;
  audios?: Array<{ src: string }>;
  links?: Array<{ href: string; label: string }>;
  actions?: MuseRichAction[];
  hasInteractiveCard?: boolean;
}

let activeEmbedded: 'feishu' | 'muse' | null = null;
let museHistoryCache: MuseRichMessage[] = [];
let museInitialHydrated = false;
let pendingMuseActions: MuseRichAction[] = [];
let lastPushedActionsSig = '';
let museLivePoller: NodeJS.Timeout | null = null;

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function attachOffscreenMuse(view: WebContentsView): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.contentView.addChildView(view);
  } catch {
    // already attached
  }
  // Keep 1px overlap at the extreme bottom-right corner with a full 1024x768 desktop viewport:
  // completely invisible to the user, yet Chromium treats visibilityState === 'visible' so Muse SPA
  // immediately connects WebSocket, loads chat history, and renders its composer on app startup!
  const [cw, ch] = mainWindow.getContentSize();
  view.setBounds({
    x: Math.max(0, cw - 1),
    y: Math.max(0, ch - 1),
    width: 1024,
    height: 768
  });
}

function ensureEmbeddedView(target: 'feishu' | 'muse', initialUrl?: string): WebContentsView {
  let view = embeddedViews[target];
  if (!view) {
    const partition = target === 'muse' ? 'persist:fmc-muse' : 'persist:fmc-feishu';
    const ses = session.fromPartition(partition);
    view = new WebContentsView({
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    view.webContents.setBackgroundThrottling(false);
    // Use standard Chrome User-Agent so Feishu & Meta Muse web portals work smoothly
    const chromeUa = view.webContents.getUserAgent().replace(/Electron\/[\d.]+ /, '');
    view.webContents.setUserAgent(chromeUa);

    // Handle popups inside the same embedded view instead of losing session
    view.webContents.setWindowOpenHandler(({ url }) => {
      void view?.webContents.loadURL(url);
      return { action: 'deny' };
    });

    const defaultUrl =
      initialUrl ||
      (target === 'muse'
        ? store.getState().muse.webUrl || 'https://muse.ai'
        : 'https://open.feishu.cn/app');
    void view.webContents.loadURL(defaultUrl);
    embeddedViews[target] = view;

    // Attach Muse off-screen immediately so Chromium hydrates its React DOM without needing Web View first
    if (target === 'muse' && activeEmbedded !== 'muse') {
      attachOffscreenMuse(view);
    }
  } else if (initialUrl && view.webContents.getURL() !== initialUrl) {
    void view.webContents.loadURL(initialUrl);
  }
  return view;
}

function hideAllEmbeddedViews(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const feishuView = embeddedViews.feishu;
  if (feishuView) {
    try {
      mainWindow.contentView.removeChildView(feishuView);
    } catch {
      // not attached
    }
  }
  // Keep Muse attached off-screen (non-throttled) so sync/send/live-status work immediately without opening Web View
  const museView = embeddedViews.muse;
  if (museView) {
    attachOffscreenMuse(museView);
  }
  activeEmbedded = null;
}

function getCustomIconPaths(): { pngPath: string; icoPath: string } {
  const dir = path.join(app.getPath('userData'), 'fmc-data');
  fs.mkdirSync(dir, { recursive: true });
  return {
    pngPath: path.join(dir, 'custom-muse-icon.png'),
    icoPath: path.join(dir, 'custom-muse-icon.ico')
  };
}

function resolveDefaultAppIconPath(): string {
  const candidates = [
    path.join(process.resourcesPath, 'build', 'icon.ico'),
    path.join(process.resourcesPath, 'build', 'icon.png'),
    path.join(app.getAppPath(), 'build', 'icon.ico'),
    path.join(app.getAppPath(), 'build', 'icon.png')
  ];
  return candidates.find((p) => fs.existsSync(p)) || '';
}

function resolveAppIconPath(): string {
  try {
    const { icoPath, pngPath } = getCustomIconPaths();
    if (fs.existsSync(icoPath)) return icoPath;
    if (fs.existsSync(pngPath)) return pngPath;
  } catch {
    // ignore before app ready
  }
  return resolveDefaultAppIconPath();
}

function wrapPngAsIco(pngBuf: Buffer): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(0, 6); // 256px
  header.writeUInt8(0, 7); // 256px
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(pngBuf.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, pngBuf]);
}

function clipImageFileToSquirclePng(srcPath: string, pngOutPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ps = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($env:FMC_ICON_SRC)
$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)
$r = 56
$p = New-Object System.Drawing.Drawing2D.GraphicsPath
$p.AddArc(0, 0, $r, $r, 180, 90)
$p.AddArc($size - $r, 0, $r, $r, 270, 90)
$p.AddArc($size - $r, $size - $r, $r, $r, 0, 90)
$p.AddArc(0, $size - $r, $r, $r, 90, 90)
$p.CloseFigure()
$g.SetClip($p)
$g.FillRectangle([System.Drawing.Brushes]::WhiteSmoke, 0, 0, $size, $size)
$minSide = [int]([Math]::Min($img.Width, $img.Height) / 1.06)
$sx = [int](($img.Width - $minSide) / 2)
$sy = [int](($img.Height - $minSide) / 2)
$srcRect = New-Object System.Drawing.Rectangle($sx, $sy, $minSide, $minSide)
$dstRect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
$g.DrawImage($img, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$img.Dispose()
$bmp.Save($env:FMC_ICON_DST, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      {
        windowsHide: true,
        timeout: 15000,
        env: { ...process.env, FMC_ICON_SRC: srcPath, FMC_ICON_DST: pngOutPath }
      },
      (err) => resolve(!err && fs.existsSync(pngOutPath))
    );
  });
}

function updateWindowsShortcutsIcon(icoPath: string): Promise<number> {
  if (process.platform !== 'win32') return Promise.resolve(0);
  return new Promise((resolve) => {
    const ps = `
$ico = $env:FMC_ICO_PATH
$ws = New-Object -ComObject WScript.Shell
$dirs = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs')
)
$names = @('MuseDeck.lnk', 'Feishu Muse Commander.lnk')
$updated = 0
foreach ($d in $dirs) {
  if (-not $d -or -not (Test-Path $d)) { continue }
  foreach ($n in $names) {
    $lnk = Join-Path $d $n
    if (Test-Path $lnk) {
      try {
        $sc = $ws.CreateShortcut($lnk)
        $sc.IconLocation = "$ico,0"
        $sc.Save()
        $updated++
      } catch {}
    }
  }
}
try {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ShNotify { [DllImport("shell32.dll")] public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2); }'
  [ShNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
} catch {}
Write-Output $updated
`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      {
        windowsHide: true,
        timeout: 15000,
        env: { ...process.env, FMC_ICO_PATH: icoPath }
      },
      (_err, stdout) => {
        const count = Number.parseInt(String(stdout || '').trim(), 10);
        resolve(Number.isFinite(count) ? count : 0);
      }
    );
  });
}

function applyLiveAppIcon(iconPath: string): void {
  if (!iconPath || !fs.existsSync(iconPath)) return;
  const img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIcon(img);
  }
  if (tray && !tray.isDestroyed()) {
    tray.setImage(img.resize({ width: 16, height: 16 }));
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function ensureTray(): void {
  if (tray && !tray.isDestroyed()) return;
  const iconPath = resolveAppIconPath();
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('MuseDeck');
  const menu = Menu.buildFromTemplate([
    {
      label: '打开主窗口',
      click: () => showMainWindow()
    },
    { type: 'separator' },
    {
      label: '完全退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
}

function createMainWindow(): void {
  const iconPath = resolveAppIconPath();
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    show: true,
    title: 'MuseDeck',
    icon: iconPath || undefined,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  const devUrl = process.env.FMC_DEV_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    const behavior = store?.getState().settings?.closeBehavior || 'ask';
    if (behavior === 'quit') {
      isQuitting = true;
      return;
    }
    e.preventDefault();
    hideAllEmbeddedViews();
    if (behavior === 'tray') {
      ensureTray();
      mainWindow?.hide();
    } else {
      broadcast('window:closeRequested', {});
    }
  });

  mainWindow.on('resize', () => {
    if (activeEmbedded !== 'muse' && embeddedViews.muse) {
      attachOffscreenMuse(embeddedViews.muse);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function sendTextToMuseChat(msgText: string): Promise<{ ok: boolean; message: string }> {
  const view = ensureEmbeddedView('muse');

  // Wait for page load to settle if still navigating (max 4s, exits immediately once ready)
  const loadDeadline = Date.now() + 4000;
  while (view.webContents.isLoading() && Date.now() < loadDeadline) {
    await new Promise((r) => setTimeout(r, 150));
  }

  try {
    const js = `
      (async () => {
        const text = ${JSON.stringify(msgText)};
        const findInput = () =>
          document.querySelector('textarea') ||
          document.querySelector('[contenteditable="true"][role="textbox"]') ||
          document.querySelector('[contenteditable="true"]');

        let input = findInput();
        for (let i = 0; !input && i < 20; i++) {
          await new Promise(r => setTimeout(r, 150));
          input = findInput();
        }
        if (!input) return { ok: false, reason: 'no_input' };

        input.focus();
        if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
            || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(input, text);
          else input.value = text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(input);
          sel?.removeAllRanges();
          sel?.addRange(range);
          const inserted = document.execCommand('insertText', false, text);
          if (!inserted) {
            input.textContent = text;
          }
          input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
        }

        await new Promise(r => setTimeout(r, 150));

        // Prefer clicking the visible enabled Send button near the composer
        const form = input.closest('form') || input.parentElement?.parentElement || document;
        const sendBtn =
          form.querySelector('button[type="submit"]:not([disabled])') ||
          document.querySelector('button[aria-label*="发送"]:not([disabled])') ||
          document.querySelector('button[aria-label*="Send" i]:not([disabled])');

        if (sendBtn && sendBtn instanceof HTMLElement) {
          sendBtn.click();
          await new Promise(r => setTimeout(r, 120));
        }

        // Fallback: if input still has text, dispatch Enter key sequence
        const remaining = (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT')
          ? (input.value || '').trim()
          : (input.textContent || '').trim();
        if (remaining.length > 0) {
          input.focus();
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
          input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
          input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        }
        return { ok: true };
      })();
    `;
    const res = (await view.webContents.executeJavaScript(js, true)) as {
      ok?: boolean;
      reason?: string;
    };
    if (res?.ok) {
      return { ok: true, message: '已自动发送给 Muse' };
    }
    return {
      ok: false,
      message: '未检测到 Muse 聊天输入框（请先点右上角「网页视图」确认已登录）'
    };
  } catch (err) {
    return {
      ok: false,
      message: `自动发送失败：${err instanceof Error ? err.message : String(err)}`
    };
  }
}

let lastPushedTunnelUrl = '';
let briefSyncTimer: NodeJS.Timeout | null = null;

async function getFastClis(st: ReturnType<FmcStore['getState']>): Promise<DetectedCli[]> {
  if (cachedClis) {
    return cachedClis.map((c) => ({
      ...c,
      config: st.cliConfigs[c.id] ? { ...c.config, ...st.cliConfigs[c.id] } : c.config
    }));
  }
  cachedClis = await scanLocalClis(st);
  return cachedClis;
}

async function syncLatestBriefToMuse(force = false): Promise<{ ok: boolean; message: string }> {
  const st = store.getState();
  if (!force && st.controlApi.autoSyncToMuse === false) {
    return { ok: false, message: '已关闭自动同步' };
  }
  const clis = await getFastClis(st);
  const brief = buildMuseBrief(st, clis, benchmarks?.getCache().digest);
  const hash = crypto.createHash('sha256').update(brief).digest('hex').slice(0, 16);

  if (!force && st.muse.lastBriefHash === hash) {
    return { ok: true, message: '协议无变化，无需重复发送' };
  }

  const nextRev = (st.muse.briefRevision || 0) + 1;
  const payload = `【FMC 调度协议已更新 · 版本 Rev #${nextRev}（请覆盖旧记忆，一切以本条最新协议为准）】
以下为当前最新生效的控制接口、已启用 CLI 职能权重与工作流策略。此前历史消息中的旧地址、旧 Token、旧 CLI 列表或旧规则均已作废，请立即更新记忆并严格以本版本（Rev #${nextRev}）为准执行：

${brief}`;

  const res = await sendTextToMuseChat(payload);
  if (res.ok) {
    const updated = store.update((s) => {
      s.muse.lastBriefHash = hash;
      s.muse.briefRevision = nextRev;
      s.muse.autoBriefSynced = true;
    });
    broadcast('state:changed', updated);
    return { ok: true, message: `已同步最新协议 (Rev #${nextRev})` };
  }
  return res;
}

function scheduleBriefAutoSync(delayMs = 2500): void {
  const st = store?.getState();
  if (!st || !st.onboardingCompleted || st.controlApi.autoSyncToMuse === false) return;
  if (briefSyncTimer) clearTimeout(briefSyncTimer);
  briefSyncTimer = setTimeout(() => {
    briefSyncTimer = null;
    void syncLatestBriefToMuse(false);
  }, delayMs);
}

let lastLiveAvatarRaw = '';

async function pollMuseLiveState(): Promise<void> {
  const view = embeddedViews.muse;
  if (!view || view.webContents.isDestroyed() || view.webContents.isLoading()) return;
  try {
    const js = `
      (async () => {
        const bodyText = document.body?.innerText || '';
        const hasPendingPermission =
          bodyText.includes('总是允许此站点') || bodyText.includes('允许Muse访问');

        let statusText = '';
        let isBusy = false;

        const stopBtn =
          document.querySelector('button[aria-label*="停止"]') ||
          document.querySelector('button[aria-label*="Stop" i]');
        if (stopBtn) isBusy = true;

        const statusCandidates = Array.from(document.querySelectorAll('div, span, p')).filter((el) => {
          if (el.children.length > 2) return false;
          const r = el.getBoundingClientRect();
          if (r.top < 0 || r.top > 180 || r.width < 20 || r.height < 10 || r.height > 44) return false;
          const t = (el.innerText || '').trim();
          if (!t || t.length > 48) return false;
          return /(思考|正在|执行|分析|读取|运行|搜索|需要批准|等待|处理|生成|Thinking|Working|Running|Searching|Pending|Generating)/i.test(t);
        });
        if (statusCandidates.length > 0) {
          statusText = (statusCandidates[0].innerText || '').trim();
          isBusy = true;
        } else if (hasPendingPermission) {
          statusText = '等待批准访问';
          isBusy = true;
        } else if (isBusy) {
          statusText = '工作中...';
        }

        window.__fmcBlobCache = window.__fmcBlobCache || {};
        const resolveMediaSrc = async (src) => {
          if (!src) return '';
          if (src.startsWith('blob:')) {
            if (window.__fmcBlobCache[src]) return window.__fmcBlobCache[src];
            try {
              const resp = await fetch(src);
              const blob = await resp.blob();
              if (blob.size > 4 * 1024 * 1024) return '';
              const dataUrl = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : '');
                reader.onerror = () => resolve('');
                reader.readAsDataURL(blob);
              });
              if (dataUrl) window.__fmcBlobCache[src] = dataUrl;
              return dataUrl;
            } catch {
              return '';
            }
          }
          return src;
        };

        let avatarUrl = '';
        let avatarKind = '';
        const topVideos = Array.from(document.querySelectorAll('video')).filter((v) => {
          const r = v.getBoundingClientRect();
          return r.top >= 0 && r.top < 200 && r.width >= 28 && r.width <= 260;
        });
        if (topVideos.length > 0) {
          const rawSrc = topVideos[0].currentSrc || topVideos[0].src || '';
          const resolved = await resolveMediaSrc(rawSrc);
          if (resolved && (/^https?:\/\//i.test(resolved) || resolved.startsWith('data:'))) {
            avatarUrl = resolved;
            avatarKind = 'video';
          }
        }
        if (!avatarUrl) {
          const topImgs = Array.from(document.querySelectorAll('img')).filter((img) => {
            const r = img.getBoundingClientRect();
            const src = img.currentSrc || img.src || '';
            return (
              r.top >= 0 &&
              r.top < 200 &&
              r.width >= 28 &&
              r.width <= 220 &&
              (/^https?:\/\//i.test(src) || src.startsWith('blob:') || src.startsWith('data:image/'))
            );
          });
          // Prefer the centered Muse avatar (closest to horizontal center of viewport)
          if (topImgs.length > 0) {
            const midX = window.innerWidth / 2;
            topImgs.sort((a, b) => {
              const ar = a.getBoundingClientRect();
              const br = b.getBoundingClientRect();
              return Math.abs(ar.left + ar.width / 2 - midX) - Math.abs(br.left + br.width / 2 - midX);
            });
            const rawSrc = topImgs[0].currentSrc || topImgs[0].src || '';
            const resolved = await resolveMediaSrc(rawSrc);
            if (resolved) {
              avatarUrl = resolved;
              avatarKind = 'image';
            }
          }
        }

        return { isBusy, statusText, hasPendingPermission, avatarUrl, avatarKind };
      })();
    `;
    const res = (await view.webContents.executeJavaScript(js, true)) as {
      isBusy?: boolean;
      statusText?: string;
      hasPendingPermission?: boolean;
      avatarUrl?: string;
      avatarKind?: 'image' | 'video';
    };

    const st = store.getState();
    const port = st.controlApi.port || 18787;
    const token = encodeURIComponent(st.controlApi.token || '');
    const rawAvatar = res?.avatarUrl || '';
    const proxiedAvatar =
      rawAvatar && /^https?:\/\//i.test(rawAvatar) && !rawAvatar.startsWith(`http://127.0.0.1:${port}/api/v1/muse-media`)
        ? `http://127.0.0.1:${port}/api/v1/muse-media?token=${token}&url=${encodeURIComponent(rawAvatar)}`
        : rawAvatar;

    // Immediately persist & broadcast whenever Muse's top avatar changes (e.g. outfit change or live animation)
    if (proxiedAvatar && rawAvatar !== lastLiveAvatarRaw) {
      lastLiveAvatarRaw = rawAvatar;
      const nextState = store.update((s) => {
        s.muse.avatarUrl = proxiedAvatar;
        s.muse.avatarKind = res?.avatarKind || 'image';
      });
      broadcast('state:changed', nextState);
    }

    broadcast('muse:liveState', {
      isBusy: Boolean(res?.isBusy),
      statusText: res?.statusText || '',
      hasPendingPermission: Boolean(res?.hasPendingPermission),
      avatarUrl: proxiedAvatar || undefined,
      avatarKind: res?.avatarKind || undefined
    });
  } catch {
    // ignore transient page reload errors
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('state:get', () => store.getState());

  ipcMain.handle('onboarding:complete', () => {
    const st = store.update((s) => {
      s.onboardingCompleted = true;
    });
    hideAllEmbeddedViews();
    broadcast('state:changed', st);
    return st;
  });

  ipcMain.handle('onboarding:reset', () => {
    const st = store.update((s) => {
      s.onboardingCompleted = false;
    });
    hideAllEmbeddedViews();
    broadcast('state:changed', st);
    return st;
  });

  ipcMain.handle('muse:updateConfig', (_ev, patch: { webUrl?: string; autoBriefSynced?: boolean }) => {
    const st = store.update((s) => {
      if (patch.webUrl !== undefined) s.muse.webUrl = patch.webUrl;
      if (patch.autoBriefSynced !== undefined) s.muse.autoBriefSynced = patch.autoBriefSynced;
    });
    broadcast('state:changed', st);
    return st;
  });

  ipcMain.handle(
    'controlApi:update',
    (
      _ev,
      patch: {
        tunnelUrl?: string;
        regenerateToken?: boolean;
        autoStartTunnel?: boolean;
        autoSyncToMuse?: boolean;
      }
    ) => {
      const st = store.update((s) => {
        if (patch.tunnelUrl !== undefined) s.controlApi.tunnelUrl = patch.tunnelUrl;
        if (patch.autoStartTunnel !== undefined) s.controlApi.autoStartTunnel = patch.autoStartTunnel;
        if (patch.autoSyncToMuse !== undefined) s.controlApi.autoSyncToMuse = patch.autoSyncToMuse;
        if (patch.regenerateToken) s.controlApi.token = crypto.randomBytes(16).toString('hex');
      });
      broadcast('state:changed', st);
      if (patch.tunnelUrl !== undefined || patch.regenerateToken) {
        scheduleBriefAutoSync(1800);
      }
      return st;
    }
  );

  ipcMain.handle('permission:set', (_ev, level: import('./store').PermissionLevel) => {
    const st = store.update((s) => {
      s.permissionLevel = level;
    });
    broadcast('state:changed', st);
    return st;
  });

  ipcMain.handle('muse:sendChat', async (_ev, text: string) => {
    return sendTextToMuseChat(text);
  });

  ipcMain.handle('muse:readMessages', async () => {
    const view = ensureEmbeddedView('muse');
    if (!view || view.webContents.isDestroyed()) {
      return { messages: museHistoryCache, hasPendingPermission: false };
    }
    try {
      const keepBottom = activeEmbedded !== 'muse';
      const js = `
        (async () => {
          const bodyText = document.body?.innerText || '';
          const hasPendingPermission = bodyText.includes('总是允许此站点') || bodyText.includes('允许Muse访问');

          // When hidden in native mode, keep the scroll container near bottom so latest replies are mounted
          if (${keepBottom}) {
            const scrollers = Array.from(document.querySelectorAll('main, [class*="scroll"], [class*="chat"], div'))
              .filter((el) => el.scrollHeight > el.clientHeight + 100 && el.clientHeight > 200);
            if (scrollers.length > 0) {
              scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight);
              scrollers[0].scrollTop = scrollers[0].scrollHeight;
            }
          }

          window.__fmcBlobCache = window.__fmcBlobCache || {};
          const blobToDataUrl = async (blobUrl) => {
            if (!blobUrl || !blobUrl.startsWith('blob:')) return blobUrl;
            if (window.__fmcBlobCache[blobUrl]) return window.__fmcBlobCache[blobUrl];
            try {
              const resp = await fetch(blobUrl);
              const blob = await resp.blob();
              if (blob.size > 6 * 1024 * 1024) return '';
              const dataUrl = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : '');
                reader.onerror = () => resolve('');
                reader.readAsDataURL(blob);
              });
              if (dataUrl) window.__fmcBlobCache[blobUrl] = dataUrl;
              return dataUrl;
            } catch {
              return '';
            }
          };

          const UI_NOISE = new Set([
            '聊天', '邀请', '消息', '打开预览', '允许', '拒绝', '总是允许此站点',
            '显示更多', '加载更多', '查看更多', '展开', '收起', '滚动到底部', '新消息',
            'Show more', 'Load more', 'Allow', 'Deny', 'Always allow', 'Muse'
          ]);

          // Collect floating time divider labels (e.g. "23:06", "今天 19:53", "昨天 21:20") with their Y coordinate
          const timeDividers = [];
          for (const td of Array.from(document.querySelectorAll('time, div, span, p'))) {
            if (td.children.length > 1 || td.closest('header, nav, aside, form')) continue;
            const txt = (td.textContent || '').trim();
            if (/^(?:今天|昨天|前天|\d{1,2}月\d{1,2}日|\d{4}[/-]\d{1,2}[/-]\d{1,2})?\s*\d{1,2}:\d{2}(?::\d{2})?$/.test(txt)) {
              const tr = td.getBoundingClientRect();
              if (tr.height > 0 && tr.height < 40) {
                timeDividers.push({ top: tr.top, text: txt });
              }
            }
          }
          timeDividers.sort((a, b) => a.top - b.top);

          const candidates = Array.from(
            document.querySelectorAll('[class*="message"], [class*="bubble"], [role="article"], main p, main div')
          );
          const seenKeys = new Set();
          const extracted = [];

          for (const el of candidates) {
            if (el.closest('header, nav, aside, form, button, [role="dialog"]')) continue;
            const hasQuickMedia = el.querySelector('img, video, audio, canvas, iframe') !== null;
            if (el.children.length > (hasQuickMedia ? 24 : 14)) continue;

            const rect = el.getBoundingClientRect();
            if (rect.width < 50 || rect.height < 14) continue;

            // Collect rich media inside this message candidate
            const imgs = [];
            const seenImgSrc = new Set();
            for (const img of Array.from(el.querySelectorAll('img'))) {
              if (img.closest('header, nav, aside, button')) continue;
              const ir = img.getBoundingClientRect();
              const nw = img.naturalWidth || ir.width || 0;
              const nh = img.naturalHeight || ir.height || 0;
              // Filter out tiny icons and circular chat avatars (< 64px)
              if (Math.max(ir.width, nw) < 64 || Math.max(ir.height, nh) < 64) continue;
              const altLower = (img.alt || '').toLowerCase();
              const clsLower = (typeof img.className === 'string' ? img.className : '').toLowerCase();
              if ((altLower.includes('avatar') || clsLower.includes('avatar')) && ir.width <= 72) continue;
              let src = img.currentSrc || img.src || '';
              if (!src) continue;
              if (src.startsWith('blob:')) {
                src = await blobToDataUrl(src);
              }
              if (!src || seenImgSrc.has(src)) continue;
              seenImgSrc.add(src);
              imgs.push({ src, alt: img.alt || '' });
            }

            // Also capture large CSS background-image cards (common in Muse share/preview cards)
            for (const bgEl of Array.from(el.querySelectorAll('div, span, figure'))) {
              const br = bgEl.getBoundingClientRect();
              if (br.width < 90 || br.height < 90) continue;
              const bgImg = window.getComputedStyle(bgEl).backgroundImage || '';
              const m = bgImg.match(/url\\(["']?([^"')]+)["']?\\)/i);
              if (!m || !m[1]) continue;
              let src = m[1];
              if (src.startsWith('blob:')) src = await blobToDataUrl(src);
              if (!src || seenImgSrc.has(src)) continue;
              seenImgSrc.add(src);
              imgs.push({ src, alt: 'Muse card image' });
            }

            // Capture large rendered canvases (e.g. charts/diagrams)
            for (const cv of Array.from(el.querySelectorAll('canvas'))) {
              const cr = cv.getBoundingClientRect();
              if (cr.width < 110 || cr.height < 80) continue;
              try {
                const dataUrl = cv.toDataURL('image/png');
                if (dataUrl && dataUrl.length > 200 && !seenImgSrc.has(dataUrl)) {
                  seenImgSrc.add(dataUrl);
                  imgs.push({ src: dataUrl, alt: 'Canvas' });
                }
              } catch {}
            }

            const videos = [];
            const seenVid = new Set();
            for (const v of Array.from(el.querySelectorAll('video'))) {
              if (v.closest('header, nav, aside')) continue;
              const vr = v.getBoundingClientRect();
              if (vr.width < 80 || vr.height < 60) continue;
              const src = v.currentSrc || v.src || '';
              if (!src || seenVid.has(src)) continue;
              seenVid.add(src);
              videos.push({ src, poster: v.poster || '' });
            }

            const audios = [];
            const seenAud = new Set();
            for (const a of Array.from(el.querySelectorAll('audio'))) {
              const src = a.currentSrc || a.src || '';
              if (!src || seenAud.has(src)) continue;
              seenAud.add(src);
              audios.push({ src });
            }

            const links = [];
            const seenHref = new Set();
            for (const a of Array.from(el.querySelectorAll('a[href]'))) {
              if (a.closest('header, nav, aside')) continue;
              const href = a.href || '';
              if (!/^https?:\\/\\//i.test(href) || seenHref.has(href)) continue;
              seenHref.add(href);
              const label = (a.innerText || a.getAttribute('title') || href).trim().slice(0, 80);
              links.push({ href, label: label || href });
            }

            const hasIframe = el.querySelector('iframe') !== null;

            // Extract interactive action/option buttons (e.g. avatar picker options, permission approve/deny, card CTA buttons)
            const actions = [];
            const seenActionLabels = new Set();
            const BTN_IGNORE = /^(复制|点赞|点踩|回复|更多|分享|重新生成|朗读|收起|展开|Copy|Like|Dislike|Reply|More|Share)$/i;
            window.__fmcActCounter = window.__fmcActCounter || 1;
            for (const btn of Array.from(el.querySelectorAll('button, [role="button"]'))) {
              if (btn.closest('header, nav, aside, form')) continue;
              const br = btn.getBoundingClientRect();
              if (br.width < 26 || br.height < 18) continue;
              const label = (btn.innerText || btn.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 48);
              if (!label || BTN_IGNORE.test(label) || seenActionLabels.has(label)) continue;
              seenActionLabels.add(label);

              let actId = btn.getAttribute('data-fmc-action-id');
              if (!actId) {
                actId = 'fmc-act-' + (window.__fmcActCounter++);
                btn.setAttribute('data-fmc-action-id', actId);
              }
              let thumb = '';
              const bImg = btn.querySelector('img');
              if (bImg) {
                let s = bImg.currentSrc || bImg.src || '';
                if (s.startsWith('blob:')) s = await blobToDataUrl(s);
                if (s) thumb = s;
              }
              const kind =
                /(总是允许|允许|批准|确认|同意|Allow|Approve|Confirm)/i.test(label)
                  ? 'approve'
                  : /(拒绝|取消|删除|Deny|Reject|Cancel)/i.test(label)
                    ? 'danger'
                    : /(选项|候选|方案|Option|Choice)/i.test(label) || Boolean(thumb)
                      ? 'option'
                      : 'action';
              actions.push({ id: actId, label, thumb: thumb || undefined, kind });
            }

            const rawText = (el.innerText || '').trim();
            const isNoiseText =
              !rawText ||
              rawText.length < 2 ||
              rawText.length > 12000 ||
              UI_NOISE.has(rawText) ||
              /^\\d{1,2}:\\d{2}$/.test(rawText) ||
              /^(今天|昨天)\\s*\\d{1,2}:\\d{2}$/.test(rawText) ||
              /^(显示更多|加载更多|有新消息|滚动到底部)/.test(rawText);

            const hasMedia = imgs.length > 0 || videos.length > 0 || audios.length > 0 || hasIframe || actions.length > 0;
            if (isNoiseText && !hasMedia) continue;

            const cleanText = isNoiseText ? '' : rawText;
            const hasInteractiveCard =
              hasIframe ||
              Boolean(
                Array.from(el.querySelectorAll('button')).find((b) =>
                  /(打开预览|预览|Preview|运行|查看详情)/i.test((b.innerText || '').trim())
                )
              );

            const style = window.getComputedStyle(el);
            const bg = style.backgroundColor || '';
            const isUser =
              bg.includes('180, 213') ||
              bg.includes('173, 216') ||
              bg.includes('59, 130') ||
              rect.left > window.innerWidth * 0.38;

            const dedupeKey =
              (isUser ? 'u' : 'm') +
              '::' +
              cleanText +
              '::' +
              imgs.map((i) => i.src.slice(0, 96)).join(',') +
              '::' +
              videos.map((v) => v.src.slice(0, 96)).join(',') +
              '::' +
              actions.map((a) => a.label).join('|');

            if (seenKeys.has(dedupeKey)) continue;
            seenKeys.add(dedupeKey);

            let msgTime = '';
            const timeEl =
              el.querySelector('time') ||
              el.parentElement?.querySelector('time') ||
              el.nextElementSibling?.querySelector?.('time');
            if (timeEl) {
              msgTime = (timeEl.textContent || timeEl.getAttribute('datetime') || '').trim().slice(0, 24);
            }
            if (!msgTime && el.parentElement) {
              const sibText = Array.from(el.parentElement.children)
                .map((c) => (c.textContent || '').trim())
                .find((t) => /^(?:今天|昨天)?\s*\d{1,2}:\d{2}(?::\d{2})?$/.test(t));
              if (sibText) msgTime = sibText;
            }

            if (!msgTime && timeDividers.length > 0) {
              // Find the closest time divider positioned above this message
              let nearest = '';
              for (const td of timeDividers) {
                if (td.top <= rect.top + 8) nearest = td.text;
                else break;
              }
              if (nearest) msgTime = nearest;
            }

            extracted.push({
              role: isUser ? 'user' : 'muse',
              text: cleanText,
              time: msgTime || undefined,
              _top: Math.round(rect.top),
              images: imgs.length > 0 ? imgs : undefined,
              videos: videos.length > 0 ? videos : undefined,
              audios: audios.length > 0 ? audios : undefined,
              links: links.length > 0 ? links.slice(0, 6) : undefined,
              actions: !isUser && actions.length > 0 ? actions.slice(0, 8) : undefined,
              hasInteractiveCard: hasInteractiveCard || undefined
            });
          }

          // Deduplicate subsets: drop item if another extracted item contains both its text and its media
          const filtered = extracted.filter((item, idx) => {
            return !extracted.some((other, j) => {
              if (j === idx) return false;
              const otherTextLen = other.text.length;
              const itemTextLen = item.text.length;
              const otherMediaCount = (other.images?.length || 0) + (other.videos?.length || 0) + (other.audios?.length || 0);
              const itemMediaCount = (item.images?.length || 0) + (item.videos?.length || 0) + (item.audios?.length || 0);
              const strictlyRicher =
                otherTextLen > itemTextLen ||
                (otherTextLen === itemTextLen && otherMediaCount > itemMediaCount);
              if (!strictlyRicher) return false;
              const textCovered = !item.text || other.text.includes(item.text);
              const imgsCovered =
                !item.images ||
                item.images.every((im) => other.images?.some((om) => om.src === im.src));
              const vidsCovered =
                !item.videos ||
                item.videos.every((vi) => other.videos?.some((ov) => ov.src === vi.src));
              return textCovered && imgsCovered && vidsCovered;
            });
          });
          // Sort strictly top-to-bottom by visual Y coordinate so chronological order is always preserved
          filtered.sort((a, b) => (a._top ?? 0) - (b._top ?? 0));
          return {
            messages: filtered.slice(-80).map(({ _top, ...rest }) => rest),
            hasPendingPermission
          };
        })();
      `;
      const res = (await view.webContents.executeJavaScript(js, true)) as {
        messages: MuseRichMessage[];
        hasPendingPermission: boolean;
      };

      const st = store.getState();
      const port = st.controlApi.port || 18787;
      const token = encodeURIComponent(st.controlApi.token || '');
      const proxyMediaUrl = (u: string) => {
        if (!u || !/^https?:\/\//i.test(u)) return u;
        if (u.startsWith(`http://127.0.0.1:${port}/api/v1/muse-media`)) return u;
        return `http://127.0.0.1:${port}/api/v1/muse-media?token=${token}&url=${encodeURIComponent(u)}`;
      };

      const proxiedMessages: MuseRichMessage[] = (res.messages || []).map((m) => ({
        ...m,
        images: m.images?.map((im) => ({ ...im, src: proxyMediaUrl(im.src) })),
        videos: m.videos?.map((vi) => ({
          src: proxyMediaUrl(vi.src),
          poster: vi.poster ? proxyMediaUrl(vi.poster) : undefined
        })),
        audios: m.audios?.map((au) => ({ src: proxyMediaUrl(au.src) })),
        actions: m.actions?.map((a) => ({
          ...a,
          thumb: a.thumb ? proxyMediaUrl(a.thumb) : undefined
        }))
      }));

      // Auto-detect latest Muse interactive choice/approval widget & forward to Feishu for remote clicking
      const lastWithActions = [...proxiedMessages]
        .reverse()
        .find((m) => m.role === 'muse' && m.actions && m.actions.length >= 2);
      if (lastWithActions?.actions && lastWithActions.actions.length >= 2) {
        const sig = lastWithActions.actions.map((a) => a.label).join('|');
        pendingMuseActions = lastWithActions.actions;
        if (sig !== lastPushedActionsSig) {
          lastPushedActionsSig = sig;
          const chatId = store.getState().feishu.lastChatId || '';
          if (chatId && feishu?.getStatus().state === 'connected') {
            const lines = lastWithActions.actions.map((a, idx) => `${idx + 1}. ${a.label}`);
            const promptText = `🤔 【Muse 等待你做出选择】\n${lastWithActions.text ? `${lastWithActions.text.slice(0, 260)}\n\n` : ''}${lines.join('\n')}\n\n👉 直接回复数字（1~${lastWithActions.actions.length}）或按钮名称，电脑端会自动为你点击对应选项。`;
            void (async () => {
              await feishu.sendText(chatId, promptText);
              const thumbs = lastWithActions.actions!
                .map((a) => a.thumb)
                .filter((t): t is string => Boolean(t))
                .slice(0, 4);
              for (const t of thumbs) {
                await feishu.sendImage(chatId, t);
              }
            })();
          }
        }
      }

      if (proxiedMessages.length > 0) {
        const keyOf = (m: MuseRichMessage) =>
          `${m.role}::${m.text}::${(m.images || []).map((i) => i.src.slice(0, 120)).join('|')}::${(m.videos || []).map((v) => v.src.slice(0, 120)).join('|')}`;
        const nowTimeLabel = new Date().toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit'
        });
        const isFirstHydrate = !museInitialHydrated;
        museInitialHydrated = true;

        if (museHistoryCache.length === 0) {
          // Initial load: keep ONLY real timestamps found in Muse DOM (never fabricate app-startup time!)
          museHistoryCache = proxiedMessages.map((item) => ({
            ...item,
            time: item.time || undefined
          }));
        } else {
          // Anchor-based chronological merge:
          // Older scrolled-up messages are prepended BEFORE the first shared anchor,
          // while genuinely new messages are appended AFTER the last shared anchor!
          const cacheIndexByKey = new Map<string, number>();
          museHistoryCache.forEach((m, idx) => cacheIndexByKey.set(keyOf(m), idx));

          let firstAnchorInNew = -1;
          let firstAnchorInCache = -1;
          let lastAnchorInNew = -1;
          let lastAnchorInCache = -1;

          proxiedMessages.forEach((item, newIdx) => {
            const k = keyOf(item);
            let cIdx = cacheIndexByKey.get(k);
            if (cIdx === undefined && item.text) {
              const upIdx = museHistoryCache.findIndex(
                (old) => old.role === item.role && old.text === item.text
              );
              if (upIdx !== -1) cIdx = upIdx;
            }
            if (cIdx !== undefined) {
              // Refresh media/actions in place while preserving original timestamp
              museHistoryCache[cIdx] = {
                ...item,
                time: museHistoryCache[cIdx].time || item.time
              };
              if (firstAnchorInNew === -1) {
                firstAnchorInNew = newIdx;
                firstAnchorInCache = cIdx;
              }
              lastAnchorInNew = newIdx;
              lastAnchorInCache = cIdx;
            }
          });

          if (firstAnchorInNew === -1) {
            // No overlap (e.g. switched chat or jumped far): replace cleanly with top-to-bottom DOM order
            museHistoryCache = proxiedMessages.map((item) => ({
              ...item,
              time: item.time || (isFirstHydrate ? undefined : nowTimeLabel)
            }));
          } else {
            const existingKeys = new Set(museHistoryCache.map(keyOf));
            // 1. Prepend older messages appearing ABOVE the first anchor (no fake current time!)
            const olderToInsert: MuseRichMessage[] = [];
            for (let i = 0; i < firstAnchorInNew; i++) {
              const item = proxiedMessages[i];
              const k = keyOf(item);
              if (!existingKeys.has(k)) {
                olderToInsert.push({ ...item, time: item.time || undefined });
                existingKeys.add(k);
              }
            }
            if (olderToInsert.length > 0) {
              museHistoryCache.splice(firstAnchorInCache, 0, ...olderToInsert);
              lastAnchorInCache += olderToInsert.length;
            }

            // 2. Append newer messages appearing BELOW the last anchor (stamp live time if no DOM time)
            const newerToAppend: MuseRichMessage[] = [];
            for (let i = lastAnchorInNew + 1; i < proxiedMessages.length; i++) {
              const item = proxiedMessages[i];
              const k = keyOf(item);
              if (!existingKeys.has(k)) {
                newerToAppend.push({
                  ...item,
                  time: item.time || (isFirstHydrate ? undefined : nowTimeLabel)
                });
                existingKeys.add(k);
              }
            }
            if (newerToAppend.length > 0) {
              museHistoryCache.splice(lastAnchorInCache + 1, 0, ...newerToAppend);
            }
          }
        }
        // Deduplicate streaming partial-prefix snapshots (e.g. half-streamed reply superseded by full reply)
        museHistoryCache = museHistoryCache.filter((item, idx) => {
          if (!item.text || item.text.length < 4) return true;
          const itemMediaCount = (item.images?.length || 0) + (item.videos?.length || 0);
          return !museHistoryCache.some((other, j) => {
            if (j === idx || other.role !== item.role) return false;
            if (other.text.length <= item.text.length) return false;
            const otherMediaCount = (other.images?.length || 0) + (other.videos?.length || 0);
            if (otherMediaCount < itemMediaCount) return false;
            return other.text.startsWith(item.text) || other.text.includes(item.text);
          });
        });

        if (museHistoryCache.length > 120) {
          museHistoryCache = museHistoryCache.slice(-120);
        }
      }
      return {
        messages: museHistoryCache.length > 0 ? museHistoryCache : proxiedMessages,
        hasPendingPermission: res.hasPendingPermission
      };
    } catch {
      return { messages: museHistoryCache, hasPendingPermission: false };
    }
  });

  ipcMain.handle('muse:clickAction', async (_ev, actionId: string) => {
    const view = ensureEmbeddedView('muse');
    if (!view || view.webContents.isDestroyed()) {
      return { ok: false, message: 'Muse 视图未就绪' };
    }
    try {
      const ok = (await view.webContents.executeJavaScript(
        `(() => {
          const el = document.querySelector('[data-fmc-action-id=${JSON.stringify(actionId)}]');
          if (!el || !(el instanceof HTMLElement)) return false;
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        })()`,
        true
      )) as boolean;
      if (ok) {
        pendingMuseActions = [];
      }
      return ok
        ? { ok: true, message: '已触发对应选项' }
        : { ok: false, message: '该选项已过期或不存在，可切至网页视图查看' };
    } catch (err) {
      return {
        ok: false,
        message: `点击失败：${err instanceof Error ? err.message : String(err)}`
      };
    }
  });

  ipcMain.handle(
    'muse:saveMediaFile',
    async (_ev, url: string, suggestedName?: string) => {
      try {
        if (!url) return { ok: false, message: '无效的媒体地址' };
        let buf: Buffer;
        let ext = '.png';

        if (url.startsWith('data:')) {
          const match = url.match(/^data:([^;]+);base64,(.+)$/);
          if (!match) return { ok: false, message: '不支持的数据格式' };
          const mime = match[1].toLowerCase();
          if (mime.includes('jpeg') || mime.includes('jpg')) ext = '.jpg';
          else if (mime.includes('webp')) ext = '.webp';
          else if (mime.includes('gif')) ext = '.gif';
          else if (mime.includes('mp4')) ext = '.mp4';
          buf = Buffer.from(match[2], 'base64');
        } else if (/^https?:\/\//i.test(url)) {
          // If it's our local proxy URL, unwrap original URL and fetch with persist:muse session
          let targetUrl = url;
          try {
            const u = new URL(url);
            if (u.pathname === '/api/v1/muse-media' && u.searchParams.get('url')) {
              targetUrl = u.searchParams.get('url')!;
            }
          } catch {
            // ignore
          }
          const resp = await session.fromPartition('persist:muse').fetch(targetUrl);
          if (!resp.ok) return { ok: false, message: `下载失败 (HTTP ${resp.status})` };
          const ct = (resp.headers.get('content-type') || '').toLowerCase();
          if (ct.includes('jpeg') || ct.includes('jpg')) ext = '.jpg';
          else if (ct.includes('webp')) ext = '.webp';
          else if (ct.includes('gif')) ext = '.gif';
          else if (ct.includes('mp4')) ext = '.mp4';
          buf = Buffer.from(await resp.arrayBuffer());
        } else {
          return { ok: false, message: '不支持的地址类型' };
        }

        const defaultName = (suggestedName || `muse-media-${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_');
        const finalName = path.extname(defaultName) ? defaultName : `${defaultName}${ext}`;
        const picked = await dialog.showSaveDialog({
          title: '保存 Muse 媒体文件',
          defaultPath: path.join(app.getPath('downloads'), finalName)
        });
        if (picked.canceled || !picked.filePath) {
          return { ok: false, message: '已取消保存' };
        }
        fs.writeFileSync(picked.filePath, buf);
        return { ok: true, savedPath: picked.filePath, message: '已保存到本地' };
      } catch (err) {
        return {
          ok: false,
          message: `保存失败：${err instanceof Error ? err.message : String(err)}`
        };
      }
    }
  );

  ipcMain.handle('muse:syncTunnel', async () => {
    return syncLatestBriefToMuse(true);
  });

  ipcMain.handle('muse:fetchAvatar', async () => {
    try {
      const view = ensureEmbeddedView('muse');
      if (view.webContents.isLoading()) {
        await new Promise((r) => setTimeout(r, 2500));
      }
      const js = `
        (async () => {
          const toDataUrl = async (url) => {
            try {
              const resp = await fetch(url);
              const blob = await resp.blob();
              if (blob.size > 4 * 1024 * 1024) return '';
              return await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : '');
                reader.onerror = () => resolve('');
                reader.readAsDataURL(blob);
              });
            } catch {
              return '';
            }
          };

          // 1. Look for animated <video> avatar (Muse often uses looping mp4/webm)
          const videos = Array.from(document.querySelectorAll('video'));
          for (const v of videos) {
            const rect = v.getBoundingClientRect();
            const src = v.currentSrc || v.src || v.querySelector('source')?.src || '';
            if (!src) continue;
            if (rect.width >= 32 && rect.width <= 360 && rect.height >= 32 && rect.height <= 360) {
              if (src.startsWith('blob:')) {
                const data = await toDataUrl(src);
                if (data) return { ok: true, kind: 'video', url: data };
              } else {
                return { ok: true, kind: 'video', url: src };
              }
            }
          }

          // 2. Look for avatar <img> (preferring square/circular images near header or with avatar/muse hints)
          const imgs = Array.from(document.querySelectorAll('img')).filter((img) => {
            const src = img.currentSrc || img.src || '';
            if (!src || src.startsWith('data:image/svg')) return false;
            const rect = img.getBoundingClientRect();
            const w = rect.width || img.naturalWidth;
            const h = rect.height || img.naturalHeight;
            if (w < 28 || h < 28 || w > 420 || h > 420) return false;
            const ratio = w / h;
            return ratio >= 0.65 && ratio <= 1.5;
          });

          const scoreImg = (img) => {
            let score = 0;
            const meta = (
              (img.alt || '') + ' ' + (img.className || '') + ' ' + (img.src || '')
            ).toLowerCase();
            if (/muse|avatar|mascot|character|bot|agent|profile/.test(meta)) score += 50;
            const rect = img.getBoundingClientRect();
            if (rect.top >= 0 && rect.top < 260) score += 25;
            if (rect.width >= 40 && rect.width <= 180) score += 15;
            const br = window.getComputedStyle(img).borderRadius || '';
            if (br.includes('50%') || br.includes('999')) score += 20;
            return score;
          };

          imgs.sort((a, b) => scoreImg(b) - scoreImg(a));
          if (imgs.length > 0) {
            const best = imgs[0];
            const src = best.currentSrc || best.src;
            if (src.startsWith('blob:')) {
              const data = await toDataUrl(src);
              if (data) return { ok: true, kind: 'image', url: data };
            } else {
              // Convert authenticated image to dataURL so it renders reliably in renderer without cookies
              const data = await toDataUrl(src);
              return { ok: true, kind: 'image', url: data || src };
            }
          }

          // 3. Fallback: WebGL / 2D <canvas> avatar snapshot
          const canvases = Array.from(document.querySelectorAll('canvas'));
          for (const c of canvases) {
            const rect = c.getBoundingClientRect();
            if (rect.width >= 36 && rect.width <= 320 && rect.height >= 36 && rect.height <= 320) {
              try {
                const data = c.toDataURL('image/png');
                if (data && data.length > 200) return { ok: true, kind: 'image', url: data };
              } catch {}
            }
          }

          return { ok: false, message: '未在当前 Muse 页面检测到形象，请先在「网页视图」登录 Muse 账号' };
        })();
      `;
      const res = (await view.webContents.executeJavaScript(js, true)) as {
        ok?: boolean;
        kind?: 'image' | 'video';
        url?: string;
        message?: string;
      };
      if (res?.ok && res.url) {
        const st = store.update((s) => {
          s.muse.avatarUrl = res.url;
          s.muse.avatarKind = res.kind || 'image';
        });
        broadcast('state:changed', st);
        return { ok: true, kind: res.kind || 'image', url: res.url };
      }
      return { ok: false, message: res?.message || '未检测到 Muse 形象' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : '读取 Muse 形象失败'
      };
    }
  });

  ipcMain.handle('cli:scan', async () => {
    cachedClis = await scanLocalClis(store.getState());
    return cachedClis;
  });

  ipcMain.handle('cli:checkUpdates', async () => {
    const clis = await scanLocalClis(store.getState());
    return checkCliUpdates(clis);
  });

  ipcMain.handle('cli:install', async (_ev, cliId: string) => {
    const res = await runCliPackageCommand(cliId, 'install', (text) => {
      broadcast('cli:pkgLog', { cliId, action: 'install', text });
    });
    const clis = await scanLocalClis(store.getState());
    return { ...res, clis };
  });

  ipcMain.handle('cli:update', async (_ev, cliId: string) => {
    const res = await runCliPackageCommand(cliId, 'update', (text) => {
      broadcast('cli:pkgLog', { cliId, action: 'update', text });
    });
    const clis = await scanLocalClis(store.getState());
    return { ...res, clis };
  });

  ipcMain.handle('cli:uninstall', async (_ev, cliId: string) => {
    const res = await runCliPackageCommand(cliId, 'uninstall', (text) => {
      broadcast('cli:pkgLog', { cliId, action: 'uninstall', text });
    });
    const clis = await scanLocalClis(store.getState());
    return { ...res, clis };
  });

  ipcMain.handle('cli:testEndpoint', async (_ev, cliId: string, draft: Partial<CliUserConfig>) => {
    return testCliEndpoint(cliId, draft);
  });

  ipcMain.handle('cli:getQuota', async (_ev, cliId: string, force = false) => {
    return quotas.getQuota(cliId, force);
  });

  ipcMain.handle('cli:scanModels', async (_ev, cliId: string, draft?: Partial<CliUserConfig>) => {
    return scanCliModels(cliId, draft);
  });

  ipcMain.handle('cli:saveConfig', (_ev, cliId: string, cfg: CliUserConfig) => {
    const st = store.update((s) => {
      s.cliConfigs[cliId] = cfg;
    });
    broadcast('state:changed', st);
    scheduleBriefAutoSync(2500);
    return st;
  });

  ipcMain.handle(
    'app:applyMuseDesktopIcon',
    async (_ev, payload?: { pngDataUrl?: string; avatarUrl?: string }) => {
      try {
        const { pngPath, icoPath } = getCustomIconPaths();
        let pngBuf: Buffer | null = null;

        if (payload?.pngDataUrl && payload.pngDataUrl.startsWith('data:image/png;base64,')) {
          const b64 = payload.pngDataUrl.slice('data:image/png;base64,'.length);
          pngBuf = Buffer.from(b64, 'base64');
          fs.writeFileSync(pngPath, pngBuf);
        } else {
          const rawUrl = (payload?.avatarUrl || store.getState().muse.avatarUrl || '').trim();
          if (!rawUrl) {
            return { ok: false, message: '当前没有可用的 Muse 形象，请先同步账号形象' };
          }
          const tmpSrc = path.join(path.dirname(pngPath), 'custom-muse-icon-src.bin');
          if (rawUrl.startsWith('data:image/')) {
            const commaIdx = rawUrl.indexOf(',');
            if (commaIdx === -1) return { ok: false, message: '无效的图片数据' };
            fs.writeFileSync(tmpSrc, Buffer.from(rawUrl.slice(commaIdx + 1), 'base64'));
          } else if (/^https?:\/\//i.test(rawUrl)) {
            const resp = await fetch(rawUrl);
            if (!resp.ok) return { ok: false, message: `下载 Muse 形象失败 (HTTP ${resp.status})` };
            const arr = Buffer.from(await resp.arrayBuffer());
            fs.writeFileSync(tmpSrc, arr);
          } else {
            return { ok: false, message: '暂不支持当前 Muse 形象地址格式' };
          }
          const clipped = await clipImageFileToSquirclePng(tmpSrc, pngPath);
          try {
            fs.unlinkSync(tmpSrc);
          } catch {
            // ignore
          }
          if (!clipped) {
            return { ok: false, message: '裁剪 Muse 形象为图标失败（视频格式请稍后再试）' };
          }
          pngBuf = fs.readFileSync(pngPath);
        }

        const icoBuf = wrapPngAsIco(pngBuf);
        fs.writeFileSync(icoPath, icoBuf);
        applyLiveAppIcon(pngPath);
        const updatedShortcuts = await updateWindowsShortcutsIcon(icoPath);
        return {
          ok: true,
          message:
            updatedShortcuts > 0
              ? `已将当前 Muse 形象设为应用图标，并同步更新了 ${updatedShortcuts} 个桌面/开始菜单快捷方式`
              : '已将当前 Muse 形象设为窗口与托盘图标（未找到桌面快捷方式，重新安装或创建快捷方式后即可生效）'
        };
      } catch (err) {
        return {
          ok: false,
          message: `生成桌面图标失败：${err instanceof Error ? err.message : String(err)}`
        };
      }
    }
  );

  ipcMain.handle('app:resetDesktopIcon', async () => {
    try {
      const { pngPath, icoPath } = getCustomIconPaths();
      if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath);
      if (fs.existsSync(icoPath)) fs.unlinkSync(icoPath);
      const defaultIcon = resolveDefaultAppIconPath();
      if (defaultIcon) {
        applyLiveAppIcon(defaultIcon);
        await updateWindowsShortcutsIcon(defaultIcon);
      }
      return { ok: true, message: '已恢复 MuseDeck 默认图标' };
    } catch (err) {
      return {
        ok: false,
        message: `恢复默认图标失败：${err instanceof Error ? err.message : String(err)}`
      };
    }
  });

  ipcMain.handle(
    'project:create',
    (
      _ev,
      input: { name: string; description?: string; repoPath?: string; createdBy?: 'user' | 'muse' }
    ) => {
      const proj = store.addProject({
        name: input.name,
        description: input.description,
        repoPath: input.repoPath,
        createdBy: input.createdBy || 'user'
      });
      broadcast('state:changed', store.getState());
      return proj;
    }
  );

  ipcMain.handle(
    'project:update',
    (
      _ev,
      id: string,
      patch: { name?: string; description?: string; repoPath?: string; allowedClis?: string[] | null }
    ) => {
      store.updateProject(id, patch);
      const st = store.getState();
      broadcast('state:changed', st);
      return st;
    }
  );

  ipcMain.handle('project:delete', (_ev, id: string) => {
    store.deleteProject(id);
    const st = store.getState();
    broadcast('state:changed', st);
    return st;
  });

  ipcMain.handle('sessions:scanLocal', (_ev, repoPath?: string) => {
    return scanLocalCliSessions(repoPath);
  });

  ipcMain.handle(
    'sessions:importLocal',
    (
      _ev,
      items: Array<{
        cliId: CliId;
        externalSessionId: string;
        filePath: string;
        cwd: string;
        title: string;
      }>,
      targetProjectId?: string
    ) => {
      let importedCount = 0;
      for (const item of items || []) {
        const parsed = readLocalCliSessionMessages(item.cliId, item.filePath);
        if (!parsed.meta || parsed.messages.length === 0) continue;

        let projId = targetProjectId;
        if (!projId) {
          const existingByPath = item.cwd
            ? store
                .getState()
                .projects.find(
                  (p) =>
                    p.repoPath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() ===
                    item.cwd.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
                )
            : undefined;
          if (existingByPath) {
            projId = existingByPath.id;
          } else if (item.cwd) {
            const created = store.addProject({
              name: path.basename(item.cwd) || parsed.meta.projectGuessName,
              description: `从本地 ${item.cliId} 历史会话自动归类导入`,
              repoPath: item.cwd,
              createdBy: 'user'
            });
            projId = created.id;
          } else {
            projId = store.getState().projects[0]?.id || 'proj-default';
          }
        }

        const already = (store.getState().sessions || []).find(
          (s) => s.projectId === projId && s.externalSessionId === item.externalSessionId
        );
        if (already) continue;

        const now = new Date().toISOString();
        const sessionId = `sess-${crypto.randomBytes(4).toString('hex')}`;
        store.update((s) => {
          if (!Array.isArray(s.sessions)) s.sessions = [];
          s.sessions.unshift({
            id: sessionId,
            projectId: projId!,
            cliId: item.cliId,
            title: item.title || parsed.meta!.title,
            externalSessionId: item.externalSessionId,
            source: 'imported',
            createdAt: parsed.messages[0]?.timestamp || now,
            updatedAt: parsed.meta!.updatedAt || now
          });
        });

        for (const msg of parsed.messages.slice(-40)) {
          store.addMessage({
            projectId: projId!,
            sessionId,
            source: msg.role === 'user' ? 'user' : 'cli',
            agentId: item.cliId,
            role: msg.role === 'user' ? 'directive' : 'output',
            title: msg.role === 'user' ? '本地历史提问（已导入）' : `${item.cliId} 历史回复`,
            content: msg.content,
            status: 'done'
          });
        }
        importedCount += 1;
      }
      const st = store.getState();
      broadcast('state:changed', st);
      return { state: st, importedCount };
    }
  );

  ipcMain.handle('sessions:create', (_ev, projectId: string, cliId: CliId, title?: string) => {
    const now = new Date().toISOString();
    const session = {
      id: `sess-${crypto.randomBytes(4).toString('hex')}`,
      projectId,
      cliId,
      title: (title || '').trim() || `新对话 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
      source: 'local' as const,
      createdAt: now,
      updatedAt: now
    };
    const st = store.update((s) => {
      if (!Array.isArray(s.sessions)) s.sessions = [];
      s.sessions.unshift(session);
    });
    broadcast('state:changed', st);
    return { state: st, session };
  });

  ipcMain.handle('benchmarks:get', () => benchmarks.getCache());
  ipcMain.handle('benchmarks:refresh', async () => {
    const data = await benchmarks.refresh(true);
    scheduleBriefAutoSync(1800);
    return data;
  });

  ipcMain.handle('shell:openPath', async (_ev, targetPath: string) => {
    if (!targetPath || !fs.existsSync(targetPath)) return false;
    await shell.openPath(targetPath);
    return true;
  });

  ipcMain.handle('dialog:pickDirectory', async () => {
    if (!mainWindow) return '';
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    });
    return res.canceled ? '' : res.filePaths[0] || '';
  });

  ipcMain.handle('task:dispatch', async (_ev, req: DispatchRequest) => {
    return runner.dispatch(req);
  });

  ipcMain.handle('task:cancel', (_ev, taskId: string) => {
    return runner.cancel(taskId);
  });

  ipcMain.handle('muse:getBrief', async () => {
    const clis = await scanLocalClis(store.getState());
    return buildMuseBrief(store.getState(), clis, benchmarks?.getCache().digest);
  });

  ipcMain.handle('feishu:status', () => feishu.getStatus());

  ipcMain.handle('feishu:checkSetup', async (_ev, rawAppId?: string, rawAppSecret?: string) => {
    const st = store.getState();
    const appId = (rawAppId ?? st.feishu.appId ?? '').trim();
    const appSecret = (rawAppSecret ?? st.feishu.appSecret ?? '').trim();
    const wsStatus = feishu.getStatus();
    const wsConnected = wsStatus.state === 'connected';
    const messageVerified = Boolean(wsStatus.verified || st.feishu.verified);

    if (!appId || !appSecret) {
      return {
        hasCredentials: false,
        credentialsValid: false,
        botEnabled: false,
        wsConnected,
        messageVerified
      };
    }

    try {
      const tokenResp = await fetch(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
          signal: AbortSignal.timeout(7000)
        }
      );
      const tokenJson = (await tokenResp.json()) as {
        code?: number;
        msg?: string;
        tenant_access_token?: string;
      };
      if (tokenJson.code !== 0 || !tokenJson.tenant_access_token) {
        return {
          hasCredentials: true,
          credentialsValid: false,
          botEnabled: false,
          wsConnected,
          messageVerified,
          error: tokenJson.msg || `凭证校验失败 (code=${tokenJson.code})`
        };
      }

      // Probe Bot Info API to verify "机器人" capability is added and app is published
      let botEnabled = false;
      let botName: string | undefined;
      try {
        const botResp = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
          headers: { Authorization: `Bearer ${tokenJson.tenant_access_token}` },
          signal: AbortSignal.timeout(7000)
        });
        const botJson = (await botResp.json()) as {
          code?: number;
          bot?: { app_name?: string; open_id?: string };
        };
        if (botJson.code === 0 && botJson.bot?.open_id) {
          botEnabled = true;
          botName = botJson.bot.app_name;
        }
      } catch {
        // bot info probe optional
      }

      return {
        hasCredentials: true,
        credentialsValid: true,
        botEnabled,
        botName,
        wsConnected,
        messageVerified
      };
    } catch (err) {
      return {
        hasCredentials: true,
        credentialsValid: false,
        botEnabled: false,
        wsConnected,
        messageVerified,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  });

  ipcMain.handle('feishu:connect', async (_ev, appId: string, appSecret: string) => {
    return feishu.connect(appId, appSecret);
  });

  ipcMain.handle('feishu:disconnect', () => {
    feishu.disconnect();
    return feishu.getStatus();
  });

  ipcMain.handle('feishu:sendTest', async (_ev, text: string) => {
    const chatId = store.getState().feishu.lastChatId || '';
    if (!chatId) return false;
    return feishu.sendText(chatId, text);
  });

  // Built-in Embedded Tailscale, Serveo 443, Cloudflare & Custom VPS SSH Reverse Tunnel controls
  ipcMain.handle('tunnel:status', () => tunnel.getStatus());
  ipcMain.handle('tunnel:startTailscale', async () => tunnel.startTailscale());
  ipcMain.handle('tunnel:startServeo', async () => tunnel.startServeo());
  ipcMain.handle('tunnel:start', async () => tunnel.start());
  ipcMain.handle('tunnel:startSsh', async (_ev, cfg?: Record<string, unknown>) =>
    tunnel.startSsh(cfg as Partial<import('./store').SshTunnelConfig>)
  );
  ipcMain.handle('tunnel:stop', () => tunnel.stop());
  ipcMain.handle('shell:openExternal', async (_ev, url: string) => {
    if (url && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  // Embedded Chromium WebContentsView controls
  ipcMain.handle(
    'browser:show',
    (
      _ev,
      target: 'feishu' | 'muse',
      bounds: { x: number; y: number; width: number; height: number },
      url?: string
    ) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      if (activeEmbedded && activeEmbedded !== target) {
        hideAllEmbeddedViews();
      }
      const view = ensureEmbeddedView(target, url);
      if (activeEmbedded !== target) {
        mainWindow.contentView.addChildView(view);
        activeEmbedded = target;
      }
      view.setBounds({
        x: Math.max(0, Math.round(bounds.x)),
        y: Math.max(0, Math.round(bounds.y)),
        width: Math.max(100, Math.round(bounds.width)),
        height: Math.max(100, Math.round(bounds.height))
      });
      return true;
    }
  );

  ipcMain.handle('browser:hideAll', () => {
    hideAllEmbeddedViews();
    return true;
  });

  ipcMain.handle('browser:navigate', (_ev, target: 'feishu' | 'muse', url: string) => {
    const v = embeddedViews[target];
    if (v && url.trim()) {
      const normalized = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
      void v.webContents.loadURL(normalized);
      return true;
    }
    return false;
  });

  ipcMain.handle('browser:reload', (_ev, target: 'feishu' | 'muse') => {
    embeddedViews[target]?.webContents.reload();
    return true;
  });

  ipcMain.handle('browser:goBack', (_ev, target: 'feishu' | 'muse') => {
    const v = embeddedViews[target];
    if (v && v.webContents.navigationHistory.canGoBack()) {
      v.webContents.navigationHistory.goBack();
      return true;
    }
    return false;
  });

  ipcMain.handle('settings:update', (_ev, patch: Partial<AppSettings>) => {
    const st = store.update((s) => {
      s.settings = {
        ...s.settings,
        ...patch
      };
    });
    if (typeof patch.launchAtLogin === 'boolean') {
      try {
        app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
      } catch {
        // ignore if unsupported in dev environment
      }
    }
    broadcast('state:changed', st);
    return st;
  });

  ipcMain.handle('window:closeAction', (_ev, action: 'tray' | 'quit', remember: boolean) => {
    if (remember) {
      const st = store.update((s) => {
        s.settings = { ...s.settings, closeBehavior: action };
      });
      broadcast('state:changed', st);
    }
    if (action === 'tray') {
      ensureTray();
      hideAllEmbeddedViews();
      mainWindow?.hide();
    } else {
      isQuitting = true;
      app.quit();
    }
    return true;
  });

  ipcMain.handle('shell:openDataDir', async () => {
    const dir = path.join(app.getPath('userData'), 'fmc-data');
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return true;
  });

  ipcMain.handle('workflow:updateConfig', (_ev, patch: Partial<WorkflowConfig>) => {
    const st = store.update((s) => {
      s.workflow = { ...s.workflow, ...patch };
    });
    broadcast('state:changed', st);
    broadcast('workflow:status', workflow.getStatus());
    scheduleBriefAutoSync(2500);
    return st;
  });

  ipcMain.handle('workflow:status', () => workflow.getStatus());
  ipcMain.handle('workflow:approveProject', () =>
    workflow.approveProject(() => broadcast('state:changed', store.getState()))
  );
  ipcMain.handle('workflow:approvePlan', () => workflow.approvePlan());
  ipcMain.handle('workflow:approve', () => workflow.approveByUser());
  ipcMain.handle('workflow:addBudget', (_ev, extraTokens?: number) =>
    workflow.addBudgetAndResume(extraTokens || 100000)
  );
  ipcMain.handle('workflow:feedback', (_ev, text: string) => workflow.sendUserFeedback(text));
  ipcMain.handle('workflow:reset', () => workflow.reset());
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

app.whenReady().then(async () => {
  store = new FmcStore();
  runner = new CliRunner(store, (event, payload) => {
    broadcast(event, payload);
    broadcast('state:changed', store.getState());
    if (event === 'task:finished' && workflow) {
      workflow.onTaskFinished(payload as RunningTaskInfo);
    }
  });
  feishu = new FeishuBridge(
    store,
    runner,
    (status) => broadcast('feishu:status', status),
    () => broadcast('state:changed', store.getState()),
    async (text) => {
      const trimmed = text.trim();
      // Stage 0: Remote click on pending Muse interactive choice/permission buttons from Feishu!
      if (pendingMuseActions.length > 0) {
        const numMatch = trimmed.match(/^(?:选|选择|点|点击|第)?\s*(\d+)\s*$/);
        let matchedAction: MuseRichAction | undefined;
        if (numMatch) {
          const idx = Number.parseInt(numMatch[1], 10) - 1;
          if (idx >= 0 && idx < pendingMuseActions.length) {
            matchedAction = pendingMuseActions[idx];
          }
        } else {
          matchedAction = pendingMuseActions.find(
            (a) => a.label.toLowerCase() === trimmed.toLowerCase()
          );
        }
        if (matchedAction) {
          const view = ensureEmbeddedView('muse');
          const clicked = await view.webContents
            .executeJavaScript(
              `(() => {
                const el = document.querySelector('[data-fmc-action-id=${JSON.stringify(matchedAction.id)}]');
                if (!el || !(el instanceof HTMLElement)) return false;
                el.scrollIntoView({ block: 'center' });
                el.click();
                return true;
              })()`,
              true
            )
            .catch(() => false);
          if (clicked) {
            pendingMuseActions = [];
            const chatId = store.getState().feishu.lastChatId;
            if (chatId) {
              void feishu.sendText(chatId, `✅ 已在电脑端为你点击「${matchedAction.label}」！`);
            }
            return { ok: true, message: `已远程点击「${matchedAction.label}」` };
          }
        }
      }

      const wfStatus = workflow?.getStatus();
      // Stage 1: Natural-language approval from Feishu when awaiting project routing approval
      if (wfStatus?.phase === 'awaiting_project_approval') {
        if (/^(批准|同意|通过|开始|可以|好的?|没问题|行|ok|okay|yes|go|lgtm|approve|确认)[！!。.~～\s]*$/i.test(trimmed)) {
          const nextWf = await workflow.approveProject(() => broadcast('state:changed', store.getState()));
          const chatId = store.getState().feishu.lastChatId;
          if (chatId) {
            void feishu.sendText(
              chatId,
              `✅ 已确认项目归属：《${nextWf.approvedProjectName || '默认总控台'}》，Muse 正在为你整理具体执行方案...`
            );
          }
          return { ok: true, message: '项目归属已批准' };
        }
        await workflow.reviseProjectFeedback(trimmed);
        return { ok: true, message: '已将项目归属修改意见发给 Muse 调整' };
      }
      // Stage 2: Natural-language approval from Feishu when awaiting pre-execution plan approval
      if (wfStatus?.phase === 'awaiting_plan_approval') {
        if (/^(批准|同意|通过|开始|开工|启动|可以|好的?|没问题|行|ok|okay|yes|go|lgtm|approve)[！!。.~～\s]*$/i.test(trimmed)) {
          await workflow.approvePlan();
          const chatId = store.getState().feishu.lastChatId;
          if (chatId) {
            void feishu.sendText(chatId, '✅ 已批准执行方案，Muse 正在按计划派单开工！');
          }
          return { ok: true, message: '执行方案已批准，正在开工' };
        }
        await workflow.revisePlanFeedback(trimmed);
        return { ok: true, message: '已将方案修改意见发给 Muse 调整' };
      }
      // Natural-language approval from Feishu when awaiting user verification
      if (
        wfStatus?.phase === 'awaiting_user' &&
        /^(满意|通过|可以|ok|没问题|结项|完成|好|好的)[！!。.~～\s]*$/i.test(trimmed)
      ) {
        workflow.approveByUser();
        const chatId = store.getState().feishu.lastChatId;
        if (chatId) {
          void feishu.sendText(chatId, '✅ 已确认验收通过，本次工作流已结项！有新需求随时发我。');
        }
        return { ok: true, message: '工作流已验收结项' };
      }
      if (wfStatus?.phase === 'awaiting_user' || wfStatus?.phase === 'paused_budget') {
        await workflow.sendUserFeedback(trimmed);
        return { ok: true, message: '已将修改意见发给 Muse 继续迭代' };
      }
      workflow?.startNewGoal(trimmed);
      const prompt = `【来自手机飞书的新需求】${trimmed}\n（请先调用 GET /api/v1/projects 查看现有项目列表，然后先调用 POST /api/v1/workflow/propose-project 单独问我此次任务应归入哪个已有项目还是新建项目；等我批准项目归属后，再继续制定执行方案与派单。）`;
      return sendTextToMuseChat(prompt);
    }
  );
  workflow = new WorkflowManager(
    store,
    (st) => broadcast('workflow:status', st),
    (msg) => sendTextToMuseChat(msg),
    async (msg) => {
      const chatId = store.getState().feishu.lastChatId || '';
      if (!chatId) return false;
      return feishu.sendText(chatId, msg);
    }
  );
  benchmarks = new BenchmarkManager();
  benchmarks.startDailyScheduler(store.getState().workflow?.autoFetchBenchmarks !== false);
  quotas = new QuotaManager(store);
  controlServer = new ControlServer(store, runner, feishu, workflow, benchmarks, quotas, () =>
    broadcast('state:changed', store.getState())
  );
  tunnel = new TunnelManager(
    store,
    (status) => {
      broadcast('tunnel:status', status);
      if (status.state === 'running' && status.url && status.url !== lastPushedTunnelUrl) {
        lastPushedTunnelUrl = status.url;
        scheduleBriefAutoSync(2000);
      }
    },
    () => broadcast('state:changed', store.getState())
  );

  await controlServer.start();
  registerIpcHandlers();
  createMainWindow();

  // Auto-reconnect Feishu if credentials already saved
  const savedState = store.getState();
  if (savedState.feishu.appId && savedState.feishu.appSecret) {
    void feishu.connect(savedState.feishu.appId, savedState.feishu.appSecret);
  }

  // Auto-start embedded permanent Tailscale Funnel tunnel on app launch if onboarding completed
  if (savedState.onboardingCompleted && savedState.controlApi.autoStartTunnel !== false) {
    void tunnel.startTailscale();
  }
  // Pre-warm hidden Muse web session in background so first click on Sync / Send is instant
  if (savedState.onboardingCompleted) {
    ensureEmbeddedView('muse');
    if (museLivePoller) clearInterval(museLivePoller);
    museLivePoller = setInterval(() => {
      void pollMuseLiveState();
    }, 2500);
  }
  // Check if protocol changed since last launch (e.g. after app upgrade) and auto-sync to Muse
  if (savedState.onboardingCompleted && savedState.controlApi.autoSyncToMuse !== false) {
    scheduleBriefAutoSync(6000);
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (museLivePoller) {
    clearInterval(museLivePoller);
    museLivePoller = null;
  }
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
  tunnel?.stop();
  feishu?.disconnect();
  controlServer?.stop();
});

app.on('window-all-closed', () => {
  if (isQuitting && process.platform !== 'darwin') {
    app.quit();
  }
});
