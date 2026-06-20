import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
    root: 'src',
    publicDir: '../public',
    build: {
        outDir: '../dist',
        emptyOutDir: true,
    },
    server: {
        port: 5174,
        proxy: {
            '/api':  'http://127.0.0.1:3001',
            '/auth': 'http://127.0.0.1:3001',
        },
    },
    plugins: [tailwindcss()],
});
