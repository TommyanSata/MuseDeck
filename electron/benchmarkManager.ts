import fs from 'fs';
import path from 'path';
import { app } from 'electron';

export interface BenchmarkSourceResult {
  id: string;
  name: string;
  url: string;
  ok: boolean;
  fetchedAt: string;
  highlights: string[];
  error?: string;
}

export interface BenchmarkCache {
  updatedAt: string;
  sources: BenchmarkSourceResult[];
  digest: string;
}

const BENCHMARK_SOURCES = [
  {
    id: 'lmarena',
    name: 'LMArena (Chatbot Arena Coding)',
    url: 'https://lmarena.ai/leaderboard/coding'
  },
  {
    id: 'artificial_analysis',
    name: 'Artificial Analysis (智力与性价比榜)',
    url: 'https://artificialanalysis.ai/leaderboards/models'
  },
  {
    id: 'swebench',
    name: 'SWE-bench Verified (真实软件工程榜)',
    url: 'https://www.swebench.com/'
  }
];

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractModelMentions(text: string): string[] {
  const patterns = [
    /(?:claude[- ]?(?:opus|sonnet|haiku)[- ]?[\d.]+|gpt[- ]?5(?:\.\d+)?(?:[- ]?(?:codex|mini|nano|pro))?|gpt[- ]?4o(?:-mini)?|o[134](?:-mini|-pro)?|gemini[- ]?[\d.]+[- ]?(?:pro|flash|ultra|neon)|deepseek[- ]?(?:r1|v3(?:\.\d+)?)|qwen[\d.]+[- ]?coder|grok[- ]?[\d.]+|kimi[- ]?k[\d.]+)/gi
  ];
  const seen = new Set<string>();
  const found: string[] = [];
  for (const re of patterns) {
    const matches = text.match(re) || [];
    for (const m of matches) {
      const norm = m.trim().replace(/\s+/g, '-');
      const key = norm.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        found.push(norm);
        if (found.length >= 10) return found;
      }
    }
  }
  return found;
}

