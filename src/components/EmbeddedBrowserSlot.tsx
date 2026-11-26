import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, Globe, RotateCw } from 'lucide-react';

interface PresetTab {
  label: string;
  url: string;
}

interface EmbeddedBrowserSlotProps {
  target: 'feishu' | 'muse';
  initialUrl: string;
  presets?: PresetTab[];
  visible?: boolean;
  headerRight?: React.ReactNode;
}

export const EmbeddedBrowserSlot: React.FC<EmbeddedBrowserSlotProps> = ({
  target,
  initialUrl,
  presets = [],
  visible = true,
  headerRight
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [urlInput, setUrlInput] = useState(initialUrl);

  const syncBounds = (explicitUrl?: string) => {
    if (!visible || !containerRef.current || !window.fmc) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    void window.fmc.showEmbeddedView(
      target,
      { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      explicitUrl
    );
  };

  useEffect(() => {
    if (!visible) {
      void window.fmc?.hideEmbeddedViews();
      return;
    }
    syncBounds(initialUrl);
    const ro = new ResizeObserver(() => syncBounds());
    if (containerRef.current) ro.observe(containerRef.current);
    const onWinResize = () => syncBounds();
    window.addEventListener('resize', onWinResize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
      void window.fmc?.hideEmbeddedViews();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, visible]);

  const navigateTo = (nextUrl: string) => {
    setUrlInput(nextUrl);
    void window.fmc?.navigateEmbeddedView(target, nextUrl);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[#eaecef] bg-white px-3">
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => void window.fmc?.goBackEmbeddedView(target)}
            className="rounded-md p-1.5 text-[#71717a] transition-colors hover:bg-[#f1f1f3] hover:text-[#111827]"
            title="后退"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => void window.fmc?.reloadEmbeddedView(target)}
            className="rounded-md p-1.5 text-[#71717a] transition-colors hover:bg-[#f1f1f3] hover:text-[#111827]"
            title="刷新"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
        </div>

        {presets.length > 0 && (
          <div className="flex items-center rounded-lg bg-[#f4f4f5] p-0.5">
            {presets.map((p) => (
              <button
                key={p.url}
                onClick={() => navigateTo(p.url)}
                className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                  urlInput === p.url
                    ? 'bg-white text-[#111827] shadow-2xs'
                    : 'text-[#71717a] hover:text-[#111827]'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}

        <form
          className="flex flex-1 items-center gap-1.5 rounded-lg border border-[#eaecef] bg-[#fafafa] px-2.5 py-1 transition-colors focus-within:border-[#d4d4d8] focus-within:bg-white"
          onSubmit={(e) => {
            e.preventDefault();
            navigateTo(urlInput);
          }}
        >
          <Globe className="h-3.5 w-3.5 shrink-0 text-[#a1a1aa]" />
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            className="w-full bg-transparent text-[12px] text-[#3f3f46] outline-none"
            placeholder="输入网址并回车..."
          />
        </form>

        <button
          onClick={() => {
            const targetUrl = /^https?:\/\//i.test(urlInput.trim())
              ? urlInput.trim()
              : `https://${urlInput.trim()}`;
            void window.fmc?.openExternal(targetUrl);
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[#eaecef] bg-white px-2.5 py-1 text-[11.5px] font-medium text-[#52525b] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
          title="用本机正式版 Chrome 打开（支持 Chrome 扩展插件）"
        >
          <ExternalLink className="h-3 w-3" />
          外部打开
        </button>
        {headerRight}
      </div>

      <div ref={containerRef} className="relative flex-1 bg-[#f7f7f8]">
        <div className="flex h-full items-center justify-center text-xs text-[#8a8f98]">
          内嵌 Chromium 视窗（独立持久化分区：{target === 'muse' ? 'persist:fmc-muse' : 'persist:fmc-feishu'}）
        </div>
      </div>
    </div>
  );
};
