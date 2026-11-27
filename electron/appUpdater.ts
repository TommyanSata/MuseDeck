import { spawn } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { app } from 'electron';

const GITHUB_REPO = 'TommyanSata/MuseDeck';
const GITHUB_API_LATEST = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const GITHUB_WEB_LATEST = `https://github.com/${GITHUB_REPO}/releases/latest`;

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

export const BUILTIN_RELEASE_HIGHLIGHTS: Record<string, { title: string; highlights: string[] }> = {
  '0.6.3': {
    title: '彻底修复飞书一键代配跳窗口与页面滚动点偏问题',
    highlights: [
      '改用免滚动 DOM 节点直接锁定点击与 preventScroll 聚焦输入，彻底消除识别画框后页面下滑导致的误点',
      '锁死飞书开放平台视图的新窗口弹窗拦截（屏蔽说明文档外链抢占窗口），确保机器人能力稳定在同一窗口添加成功',
      '保留在线检查更新、一键下载自动覆盖升级与启动更新检测开关'
    ]
  },
  '0.6.2': {
    title: '支持在线检测与一键安装更新 · 升级后更新说明提示',
    highlights: [
      '软件设置新增「检查更新」与「一键下载并自动安装新版本」，支持显示实时下载进度',
      '新增「启动时自动检测一次更新」开关（可在软件设置随时勾选或关闭）',
      '每次版本升级后首次打开软件，自动弹出简洁明了的「本次更新内容」卡片',
      '保留并优化飞书开放平台 6 步可视自动代配（原生剪贴板写入权限 JSON）与本地浏览器双通道'
    ]
  },
  '0.6.1': {
    title: '修复飞书一键自动代配与 6 步核对清单',
    highlights: [
      '采用原生硬件点击 + 系统剪贴板真粘贴写入飞书 Monaco 权限编辑器，彻底解决 JSON 未导入问题',
      '加入页面顶部实时步骤浮窗与绿色点击高亮节奏，并输出 6 步逐项校验结果清单'
    ]
  },
  '0.6.0': {
    title: '本地真实 IP 浏览器双通道与一键自动代配',
    highlights: [
      '自动检测并一键唤醒本机 Chrome 官方 Muse from Meta 插件，内置 /api/v1/browser/* 本地受控浏览器防风控',
      '新增飞书开放平台扫码后一键自动代配与 Tailscale 授权窗口自动点击 Connect / Enable Funnel'
    ]
  },
  '0.5.1': {
    title: 'HTTP 静默云端同步与对话界面零冗余净化',
    highlights: [
      '取消配置修改后的 Rev #N 协议刷屏，改为随 HTTP 接口 _livePolicy 实时静默生效',
      '原生对话界面将协议握手与本地 CLI 执行回执自动折叠为清爽的单行胶囊'
    ]
  },
  '0.5.0': {
    title: '云端探路协同 · 主动思考实时触达 · 未决议题池',
    highlights: [
      '发挥 Muse 海外云端联网与网页操作特长，调研结论可一键落盘供本地 CLI 施工',
      '后台捕捉 Muse 跨时间主动思考追问并推送到手机飞书与桌面通知（支持夜间免打扰时段）',
      '右侧栏新增「未决议题池」与像素小人灵感灯泡动画'
    ]
  }
};

function cleanVer(v: string): string {
  return (v || '').trim().replace(/^v/i, '');
}

