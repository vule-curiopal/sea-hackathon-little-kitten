import { createServer as createHttpServer } from 'node:http';
import type { Express } from 'express';
import { disposeApp } from './app.js';
import { attachSpeechStreams } from './modules/speech-streams/speech-stream.routes.js';

export interface PipelineServer {
  app: Express;
  listen(options: { host: string; port: number }): Promise<string>;
  close(): Promise<void>;
}

/** Express handles requests; this adapter owns sockets and process shutdown. */
export function createServer(app: Express): PipelineServer {
  const server = createHttpServer({ requestTimeout: 45_000, headersTimeout: 45_000 }, app);
  attachSpeechStreams(app, server);
  let closing: Promise<void> | undefined;

  return {
    app,
    async listen(options) {
      if (closing) throw new Error('Cannot listen after server shutdown.');
      if (!server.listening) {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => { server.removeListener('listening', onListening); reject(error); };
          const onListening = () => { server.removeListener('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(options);
        });
      }
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP address.');
      const host = address.address.includes(':') ? `[${address.address}]` : address.address;
      return `http://${host}:${address.port}`;
    },
    close() {
      closing ??= (async () => {
        disposeApp(app);
        if (!server.listening) return;
        await new Promise<void>((resolve, reject) => {
          server.close(error => { if (error) reject(error); else resolve(); });
          // Pending clients must not keep shutdown blocked after turn cancellation.
          server.closeAllConnections();
        });
      })();
      return closing;
    },
  };
}
