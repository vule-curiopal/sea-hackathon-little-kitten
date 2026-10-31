import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { networkInterfaces } from 'node:os';
import { selectLanAddress } from './src/lib/demo-share.ts';

function demoNetwork() {
  return {
    name: 'miu-demo-network',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use('/__demo/network', (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
        const addresses = Object.entries(networkInterfaces()).flatMap(([name, entries]) => (entries ?? []).map(entry => ({ ...entry, name })));
        const address = selectLanAddress(addresses);
        const listener = server.httpServer?.address();
        const port = listener && typeof listener !== 'string' ? listener.port : server.config.server.port;
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify({ origin: address ? `http://${address}:${port}` : null }));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), demoNetwork()],
  build: { target: 'safari16.4' },
  server: {
    port: 5173, strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true } },
  },
  preview: { proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true } } },
});
