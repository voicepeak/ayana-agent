import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import characters from './src/generated/characters.json' with { type: 'json' };

export default defineConfig({
  base: './',
  plugins: [react(), {
    name: 'mobile-offline-shell',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter(file => /\.(?:js|css)$/.test(file));
      this.emitFile({ type: 'asset', fileName: 'precache.json', source: JSON.stringify(files) });
      const mappings = { ayana: { mapping: characters.ayana.mapping } };
      this.emitFile({ type: 'asset', fileName: 'native-characters.json', source: JSON.stringify(mappings) });
    },
  }],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: {
      '/v1': { target: 'http://127.0.0.1:17330', ws: true, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
