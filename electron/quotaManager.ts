import fs from 'fs';
import os from 'os';
import path from 'path';
import { defaultCliProfile } from './controlServer';
import { CliUserConfig, FmcStore } from './store';

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

function readLatestCodexRateLimits(): {
  window5hUsedPct?: number;
  window7dUsedPct?: number;
  balanceText?: string;
  planType?: string;
} | null {
  try {
    const dir = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(dir)) return null;
    const files: Array<{ f: string; mtime: number }> = [];
    const walk = (d: string, depth: number) => {
      if (depth > 4) return;
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) walk(full, depth + 1);
        else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
          files.push({ f: full, mtime: fs.statSync(full).mtimeMs });
        }
      }
    };
    walk(dir, 0);
    files.sort((a, b) => b.mtime - a.mtime);
    for (const { f } of files.slice(0, 5)) {
      const lines = fs.readFileSync(f, 'utf-8').split(/\r?\n/).reverse();
      for (const line of lines) {
        if (!line.includes('rate_limits')) continue;
        try {
          const obj = JSON.parse(line) as {
            payload?: {
              rate_limits?: {
                primary?: { used_percent?: number; window_minutes?: number } | null;
                secondary?: { used_percent?: number; window_minutes?: number } | null;
                credits?: { balance?: string | number | null } | null;
                plan_type?: string | null;
              };
            };
          };
          const rl = obj.payload?.rate_limits;
          if (!rl) continue;
          const p5h = rl.primary?.used_percent;
          const p7d = rl.secondary?.used_percent;
          const bal = rl.credits?.balance;
          if (p5h !== undefined || p7d !== undefined || bal != null) {
            return {
              window5hUsedPct: typeof p5h === 'number' ? Math.round(p5h) : undefined,
              window7dUsedPct: typeof p7d === 'number' ? Math.round(p7d) : undefined,
              balanceText: bal != null ? String(bal) : undefined,
              planType: rl.plan_type || undefined
            };
          }
        } catch {
          // skip malformed line
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

async function fetchJsonWithTimeout(url: string, headers: Record<string, string>): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetch(url, { headers, signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

async function queryMeteredBalance(
  cliId: string,
  cfg?: CliUserConfig
): Promise<{
  balanceText?: string;
  balanceNumeric?: number;
  currency?: string;
  source: string;
  error?: string;
}> {
  const apiKey = (cfg?.apiKey || '').trim();
  const baseUrl = (cfg?.baseUrl || '').trim().replace(/\/+$/, '');
  const customUrl = (cfg?.balanceUrl || '').trim();
  if (!apiKey && !customUrl) {
    return { source: '未配置 API Key', error: '未填 API Key 或自定义余额查询地址' };
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
  };

  // 1. Custom balance URL
  if (customUrl && /^https?:\/\//i.test(customUrl)) {
    try {
      const data = (await fetchJsonWithTimeout(customUrl, headers)) as Record<string, unknown>;
      const raw =
        (data.data as Record<string, unknown> | undefined)?.balance ??
        (data.data as Record<string, unknown> | undefined)?.total_available ??
        data.balance ??
        data.available_balance ??
        data.remaining;
      if (raw !== undefined) {
        const num = Number(raw);
        return {
          balanceText: Number.isFinite(num) ? `${num.toFixed(2)}` : String(raw),
          balanceNumeric: Number.isFinite(num) ? num : undefined,
          source: '自定义余额接口'
        };
      }
    } catch (err) {
      return { source: '自定义余额接口', error: err instanceof Error ? err.message : String(err) };
    }
  }

  const lowerBase = baseUrl.toLowerCase();

  // 2. DeepSeek Official
  if (cliId === 'deepseek' || lowerBase.includes('deepseek.com')) {
    try {
      const url = `${baseUrl ? baseUrl.replace(/\/v1$/i, '') : 'https://api.deepseek.com'}/user/balance`;
      const data = (await fetchJsonWithTimeout(url, headers)) as {
        balance_infos?: Array<{ currency?: string; total_balance?: string }>;
      };
      const infos = data.balance_infos || [];
      if (infos.length > 0) {
        const primary = infos.find((i) => Number(i.total_balance) > 0) || infos[0];
        const num = Number(primary.total_balance || 0);
        const cur = primary.currency || 'CNY';
        const sym = cur === 'CNY' ? '¥' : '$';
        return {
          balanceText: `${sym}${num.toFixed(2)} ${cur}`,
          balanceNumeric: num,
          currency: cur,
          source: 'DeepSeek 官方余额'
        };
      }
    } catch (err) {
      return { source: 'DeepSeek 官方', error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 3. OpenRouter
  if (lowerBase.includes('openrouter.ai')) {
    try {
      const data = (await fetchJsonWithTimeout('https://openrouter.ai/api/v1/credits', headers)) as {
        data?: { total_credits?: number; total_usage?: number };
      };
      const total = data.data?.total_credits ?? 0;
      const used = data.data?.total_usage ?? 0;
      const rem = Math.max(0, total - used);
      return {
        balanceText: `$${rem.toFixed(2)} USD`,
        balanceNumeric: rem,
        currency: 'USD',
        source: 'OpenRouter Credits'
      };
    } catch (err) {
      return { source: 'OpenRouter', error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 4. Kimi / Moonshot
  if (cliId === 'kimi' || lowerBase.includes('moonshot.cn')) {
    try {
      const url = `${baseUrl ? baseUrl.replace(/\/v1$/i, '') : 'https://api.moonshot.cn'}/v1/users/me/balance`;
      const data = (await fetchJsonWithTimeout(url, headers)) as {
        data?: { available_balance?: number };
      };
      const rem = Number(data.data?.available_balance ?? 0);
      return {
        balanceText: `¥${rem.toFixed(2)} CNY`,
        balanceNumeric: rem,
        currency: 'CNY',
        source: 'Moonshot 官方余额'
      };
    } catch (err) {
      return { source: 'Moonshot', error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 5. Generic NewAPI / OneAPI / OpenAI-compatible billing endpoints
  if (baseUrl) {
    const root = baseUrl.replace(/\/v1$/i, '');
    const probes = [
      `${root}/api/user/self`,
      `${root}/v1/dashboard/billing/subscription`,
      `${root}/v1/credits`
    ];
    for (const p of probes) {
      try {
        const data = (await fetchJsonWithTimeout(p, headers)) as Record<string, unknown>;
        const d = (data.data as Record<string, unknown> | undefined) || data;
        if (typeof d.quota === 'number') {
          // NewAPI/OneAPI standard quota unit: 500000 = $1
          const usd = d.quota / 500000;
          return {
            balanceText: `$${usd.toFixed(2)} (NewAPI)`,
            balanceNumeric: usd,
            currency: 'USD',
            source: 'NewAPI / OneAPI'
          };
        }
        if (typeof d.hard_limit_usd === 'number') {
          return {
            balanceText: `$${d.hard_limit_usd.toFixed(2)} 上限`,
            balanceNumeric: d.hard_limit_usd,
            currency: 'USD',
            source: 'Billing Subscription'
          };
        }
        if (typeof d.total_credits === 'number') {
          const rem = Math.max(0, d.total_credits - Number(d.total_usage || 0));
          return {
            balanceText: `$${rem.toFixed(2)}`,
            balanceNumeric: rem,
            currency: 'USD',
            source: 'Credits API'
          };
        }
      } catch {
        // try next probe
      }
    }
    return { source: '中转站探测', error: '该接口未暴露标准余额端点，可手动填写自定义余额 URL' };
  }

  return { source: '未配置', error: '请填写 Base URL 或自定义余额 URL' };
}

export class QuotaManager {
  private store: FmcStore;
  private cache = new Map<string, CliQuotaSnapshot>();
  private runtimeExhausted = new Map<string, { until: number; reason: string }>();

  constructor(store: FmcStore) {
    this.store = store;
  }

  markRuntimeExhausted(cliId: string, reason: string, cooldownMs = 30 * 60_000): void {
    const safeCooldown = Math.min(2 * 60 * 60_000, Math.max(60_000, cooldownMs));
    this.runtimeExhausted.set(cliId, {
      until: Date.now() + safeCooldown,
      reason: reason || 'CLI 运行时触发额度/速率限制'
    });
    this.cache.delete(cliId);
  }

  clearRuntimeExhausted(cliId: string): void {
    if (this.runtimeExhausted.delete(cliId)) {
      this.cache.delete(cliId);
    }
  }

  isRuntimeExhausted(cliId: string): boolean {
    const hit = this.runtimeExhausted.get(cliId);
    if (!hit) return false;
    if (Date.now() >= hit.until) {
      this.runtimeExhausted.delete(cliId);
      return false;
    }
    return true;
  }

  private computeLocalWindowTokens(cliId: string): {
    local5hTokens: number;
    local7dTokens: number;
    local30dTokens: number;
  } {
    const now = Date.now();
    const h5 = now - 5 * 60 * 60 * 1000;
    const d7 = now - 7 * 24 * 60 * 60 * 1000;
    const d30 = now - 30 * 24 * 60 * 60 * 1000;
    let local5hTokens = 0;
    let local7dTokens = 0;
    let local30dTokens = 0;

    for (const m of this.store.getState().messages) {
      if (m.agentId !== cliId) continue;
      const ts = new Date(m.createdAt).getTime();
      if (!Number.isFinite(ts) || ts < d30) continue;
      // Estimate tokens (~3 chars/token) or extract exact "tokens used\nN"
      let tokens = Math.max(80, Math.round((m.content || '').length / 3));
      const exact = (m.content || '').match(/tokens used\s*\n\s*([\d,]+)/i);
      if (exact) {
        const n = Number(exact[1].replace(/,/g, ''));
        if (Number.isFinite(n) && n > 0) tokens = n;
      }
      local30dTokens += tokens;
      if (ts >= d7) local7dTokens += tokens;
      if (ts >= h5) local5hTokens += tokens;
    }

    return { local5hTokens, local7dTokens, local30dTokens };
  }

  async getQuota(cliId: string, force = false): Promise<CliQuotaSnapshot> {
    const cached = this.cache.get(cliId);
    if (!force && cached && Date.now() - new Date(cached.checkedAt).getTime() < 5 * 60 * 1000) {
      return cached;
    }

    const st = this.store.getState();
    const cfg = st.cliConfigs[cliId];
    const defProf = defaultCliProfile(cliId);
    const costTier = cfg?.costTier || defProf.costTier;
    const local = this.computeLocalWindowTokens(cliId);
    const checkedAt = new Date().toISOString();

    let snapshot: CliQuotaSnapshot = {
      cliId,
      costTier,
      ...local,
      health: 'healthy',
      source: costTier === 'subscription' ? '本地滚动窗口统计' : '按量余额探测',
      checkedAt
    };

    if (costTier === 'subscription') {
      if (cliId === 'codex') {
        const rl = readLatestCodexRateLimits();
        if (rl) {
          snapshot.window5hUsedPct = rl.window5hUsedPct;
          snapshot.window7dUsedPct = rl.window7dUsedPct;
          snapshot.balanceText = rl.balanceText;
          snapshot.source = rl.planType ? `Codex 订阅 (${rl.planType})` : 'Codex 本地限额日志';
        }
      }
      // If user set reference token limits for 5h / 7d / 30d, compute percentage when official pct unavailable
      if (snapshot.window5hUsedPct === undefined && cfg?.limit5hTokens && cfg.limit5hTokens > 0) {
        snapshot.window5hUsedPct = Math.min(100, Math.round((local.local5hTokens / cfg.limit5hTokens) * 100));
      }
      if (snapshot.window7dUsedPct === undefined && cfg?.limit7dTokens && cfg.limit7dTokens > 0) {
        snapshot.window7dUsedPct = Math.min(100, Math.round((local.local7dTokens / cfg.limit7dTokens) * 100));
      }
      if (cfg?.limit30dTokens && cfg.limit30dTokens > 0) {
        snapshot.window30dUsedPct = Math.min(100, Math.round((local.local30dTokens / cfg.limit30dTokens) * 100));
      }

      const maxPct = Math.max(
        snapshot.window5hUsedPct ?? 0,
        snapshot.window7dUsedPct ?? 0,
        snapshot.window30dUsedPct ?? 0
      );
      snapshot.health = maxPct >= 95 ? 'exhausted' : maxPct >= 80 ? 'tight' : 'healthy';
    } else {
      const bal = await queryMeteredBalance(cliId, cfg);
      snapshot.balanceText = bal.balanceText;
      snapshot.balanceNumeric = bal.balanceNumeric;
      snapshot.currency = bal.currency;
      snapshot.source = bal.source;
      snapshot.error = bal.error;
      if (bal.balanceNumeric !== undefined) {
        snapshot.health =
          bal.balanceNumeric <= 0.1 ? 'exhausted' : bal.balanceNumeric < 2 ? 'tight' : 'healthy';
      } else {
        snapshot.health = 'unknown';
      }
    }

    const rtHit = this.runtimeExhausted.get(cliId);
    if (rtHit) {
      if (Date.now() < rtHit.until) {
        snapshot.health = 'exhausted';
        snapshot.error = rtHit.reason;
        snapshot.source = '运行时限额实时熔断';
      } else {
        this.runtimeExhausted.delete(cliId);
      }
    }

    this.cache.set(cliId, snapshot);
    return snapshot;
  }
}
