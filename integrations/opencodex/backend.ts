import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// A separate process keeps OpenCodex's proxy environment, caches and dependencies
// out of the ChatGPT browser/tool runtime. No OpenCodex source is modified.
const packageRoot = resolve(process.argv[2]!);
const home = resolve(process.env.OPENCODEX_HOME!);
const disk = JSON.parse(readFileSync(resolve(home, 'config.json'), 'utf8'));
if (disk.runtimeRole !== 'hub' || disk.unauthenticatedLoopbackListener?.enabled === true
  || disk.hostname !== '127.0.0.1' || disk.clientIntegrations?.codex !== false) {
  throw new Error('OpenCodex gateway ownership settings changed; refusing native client takeover');
}
const { startServer, loadConfig } = await import(resolve(packageRoot, 'src/index.ts'));
const admitted = loadConfig();
if (admitted.runtimeRole !== 'hub' || admitted.unauthenticatedLoopbackListener?.enabled === true
  || admitted.hostname !== '127.0.0.1' || admitted.clientIntegrations?.codex !== false) {
  throw new Error('OpenCodex configuration was not admitted as a hub; refusing standalone fallback');
}
const { takeDesktopSupervisedMarker } = await import(resolve(packageRoot, 'src/lib/system-restart-contract.ts'));
takeDesktopSupervisedMarker(process.env);
const server = startServer(Number(process.env.OPENCODEX_GATEWAY_PORT || disk.port));
const stop = async () => { await server.stop(true); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
// Owner PID is supplied by the gateway supervisor, not persisted in provider config.
const owner = Number(process.env.OPENCODEX_GATEWAY_OWNER_PID);
if (owner) setInterval(() => { try { process.kill(owner, 0); } catch { void stop(); } }, 1500).unref();
