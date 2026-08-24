/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/renderer/index.html',
    './src/renderer/avatar.html',
    './src/renderer/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        panel: 'var(--panel)',
        line: 'var(--border)',
        fg: 'var(--fg)',
        dim: 'var(--fg-dim)',
        accent: 'var(--accent)',
      },
    },
  },
  plugins: [],
};
