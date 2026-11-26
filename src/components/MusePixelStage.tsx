import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Play, Square } from 'lucide-react';
import { DetectedCli } from '../types';

interface MusePixelStageProps {
  museAvatarUrl?: string;
  runningCliIds: string[];
  clis: DetectedCli[];
}

interface Palette {
  head: string;
  body: string;
  accent: string;
}

interface RoamerState {
  id: string;
  name: string;
  isMuse: boolean;
  x: number;
  dir: 1 | -1;
  mode: 'walk' | 'idle' | 'coffee' | 'nap' | 'hop';
  timer: number;
}

const DEFAULT_CLI_PALETTES: Record<string, Palette> = {
  codex: { head: '#3f3f46', body: '#18181b', accent: '#10b981' },
  claude: { head: '#f5b092', body: '#d97757', accent: '#ea580c' },
  antigravity: { head: '#a5f3fc', body: '#0891b2', accent: '#06b6d4' },
  gemini: { head: '#bfdbfe', body: '#2563eb', accent: '#3b82f6' },
  pi: { head: '#ddd6fe', body: '#7c3aed', accent: '#8b5cf6' },
  opencode: { head: '#d4d4d8', body: '#27272a', accent: '#52525b' },
  openclaw: { head: '#fecaca', body: '#dc2626', accent: '#ef4444' },
  grok: { head: '#cbd5e1', body: '#1e293b', accent: '#475569' },
  kimi: { head: '#bfdbfe', body: '#1d4ed8', accent: '#2563eb' },
  deepseek: { head: '#c7d2fe', body: '#4338ca', accent: '#4f46e5' }
};

