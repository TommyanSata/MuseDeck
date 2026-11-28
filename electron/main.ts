import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  Tray,
  WebContentsView
} from 'electron';
import {
  checkAppUpdate,
  downloadAndInstallUpdate,
  resolveWhatsNewForVersion
} from './appUpdater';
import { BenchmarkManager } from './benchmarkManager';
import {
  detectMuseChromeExtension,
  launchMuseExtensionHost,
  LocalBrowserController,
  runFeishuLocalAutoPilot
} from './browserAutoPilot';
import { CliRunner, DispatchRequest, RunningTaskInfo } from './cliRunner';
import {
  checkCliUpdates,
  DetectedCli,
  runCliPackageCommand,
  scanCliModels,
  scanLocalClis,
  testCliEndpoint
} from './cliScanner';
import { buildMuseBrief, ControlServer, isWithinQuietHours } from './controlServer';
import { FeishuBridge, FeishuIncomingContext } from './feishuBridge';
import { FeishuSpotlightController } from './feishuSpotlightGuide';
import { QuotaManager } from './quotaManager';
import {
  buildMuseRoleRecommendationPrompt,
  buildSingleCliMuseRolePrompt,
  computeSingleCliModelRecommendation,
  computeSmartRoleRecommendations
} from './roleRecommender';
import { readLocalCliSessionMessages, scanLocalCliSessions } from './sessionScanner';
import {
  AppSettings,
  CliId,
  CliPresetCliSnapshot,
  CliPresetGroup,
  CliUserConfig,
  FmcStore,
  UserProfileConfig,
  WorkflowConfig
} from './store';
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
let localBrowser: LocalBrowserController;
let feishuSpotlight: FeishuSpotlightController | null = null;
let feishuPopupWin: BrowserWindow | null = null;
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
let pendingFeishuTurn: {
  startedAt: number;
  sawBusy: boolean;
  baselineMuseText: string;
} | null = null;
let lastDirectFeishuPushAt = 0;

function syncUserApprovalFromChatOrButton(rawText: string): void {
  const t = (rawText || '').trim();
  if (!t || !workflow) return;
  const st = workflow.getStatus();
  if (st.phase === 'awaiting_project_approval') {
    if (
      /^(?:批准|同意|通过|开始|可以|好的?|没问题|行|ok|okay|yes|go|lgtm|approve|确认|放这里|新建|用当前)/i.test(t)
    ) {
      workflow.markApprovedSilently('project', () => broadcast('state:changed', store.getState()));
    }
  } else if (st.phase === 'awaiting_plan_approval') {
    if (
      /^(?:批准|同意|通过|开始|开工|启动|可以|好的?|没问题|行|ok|okay|yes|go|lgtm|approve|确认|[12])$|(?:推荐配置|默认配置|推荐方案|默认方案|第一套|第二套|方案\s*[12]|选\s*[12])/i.test(
        t
      )
    ) {
      workflow.markApprovedSilently('plan', () => broadcast('state:changed', store.getState()));
    }
  } else if (st.phase === 'awaiting_user') {
    if (/^(?:满意|通过|结项|完成)[！!。.~～\s]*$/i.test(t)) {
      workflow.approveByUser();
    }
  }
}
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

    // Keep app console routes inside the same view; block doc/external popups from hijacking or spawning windows
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (target === 'feishu') {
        if (
          /^https:\/\/open\.feishu\.cn\/app(\/|$|\?)/i.test(url) ||
          /^https:\/\/(accounts|passport)\.feishu\.cn\//i.test(url)
        ) {
          void view?.webContents.loadURL(url);
        }
        return { action: 'deny' };
      }
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

function syncDetectedFeishuAppId(detectedAppId: string): void {
  const prev = store.getState().feishu;
  if (prev.appId === detectedAppId) return;
  feishu.disconnect();
  const next = store.update((s) => {
    s.feishu.appId = detectedAppId;
    s.feishu.appSecret = '';
    s.feishu.verified = false;
    s.feishu.verifiedAppId = undefined;
    s.feishu.verifiedAt = undefined;
    s.feishu.lastChatId = undefined;
    s.feishu.lastSenderOpenId = undefined;
    s.feishu.lastPingMessage = undefined;
  });
  broadcast('state:changed', next);
}

