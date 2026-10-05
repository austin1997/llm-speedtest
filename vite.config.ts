import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;
let revision = 'dev';
try { revision = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev'; } catch { /* A source archive may not be a git checkout. */ }

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(`${version}+${revision}`) },
  server: {
    port: 5173,
    strictPort: true,
    proxy: process.env.API_PROXY ? {
      '/api': {
        target: process.env.API_PROXY,
        configure: proxy => proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('origin', new URL(process.env.API_PROXY!).origin)),
      },
    } : undefined,
  },
});
