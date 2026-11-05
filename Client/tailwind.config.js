/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        // Neutral surfaces: warm paper and ink, so status colours carry meaning.
        paper: '#f6f5f1',
        panel: '#ffffff',
        line: '#e4e1d8',
        ink: { DEFAULT: '#1b1d1f', soft: '#4a4e53', faint: '#8a8f94' },
        // Driver state. Used only for state, never for decoration.
        ok: { DEFAULT: '#1f8a5b', bg: '#e7f4ec' },
        warn: { DEFAULT: '#c27a0a', bg: '#fdf3e1' },
        crit: { DEFAULT: '#c8322b', bg: '#fbe9e7' },
        idle: { DEFAULT: '#6b7075', bg: '#eeede8' },
      },
      boxShadow: {
        panel: '0 1px 0 rgba(27,29,31,0.04), 0 1px 2px rgba(27,29,31,0.06)',
      },
      keyframes: {
        flash: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.55' } },
        rise: { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: {
        flash: 'flash 0.9s ease-in-out infinite',
        rise: 'rise 180ms ease-out',
      },
    },
  },
  plugins: [],
};