export function compareSemver(a: string, b: string): number {
  const pa = cleanVer(a).split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = cleanVer(b).split('.').map((x) => Number.parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function parseReleaseHighlights(markdownBody: string, ver: string): string[] {
  const lines = (markdownBody || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[-*•]\s+/.test(l))
    .map((l) =>
      l
        .replace(/^[-*•]\s+/, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim()
    )
    .filter((l) => l.length >= 4);

  if (lines.length > 0) return lines.slice(0, 5);
  const builtin = BUILTIN_RELEASE_HIGHLIGHTS[cleanVer(ver)];
  if (builtin) return builtin.highlights;
  return [`MuseDeck v${cleanVer(ver)} 常规体验优化与问题修复`];
}

function getNotesCachePath(): string {
  const dir = path.join(app.getPath('userData'), 'fmc-data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'release-notes-cache.json');
}

export function saveCachedReleaseNotes(version: string, title: string, highlights: string[]): void {
  try {
    const p = getNotesCachePath();
    let map: Record<string, { title: string; highlights: string[] }> = {};
    if (fs.existsSync(p)) {
      map = JSON.parse(fs.readFileSync(p, 'utf-8')) as typeof map;
    }
    map[cleanVer(version)] = { title, highlights };
    fs.writeFileSync(p, JSON.stringify(map, null, 2), 'utf-8');
  } catch {
    // ignore cache write error
  }
}

export function resolveWhatsNewForVersion(version: string): { title: string; highlights: string[] } {
  const v = cleanVer(version);
  // Prefer builtin curated Chinese summary when available
  if (BUILTIN_RELEASE_HIGHLIGHTS[v]) {
    return BUILTIN_RELEASE_HIGHLIGHTS[v];
  }
  try {
    const p = getNotesCachePath();
    if (fs.existsSync(p)) {
      const map = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<
        string,
        { title: string; highlights: string[] }
      >;
      if (map[v] && map[v].highlights?.length > 0) {
        return map[v];
      }
    }
  } catch {
    // ignore
  }
  return {
    title: `已升级至 MuseDeck v${v}`,
    highlights: [`欢迎使用 MuseDeck v${v}，本次更新包含稳定性提升与细节体验优化。`]
  };
}

export async function checkAppUpdate(currentVersion: string): Promise<AppUpdateCheckResult> {
  const cur = cleanVer(currentVersion);
  const nowIso = new Date().toISOString();

  // Channel 1: Official GitHub Releases REST API
  try {
    const resp = await fetch(GITHUB_API_LATEST, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `MuseDeck-Desktop/${cur}`
      },
      signal: AbortSignal.timeout(9000)
    });
    if (resp.ok) {
      const data = (await resp.json()) as {
        tag_name?: string;
        name?: string;
        body?: string;
        html_url?: string;
        published_at?: string;
        assets?: Array<{ name?: string; browser_download_url?: string }>;
      };
      const latest = cleanVer(data.tag_name || '');
      if (latest) {
        const hasUpdate = compareSemver(latest, cur) > 0;
        const exeAsset = (data.assets || []).find((a) =>
          (a.name || '').toLowerCase().endsWith('.exe')
        );
        const downloadUrl =
          exeAsset?.browser_download_url ||
          `https://github.com/${GITHUB_REPO}/releases/download/v${latest}/MuseDeck-Setup-${latest}.exe`;
        const highlights = parseReleaseHighlights(data.body || '', latest);
        if (hasUpdate) {
          saveCachedReleaseNotes(latest, data.name || `MuseDeck v${latest}`, highlights);
        }
        return {
          ok: true,
          currentVersion: cur,
          latestVersion: latest,
          hasUpdate,
          releaseTitle: data.name || `MuseDeck v${latest}`,
          highlights,
          rawNotes: data.body || '',
          downloadUrl,
          htmlUrl: data.html_url || `https://github.com/${GITHUB_REPO}/releases/tag/v${latest}`,
          publishedAt: data.published_at,
          checkedAt: nowIso
        };
      }
    }
  } catch {
    // Fall through to Channel 2 web redirect fallback
  }

  // Channel 2: Rate-limit immune GitHub /releases/latest HTTP redirect + HTML fallback
  try {
    const webResp = await fetch(GITHUB_WEB_LATEST, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(10000)
    });
    const finalUrl = webResp.url || '';
    const tagMatch = finalUrl.match(/\/releases\/tag\/v?([\d.]+)/i);
    if (tagMatch) {
      const latest = cleanVer(tagMatch[1]);
      const html = await webResp.text();
      const liMatches = Array.from(html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi))
        .map((m) =>
          m[1]
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;|&quot;|&#39;|&lt;|&gt;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        )
        .filter((t) => t.length >= 8 && t.length <= 180)
        .slice(0, 4);
      const highlights =
        liMatches.length > 0
          ? liMatches
          : BUILTIN_RELEASE_HIGHLIGHTS[latest]?.highlights || [
              `发现新版本 MuseDeck v${latest}，点击可下载更新安装包`
            ];
      const hasUpdate = compareSemver(latest, cur) > 0;
      if (hasUpdate) {
        saveCachedReleaseNotes(latest, `MuseDeck v${latest}`, highlights);
      }
      return {
        ok: true,
        currentVersion: cur,
        latestVersion: latest,
        hasUpdate,
        releaseTitle: `MuseDeck v${latest}`,
        highlights,
        downloadUrl: `https://github.com/${GITHUB_REPO}/releases/download/v${latest}/MuseDeck-Setup-${latest}.exe`,
        htmlUrl: finalUrl,
        checkedAt: nowIso
      };
    }
  } catch (err) {
    return {
      ok: false,
      currentVersion: cur,
      latestVersion: cur,
      hasUpdate: false,
      highlights: [],
      htmlUrl: `https://github.com/${GITHUB_REPO}/releases`,
      checkedAt: nowIso,
      error: `检查更新失败（请检查网络连接或开启代理后重试）：${
        err instanceof Error ? err.message : String(err)
      }`
    };
  }

  return {
    ok: false,
    currentVersion: cur,
    latestVersion: cur,
    hasUpdate: false,
    highlights: [],
    htmlUrl: `https://github.com/${GITHUB_REPO}/releases`,
    checkedAt: nowIso,
    error: '暂时无法解析 GitHub 最新版本信息'
  };
}

export async function downloadAndInstallUpdate(params: {
  downloadUrl: string;
  version: string;
  highlights?: string[];
  onProgress: (p: { percent: number; transferredMB: string; totalMB: string }) => void;
  onBeforeQuitAndInstall: () => void;
}): Promise<{ ok: boolean; message: string }> {
  const ver = cleanVer(params.version);
  if (params.highlights && params.highlights.length > 0) {
    saveCachedReleaseNotes(ver, `MuseDeck v${ver}`, params.highlights);
  }
  const dir = path.join(app.getPath('temp'), 'MuseDeck-Updates');
  fs.mkdirSync(dir, { recursive: true });
  const destPath = path.join(dir, `MuseDeck-Setup-${ver}.exe`);

  try {
    await new Promise<void>((resolve, reject) => {
      const follow = (url: string, redirects = 0) => {
        if (redirects > 6) {
          reject(new Error('下载重定向次数过多'));
          return;
        }
        https
          .get(
            url,
            {
              headers: {
                'User-Agent': `MuseDeck-Updater/${app.getVersion()}`
              }
            },
            (res) => {
              if (
                res.statusCode &&
                res.statusCode >= 300 &&
                res.statusCode < 400 &&
                res.headers.location
              ) {
                follow(res.headers.location, redirects + 1);
                return;
              }
              if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
              }
              const total = Number.parseInt(String(res.headers['content-length'] || '0'), 10) || 0;
              let received = 0;
              let lastEmit = 0;
              const file = fs.createWriteStream(destPath);
              res.on('data', (chunk: Buffer) => {
                received += chunk.length;
                const now = Date.now();
                if (now - lastEmit > 150 || (total > 0 && received >= total)) {
                  lastEmit = now;
                  const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 50;
                  params.onProgress({
                    percent: pct,
                    transferredMB: (received / (1024 * 1024)).toFixed(1),
                    totalMB: total > 0 ? (total / (1024 * 1024)).toFixed(1) : '?'
                  });
                }
              });
              res.pipe(file);
              file.on('finish', () => {
                file.close();
                resolve();
              });
              file.on('error', (err) => {
                fs.unlink(destPath, () => {});
                reject(err);
              });
            }
          )
          .on('error', reject);
      };
      follow(params.downloadUrl, 0);
    });

    const stat = fs.statSync(destPath);
    if (stat.size < 1024 * 1024) {
      throw new Error('下载的安装包体积异常，请改用浏览器前往 GitHub 下载');
    }

    const child = spawn(destPath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();

    setTimeout(() => {
      params.onBeforeQuitAndInstall();
    }, 650);

    return { ok: true, message: '安装包下载完成，正在拉起更新向导...' };
  } catch (err) {
    return {
      ok: false,
      message: `自动下载失败：${err instanceof Error ? err.message : String(err)}（你可点击前往 GitHub 手动下载）`
    };
  }
}
