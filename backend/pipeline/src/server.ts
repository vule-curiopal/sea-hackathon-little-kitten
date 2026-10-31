import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createServer } from './server-runtime.js';

async function main() {
  const config = loadConfig();
  const server = createServer(await buildApp({ config }));
  let address: string;
  try {
    address = await server.listen({ host: config.host, port: config.port });
  } catch (error) {
    await server.close();
    throw error;
  }
  console.log(`Miu voice API: ${address} (Express; ${config.mode}; voice_stub, no memory)`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    void server.close().catch(() => { process.exitCode = 1; });
  });
}
main().catch(() => { console.error('Voice API startup failed. Check configuration, dependencies and README; secret values are not logged.'); process.exitCode = 1; });