function sampleImagePalette(url: string): Promise<Palette | null> {
  return new Promise((resolve) => {
    if (!url || (!url.startsWith('data:image') && !/^https?:\/\//i.test(url))) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 12;
        c.height = 12;
        const ctx = c.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, 12, 12);
        const px = (x: number, y: number) => {
          const d = ctx.getImageData(x, y, 1, 1).data;
          if (d[3] < 80) return null;
          return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
        };
        const head = px(6, 3) || px(6, 4);
        const body = px(6, 9) || px(4, 8);
        const accent = px(6, 6) || head;
        if (head && body) {
          resolve({ head, body, accent: accent || body });
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

const WHIP_SHOUTS = ['快写代码!', '加速!', '*啪!*', '别摸鱼!'];

export const MusePixelStage: React.FC<MusePixelStageProps> = ({
  museAvatarUrl,
  runningCliIds,
  clis
}) => {
  const [previewMode, setPreviewMode] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [palettes, setPalettes] = useState<Record<string, Palette>>({});
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const roamersRef = useRef<RoamerState[]>([]);

  const rosterClis = useMemo(() => {
    const enabled = clis.filter((c) => c.config.enabled);
    return (enabled.length > 0 ? enabled : clis.slice(0, 3)).slice(0, 4);
  }, [clis]);

  const activeWorkers = useMemo(() => {
    if (runningCliIds.length > 0) {
      return runningCliIds
        .map((id) => clis.find((c) => c.id === id))
        .filter((c): c is DetectedCli => Boolean(c))
        .slice(0, 4);
    }
    if (previewMode) {
      return rosterClis;
    }
    return [];
  }, [runningCliIds, previewMode, clis, rosterClis]);

  const isWorking = activeWorkers.length > 0;

  // Sample real dominant colors from Muse & CLI avatars
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const next: Record<string, Palette> = {};
      if (museAvatarUrl) {
        const p = await sampleImagePalette(museAvatarUrl);
        if (p) next.__muse = p;
      }
      const pool = isWorking ? activeWorkers : rosterClis;
      for (const cli of pool) {
        if (cli.config.avatarUrl) {
          const p = await sampleImagePalette(cli.config.avatarUrl);
          if (p) next[cli.id] = p;
        }
      }
      if (!cancelled && Object.keys(next).length > 0) {
        setPalettes((prev) => ({ ...prev, ...next }));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [museAvatarUrl, activeWorkers, rosterClis, isWorking]);

  // Sync roamer entities when CLI roster changes
  useEffect(() => {
    const W = 420;
    const desired: Array<{ id: string; name: string; isMuse: boolean }> = [
      { id: '__muse', name: 'Muse', isMuse: true },
      ...rosterClis.map((c) => ({
        id: c.id,
        name: c.name.length > 7 ? c.id : c.name,
        isMuse: false
      }))
    ];
    const existing = new Map(roamersRef.current.map((r) => [r.id, r]));
    roamersRef.current = desired.map((d, idx) => {
      const prev = existing.get(d.id);
      if (prev) return { ...prev, name: d.name };
      const spacing = Math.floor((W - 60) / Math.max(1, desired.length));
      return {
        id: d.id,
        name: d.name,
        isMuse: d.isMuse,
        x: 28 + idx * spacing + (idx % 2) * 10,
        dir: idx % 2 === 0 ? 1 : -1,
        mode: idx === 0 ? 'walk' : idx % 3 === 0 ? 'coffee' : 'walk',
        timer: 10 + idx * 7
      };
    });
  }, [rosterClis]);

  // Retro pixel animation loop: Idle Roaming/Slacking OR Working Whipping
  useEffect(() => {
    if (hidden) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frame = 0;

    const drawMiniMuse = (
      mx: number,
      my: number,
      pal: Palette,
      facingRight: boolean,
      walkStep: number,
      mode: RoamerState['mode']
    ) => {
      const bounce = mode === 'hop' ? -3 : walkStep === 1 ? -1 : 0;
      const y = my + bounce;
      // Ground shadow
      ctx.fillStyle = 'rgba(0,0,0,0.08)';
      ctx.fillRect(mx + 2, my + 24, 14, 2);

      // Legs
      ctx.fillStyle = '#27272a';
      if (mode === 'walk') {
        ctx.fillRect(mx + 4, y + 19 + (walkStep === 0 ? 0 : -1), 3, 6);
        ctx.fillRect(mx + 10, y + 19 + (walkStep === 1 ? 0 : -1), 3, 6);
      } else {
        ctx.fillRect(mx + 4, y + 19, 3, 6);
        ctx.fillRect(mx + 10, y + 19, 3, 6);
      }

      // Suit torso
      ctx.fillStyle = pal.body;
      ctx.fillRect(mx + 2, y + 10, 13, 10);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(mx + 6, y + 10, 5, 4);
      ctx.fillStyle = pal.accent;
      ctx.fillRect(mx + 8, y + 11, 1, 6);

      // Capsule Muse head
      ctx.fillStyle = pal.head;
      ctx.fillRect(mx + 4, y, 10, 10);
      ctx.fillRect(mx + 3, y + 2, 12, 7);

      // Eyes
      ctx.fillStyle = '#18181b';
      const ex = facingRight ? mx + 7 : mx + 5;
      if (mode === 'nap') {
        ctx.fillRect(ex, y + 5, 2, 1);
        ctx.fillRect(ex + 3, y + 5, 2, 1);
      } else {
        ctx.fillRect(ex, y + 4, 2, 2);
        ctx.fillRect(ex + 3, y + 4, 2, 2);
      }

      // Coffee mug when slacking
      if (mode === 'coffee') {
        const cx = facingRight ? mx + 15 : mx - 3;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(cx, y + 13, 4, 4);
        ctx.fillStyle = '#92400e';
        ctx.fillRect(cx + 1, y + 13, 2, 1);
        if (frame % 4 < 2) {
          ctx.fillStyle = '#a1a1aa';
          ctx.fillRect(cx + 1, y + 10, 1, 2);
        }
      }
      if (mode === 'nap' && frame % 6 < 4) {
        ctx.fillStyle = '#71717a';
        ctx.font = 'bold 7px monospace';
        ctx.fillText('zZ', mx + 13, y + 2 - (frame % 3));
      }
    };

    const drawMiniWorkerRoam = (
      wx: number,
      wy: number,
      pal: Palette,
      facingRight: boolean,
      walkStep: number,
      mode: RoamerState['mode']
    ) => {
      const bounce = mode === 'hop' ? -3 : walkStep === 1 ? -1 : 0;
      const y = wy + bounce;
      // Ground shadow
      ctx.fillStyle = 'rgba(0,0,0,0.08)';
      ctx.fillRect(wx + 2, wy + 22, 11, 2);

      // Legs
      ctx.fillStyle = '#27272a';
      if (mode === 'walk') {
        ctx.fillRect(wx + 3, y + 17 + (walkStep === 0 ? 0 : -1), 3, 5);
        ctx.fillRect(wx + 8, y + 17 + (walkStep === 1 ? 0 : -1), 3, 5);
      } else {
        ctx.fillRect(wx + 3, y + 17, 3, 5);
        ctx.fillRect(wx + 8, y + 17, 3, 5);
      }

      // Body
      ctx.fillStyle = pal.body;
      ctx.fillRect(wx + 2, y + 9, 10, 9);

      // Head + accent cap
      ctx.fillStyle = pal.head;
      ctx.fillRect(wx + 2, y + 1, 10, 8);
      ctx.fillStyle = pal.accent;
      ctx.fillRect(wx + 2, y + 1, 10, 2);

      // Eyes
      ctx.fillStyle = '#111827';
      const ex = facingRight ? wx + 7 : wx + 4;
      if (mode === 'nap') {
        ctx.fillRect(ex, y + 5, 3, 1);
      } else {
        ctx.fillRect(ex, y + 4, 2, 2);
      }

      if (mode === 'coffee') {
        const cx = facingRight ? wx + 12 : wx - 2;
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(cx, y + 12, 3, 4);
      } else if (mode === 'nap' && frame % 6 < 4) {
        ctx.fillStyle = '#a1a1aa';
        ctx.font = 'bold 7px monospace';
        ctx.fillText('z', wx + 11, y + 2 - (frame % 3));
      } else if (mode === 'hop') {
        ctx.fillStyle = '#f59e0b';
        ctx.font = 'bold 7px monospace';
        ctx.fillText('♪', wx + 11, y + 1);
      }
    };

    const draw = () => {
      const W = 420;
      const H = 56;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, W, H);

      const musePal = palettes.__muse || { head: '#f3d27a', body: '#3f3f46', accent: '#9f1239' };

      if (!isWorking) {
        // === IDLE MODE: Pixel Muse & CLI buddies roaming/slacking right on top of the composer ===
        for (const r of roamersRef.current) {
          r.timer -= 1;
          if (r.timer <= 0) {
            const roll = Math.random();
            if (roll < 0.52) {
              r.mode = 'walk';
              r.dir = Math.random() < 0.5 ? 1 : -1;
              r.timer = 14 + Math.floor(Math.random() * 22);
            } else if (roll < 0.72) {
              r.mode = 'idle';
              r.timer = 10 + Math.floor(Math.random() * 14);
            } else if (roll < 0.85) {
              r.mode = 'coffee';
              r.timer = 16 + Math.floor(Math.random() * 14);
            } else if (roll < 0.94) {
              r.mode = 'nap';
              r.timer = 18 + Math.floor(Math.random() * 16);
            } else {
              r.mode = 'hop';
              r.timer = 6;
            }
          }

          if (r.mode === 'walk') {
            r.x += r.dir * 1.4;
            if (r.x < 16) {
              r.x = 16;
              r.dir = 1;
            } else if (r.x > W - 34) {
              r.x = W - 34;
              r.dir = -1;
            }
          }

          const step = r.mode === 'walk' ? frame % 2 : 0;
          const rx = Math.round(r.x);
          if (r.isMuse) {
            drawMiniMuse(rx, 30, musePal, r.dir === 1, step, r.mode);
          } else {
            const cli = clis.find((c) => c.id === r.id);
            const pal = palettes[r.id] || DEFAULT_CLI_PALETTES[r.id] || {
              head: '#d4d4d8',
              body: cli?.badgeColor || '#3f3f46',
              accent: cli?.badgeColor || '#18181b'
            };
            drawMiniWorkerRoam(rx, 32, pal, r.dir === 1, step, r.mode);
          }
        }
        frame++;
        return;
      }

      // === WORKING MODE: Pixel Muse cracking whip at working CLI desks perched on the composer ===
      const cycle = frame % 12;
      const isWindup = cycle >= 2 && cycle <= 4;
      const isCrack = cycle === 5 || cycle === 6;

      // 1. Pixel Muse Supervisor on the Left
      const mx = 24;
      const my = 26 + (cycle % 4 === 0 ? -1 : 0);

      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.08)';
      ctx.fillRect(mx + 2, 53, 16, 2);

      // Legs
      ctx.fillStyle = '#27272a';
      ctx.fillRect(mx + 4, my + 21, 4, 7);
      ctx.fillRect(mx + 10, my + 21, 4, 7);

      // Suit torso
      ctx.fillStyle = musePal.body;
      ctx.fillRect(mx + 2, my + 10, 14, 12);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(mx + 7, my + 10, 5, 4);
      ctx.fillStyle = musePal.accent;
      ctx.fillRect(mx + 9, my + 12, 2, 7);

      // Capsule Muse head
      ctx.fillStyle = musePal.head;
      ctx.fillRect(mx + 4, my, 11, 11);
      ctx.fillRect(mx + 3, my + 2, 13, 8);
      // Eyes looking right
      ctx.fillStyle = '#18181b';
      ctx.fillRect(mx + 9, my + 4, 2, 2);
      ctx.fillRect(mx + 12, my + 4, 2, 2);
      if (isCrack || isWindup) {
        ctx.fillRect(mx + 9, my + 2, 2, 1);
        ctx.fillRect(mx + 12, my + 2, 2, 1);
      }

      // Whip arm & pixel whip
      ctx.fillStyle = musePal.body;
      if (isWindup) {
        ctx.fillRect(mx - 1, my + 8, 4, 4);
        ctx.fillStyle = '#78350f';
        ctx.fillRect(mx - 4, my + 5, 4, 2);
        ctx.fillRect(mx - 8, my + 2, 5, 2);
        ctx.fillRect(mx - 11, my + 4, 4, 2);
      } else if (isCrack) {
        ctx.fillRect(mx + 16, my + 10, 5, 3);
        ctx.fillStyle = '#78350f';
        for (let i = 0; i < 42; i += 3) {
          const wy = my + 11 + Math.round(Math.sin(i * 0.24) * 3);
          ctx.fillRect(mx + 21 + i, wy, 3, 2);
        }
        // Golden sparks
        const sx = mx + 64;
        const sy = my + 10;
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(sx, sy - 4, 2, 3);
        ctx.fillRect(sx, sy + 4, 2, 3);
        ctx.fillRect(sx - 4, sy, 3, 2);
        ctx.fillRect(sx + 4, sy, 3, 2);
        ctx.fillStyle = '#fef08a';
        ctx.fillRect(sx, sy, 3, 3);
      } else {
        ctx.fillRect(mx + 15, my + 13, 4, 3);
        ctx.fillStyle = '#78350f';
        ctx.fillRect(mx + 19, my + 16, 6, 2);
        ctx.fillRect(mx + 24, my + 18, 6, 2);
      }

      // Speech bubble
      if (cycle >= 5 && cycle <= 9) {
        const shout = WHIP_SHOUTS[Math.floor(frame / 12) % WHIP_SHOUTS.length];
        ctx.fillStyle = '#18181b';
        ctx.fillRect(mx + 16, 2, 46, 12);
        ctx.fillRect(mx + 20, 14, 3, 2);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 8px monospace';
        ctx.fillText(shout, mx + 20, 11);
      }

      // 2. Working Pixel CLI Desks on the Right
      const count = activeWorkers.length;
      const startX = 116;
      const spacing = count > 1 ? Math.min(72, Math.floor(280 / count)) : 76;

      activeWorkers.forEach((cli, idx) => {
        const wx = startX + idx * spacing;
        const wy = 28;
        const pal = palettes[cli.id] || DEFAULT_CLI_PALETTES[cli.id] || {
          head: '#d4d4d8',
          body: cli.badgeColor || '#3f3f46',
          accent: cli.badgeColor || '#18181b'
        };
        const typingAlt = (frame + idx) % 2 === 0;
        const flinch = isCrack ? 1 : 0;

        // Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.07)';
        ctx.fillRect(wx + 2, 53, 34, 2);

        // Desk
        ctx.fillStyle = '#d6d3d1';
        ctx.fillRect(wx + 16, wy + 16, 20, 3);
        ctx.fillStyle = '#a8a29e';
        ctx.fillRect(wx + 18, wy + 19, 2, 8);
        ctx.fillRect(wx + 32, wy + 19, 2, 8);

        // Monitor
        ctx.fillStyle = '#27272a';
        ctx.fillRect(wx + 21, wy + 3, 14, 11);
        ctx.fillStyle = '#18181b';
        ctx.fillRect(wx + 22, wy + 4, 12, 9);
        ctx.fillRect(wx + 27, wy + 14, 3, 2);
        ctx.fillStyle = pal.accent;
        ctx.fillRect(wx + 24, wy + 6, typingAlt ? 7 : 4, 1);
        ctx.fillStyle = '#34d399';
        ctx.fillRect(wx + 24, wy + 8, typingAlt ? 4 : 8, 1);
        ctx.fillStyle = '#94a3b8';
        ctx.fillRect(wx + 24, wy + 10, 6, 1);

        // Chair
        ctx.fillStyle = '#71717a';
        ctx.fillRect(wx + 2, wy + 13, 3, 14);
        ctx.fillRect(wx + 2, wy + 20, 9, 2);

        // Worker body & legs
        ctx.fillStyle = pal.body;
        ctx.fillRect(wx + 5, wy + 11 + flinch, 9, 10);
        ctx.fillStyle = '#27272a';
        ctx.fillRect(wx + 6, wy + 21, 3, 6);
        ctx.fillRect(wx + 10, wy + 21, 3, 6);

        // Worker head
        ctx.fillStyle = pal.head;
        ctx.fillRect(wx + 5, wy + 1 + flinch, 9, 9);
        ctx.fillStyle = pal.accent;
        ctx.fillRect(wx + 5, wy + 1 + flinch, 9, 2);
        ctx.fillStyle = '#111827';
        ctx.fillRect(wx + 11, wy + 4 + flinch, 2, 2);

        // Typing arms
        ctx.fillStyle = pal.body;
        ctx.fillRect(wx + 12, wy + 14 + (typingAlt ? 0 : 1), 6, 3);
        ctx.fillStyle = '#52525b';
        ctx.fillRect(wx + 17, wy + 15, 4, 1);

        // Sweat drops
        if (isCrack || (frame + idx) % 5 === 0) {
          ctx.fillStyle = '#38bdf8';
          ctx.fillRect(wx + 2, wy - 2 - (frame % 3), 2, 3);
        }

        // Mini label floating cleanly above monitor
        ctx.fillStyle = '#71717a';
        ctx.font = 'bold 7px monospace';
        const shortName = cli.name.length > 7 ? cli.id : cli.name;
        ctx.fillText(shortName, wx + 18, wy + 1);
      });

      frame++;
    };

    draw();
    const timer = setInterval(draw, 115);
    return () => clearInterval(timer);
  }, [isWorking, hidden, activeWorkers, palettes, clis]);

  if (hidden) {
    return (
      <div className="mb-1 flex justify-end px-1">
        <button
          type="button"
          onClick={() => setHidden(false)}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-[#a1a1aa] transition-colors hover:bg-[#f4f4f5] hover:text-[#52525b]"
        >
          <Eye className="h-3 w-3" />
          显示像素小人
        </button>
      </div>
    );
  }

  return (
    <div className="group relative -mb-[2px] select-none px-3">
      {/* Subtle hover controls perched at top-right */}
      <div className="absolute top-0 right-3 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {runningCliIds.length === 0 && (
          <button
            type="button"
            onClick={() => setPreviewMode((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md border border-[#e4e4e7] bg-white/95 px-2 py-0.5 text-[10px] font-medium text-[#52525b] shadow-2xs hover:bg-[#f4f4f5] hover:text-[#111827]"
          >
            {previewMode ? (
              <>
                <Square className="h-2.5 w-2.5 fill-current" />
                切回摸鱼
              </>
            ) : (
              <>
                <Play className="h-2.5 w-2.5" />
                预览鞭策
              </>
            )}
          </button>
        )}
        <button
          type="button"
          onClick={() => setHidden(true)}
          className="rounded-md border border-[#e4e4e7] bg-white/95 p-0.5 text-[#71717a] shadow-2xs hover:bg-[#f4f4f5] hover:text-[#111827]"
          title="隐藏像素小人"
        >
          <EyeOff className="h-3 w-3" />
        </button>
      </div>

      <canvas
        ref={canvasRef}
        width={420}
        height={56}
        style={{ imageRendering: 'pixelated' }}
        className="pointer-events-none block h-[64px] w-full object-contain object-bottom"
      />
    </div>
  );
};
