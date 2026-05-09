import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  root: 'app',
  plugins: [wasm(), topLevelAwait()],
  worker: {
    format: 'iife',
  },
  optimizeDeps: {
    exclude: ['opencv.js', 'libraw-wasm'],
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
