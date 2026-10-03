import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [react(), tailwindcss(), ...(command === 'serve' ? [{
    name: 'ayana-development-refresh-csp',
    transformIndexHtml: (html: string) => html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';"),
  }] : [])],
  server: { host: '127.0.0.1', strictPort: true },
  build: { outDir: 'dist', sourcemap: true },
}));