export class BenchmarkManager {
  private cachePath: string;
  private cache: BenchmarkCache | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    const dir = path.join(app.getPath('userData'), 'fmc-data');
    fs.mkdirSync(dir, { recursive: true });
    this.cachePath = path.join(dir, 'benchmarks-cache.json');
    this.loadCache();
  }

  private loadCache(): void {
    try {
      if (fs.existsSync(this.cachePath)) {
        this.cache = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8')) as BenchmarkCache;
      }
    } catch {
      this.cache = null;
    }
  }

  private saveCache(data: BenchmarkCache): void {
    this.cache = data;
    try {
      fs.writeFileSync(this.cachePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // ignore
    }
  }

  getCache(): BenchmarkCache {
    if (this.cache) return this.cache;
    return {
      updatedAt: '',
      sources: [],
      digest: '尚未拉取外部权威评测榜单（将在后台由 Muse 云端或本地自动同步）。'
    };
  }

  needsCloudRefresh(): boolean {
    if (!this.cache || !this.cache.updatedAt) return true;
    const ageMs = Date.now() - new Date(this.cache.updatedAt).getTime();
    if (ageMs > 20 * 60 * 60 * 1000) return true;
    const hasMeaningfulModels = this.cache.sources.some(
      (s) => s.ok && s.highlights.some((h) => h.includes('前列模型') || h.includes('Muse 云端'))
    );
    return !hasMeaningfulModels;
  }

  updateFromMuseCloud(payload: {
    digest?: string;
    sources?: Array<{ id?: string; name?: string; url?: string; highlights?: string[] }>;
  }): BenchmarkCache {
    const now = new Date().toISOString();
    const incomingSources: BenchmarkSourceResult[] = Array.isArray(payload.sources) && payload.sources.length > 0
      ? payload.sources.map((s, idx) => ({
          id: String(s.id || `muse-cloud-${idx + 1}`),
          name: String(s.name || 'Muse 云端权威榜单同步'),
          url: String(s.url || 'https://lmarena.ai/leaderboard/coding'),
          ok: true,
          fetchedAt: now,
          highlights: Array.isArray(s.highlights) && s.highlights.length > 0
            ? s.highlights.map((h) => String(h))
            : ['已由 Muse 云端同步最新评测排名']
        }))
      : [
          {
            id: 'muse_cloud_sync',
            name: 'Muse 云端实时评测综述 (LMArena / Artificial Analysis / SWE-bench)',
            url: 'https://lmarena.ai/leaderboard/coding',
            ok: true,
            fetchedAt: now,
            highlights: ['已由 Muse 云端实时检索更新最新模型梯队与性价比参考']
          }
        ];

    const digest =
      payload.digest && payload.digest.trim().length > 10
        ? payload.digest.trim()
        : [
            `权威大模型评测快照（Muse 云端更新于 ${new Date(now).toLocaleString('zh-CN')}）：`,
            ...incomingSources.map((r) => `- **${r.name}**：${r.highlights.join('；')}`)
          ].join('\n');

    const data: BenchmarkCache = {
      updatedAt: now,
      sources: incomingSources,
      digest
    };
    this.saveCache(data);
    return data;
  }

  async refresh(force = false): Promise<BenchmarkCache> {
    if (!force && this.cache?.updatedAt) {
      const ageMs = Date.now() - new Date(this.cache.updatedAt).getTime();
      if (ageMs < 20 * 60 * 60 * 1000 && this.cache.sources.some((s) => s.ok)) {
        return this.cache;
      }
    }

    const now = new Date().toISOString();
    const results: BenchmarkSourceResult[] = await Promise.all(
      BENCHMARK_SOURCES.map(async (src) => {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 12000);
          const resp = await fetch(src.url, {
            signal: ctrl.signal,
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
              Accept: 'text/html,application/json;q=0.9,*/*;q=0.8'
            }
          });
          clearTimeout(t);
          if (!resp.ok) {
            return {
              ...src,
              ok: false,
              fetchedAt: now,
              highlights: [],
              error: `HTTP ${resp.status}`
            };
          }
          const html = await resp.text();
          const text = stripHtmlToText(html);
          const models = extractModelMentions(text);
          const highlights =
            models.length > 0
              ? [`榜单高频前列模型：${models.join('、')}`]
              : ['页面可访问（前端动态渲染，建议结合各模型公开能力与本地实测判断）'];
          return {
            ...src,
            ok: true,
            fetchedAt: now,
            highlights
          };
        } catch (err) {
          return {
            ...src,
            ok: false,
            fetchedAt: now,
            highlights: [],
            error: err instanceof Error ? err.message : String(err)
          };
        }
      })
    );

    const okLines = results.map(
      (r) =>
        `- **${r.name}**（${r.ok ? '已同步' : `抓取受限: ${r.error || 'timeout'}`}）：${
          r.highlights[0] || r.url
        }`
    );

    const digest = [
      `权威大模型评测快照（更新于 ${new Date(now).toLocaleString('zh-CN')}）：`,
      ...okLines,
      '- **细分能力分工与递进调度维度**：',
      '  1) 复杂后端/算法/真实代码修复（SWE-bench 维度）：优先选用各 CLI 模型池中代码榜靠前的旗舰/Codex/Opus/Pro 模型；',
      '  2) 前端 UI/视觉设计/多模态（LMArena 维度）：优先选用审美与长上下文强的模型；',
      '  3) 文档整理/脚手架/简单改动（Artificial Analysis 性价比维度）：优先选用 Flash/Mini/Haiku 等高性价比轻量模型 + `low`/`medium` 思考等级；',
      '  4) 允许**同一个 CLI 下不同模型处理不同子任务**，并在首轮审阅不达标时按需递进升档至更强模型或 `high`/`xhigh` 思考等级。'
    ].join('\n');

    const data: BenchmarkCache = {
      updatedAt: now,
      sources: results,
      digest
    };
    this.saveCache(data);
    return data;
  }

  startDailyScheduler(enabled = true): void {
    this.stop();
    if (!enabled) return;
    // Initial background check 15s after startup
    setTimeout(() => {
      void this.refresh(false);
    }, 15000);
    // Repeat every 24 hours
    this.timer = setInterval(() => {
      void this.refresh(false);
    }, 24 * 60 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
