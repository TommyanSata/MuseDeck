import React from 'react';

interface CliBrandIconProps {
  cliId?: string;
  avatarUrl?: string;
  className?: string;
}

export const CliBrandIcon: React.FC<CliBrandIconProps> = ({
  cliId = 'codex',
  avatarUrl,
  className = 'h-4 w-4'
}) => {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={cliId}
        className={`${className} rounded-full object-cover`}
      />
    );
  }

  switch (cliId) {
    case 'claude':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <g stroke="#D97757" strokeWidth="2.1" strokeLinecap="round">
            <line x1="12" y1="3" x2="12" y2="9" />
            <line x1="12" y1="15" x2="12" y2="21" />
            <line x1="3" y1="12" x2="9" y2="12" />
            <line x1="15" y1="12" x2="21" y2="12" />
            <line x1="5.6" y1="5.6" x2="9.8" y2="9.8" />
            <line x1="14.2" y1="14.2" x2="18.4" y2="18.4" />
            <line x1="18.4" y1="5.6" x2="14.2" y2="9.8" />
            <line x1="9.8" y1="14.2" x2="5.6" y2="18.4" />
          </g>
        </svg>
      );

    case 'codex':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <rect x="2" y="2" width="20" height="20" rx="5.5" fill="#111827" />
          <circle cx="12" cy="12" r="5.5" stroke="#FFFFFF" strokeWidth="2" />
          <path d="M9.5 14.5L14.5 9.5" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );

    case 'pi':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <path
            d="M5 7.5H19M9.5 7.5V17.5M15 7.5V15.5C15 16.8 15.8 17.5 17 17.5"
            stroke="#7C3AED"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );

    case 'opencode':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <path d="M5 5H15V13H9V19H5V5ZM15 13H19V19H15V13Z" fill="#18181B" />
          <rect x="9" y="8" width="3" height="2.5" fill="#FFFFFF" />
        </svg>
      );

    case 'gemini':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <path
            d="M12 2.5C12.8 7.8 16.2 11.2 21.5 12C16.2 12.8 12.8 16.2 12 21.5C11.2 16.2 7.8 12.8 2.5 12C7.8 11.2 11.2 7.8 12 2.5Z"
            fill="#2563EB"
          />
        </svg>
      );

    case 'antigravity':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <path d="M12 4L4.5 19H8.2L12 11.2L15.8 19H19.5L12 4Z" fill="#06B6D4" />
          <circle cx="12" cy="17.2" r="2" fill="#0E7490" />
        </svg>
      );

    case 'openclaw':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="5" fill="#EF4444" />
          <path d="M8.5 8.5L11 15.5M12 7.5V16.5M15.5 8.5L13 15.5" stroke="#FFFFFF" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
      );

    case 'grok':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="5" fill="#1E293B" />
          <path d="M8 16L16 8M9.5 8.5L15 15" stroke="#FFFFFF" strokeWidth="2.1" strokeLinecap="round" />
        </svg>
      );

    case 'kimi':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="5" fill="#2563EB" />
          <path d="M8.5 7.5V16.5M15.5 7.5L9.5 12L15.5 16.5" stroke="#FFFFFF" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );

    case 'deepseek':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="5" fill="#4F46E5" />
          <path d="M8.5 8H12.5C14.7 8 16.2 9.5 16.2 12C16.2 14.5 14.7 16 12.5 16H8.5V8Z" stroke="#FFFFFF" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      );

    default:
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="5" fill="#3F3F46" />
          <path d="M8 9.5L11 12L8 14.5M12.5 14.5H16" stroke="#FFFFFF" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
};
