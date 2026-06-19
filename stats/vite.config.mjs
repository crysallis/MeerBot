import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api':  'http://127.0.0.1:3002',
      '/auth': 'http://127.0.0.1:3002',
    },
  },
});
