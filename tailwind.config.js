/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        codex: {
          canvas: '#ffffff',
          sidebar: '#f7f7f8',
          panel: '#fafafa',
          hover: '#f1f1f3',
          active: '#ececef',
          border: '#eaecef',
          ink: '#111827',
          muted: '#71717a'
        },
        brand: {
          50: '#fafafa',
          100: '#f4f4f5',
          500: '#18181b',
          600: '#09090b'
        }
      },
      boxShadow: {
        composer: '0 2px 12px rgba(0, 0, 0, 0.04)',
        'composer-focus': '0 4px 20px rgba(0, 0, 0, 0.07)',
        popover: '0 10px 32px -4px rgba(0, 0, 0, 0.1), 0 2px 8px -2px rgba(0, 0, 0, 0.05)'
      }
    }
  },
  plugins: []
};
