import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } },
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') } } },
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          // the overlay is its own page: a looser CSP for wasm + file:
          // textures, and babylon stays out of the chat bundle
          avatar: resolve('src/renderer/avatar.html'),
        },
      },
    },
    resolve: {
      alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') },
    },
  },
});
