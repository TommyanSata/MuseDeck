import { ChildProcess, execFile, spawn } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { promisify } from 'util';
import { app, shell } from 'electron';
import { FmcStore, SshTunnelConfig } from './store';

const execFileAsync = promisify(execFile);

export interface TunnelStatusPayload {
  state: 'stopped' | 'starting' | 'running' | 'error';
  mode?: 'tailscale' | 'serveo' | 'cloudflared' | 'ssh';
  url?: string;
  authUrl?: string;
  message?: string;
}

export class TunnelManager {
  private store: FmcStore;
  private onStatus: (status: TunnelStatusPayload) => void;
  private onStateChanged: () => void;
  private onAuthUrl?: (url: string, eventType: string) => void;
  private proc: ChildProcess | null = null;
  private currentStatus: TunnelStatusPayload = { state: 'stopped' };

  constructor(
    store: FmcStore,
    onStatus: (status: TunnelStatusPayload) => void,
    onStateChanged: () => void,
    onAuthUrl?: (url: string, eventType: string) => void
  ) {
    this.store = store;
    this.onStatus = onStatus;
    this.onStateChanged = onStateChanged;
    this.onAuthUrl = onAuthUrl;
  }

  getStatus(): TunnelStatusPayload {
    return this.currentStatus;
  }

  private setStatus(next: TunnelStatusPayload): void {
    this.currentStatus = next;
    this.onStatus(next);
  }

