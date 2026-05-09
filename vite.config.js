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
});
