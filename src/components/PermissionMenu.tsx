import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Eye, Lock, Shield, ShieldAlert } from 'lucide-react';
import { PermissionLevel } from '../types';

interface PermissionMenuProps {
  value: PermissionLevel;
  onChange: (next: PermissionLevel) => Promise<void>;
}

const OPTIONS: Array<{
  id: PermissionLevel;
  title: string;
  badge?: string;
  desc: string;
  icon: React.FC<{ className?: string }>;
}> = [
  {
    id: 'ask_review',
    title: '请求审查',
    desc: '只读规划，每条命令均需批准。',
    icon: Eye
  },
  {
    id: 'default',
    title: '默认',
    badge: '默认',
    desc: '执行敏感操作前询问。',
    icon: Lock
  },
  {
    id: 'auto',
    title: '自动',
    desc: '自动判断是否执行命令。',
    icon: Shield
  },
  {
    id: 'turbo',
    title: 'Turbo',
    desc: '无限制运行所有本地 CLI 命令。',
    icon: ShieldAlert
  }
];

export const PermissionMenu: React.FC<PermissionMenuProps> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const current = OPTIONS.find((o) => o.id === value) || OPTIONS[2];
  const CurrentIcon = current.icon;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium transition-colors ${
          open
            ? 'bg-[#ececef] text-[#111827]'
            : 'text-[#52525b] hover:bg-[#f1f1f3] hover:text-[#111827]'
        }`}
        title="切换本地 CLI 执行权限等级"
      >
        <CurrentIcon className="h-3.5 w-3.5 text-[#52525b]" />
        <span>{current.title}</span>
        <ChevronDown
          className={`h-3 w-3 text-[#8a8f98] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute right-0 bottom-full z-50 mb-2 w-64 overflow-hidden rounded-2xl border border-[#e4e4e7] bg-white p-1.5 shadow-popover">
          <div className="px-2.5 py-1.5 text-[11px] font-medium text-[#8a8f98]">本会话</div>
          <div className="space-y-0.5">
            {OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const selected = opt.id === current.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    void onChange(opt.id);
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors ${
                    selected ? 'bg-[#f4f4f5]' : 'hover:bg-[#fafafa]'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0 text-[#3f3f46]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12.5px] font-medium text-[#111827]">{opt.title}</span>
                      {opt.badge && (
                        <span className="rounded-md bg-[#ececef] px-1.5 py-0.5 text-[10px] font-medium text-[#52525b]">
                          {opt.badge}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-[#71717a]">{opt.desc}</p>
                  </div>
                  {selected && <Check className="h-3.5 w-3.5 shrink-0 text-[#111827]" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
