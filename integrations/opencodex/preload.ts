import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createGateway } from './gateway';
import { startDashboard } from './dashboard';
const root = dirname(import.meta.path);
const settings = JSON.parse(readFileSync(resolve(root, 'settings.json'), 'utf8'));
if (!settings.enabled) throw new Error('OpenCodex integration is disabled');
const key = readFileSync(resolve(root, 'gateway-key'), 'utf8').trim();
const nativeFetch = globalThis.fetch.bind(globalThis);
let stopping = false;
let child: ReturnType<typeof spawn> | undefined;
let lock: number | undefined;
const lockPath = resolve(root, 'owner.lock');
mkdirSync(resolve(root, 'logs'), { recursive: true });
try { lock = openSync(lockPath, 'wx'); }
catch {
  const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
  let alive = true; try { process.kill(owner.pid, 0); } catch { alive = false; }
  if (alive) throw new Error('Another Codex Web GPT gateway owns OpenCodex');
  unlinkSync(lockPath); lock = openSync(lockPath, 'wx');
}
writeFileSync(lock!, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
const stop = () => {
  stopping = true;
  child?.kill();
  if (lock !== undefined) { closeSync(lock); lock = undefined; }
  try { if (JSON.parse(readFileSync(lockPath, 'utf8')).pid === process.pid) unlinkSync(lockPath); } catch {}
};
process.once('exit', stop);
const log = openSync(resolve(root, 'logs/backend.log'), 'a');
function launch() {
  const current = JSON.parse(readFileSync(resolve(root, 'settings.json'), 'utf8'));
  child = spawn(process.execPath, [resolve(root, 'backend.ts'), current.packageRoot], {
    env: { ...process.env, OPENCODEX_HOME: current.home, OPENCODEX_API_AUTH_TOKEN: key,
      OPENCODEX_GATEWAY_PORT: String(current.port), OPENCODEX_GATEWAY_OWNER_PID: String(process.pid),
      OPENCODEX_CODEX_SHIM_AUTO_RESTORE: '0', OCX_DESKTOP_SUPERVISED: '1' },
    stdio: ['ignore', log, log], windowsHide: true,
  });
  child.on('error', () => console.error('[opencodex] Internal service could not start; see backend.log'));
  child.on('exit', () => { if (!stopping) setTimeout(launch, 3000).unref(); });
}
launch();
const endpoint = `http://127.0.0.1:${settings.port}`;
// Wait for immediate liveness before installing the transport. Startup must not
// accept a model call against a backend that has not bound its listener.
let healthy = false;
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    const response = await nativeFetch(endpoint + '/healthz', { signal: AbortSignal.timeout(1000) });
    const health = await response.json() as { version?: string; pid?: number };
    if (response.ok && health.pid === child?.pid && health.version === settings.version) { healthy = true; break; }
  } catch {}
  await new Promise(r => setTimeout(r, 300));
}
if (!healthy) { stop(); throw new Error('OpenCodex internal service did not pass startup health check'); }
const coreConfig = JSON.parse(readFileSync(resolve(settings.coreHome, 'config.json'), 'utf8'));
let proxyResolver:string|undefined;
if(coreConfig.browserHostDescriptorPath){
  const descriptor=JSON.parse(readFileSync(coreConfig.browserHostDescriptorPath,'utf8'));
  proxyResolver=new URL('/v1/network/resolve-proxy',descriptor.control.endpoint).href;
}
const routed = createGateway(nativeFetch, { endpoint, key, clientVersion: settings.clientVersion, proxyResolver });
// Preserve Bun's extra fetch helpers for official runtime code.
Object.assign(routed, globalThis.fetch);
globalThis.fetch = routed as typeof fetch;
const statusFile = resolve(root, 'runtime.json');
writeFileSync(statusFile + '.next', JSON.stringify({ gatewayPid: process.pid, backendPid: child?.pid, version: settings.version, endpoint, startedAt: new Date().toISOString() }));
renameSync(statusFile + '.next', statusFile);
console.log(`[opencodex] official backend ${settings.version} attached to Codex Web GPT`);
startDashboard(root, nativeFetch);
// A CLI configuration failure must not leave an apparently healthy dashboard
// keeping a failed Codex Web GPT child alive indefinitely.
setTimeout(async () => {
  try {
    const response = await nativeFetch(`http://${coreConfig.host}:${coreConfig.port}/healthz`, { signal: AbortSignal.timeout(3000) });
    const health = await response.json() as { pid?: number };
    if (!response.ok || health.pid !== process.pid) throw new Error();
  } catch { stop(); process.exit(1); }
}, 30000).unref();