function hideAllEmbeddedViews(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  feishuSpotlight?.detach();
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

async function sendTextToMuseChat(
  msgText: string,
  imagePaths?: string[]
): Promise<{ ok: boolean; message: string }> {
  const view = ensureEmbeddedView('muse');

  // Wait for page load to settle if still navigating (max 4s, exits immediately once ready)
  const loadDeadline = Date.now() + 4000;
  while (view.webContents.isLoading() && Date.now() < loadDeadline) {
    await new Promise((r) => setTimeout(r, 150));
  }

  try {
    // Optional: natively paste user-sent Feishu screenshots into Muse's composer before text!
    if (imagePaths && imagePaths.length > 0) {
      const focusedInput = (await view.webContents.executeJavaScript(
        `(() => {
          const inp =
            document.querySelector('textarea') ||
            document.querySelector('[contenteditable="true"][role="textbox"]') ||
            document.querySelector('[contenteditable="true"]');
          if (inp && inp instanceof HTMLElement) {
            inp.focus({ preventScroll: true });
            return true;
          }
          return false;
        })()`,
        true
      )) as boolean;

      if (focusedInput) {
        const prevText = clipboard.readText();
        const prevImg = clipboard.readImage();
        try {
          for (const imgPath of imagePaths.slice(0, 4)) {
            if (!fs.existsSync(imgPath)) continue;
            const nImg = nativeImage.createFromPath(imgPath);
            if (nImg.isEmpty()) continue;
            clipboard.writeImage(nImg);
            view.webContents.focus();
            view.webContents.paste();
            await new Promise((r) => setTimeout(r, 600));
          }
        } finally {
          if (!prevImg.isEmpty()) {
            clipboard.writeImage(prevImg);
          } else {
            clipboard.writeText(prevText);
          }
        }
      }
    }

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
      markMuseInteraction();
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
let lastMuseInteractionAt = 0;
let proactiveBaselineReady = false;
let lastObservedMuseReply = '';

function markMuseInteraction(): void {
  lastMuseInteractionAt = Date.now();
}

function deliverProactiveMuseThought(
  rawText: string,
  actions?: Array<{ id: string; label: string }>
): void {
  const cleaned = rawText.trim();
  if (!cleaned || cleaned.length < 4) return;
  // Skip automatic protocol revision acks
  if (/^Rev\s*#\d+/i.test(cleaned)) return;

  const st = store.getState();
  if (st.muse.lastProactiveText && cleaned === st.muse.lastProactiveText) {
    return;
  }

  const nowIso = new Date().toISOString();
  const nextState = store.update((s) => {
    s.muse.unreadProactiveCount = (s.muse.unreadProactiveCount || 0) + 1;
    s.muse.lastProactiveText = cleaned.slice(0, 800);
    s.muse.lastProactiveAt = nowIso;
  });
  broadcast('state:changed', nextState);
  broadcast('muse:proactiveThought', {
    text: cleaned,
    at: nowIso,
    quietHours: isWithinQuietHours(nextState.workflow)
  });

  const wf = nextState.workflow;
  if (wf?.proactivePushEnabled === false) {
    return;
  }
  // Respect Night Do-Not-Disturb window (default 23:00-08:00): keep quiet desktop badge only
  if (isWithinQuietHours(wf)) {
    return;
  }

  // 1. Native Windows Desktop Notification (useful when minimized to tray or coding in IDE)
  try {
    if (Notification.isSupported()) {
      const notif = new Notification({
        title: '💡 Muse 主动思考追问',
        body: cleaned.replace(/\s+/g, ' ').slice(0, 140)
      });
      notif.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
      });
      notif.show();
    }
  } catch {
    // ignore notification errors
  }

  // 2. Push to Feishu so user can reply to Muse's proactive question right from their phone!
  const chatId = nextState.feishu.lastChatId || '';
  if (chatId && feishu?.getStatus().state === 'connected') {
    lastDirectFeishuPushAt = Date.now();
    if (actions && actions.length >= 2) {
      pendingMuseActions = actions.map((a) => ({
        id: a.id,
        label: a.label,
        kind: 'option'
      }));
      const opts = actions.map((a, i) => `${i + 1}. ${a.label}`).join('\n');
      void feishu.sendText(
        chatId,
        `💡 【Muse 主动思考追问】\n${cleaned.slice(0, 1300)}\n\n${opts}\n👉 直接回复序号 1~${actions.length} 或文字即可继续和 Muse 敲定结论！`
      );
    } else {
      void feishu.sendText(
        chatId,
        `💡 【Muse 主动思考追问】\n${cleaned.slice(0, 1400)}\n\n👉 直接在此回复文字即可回传给电脑端 Muse 继续探讨！`
      );
    }
  }
}

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
  const baseUrl = st.controlApi.tunnelUrl.trim() || `http://127.0.0.1:${st.controlApi.port}`;
  const endpointSig = `${baseUrl}|${st.controlApi.token}`;

  // ZERO CHAT POLLUTION RULE:
  // Once initial onboarding handshake succeeded and neither tunnelUrl nor token changed,
  // NEVER inject Rev #N brief updates into the user's chat! All config/weight/CLI/question changes
  // are already delivered silently in real time via HTTP _livePolicy on every /api/v1/* call!
  if (!force && st.muse.autoBriefSynced && st.muse.lastSyncedEndpointSig === endpointSig) {
    return { ok: true, message: '最新策略已通过 HTTP 通道静默生效（无需向聊天框发送协议）' };
  }

  const clis = await getFastClis(st);
  const brief = buildMuseBrief(st, clis, benchmarks?.getCache().digest);
  const hash = crypto.createHash('sha256').update(brief).digest('hex').slice(0, 16);

  if (!force && st.muse.lastBriefHash === hash) {
    return { ok: true, message: '协议无变化，无需重复发送' };
  }

  const nextRev = (st.muse.briefRevision || 0) + 1;
  const payload = `【MuseDeck 调度协议握手 · Rev #${nextRev}（请静默记住接口凭证，简短回复一句已就绪即可）】
${brief}`;

  const res = await sendTextToMuseChat(payload);
  if (res.ok) {
    const updated = store.update((s) => {
      s.muse.lastBriefHash = hash;
      s.muse.lastSyncedEndpointSig = endpointSig;
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

        // Also extract latest Muse reply & option buttons so background Feishu auto-reply works even in tray/other tabs
        let latestMuseReply = '';
        const bgActions = [];
        const allBubbles = Array.from(
          document.querySelectorAll('[class*="message"], [class*="bubble"], [role="article"], main div')
        ).filter((el) => {
          if (el.closest('header, nav, aside, form, button, [role="dialog"]')) return false;
          if (el.children.length > 16) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 60 || r.height < 16 || r.left > window.innerWidth * 0.36) return false;
          const txt = (el.innerText || '').trim();
          return txt.length >= 2 && txt.length < 8000;
        });
        if (allBubbles.length > 0) {
          const lastEl = allBubbles[allBubbles.length - 1];
          latestMuseReply = (lastEl.innerText || '').trim();
          window.__fmcActCounter = window.__fmcActCounter || 1;
          for (const b of Array.from(lastEl.querySelectorAll('button, [role="button"]'))) {
            const lbl = (b.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 48);
            if (!lbl || /^(复制|点赞|点踩|回复|更多|分享|Copy|Like|Dislike)$/i.test(lbl)) continue;
            let aid = b.getAttribute('data-fmc-action-id');
            if (!aid) {
              aid = 'fmc-act-' + (window.__fmcActCounter++);
              b.setAttribute('data-fmc-action-id', aid);
            }
            bgActions.push({ id: aid, label: lbl });
          }
        }

        return { isBusy, statusText, hasPendingPermission, avatarUrl, avatarKind, latestMuseReply, bgActions };
      })();
    `;
    const res = (await view.webContents.executeJavaScript(js, true)) as {
      isBusy?: boolean;
      statusText?: string;
      hasPendingPermission?: boolean;
      avatarUrl?: string;
      avatarKind?: 'image' | 'video';
      latestMuseReply?: string;
      bgActions?: Array<{ id: string; label: string }>;
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

    // Background Feishu auto-forward fallback:
    // If a Feishu message was sent to Muse, and Muse finished replying in chat WITHOUT calling Feishu API
    // (or popped up site-permission / config-choice buttons), push it to Feishu automatically!
    if (res?.hasPendingPermission) {
      const permSig = '__site_perm__';
      if (lastPushedActionsSig !== permSig) {
        lastPushedActionsSig = permSig;
        const chatId = store.getState().feishu.lastChatId || '';
        if (chatId && feishu?.getStatus().state === 'connected') {
          void feishu.sendText(
            chatId,
            '🔐 【Muse 站点访问权限确认】\nMuse 正在请求访问你的本地穿透接口。请直接回复「总是允许」或「1」，电脑端将自动为你点击「总是允许此站点」！'
          );
        }
      }
    }

    if (pendingFeishuTurn) {
      if (res?.isBusy) {
        pendingFeishuTurn.sawBusy = true;
      }
      const elapsed = Date.now() - pendingFeishuTurn.startedAt;
      const latestText = (res?.latestMuseReply || '').trim();
      const hasNewReply = Boolean(latestText && latestText !== pendingFeishuTurn.baselineMuseText);
      const apiAlreadyPushed =
        Math.max(controlServer?.lastFeishuPushAt || 0, lastDirectFeishuPushAt) >=
        pendingFeishuTurn.startedAt;

      if (apiAlreadyPushed || elapsed > 90000) {
        pendingFeishuTurn = null;
      } else if (!res?.isBusy && hasNewReply && (pendingFeishuTurn.sawBusy || elapsed > 6500)) {
        const turnCopy = pendingFeishuTurn;
        pendingFeishuTurn = null;
        if (turnCopy) {
          const chatId = store.getState().feishu.lastChatId || '';
          if (chatId && feishu?.getStatus().state === 'connected') {
            if (res?.bgActions && res.bgActions.length >= 2) {
              pendingMuseActions = res.bgActions.map((a) => ({
                id: a.id,
                label: a.label,
                kind: 'option'
              }));
              const opts = res.bgActions.map((a, i) => `${i + 1}. ${a.label}`).join('\n');
              lastDirectFeishuPushAt = Date.now();
              void feishu.sendText(
                chatId,
                `💬 【Muse 回复 · 请选择】\n${latestText.slice(0, 1200)}\n\n${opts}\n👉 直接回复数字 1~${res.bgActions.length} 或选项文字即可确认！`
              );
            } else {
              lastDirectFeishuPushAt = Date.now();
              void feishu.sendText(chatId, `💬 【Muse 回复】\n${latestText.slice(0, 1500)}`);
            }
          }
        }
      }
    } else {
      // Passive Proactive Muse Thought Detector:
      // Establish baseline on first idle poll after launch so historical messages never misfire;
      // afterwards, if Muse speaks on its own >120s after the last user/system interaction, capture & push!
      const latestText = (res?.latestMuseReply || '').trim();
      if (!res?.isBusy && latestText) {
        if (!proactiveBaselineReady) {
          lastObservedMuseReply = latestText;
          proactiveBaselineReady = true;
        } else if (latestText !== lastObservedMuseReply) {
          lastObservedMuseReply = latestText;
          const idleMs = Date.now() - lastMuseInteractionAt;
          const apiRecentlyPushed =
            Math.max(controlServer?.lastFeishuPushAt || 0, lastDirectFeishuPushAt) >
            Date.now() - 15000;
          if (idleMs > 120_000 && !apiRecentlyPushed) {
            deliverProactiveMuseThought(latestText, res?.bgActions);
          }
        }
      }
    }
  } catch {
    // ignore transient page reload errors
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('state:get', () => store.getState());

  ipcMain.handle('onboarding:complete', () => {
    const st = store.update((s) => {
      s.onboardingCompleted = true;
      s.lastSeenAppVersion = app.getVersion();
    });
    hideAllEmbeddedViews();
    broadcast('state:changed', st);
    return st;
  });

  ipcMain.handle('onboarding:reset', () => {
    const st = store.update((s) => {
      s.onboardingCompleted = false;
      s.muse.tunnelVerified = false;
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
    syncUserApprovalFromChatOrButton(text);
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
      const res = (await view.webContents.executeJavaScript(
        `(() => {
          const el = document.querySelector('[data-fmc-action-id=${JSON.stringify(actionId)}]');
          if (!el || !(el instanceof HTMLElement)) return { ok: false, label: '' };
          const label = (el.innerText || el.getAttribute('aria-label') || '').trim();
          el.scrollIntoView({ block: 'center' });
          el.click();
          return { ok: true, label };
        })()`,
        true
      )) as { ok: boolean; label: string };
      if (res?.ok) {
        markMuseInteraction();
        syncUserApprovalFromChatOrButton(res.label);
        pendingMuseActions = [];
      }
      return res?.ok
        ? { ok: true, message: `已触发「${res.label || '对应选项'}」` }
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

  ipcMain.handle('muse:testSitePermission', async () => {
    // Auto-start Tailscale if tunnel process isn't running yet when saved URL is .ts.net!
    let curTun = tunnel?.getStatus();
    const savedUrl = (store.getState().controlApi.tunnelUrl || '').trim();
    if (
      curTun?.state !== 'running' &&
      (!savedUrl || savedUrl.includes('.ts.net')) &&
      tunnel
    ) {
      const tsStateDir = path.join(app.getPath('userData'), 'fmc-data', 'tsnet-state');
      if (fs.existsSync(tsStateDir)) {
        curTun = await tunnel.startTailscale();
      }
    }

    const st = store.getState();
    const tunnelUrl = (curTun?.url || st.controlApi.tunnelUrl || '').trim().replace(/\/+$/, '');
    if (!tunnelUrl) {
      return { ok: false, message: '请先在上一步点击启动公网 443 隧道并拿到域名' };
    }
    if (tunnel && tunnelUrl.startsWith('https://')) {
      await tunnel.warmupPublicTunnelUrl(tunnelUrl, 16000);
    }
    store.update((s) => {
      s.muse.tunnelVerified = false;
    });
    broadcast('state:changed', store.getState());
    // Ensure latest protocol is synced first, then ask Muse to hit /api/v1/clis immediately
    await syncLatestBriefToMuse(true);
    const probeMsg = `【MuseDeck 初始站点权限与连通性预检】请立即发起一次 GET ${tunnelUrl}/api/v1/clis 请求（携带 Header: Authorization: Bearer ${st.controlApi.token}，超时请设为 20 秒），不要执行其他任务，拿到 200 后简短回复「握手成功」即可。`;
    const sent = await sendTextToMuseChat(probeMsg);
    return sent.ok
      ? {
          ok: true,
          message: '已预热公网 HTTPS 证书并向 Muse 发起权限预检！留意左侧网页，若弹出外部站点提示请点击「总是允许此站点」'
        }
      : sent;
  });

  ipcMain.handle('muse:autoClickAlwaysAllow', async () => {
    const view = ensureEmbeddedView('muse');
    if (!view || view.webContents.isDestroyed()) {
      return { ok: false, message: 'Muse 网页未就绪' };
    }
    try {
      const res = (await view.webContents.executeJavaScript(
        `(() => {
          const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
          const target =
            btns.find((b) => /总是允许此站点|Always allow/i.test((b.innerText || '').trim())) ||
            btns.find((b) => /^允许$|^Allow$/i.test((b.innerText || '').trim()));
          if (target && target instanceof HTMLElement) {
            target.click();
            return { ok: true, label: (target.innerText || '').trim() };
          }
          return { ok: false, label: '' };
        })()`,
        true
      )) as { ok: boolean; label: string };
      return res?.ok
        ? { ok: true, message: `已自动点击「${res.label}」，等待握手完成...` }
        : { ok: false, message: '当前页面未检测到权限确认弹窗（若已点过或下面已显示绿勾则无需再点）' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
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
    const st = store.getState();
    const clis = await scanLocalClis(st);
    const localUpdates = await checkCliUpdates(clis);
    const cloudCache = st.cliUpdatesCache || {};
    for (const c of clis) {
      const existing = localUpdates[c.id];
      const cached = cloudCache[c.id];
      if (cached?.latestVersion && (!existing || existing.error || !existing.latestVersion)) {
        const cur = (c.version || '').replace(/^v/i, '').trim();
        localUpdates[c.id] = {
          currentVersion: c.version || '',
          latestVersion: cached.latestVersion,
          hasUpdate: Boolean(cur && cur !== cached.latestVersion),
          checkedAt: cached.checkedAt
        };
      }
    }
    return localUpdates;
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
      const activeId = s.activePresetId || 'preset-smart-default';
      const targetPreset = (s.cliPresets || []).find((p) => p.id === activeId);
      if (targetPreset) {
        targetPreset.cliSnapshots = {
          ...(targetPreset.cliSnapshots || {}),
          [cliId]: {
            enabled: Boolean(cfg.enabled),
            defaultModel: cfg.defaultModel || '',
            reasoningEffort: cfg.reasoningEffort,
            roleWeights: cfg.roleWeights ? { ...cfg.roleWeights } : undefined,
            roles: cfg.roles ? [...cfg.roles] : undefined
          }
        };
        targetPreset.updatedAt = new Date().toISOString();
      }
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
    const isSameConnectedApp = Boolean(
      appId && appId === st.feishu.appId && (!wsStatus.connectedAppId || wsStatus.connectedAppId === appId)
    );
    const wsConnected = isSameConnectedApp && wsStatus.state === 'connected';
    const messageVerified = Boolean(
      isSameConnectedApp && st.feishu.verified && st.feishu.verifiedAppId === appId
    );

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

  ipcMain.handle('feishu:resetVerification', () => {
    return feishu.resetVerification();
  });

  ipcMain.handle('muse:clearProactiveUnread', () => {
    const st = store.update((s) => {
      s.muse.unreadProactiveCount = 0;
    });
    broadcast('state:changed', st);
    return st;
  });

  ipcMain.handle(
    'questions:mutate',
    async (
      _ev,
      payload: {
        action: 'add' | 'resolve' | 'reopen' | 'delete' | 'ask_muse';
        id?: string;
        question?: string;
        context?: string;
        projectId?: string;
        projectName?: string;
        resolution?: string;
      }
    ) => {
      const nowIso = new Date().toISOString();
      if (payload.action === 'ask_muse' && payload.id) {
        const q = (store.getState().openQuestions || []).find((item) => item.id === payload.id);
        if (q) {
          store.update((s) => {
            const target = (s.openQuestions || []).find((item) => item.id === payload.id);
            if (target) target.lastAskedAt = nowIso;
          });
          broadcast('state:changed', store.getState());
          const prompt = `【探讨未决议题 ${q.id}】我们之前留有一个待定问题：「${q.question}」${
            q.context ? `\n背景说明：${q.context}` : ''
          }\n请发挥你的云端联网搜索与深度思考能力，帮我检索最新实践或对比利弊，给出你的倾向建议帮我拍板（若得出明确参考资料也可调用 /api/v1/research/save 落盘）。`;
          await sendTextToMuseChat(prompt);
        }
        return store.getState();
      }

      const next = store.update((s) => {
        const list = Array.isArray(s.openQuestions) ? [...s.openQuestions] : [];
        if (payload.action === 'delete' && payload.id) {
          s.openQuestions = list.filter((item) => item.id !== payload.id);
        } else if ((payload.action === 'resolve' || payload.action === 'reopen') && payload.id) {
          const target = list.find((item) => item.id === payload.id);
          if (target) {
            target.status = payload.action === 'resolve' ? 'resolved' : 'open';
            if (payload.resolution !== undefined) target.resolution = payload.resolution;
            target.updatedAt = nowIso;
          }
          s.openQuestions = list;
        } else if (payload.action === 'add' && payload.question?.trim()) {
          const proj = payload.projectId
            ? s.projects.find((p) => p.id === payload.projectId)
            : undefined;
          list.unshift({
            id: `q-${Date.now().toString(36).slice(-5)}`,
            projectId: proj?.id || payload.projectId,
            projectName: proj?.name || payload.projectName,
            question: payload.question.trim(),
            context: payload.context?.trim() || undefined,
            status: 'open',
            source: 'user',
            createdAt: nowIso,
            updatedAt: nowIso
          });
          s.openQuestions = list.slice(0, 100);
        }
      });
      broadcast('state:changed', next);
      return next;
    }
  );

  ipcMain.handle('research:delete', (_ev, id: string) => {
    const next = store.update((s) => {
      s.researchNotes = (s.researchNotes || []).filter((n) => n.id !== id);
    });
    broadcast('state:changed', next);
    return next;
  });

  ipcMain.handle('browser:getExtensionStatus', () => {
    return detectMuseChromeExtension();
  });

  ipcMain.handle('browser:launchExtensionHost', async (_ev, openStore = false) => {
    return launchMuseExtensionHost(Boolean(openStore));
  });

  ipcMain.handle('browser:openLocalControlled', (_ev, url?: string) => {
    return localBrowser.showWindow(url);
  });

  ipcMain.handle('app:getWhatsNew', () => {
    const cur = app.getVersion();
    const st = store.getState();
    const shouldShow = Boolean(st.onboardingCompleted && st.lastSeenAppVersion !== cur);
    const info = resolveWhatsNewForVersion(cur);
    return {
      currentVersion: cur,
      shouldShow,
      title: info.title,
      highlights: info.highlights
    };
  });

  ipcMain.handle('app:ackWhatsNew', () => {
    const st = store.update((s) => {
      s.lastSeenAppVersion = app.getVersion();
    });
    broadcast('state:changed', st);
    return st;
  });

  ipcMain.handle('app:checkUpdate', async () => {
    return checkAppUpdate(app.getVersion());
  });

  ipcMain.handle(
    'app:downloadUpdate',
    async (_ev, payload: { downloadUrl: string; version: string; highlights?: string[] }) => {
      return downloadAndInstallUpdate({
        downloadUrl: payload.downloadUrl,
        version: payload.version,
        highlights: payload.highlights,
        onProgress: (prog) => {
          broadcast('app:updateProgress', prog);
        },
        onBeforeQuitAndInstall: () => {
          isQuitting = true;
          app.quit();
        }
      });
    }
  );

  const ensureFeishuConsoleWc = async (): Promise<Electron.WebContents> => {
    if (
      activeEmbedded === 'feishu' &&
      embeddedViews.feishu &&
      !embeddedViews.feishu.webContents.isDestroyed()
    ) {
      return embeddedViews.feishu.webContents;
    }
    if (!feishuPopupWin || feishuPopupWin.isDestroyed()) {
      const feishuSes = session.fromPartition('persist:fmc-feishu');
      feishuPopupWin = new BrowserWindow({
        width: 1080,
        height: 760,
        title: 'MuseDeck · 飞书开放平台受控窗口（本地隐私脱敏护盾已开启 · 密钥零外泄）',
        autoHideMenuBar: true,
        webPreferences: {
          session: feishuSes,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });
      const chromeUa = feishuPopupWin.webContents.getUserAgent().replace(/Electron\/[\d.]+ /, '');
      feishuPopupWin.webContents.setUserAgent(chromeUa);
      feishuPopupWin.webContents.setWindowOpenHandler(({ url }) => {
        if (
          /^https:\/\/open\.feishu\.cn\/app(\/|$|\?)/i.test(url) ||
          /^https:\/\/(accounts|passport)\.feishu\.cn\//i.test(url)
        ) {
          void feishuPopupWin?.webContents.loadURL(url);
        }
        return { action: 'deny' };
      });
      feishuPopupWin.on('closed', () => {
        feishuSpotlight?.detach();
        feishuPopupWin = null;
      });
      await feishuPopupWin.loadURL('https://open.feishu.cn/app');
    } else {
      feishuPopupWin.show();
      feishuPopupWin.focus();
    }
    return feishuPopupWin.webContents;
  };

  ipcMain.handle(
    'autopilot:feishu',
    async (
      _ev,
      params?: { botName?: string; botDesc?: string; existingAppId?: string }
    ) => {
      const targetWc = await ensureFeishuConsoleWc();
      const urlAppId = targetWc.getURL().match(/\/app\/(cli_[a-zA-Z0-9]+)/)?.[1] || '';
      if (urlAppId !== store.getState().feishu.appId) {
        syncDetectedFeishuAppId(urlAppId);
      }
      return runFeishuLocalAutoPilot({
        wc: targetWc,
        botName: params?.botName,
        botDesc: params?.botDesc,
        existingAppId: urlAppId || undefined,
        onProgress: (msg) => {
          broadcast('autopilot:feishuProgress', { message: msg });
        },
        onCredentialsReady: async (extractedAppId, extractedSecret) => {
          const status = await feishu.connect(extractedAppId, extractedSecret);
          return status.state === 'connected';
        }
      });
    }
  );

  ipcMain.handle(
    'autopilot:museFeishu',
    async (_ev, params?: { botName?: string; botDesc?: string }) => {
      const st = store.getState();
      const baseUrl = (tunnel?.getStatus().url || st.controlApi.tunnelUrl || '')
        .trim()
        .replace(/\/+$/, '');
      if (!baseUrl) {
        return {
          ok: false,
          needTunnel: true,
          message: '请先开启公网 443 隧道（Tailscale / Serveo）并完成 Muse 站点授权，随后即可让 Muse 智能接管配置！'
        };
      }

      const targetWc = await ensureFeishuConsoleWc();
      if (!targetWc.getURL().includes('open.feishu.cn')) {
        await targetWc.loadURL('https://open.feishu.cn/app');
        await new Promise((r) => setTimeout(r, 1500));
      }

      const loginState = (await targetWc
        .executeJavaScript(
          `(() => {
            const href = location.href;
            const txt = document.body?.innerText || '';
            const onPassport = href.includes('accounts.feishu.cn') || href.includes('passport.feishu.cn');
            const loggedIn = !onPassport && (txt.includes('企业自建应用') || txt.includes('凭证与基础信息') || txt.includes('添加应用能力') || /\\/app\\/cli_[a-zA-Z0-9]+/.test(href));
            return { loggedIn };
          })()`,
          true
        )
        .catch(() => ({ loggedIn: false }))) as { loggedIn: boolean };

      if (!loginState.loggedIn) {
        return {
          ok: false,
          needLogin: true,
          message:
            '已在窗口中打开飞书开放平台，请先用手机飞书扫码登录（确认右上角企业与手机一致），进入后台后再点一次「🤖 让 Muse 智能接管配置」！'
        };
      }

      // Immediately clear old bot credentials & disconnect old WS if creating a new app or viewing a different app!
      const urlAppId = targetWc.getURL().match(/\/app\/(cli_[a-zA-Z0-9]+)/)?.[1] || '';
      if (urlAppId !== store.getState().feishu.appId) {
        syncDetectedFeishuAppId(urlAppId);
      }

      localBrowser.bindFeishuWebContents(
        targetWc,
        async (extractedAppId, extractedSecret) => {
          const status = await feishu.connect(extractedAppId, extractedSecret);
          return status.state === 'connected';
        },
        (msg) => {
          broadcast('autopilot:feishuProgress', { message: msg });
        },
        (newAppId) => {
          syncDetectedFeishuAppId(newAppId);
        }
      );

      await syncLatestBriefToMuse(false);
      const botName = (params?.botName || 'MuseDeck').trim() || 'MuseDeck';
      const botDesc = (params?.botDesc || 'MuseDeck 本地多智能体调度助手').trim();

      const coPilotPrompt = `【飞书后台可视化导航代配任务（本地隐私护盾已开启）】
用户已在 MuseDeck 本地受控飞书窗口（target: "feishu"）完成扫码登录。请你通过本地接口完成飞书机器人后台的配置并校验每一步返回的快照。
🔒 隐私安全说明：所有应用密钥与敏感字段已由 MuseDeck 本地隐私护盾脱敏为 [REDACTED]，且本地长连接绑定由内核自己在后台完成，**你全程不需要、也严禁读取任何密钥、密码或敏感凭证**！

请携带 \`Authorization: Bearer ${st.controlApi.token}\` 优先按顺序调用以下组合动作（每一步都会返回脱敏后的实时页面 \`snapshot\`；若某一步因企业特殊弹窗返回 \`ok: false\`，你再对照 \`snapshot.elements\` 调用 \`POST ${baseUrl}/api/v1/browser/act\` 点击/填写对应按钮处理即可）：
1. \`POST ${baseUrl}/api/v1/browser/feishu-assist\` Body \`{"op": "create_or_enter_app", "botName": ${JSON.stringify(botName)}, "botDesc": ${JSON.stringify(botDesc)}}\` —— 自动创建或进入自建应用后台；
2. \`POST ${baseUrl}/api/v1/browser/feishu-assist\` Body \`{"op": "add_bot_capability"}\` —— 为该应用开启「机器人」能力；
3. \`POST ${baseUrl}/api/v1/browser/feishu-assist\` Body \`{"op": "fill_permission_json"}\` —— 自动批量写入并提交开通 7 项消息与表情权限；
4. \`POST ${baseUrl}/api/v1/browser/feishu-assist\` Body \`{"op": "sync_local_bridge"}\` —— 触发 MuseDeck 本机内核自己在后台绑定凭证并建立飞书长连接（不向你返回任何密钥）；
5. \`POST ${baseUrl}/api/v1/browser/feishu-assist\` Body \`{"op": "configure_events"}\` —— 开启「使用长连接接收事件」并订阅 \`im.message.receive_v1\`；
6. \`POST ${baseUrl}/api/v1/browser/feishu-assist\` Body \`{"op": "prepare_version"}\` —— 进入版本页填好 \`1.0.0\` 草稿，完成后简短通知用户在飞书窗口点击「保存 → 申请线上发布」即可！`;

      broadcast('autopilot:feishuProgress', {
        message: '🤖 已将飞书界面导航任务交由 Muse 智能接管（本地隐私脱敏护盾已开启，Muse 零接触密钥）...'
      });
      const sent = await sendTextToMuseChat(coPilotPrompt);
      return sent.ok
        ? {
            ok: true,
            message:
              '🤖 Muse 已开始智能接管飞书后台配置！你可直接观察飞书窗口中的实时绿框操作（所有密钥均由本机底层自动脱敏托管，Muse 零接触任何隐私凭证）。'
          }
        : sent;
    }
  );

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
      if (target === 'feishu') {
        feishuSpotlight?.attach(view.webContents);
      }
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

  ipcMain.handle('profile:update', (_ev, patch: Partial<UserProfileConfig>) => {
    const st = store.update((s) => {
      s.userProfile = {
        profession: '',
        purposes: [],
        ...(s.userProfile || {}),
        ...patch
      };
    });
    broadcast('state:changed', st);
    scheduleBriefAutoSync(2500);
    return st;
  });

  ipcMain.handle(
    'cli:recommendRoles',
    async (_ev, mode: 'muse' | 'preset', profilePatch?: Partial<UserProfileConfig>) => {
      if (profilePatch) {
        store.update((s) => {
          s.userProfile = {
            profession: '',
            purposes: [],
            ...(s.userProfile || {}),
            ...profilePatch
          };
        });
      }
      const curState = store.getState();
      const profile: UserProfileConfig = curState.userProfile || { profession: '', purposes: [] };
      const clis = await getFastClis(curState);

      if (mode === 'preset') {
        const plan = computeSmartRoleRecommendations(profile, clis);
        const nextSt = store.update((s) => {
          const reasonsMap: Record<string, string> = { ...(s.userProfile?.cliReasons || {}) };
          for (const rec of plan.recommendations) {
            const prev = s.cliConfigs[rec.cliId] || {
              enabled: true,
              authMode: 'oauth' as const,
              apiKey: '',
              baseUrl: '',
              defaultModel: '',
              extraArgs: ''
            };
            const activeRoles = Object.entries(rec.roleWeights)
              .filter(([, w]) => w > 0)
              .map(([r]) => r);
            s.cliConfigs[rec.cliId] = {
              ...prev,
              enabled: true,
              defaultModel: rec.defaultModel || prev.defaultModel,
              reasoningEffort: rec.reasoningEffort || prev.reasoningEffort || 'medium',
              roleWeights: rec.roleWeights,
              roles: activeRoles
            };
            reasonsMap[rec.cliId] = rec.reason;
          }
          s.workflow.decisionWeights = plan.decisionWeights;
          s.userProfile = {
            ...profile,
            recommendedAt: new Date().toISOString(),
            lastRecommendationSource: 'preset',
            lastRecommendationSummary: plan.summary,
            cliReasons: reasonsMap
          };
          // Update smart preset snapshot as well
          const presets = Array.isArray(s.cliPresets) ? s.cliPresets : [];
          const activeId = s.activePresetId || 'preset-smart-default';
          for (const p of presets) {
            if (p.id === activeId || p.id === 'preset-smart-default') {
              const snaps: Record<string, CliPresetCliSnapshot> = { ...(p.cliSnapshots || {}) };
              for (const [cid, c] of Object.entries(s.cliConfigs)) {
                snaps[cid] = {
                  enabled: Boolean(c.enabled),
                  defaultModel: c.defaultModel || '',
                  reasoningEffort: c.reasoningEffort,
                  roleWeights: c.roleWeights ? { ...c.roleWeights } : undefined,
                  roles: c.roles ? [...c.roles] : undefined
                };
              }
              p.cliSnapshots = snaps;
              p.decisionWeights = { ...plan.decisionWeights };
              p.updatedAt = new Date().toISOString();
            }
          }
        });
        broadcast('state:changed', nextSt);
        return {
          ok: true,
          mode: 'preset' as const,
          message: plan.summary,
          state: nextSt
        };
      }

      // mode === 'muse': Ask live Muse over HTTP tunnel to tailor & POST /api/v1/clis/apply-recommendations
      const baseUrl = (tunnel?.getStatus().url || curState.controlApi.tunnelUrl || '')
        .trim()
        .replace(/\/+$/, '');
      if (!baseUrl) {
        return {
          ok: false,
          mode: 'muse' as const,
          message:
            '当前尚未开启公网隧道连通 Muse。你可以先去上一步连通 Muse，或直接点击右侧「⚡ 快速套用场景预设推荐」秒级完成配置！'
        };
      }
      await syncLatestBriefToMuse(false);
      const prompt = buildMuseRoleRecommendationPrompt(
        baseUrl,
        curState.controlApi.token,
        profile,
        clis
      );
      const sent = await sendTextToMuseChat(prompt);
      if (!sent.ok) {
        return {
          ok: false,
          mode: 'muse' as const,
          message: `${sent.message}（也可先点击「⚡ 快速套用场景预设推荐」立即生效）`
        };
      }
      return {
        ok: true,
        mode: 'muse' as const,
        message:
          '✨ 已将你的职业与用途发给 Muse！Muse 正在结合各家模型能力为你写入定制职能与权重（约 5~15 秒内下方卡片将自动实时刷新，后续也随时可改）...'
      };
    }
  );

  ipcMain.handle(
    'cli:recommendSingleModelRoles',
    async (_ev, cliId: string, cliName: string, modelId: string, mode: 'muse' | 'preset') => {
      const curState = store.getState();
      const profile = curState.userProfile || { profession: '', purposes: [] };

      if (mode === 'preset') {
        const rec = computeSingleCliModelRecommendation(cliId, cliName, modelId, profile);
        return {
          ok: true,
          mode: 'preset' as const,
          message: `⚡ ${rec.reason}`,
          recommendation: rec
        };
      }

      const baseUrl = (tunnel?.getStatus().url || curState.controlApi.tunnelUrl || '')
        .trim()
        .replace(/\/+$/, '');
      if (!baseUrl) {
        return {
          ok: false,
          mode: 'muse' as const,
          message: '尚未开启公网隧道连通 Muse，可先点击左侧「⚡ 按此模型秒级推荐」立即生成推荐职能！'
        };
      }
      await syncLatestBriefToMuse(false);
      const prompt = buildSingleCliMuseRolePrompt(
        baseUrl,
        curState.controlApi.token,
        cliId,
        cliName,
        modelId,
        profile
      );
      const sent = await sendTextToMuseChat(prompt);
      if (!sent.ok) {
        return {
          ok: false,
          mode: 'muse' as const,
          message: `${sent.message}（可先点击「⚡ 按此模型秒级推荐」立即生成）`
        };
      }
      return {
        ok: true,
        mode: 'muse' as const,
        message: `✨ 已请 Muse 针对新模型「${modelId}」评估专属职能权重（约 5~12 秒内自动回填，你仍可自由微调）...`
      };
    }
  );

  ipcMain.handle(
    'cli:mutatePreset',
    (
      _ev,
      payload: {
        action: 'activate' | 'save_new' | 'update_current' | 'delete';
        presetId?: string;
        name?: string;
        dispatchPolicy?: 'muse_decide' | 'strict_custom';
        description?: string;
      }
    ) => {
      const captureAllSnapshots = (
        configs: Record<string, CliUserConfig>
      ): Record<string, CliPresetCliSnapshot> => {
        const out: Record<string, CliPresetCliSnapshot> = {};
        for (const [cid, cfg] of Object.entries(configs || {})) {
          out[cid] = {
            enabled: Boolean(cfg.enabled),
            defaultModel: cfg.defaultModel || '',
            reasoningEffort: cfg.reasoningEffort,
            roleWeights: cfg.roleWeights ? { ...cfg.roleWeights } : undefined,
            roles: cfg.roles ? [...cfg.roles] : undefined
          };
        }
        return out;
      };

      const applyPresetToState = (s: ReturnType<FmcStore['getState']>, preset: CliPresetGroup) => {
        for (const [cid, snap] of Object.entries(preset.cliSnapshots || {})) {
          const prev = s.cliConfigs[cid] || {
            enabled: snap.enabled,
            authMode: 'oauth' as const,
            apiKey: '',
            baseUrl: '',
            defaultModel: '',
            extraArgs: ''
          };
          s.cliConfigs[cid] = {
            ...prev,
            enabled: snap.enabled,
            defaultModel: snap.defaultModel || prev.defaultModel,
            reasoningEffort: snap.reasoningEffort || prev.reasoningEffort,
            roleWeights: snap.roleWeights ? { ...snap.roleWeights } : prev.roleWeights,
            roles: snap.roles ? [...snap.roles] : prev.roles
          };
        }
        if (preset.decisionWeights) {
          s.workflow.decisionWeights = { ...preset.decisionWeights };
        }
        if (preset.dispatchPolicy === 'strict_custom') {
          s.workflow.modelRoutingMode = 'user_default';
        } else if (s.workflow.modelRoutingMode === 'user_default') {
          s.workflow.modelRoutingMode = 'muse_ask';
        }
      };

      const nextSt = store.update((s) => {
        if (!Array.isArray(s.cliPresets) || s.cliPresets.length === 0) {
          s.cliPresets = [
            {
              id: 'preset-smart-default',
              name: 'Muse 智能决策组',
              kind: 'smart',
              dispatchPolicy: 'muse_decide',
              description: '由 Muse 结合任务难度、评测榜单与可用模型池动态选择最优模型与分工',
              cliSnapshots: captureAllSnapshots(s.cliConfigs),
              updatedAt: new Date().toISOString()
            }
          ];
        }
        const curActiveId = s.activePresetId || 'preset-smart-default';
        const nowIso = new Date().toISOString();

        if (payload.action === 'activate' && payload.presetId) {
          // 1. Save outgoing active preset's latest CLI states first
          const outgoing = s.cliPresets.find((p) => p.id === curActiveId);
          if (outgoing) {
            outgoing.cliSnapshots = captureAllSnapshots(s.cliConfigs);
            outgoing.decisionWeights = s.workflow.decisionWeights
              ? { ...s.workflow.decisionWeights }
              : undefined;
            outgoing.updatedAt = nowIso;
          }
          // 2. Activate target preset
          const target = s.cliPresets.find((p) => p.id === payload.presetId);
          if (target) {
            s.activePresetId = target.id;
            applyPresetToState(s, target);
          }
        } else if (payload.action === 'save_new') {
          const cleanName = (payload.name || '').trim() || `自定义组合 ${s.cliPresets.length}`;
          const policy = payload.dispatchPolicy || 'strict_custom';
          const newPreset: CliPresetGroup = {
            id: `preset-${crypto.randomBytes(4).toString('hex')}`,
            name: cleanName,
            kind: 'custom',
            dispatchPolicy: policy,
            description:
              payload.description?.trim() ||
              (policy === 'strict_custom'
                ? '严格按此自定义组合设定的模型与职能权重进行分工'
                : '按此自定义职能分工，并允许 Muse 动态挑选具体模型'),
            decisionWeights: s.workflow.decisionWeights
              ? { ...s.workflow.decisionWeights }
              : undefined,
            cliSnapshots: captureAllSnapshots(s.cliConfigs),
            updatedAt: nowIso
          };
          s.cliPresets.push(newPreset);
          s.activePresetId = newPreset.id;
          applyPresetToState(s, newPreset);
        } else if (payload.action === 'update_current') {
          const targetId = payload.presetId || curActiveId;
          const target = s.cliPresets.find((p) => p.id === targetId);
          if (target) {
            if (payload.name && payload.name.trim() && target.kind !== 'smart') {
              target.name = payload.name.trim();
            }
            if (payload.dispatchPolicy) {
              target.dispatchPolicy = payload.dispatchPolicy;
            }
            if (payload.description !== undefined) {
              target.description = payload.description.trim();
            }
            target.cliSnapshots = captureAllSnapshots(s.cliConfigs);
            target.decisionWeights = s.workflow.decisionWeights
              ? { ...s.workflow.decisionWeights }
              : undefined;
            target.updatedAt = nowIso;
            if (s.activePresetId === target.id) {
              applyPresetToState(s, target);
            }
          }
        } else if (payload.action === 'delete' && payload.presetId) {
          if (payload.presetId !== 'preset-smart-default') {
            s.cliPresets = s.cliPresets.filter((p) => p.id !== payload.presetId);
            if (s.activePresetId === payload.presetId) {
              const fallback = s.cliPresets[0];
              if (fallback) {
                s.activePresetId = fallback.id;
                applyPresetToState(s, fallback);
              }
            }
          }
        }
      });

      broadcast('state:changed', nextSt);
      scheduleBriefAutoSync(2500);
      return nextSt;
    }
  );

  ipcMain.handle('feishuGuide:setSpotlight', (_ev, enabled: boolean) => {
    feishuSpotlight?.setSpotlightEnabled(Boolean(enabled));
    return true;
  });

  ipcMain.handle('feishuGuide:jumpStep', async (_ev, step: number, appIdHint?: string) => {
    if (!feishuSpotlight) return { ok: false, message: '引导助手未就绪' };
    if (activeEmbedded === 'feishu' && embeddedViews.feishu) {
      feishuSpotlight.attach(embeddedViews.feishu.webContents);
    } else {
      const wc = await ensureFeishuConsoleWc();
      feishuSpotlight.attach(wc);
    }
    return feishuSpotlight.jumpToStep(step, appIdHint);
  });

  ipcMain.handle(
    'feishuGuide:quickFill',
    async (
      _ev,
      kind: 'app_info' | 'permission_json' | 'version_draft',
      params?: { botName?: string; botDesc?: string }
    ) => {
      if (!feishuSpotlight) return { ok: false, message: '引导助手未就绪' };
      if (activeEmbedded === 'feishu' && embeddedViews.feishu) {
        feishuSpotlight.attach(embeddedViews.feishu.webContents);
      }
      return feishuSpotlight.quickFill(kind, params);
    }
  );

  ipcMain.handle('feishuGuide:readClipboard', () => {
    const raw = clipboard.readText().trim();
    if (/^cli_[a-zA-Z0-9]+$/.test(raw)) {
      return { raw, appId: raw };
    }
    if (/^[A-Za-z0-9_-]{20,56}$/.test(raw) && !raw.startsWith('cli_')) {
      return { raw, appSecret: raw };
    }
    return { raw };
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
  ipcMain.handle('workflow:retryQuota', () => workflow.retryQuotaNow());
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
    async (ctx: FeishuIncomingContext) => {
      const trimmed = ctx.text.trim();
      const hasImages = Boolean(ctx.imagePaths && ctx.imagePaths.length > 0);
      // Stage -1: Remote approve Muse site-access permission prompt directly from Feishu!
      if (!hasImages && /^(总是允许此站点|总是允许|允许访问)$/i.test(trimmed)) {
        const view = ensureEmbeddedView('muse');
        const clickedPerm = await view.webContents
          .executeJavaScript(
            `(() => {
              const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
              const target =
                btns.find((b) => /总是允许此站点|Always allow/i.test((b.innerText || '').trim())) ||
                btns.find((b) => /^允许$|^Allow$/i.test((b.innerText || '').trim()));
              if (target && target instanceof HTMLElement) {
                target.click();
                return true;
              }
              return false;
            })()`,
            true
          )
          .catch(() => false);
        if (clickedPerm) {
          const chatId = store.getState().feishu.lastChatId;
          if (chatId) {
            void feishu.sendText(chatId, '✅ 已为你点击「总是允许此站点」，后续不会再重复弹窗！');
          }
          return { ok: true, message: '已远程批准站点访问权限' };
        }
      }

      // Stage 0: Remote click on pending Muse interactive choice/permission buttons from Feishu!
      if (!hasImages && pendingMuseActions.length > 0) {
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
                el.click();
                return true;
              })()`,
              true
            )
            .catch(() => false);
          if (clicked) {
            syncUserApprovalFromChatOrButton(matchedAction.label);
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
      if (!hasImages && wfStatus?.phase === 'paused_quota' && /^(继续|重试|续跑|retry|continue)[！!。.\s]*$/i.test(trimmed)) {
        await workflow.retryQuotaNow();
        const chatId = store.getState().feishu.lastChatId;
        if (chatId) {
          lastDirectFeishuPushAt = Date.now();
          void feishu.sendText(chatId, '⚡ 已立即触发续跑，正在检查原工作区并继续执行！');
        }
        return { ok: true, message: '已触发额度恢复立即续跑' };
      }
      // Stage 1: Natural-language approval from Feishu when awaiting project routing approval
      if (!hasImages && wfStatus?.phase === 'awaiting_project_approval') {
        if (/^(批准|同意|通过|开始|可以|好的?|没问题|行|ok|okay|yes|go|lgtm|approve|确认)[！!。.~～\s]*$/i.test(trimmed)) {
          const nextWf = await workflow.approveProject(() => broadcast('state:changed', store.getState()));
          const chatId = store.getState().feishu.lastChatId;
          if (chatId) {
            lastDirectFeishuPushAt = Date.now();
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
      // Stage 2: Natural-language approval or config-choice selection from Feishu when awaiting plan approval
      if (!hasImages && wfStatus?.phase === 'awaiting_plan_approval') {
        if (/^(批准|同意|通过|开始|开工|启动|可以|好的?|没问题|行|ok|okay|yes|go|lgtm|approve)[！!。.~～\s]*$/i.test(trimmed)) {
          await workflow.approvePlan();
          const chatId = store.getState().feishu.lastChatId;
          if (chatId) {
            lastDirectFeishuPushAt = Date.now();
            void feishu.sendText(chatId, '✅ 已批准执行方案，Muse 正在按计划派单开工！');
          }
          return { ok: true, message: '执行方案已批准，正在开工' };
        }
        if (/(推荐配置|默认配置|推荐方案|默认方案|第一套|第二套|方案\s*[12]|选\s*[12])/i.test(trimmed)) {
          workflow.markApprovedSilently('plan', () => broadcast('state:changed', store.getState()));
          const chatId = store.getState().feishu.lastChatId;
          if (chatId) {
            lastDirectFeishuPushAt = Date.now();
            void feishu.sendText(chatId, `✅ 已批准方案并选择「${trimmed}」，Muse 正在派单开工！`);
          }
          return sendTextToMuseChat(`【用户已批准执行方案】我选择：${trimmed}。请立即按此配置派单执行。`);
        }
        await workflow.revisePlanFeedback(trimmed);
        return { ok: true, message: '已将方案修改意见发给 Muse 调整' };
      }
      // Natural-language approval from Feishu when awaiting user verification
      if (
        !hasImages &&
        wfStatus?.phase === 'awaiting_user' &&
        /^(满意|通过|可以|ok|没问题|结项|完成|好|好的)[！!。.~～\s]*$/i.test(trimmed)
      ) {
        workflow.approveByUser();
        const chatId = store.getState().feishu.lastChatId;
        if (chatId) {
          lastDirectFeishuPushAt = Date.now();
          void feishu.sendText(chatId, '✅ 已确认验收通过，本次工作流已结项！有新需求随时发我。');
        }
        return { ok: true, message: '工作流已验收结项' };
      }
      if (!hasImages && (wfStatus?.phase === 'awaiting_user' || wfStatus?.phase === 'paused_budget')) {
        await workflow.sendUserFeedback(trimmed);
        return { ok: true, message: '已将修改意见发给 Muse 继续迭代' };
      }
      workflow?.startNewGoal(trimmed);
      const lastMuseMsg = [...museHistoryCache].reverse().find((m) => m.role === 'muse')?.text || '';
      pendingFeishuTurn = {
        startedAt: Date.now(),
        sawBusy: false,
        baselineMuseText: lastMuseMsg
      };
      const threadTag = ctx.threadKey ? `（飞书话题串 #${ctx.threadKey.slice(-6)}）` : '';
      const imgSuffix =
        ctx.imagePaths && ctx.imagePaths.length > 0
          ? `\n【附带飞书截图已同步粘贴并保存至本地：${ctx.imagePaths.join(' , ')} —— 你可直接查看图片，若需派发给本地 CLI 看图修 Bug，请将该本地图片路径写进 dispatch 的 prompt！】`
          : '';
      const prompt = `【来自手机飞书的消息】${threadTag}${trimmed}${imgSuffix}\n（若这是联网查资料、看图解答、云端网页操作、日常探讨或回应你之前的主动思考追问，请直接处理并调用 POST /api/v1/feishu/send 回复飞书；若是需要修改本地代码的新开发需求，再先查 GET /api/v1/projects 并调用 propose-project / propose-plan 派发本地 CLI。若有尚未定论的问题可记入 POST /api/v1/questions。）`;
      return sendTextToMuseChat(prompt, ctx.imagePaths);
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
  workflow.attachQuotaServices(quotas, (req: DispatchRequest) => runner.dispatch(req));
  localBrowser = new LocalBrowserController();
  feishuSpotlight = new FeishuSpotlightController({
    getBridgeContext: () => {
      const fsCfg = store.getState().feishu;
      const fsSt = feishu.getStatus();
      const connected =
        Boolean(fsCfg.appId && fsCfg.appSecret) &&
        fsSt.state === 'connected' &&
        (!fsSt.connectedAppId || fsSt.connectedAppId === fsCfg.appId);
      return {
        hasAppSecret: Boolean((fsCfg.appSecret || '').trim()),
        feishuConnected: connected,
        feishuVerified: Boolean(fsCfg.verified && fsCfg.verifiedAppId === fsCfg.appId)
      };
    },
    onGuideState: (guideState) => {
      broadcast('feishuGuide:state', guideState);
    },
    onCredentialCaptured: (cred) => {
      if (cred.appId && cred.appId !== store.getState().feishu.appId) {
        syncDetectedFeishuAppId(cred.appId);
        broadcast('feishuGuide:credentialCaptured', { appId: cred.appId });
      }
      if (cred.appSecret && cred.appSecret !== store.getState().feishu.appSecret) {
        const st = store.update((s) => {
          s.feishu.appSecret = cred.appSecret!;
        });
        broadcast('state:changed', st);
        broadcast('feishuGuide:credentialCaptured', { appSecret: cred.appSecret });
      }
    }
  });
  controlServer = new ControlServer(
    store,
    runner,
    feishu,
    workflow,
    benchmarks,
    quotas,
    () => broadcast('state:changed', store.getState()),
    (proactivePayload) => {
      const syntheticActions = (proactivePayload.options || []).map((opt, idx) => ({
        id: `api-opt-${idx + 1}`,
        label: opt
      }));
      deliverProactiveMuseThought(proactivePayload.text, syntheticActions);
    },
    localBrowser
  );
  tunnel = new TunnelManager(
    store,
    (status) => {
      broadcast('tunnel:status', status);
      if (status.state === 'running') {
        localBrowser?.closeTailscaleWindowSoon();
        if (status.url && status.url !== lastPushedTunnelUrl) {
          lastPushedTunnelUrl = status.url;
          scheduleBriefAutoSync(2000);
        }
      }
    },
    () => broadcast('state:changed', store.getState()),
    (authUrl) => {
      localBrowser?.openTailscaleAutoAuthWindow(authUrl, (msg) => {
        broadcast('tunnel:status', {
          ...tunnel.getStatus(),
          message: msg
        });
      });
    }
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
  // Auto-check for new MuseDeck release once on startup if enabled in Settings
  if (savedState.onboardingCompleted && savedState.settings?.checkUpdateOnStartup !== false) {
    setTimeout(async () => {
      try {
        const res = await checkAppUpdate(app.getVersion());
        if (res.ok && res.hasUpdate) {
          broadcast('app:updateAvailable', res);
        }
      } catch {
        // ignore startup check network failure silently
      }
    }, 4500);
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
  if (feishuPopupWin && !feishuPopupWin.isDestroyed()) {
    feishuPopupWin.destroy();
    feishuPopupWin = null;
  }
  feishuSpotlight?.detach();
  localBrowser?.destroyAll();
  tunnel?.stop();
  feishu?.disconnect();
  controlServer?.stop();
});

app.on('window-all-closed', () => {
  if (isQuitting && process.platform !== 'darwin') {
    app.quit();
  }
});