  private resolveBundledBin(fileName: string): string | null {
    const candidates = [
      path.join(process.resourcesPath, 'bin', fileName),
      path.join(app.getAppPath(), 'bin', fileName)
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  private async resolveCloudflaredBin(): Promise<string> {
    const isWin = process.platform === 'win32';
    const exeName = isWin ? 'cloudflared.exe' : 'cloudflared';

    const bundled = this.resolveBundledBin(exeName);
    if (bundled) return bundled;

    const userBinDir = path.join(app.getPath('userData'), 'bin');
    const userBin = path.join(userBinDir, exeName);
    if (fs.existsSync(userBin)) return userBin;

    try {
      const { stdout } = await execFileAsync(isWin ? 'where.exe' : 'which', ['cloudflared'], {
        timeout: 2500
      });
      const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first) return first;
    } catch {
      // not in PATH
    }

    fs.mkdirSync(userBinDir, { recursive: true });
    const downloadUrl = isWin
      ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
      : process.platform === 'darwin'
        ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz'
        : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

    this.setStatus({ state: 'starting', mode: 'cloudflared', message: '首次使用，正在自动下载官方 cloudflared...' });
    await this.downloadFile(downloadUrl, userBin);
    if (!isWin) fs.chmodSync(userBin, 0o755);
    return userBin;
  }

  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const fetchUrl = (currentUrl: string, depth: number) => {
        if (depth > 5) {
          reject(new Error('Too many redirects downloading cloudflared'));
          return;
        }
        https
          .get(currentUrl, { headers: { 'User-Agent': 'FMC-Desktop' } }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              fetchUrl(res.headers.location, depth + 1);
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`Download failed with HTTP ${res.statusCode}`));
              return;
            }
            const file = fs.createWriteStream(dest);
            res.pipe(file);
            file.on('finish', () => {
              file.close();
              resolve();
            });
            file.on('error', (err) => {
              fs.unlink(dest, () => {});
              reject(err);
            });
          })
          .on('error', reject);
      };
      fetchUrl(url, 0);
    });
  }

  /**
   * Forces eager Let's Encrypt TLS certificate provisioning on tsnet Funnel and verifies
   * real public HTTPS reachability (using DoH IP resolution so local Clash/TUN Fake-IP never blocks warmup).
   */
  async warmupPublicTunnelUrl(publicUrl: string, timeoutMs = 24000): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(publicUrl);
      if (parsed.protocol !== 'https:') return true;
    } catch {
      return false;
    }

    const hostname = parsed.hostname;
    let resolvedIp = '';
    for (const dohUrl of [
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`
    ]) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const resp = await fetch(dohUrl, {
          headers: { accept: 'application/dns-json' },
          signal: ctrl.signal
        });
        clearTimeout(t);
        if (resp.ok) {
          const json = (await resp.json()) as { Answer?: Array<{ type?: number; data?: string }> };
          const aRec = (json.Answer || []).find(
            (a) => a.type === 1 && a.data && /^\d+\.\d+\.\d+\.\d+$/.test(a.data)
          );
          if (aRec?.data) {
            resolvedIp = aRec.data;
            break;
          }
        }
      } catch {
        // try next DoH resolver
      }
    }

    const probeOnce = (perAttemptTimeout: number): Promise<boolean> =>
      new Promise((resolve) => {
        const req = https.request(
          {
            host: resolvedIp || hostname,
            port: 443,
            servername: hostname,
            path: '/api/v1/health',
            method: 'GET',
            headers: {
              Host: hostname,
              'User-Agent': 'MuseDeck-Tunnel-Warmup/1.0',
              'X-MuseDeck-Warmup': '1'
            },
            timeout: perAttemptTimeout
          },
          (res) => {
            res.resume();
            resolve(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 500));
          }
        );
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
        req.on('error', () => {
          resolve(false);
        });
        req.end();
      });

    const ok1 = await probeOnce(timeoutMs);
    if (ok1) return true;
    await new Promise((r) => setTimeout(r, 1200));
    return probeOnce(14000);
  }

  async startTailscale(): Promise<TunnelStatusPayload> {
    if (this.proc && this.currentStatus.state === 'running' && this.currentStatus.mode === 'tailscale') {
      return this.currentStatus;
    }
    this.stop();

    const port = this.store.getState().controlApi.port || 18787;
    const isWin = process.platform === 'win32';
    const binName = isWin ? 'fmc-tsnet.exe' : 'fmc-tsnet';
    const binPath = this.resolveBundledBin(binName);

    if (!binPath) {
      const st: TunnelStatusPayload = {
        state: 'error',
        mode: 'tailscale',
        message: `未找到内嵌组件 ${binName}`
      };
      this.setStatus(st);
      return st;
    }

    const stateDir = path.join(app.getPath('userData'), 'fmc-data', 'tsnet-state');
    fs.mkdirSync(stateDir, { recursive: true });

    this.setStatus({
      state: 'starting',
      mode: 'tailscale',
      message: '正在启动内嵌 Tailscale (tsnet) 永久 443 域名...'
    });

    return new Promise((resolve) => {
      let settled = false;
      const seenAuthUrls = new Set<string>();
      let buf = '';

      const child = spawn(
        binPath,
        [
          '-hostname', 'fmc-hub',
          '-state-dir', stateDir,
          '-target', `http://127.0.0.1:${port}`
        ],
        { windowsHide: true }
      );
      this.proc = child;

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) return;
        try {
          const ev = JSON.parse(trimmed) as { event?: string; url?: string; message?: string };
          if (ev.event === 'auth_url' || ev.event === 'funnel_enable') {
            if (ev.url && !seenAuthUrls.has(ev.url)) {
              seenAuthUrls.add(ev.url);
              if (this.onAuthUrl) {
                this.onAuthUrl(ev.url, ev.event);
              } else {
                void shell.openExternal(ev.url);
              }
            }
            this.setStatus({
              state: 'starting',
              mode: 'tailscale',
              authUrl: ev.url,
              message:
                ev.message ||
                '已弹出本地自动授权窗口：登录账号后将自动为你点击 Connect / Enable Funnel'
            });
          } else if (ev.event === 'waiting_funnel') {
            this.setStatus({
              state: 'starting',
              mode: 'tailscale',
              authUrl: this.currentStatus.authUrl,
              message: ev.message || '等待启用 Tailscale Funnel...'
            });
          } else if (ev.event === 'ready' && ev.url) {
            const readyUrl = ev.url;
            this.store.update((s) => {
              s.controlApi.tunnelUrl = readyUrl;
              s.controlApi.preferredTunnelMode = 'tailscale';
            });
            this.onStateChanged();
            this.setStatus({
              state: 'starting',
              mode: 'tailscale',
              url: readyUrl,
              message: '域名已分配，正在自动预签发 HTTPS 安全证书并预热公网通道（首次约需 8~18 秒）...'
            });
            void this.warmupPublicTunnelUrl(readyUrl).then((warmOk) => {
              if (this.currentStatus.state === 'stopped' || !this.proc) return;
              const st: TunnelStatusPayload = {
                state: 'running',
                mode: 'tailscale',
                url: readyUrl,
                message: warmOk
                  ? '✅ 内嵌 Tailscale 永久 443 域名与 HTTPS 证书均已预热就绪（重启不变域名）！'
                  : '内嵌 Tailscale 域名已启动（若首次握手稍慢，请等几秒再试一次）'
              };
              this.setStatus(st);
              if (!settled) {
                settled = true;
                resolve(st);
              }
            });
          } else if (ev.event === 'error') {
            const st: TunnelStatusPayload = {
              state: 'error',
              mode: 'tailscale',
              message: ev.message || '内嵌 Tailscale 启动失败'
            };
            this.setStatus(st);
            if (!settled) {
              settled = true;
              resolve(st);
            }
          }
        } catch {
          // ignore non-json line
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf-8');
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || '';
        lines.forEach(handleLine);
      });

      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          const st: TunnelStatusPayload = {
            state: 'error',
            mode: 'tailscale',
            message: `启动 fmc-tsnet 失败：${err.message}`
          };
          this.setStatus(st);
          resolve(st);
        }
      });

      child.on('close', (code) => {
        this.proc = null;
        if (!settled) {
          settled = true;
          const st: TunnelStatusPayload = {
            state: 'error',
            mode: 'tailscale',
            message: `内嵌 Tailscale 进程退出 (code=${code})`
          };
          this.setStatus(st);
          resolve(st);
        } else if (this.currentStatus.state === 'running') {
          this.setStatus({ state: 'stopped', mode: 'tailscale', message: '内嵌 Tailscale 已停止' });
        }
      });
    });
  }

  async startServeo(): Promise<TunnelStatusPayload> {
    if (this.proc && this.currentStatus.state === 'running' && this.currentStatus.mode === 'serveo') {
      return this.currentStatus;
    }
    this.stop();

    const port = this.store.getState().controlApi.port || 18787;
    this.setStatus({
      state: 'starting',
      mode: 'serveo',
      message: '正在建立免注册免费 443 HTTPS 隧道 (serveo.net)...'
    });

    return new Promise((resolve) => {
      let settled = false;
      let buf = '';

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          const st: TunnelStatusPayload = {
            state: 'error',
            mode: 'serveo',
            message: 'Serveo 443 隧道连接超时，请检查网络或切换其他隧道模式'
          };
          this.setStatus(st);
          resolve(st);
        }
      }, 15000);

      const child = spawn(
        'ssh',
        [
          '-p', '443',
          '-T',
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ServerAliveInterval=30',
          '-o', 'ServerAliveCountMax=3',
          '-R', `80:127.0.0.1:${port}`,
          'serveo.net'
        ],
        { windowsHide: true }
      );
      this.proc = child;

      const handleChunk = (chunk: Buffer) => {
        buf += chunk.toString('utf-8');
        const match = buf.match(/https:\/\/[a-z0-9.-]+\.(serveo\.net|serveousercontent\.com)/i);
        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          const url = match[0];
          this.store.update((s) => {
            s.controlApi.tunnelUrl = url;
          });
          this.onStateChanged();
          const st: TunnelStatusPayload = {
            state: 'running',
            mode: 'serveo',
            url,
            message: '免费 443 HTTPS 隧道已就绪（免注册、无 Cloudflare WAF 拦截）！'
          };
          this.setStatus(st);
          resolve(st);
        }
      };

      child.stdout?.on('data', handleChunk);
      child.stderr?.on('data', handleChunk);

      child.on('error', (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          const st: TunnelStatusPayload = {
            state: 'error',
            mode: 'serveo',
            message: `启动失败：${err.message}`
          };
          this.setStatus(st);
          resolve(st);
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        this.proc = null;
        if (!settled) {
          settled = true;
          const st: TunnelStatusPayload = {
            state: 'error',
            mode: 'serveo',
            message: `隧道已退出 (code=${code})`
          };
          this.setStatus(st);
          resolve(st);
        } else if (this.currentStatus.state === 'running') {
          this.setStatus({ state: 'stopped', mode: 'serveo', message: '隧道已断开' });
        }
      });
    });
  }

  async startSsh(override?: Partial<SshTunnelConfig>): Promise<TunnelStatusPayload> {
    this.stop();
    const state = this.store.getState();
    const port = state.controlApi.port || 18787;
    const saved = state.controlApi.sshTunnel || {
      host: '',
      user: 'azureuser',
      keyPath: '',
      remotePort: 18787
    };
    const cfg: SshTunnelConfig = {
      host: (override?.host ?? saved.host).trim(),
      user: (override?.user ?? saved.user).trim() || 'azureuser',
      keyPath: (override?.keyPath ?? saved.keyPath).trim(),
      remotePort: Number(override?.remotePort ?? saved.remotePort) || 18787
    };

    if (!cfg.host) {
      const st: TunnelStatusPayload = {
        state: 'error',
        mode: 'ssh',
        message: '请先填写 VPS 公网 IP 或域名'
      };
      this.setStatus(st);
      return st;
    }

    this.store.update((s) => {
      s.controlApi.sshTunnel = cfg;
    });
    this.onStateChanged();

    const isIpv6 = cfg.host.includes(':');
    const bindSpec = isIpv6
      ? `[::]:${cfg.remotePort}:127.0.0.1:${port}`
      : `0.0.0.0:${cfg.remotePort}:127.0.0.1:${port}`;
    const publicUrl = isIpv6
      ? `http://[${cfg.host}]:${cfg.remotePort}`
      : `http://${cfg.host}:${cfg.remotePort}`;

    this.setStatus({ state: 'starting', mode: 'ssh', message: `正在建立到 ${cfg.host} 的 SSH 反向隧道...` });

    const args: string[] = [
      '-N',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ConnectTimeout=10'
    ];
    if (cfg.keyPath) {
      args.push('-i', cfg.keyPath);
    }
    if (isIpv6 && process.platform === 'win32') {
      const proxyScript = this.resolveBundledBin('direct_v6_proxy.py');
      if (proxyScript) {
        const posixPath = proxyScript.replace(/\\/g, '/');
        args.push('-o', `ProxyCommand=python ${posixPath} %h %p`);
      }
    }
    args.push('-R', bindSpec, `${cfg.user}@${cfg.host}`);

    return new Promise((resolve) => {
      let settled = false;
      let errBuf = '';

      const child = spawn('ssh', args, { windowsHide: true });
      this.proc = child;

      // If ssh stays alive for 2.8 seconds with ExitOnForwardFailure=yes, the remote port bind succeeded!
      const okTimer = setTimeout(() => {
        if (!settled && this.proc && !this.proc.killed) {
          settled = true;
          this.store.update((s) => {
            s.controlApi.tunnelUrl = publicUrl;
          });
          this.onStateChanged();
          const st: TunnelStatusPayload = {
            state: 'running',
            mode: 'ssh',
            url: publicUrl,
            message: `VPS 专属 SSH 反向隧道已在线（无 Cloudflare WAF 拦截）！`
          };
          this.setStatus(st);
          resolve(st);
        }
      }, 2800);

      child.stderr?.on('data', (b: Buffer) => {
        errBuf += b.toString('utf-8');
      });

      child.on('error', (err) => {
        clearTimeout(okTimer);
        if (!settled) {
          settled = true;
          const st: TunnelStatusPayload = {
            state: 'error',
            mode: 'ssh',
            message: `SSH 启动失败：${err.message}`
          };
          this.setStatus(st);
          resolve(st);
        }
      });

      child.on('close', (code) => {
        clearTimeout(okTimer);
        this.proc = null;
        if (!settled) {
          settled = true;
          const st: TunnelStatusPayload = {
            state: 'error',
            mode: 'ssh',
            message: `SSH 隧道断开 (code=${code})：${errBuf.trim().slice(-240) || '请检查 Clash IPv6 开关或密钥路径'}`
          };
          this.setStatus(st);
          resolve(st);
        } else if (this.currentStatus.state === 'running') {
          this.setStatus({ state: 'stopped', mode: 'ssh', message: 'SSH 隧道已断开' });
        }
      });
    });
  }

  async start(): Promise<TunnelStatusPayload> {
    if (this.proc && this.currentStatus.state === 'running' && this.currentStatus.url) {
      return this.currentStatus;
    }
    this.stop();

    const port = this.store.getState().controlApi.port || 18787;
    this.setStatus({ state: 'starting', mode: 'cloudflared', message: '正在建立 Cloudflare 加密公网隧道...' });

    let binPath: string;
    try {
      binPath = await this.resolveCloudflaredBin();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const st: TunnelStatusPayload = {
        state: 'error',
        mode: 'cloudflared',
        message: `无法获取 cloudflared：${msg}`
      };
      this.setStatus(st);
      return st;
    }

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          const st: TunnelStatusPayload = {
            state: 'error',
            mode: 'cloudflared',
            message: '隧道启动超时（25 秒未返回公网地址），请检查网络连接'
          };
          this.setStatus(st);
          resolve(st);
        }
      }, 25000);

      const child = spawn(
        binPath,
        ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
        { windowsHide: true }
      );
      this.proc = child;

      const handleChunk = (buf: Buffer) => {
        const text = buf.toString('utf-8');
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          const url = match[0];
          this.store.update((s) => {
            s.controlApi.tunnelUrl = url;
          });
          this.onStateChanged();
          const st: TunnelStatusPayload = {
            state: 'running',
            mode: 'cloudflared',
            url,
            message: 'Cloudflare 免费加密隧道已就绪'
          };
          this.setStatus(st);
          resolve(st);
        }
      };

      child.stdout?.on('data', handleChunk);
      child.stderr?.on('data', handleChunk);

      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const st: TunnelStatusPayload = {
            state: 'error',
            mode: 'cloudflared',
            message: `启动隧道进程失败：${err.message}`
          };
          this.setStatus(st);
          resolve(st);
        }
      });

      child.on('close', (code) => {
        this.proc = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const st: TunnelStatusPayload = {
            state: 'error',
            mode: 'cloudflared',
            message: `隧道进程提前退出 (code=${code})`
          };
          this.setStatus(st);
          resolve(st);
        } else if (this.currentStatus.state === 'running') {
          this.setStatus({ state: 'stopped', mode: 'cloudflared', message: '隧道已停止' });
        }
      });
    });
  }

  stop(): TunnelStatusPayload {
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
    }
    this.proc = null;
    const st: TunnelStatusPayload = { state: 'stopped', message: '隧道未开启' };
    this.setStatus(st);
    return st;
  }
}
