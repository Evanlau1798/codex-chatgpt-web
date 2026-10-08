const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const source = __dirname;
const runtimeFiles = [
  'backend.ts', 'dashboard.ts', 'gateway.ts', 'GUIDE.fr.md',
  'launcher-hook.cjs', 'launcher-surface.cjs', 'launcher-ui-patch.cjs',
  'launcher-ui.css', 'manager.cjs', 'OpenCodexSurface.tsx', 'preload.ts',
];

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function absolute(value) { return path.resolve(value); }
function json(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

const root = absolute(option('root', process.env.CODEX_OPENCODEX_ROOT
  || path.join(os.homedir(), '.codex-chatgpt-web', 'integrations', 'opencodex')));
if (root === source) throw new Error('OpenCodex integration root must be separate from the source directory');
fs.mkdirSync(root, { recursive: true });
for (const file of runtimeFiles) fs.copyFileSync(path.join(source, file), path.join(root, file));

const home = absolute(option('home', process.env.OPENCODEX_HOME || path.join(root, 'state')));
fs.mkdirSync(home, { recursive: true });
const coreHome = absolute(option('core-home', process.env.CODEX_WEB_GPT_HOME
  || path.join(os.homedir(), '.codex-chatgpt-web')));
const codexHome = absolute(option('codex-home', process.env.CODEX_HOME || path.join(os.homedir(), '.codex')));
const node = process.execPath;
const nodeDir = path.dirname(node);
const npmCli = option('npm-cli', process.env.NPM_CLI || path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
const settingsPath = path.join(root, 'settings.json');
const current = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
const settings = {
  ...current,
  enabled: true,
  version: current.version || option('version', process.env.OPENCODEX_VERSION || 'unresolved'),
  packageRoot: current.packageRoot || option('package-root', process.env.OPENCODEX_PACKAGE_ROOT
    || path.join(root, 'packages', 'current', 'node_modules', '@bitkyc08', 'opencodex')),
  port: current.port || Number(option('port', process.env.OPENCODEX_PORT || '10110')),
  dashboardPort: current.dashboardPort || Number(option('dashboard-port', process.env.OPENCODEX_DASHBOARD_PORT || '10100')),
  home, coreHome, codexHome,
  clientVersion: current.clientVersion || process.env.CODEX_CLIENT_VERSION || 'unknown',
  launcher: current.launcher || option('launcher', process.env.CODEX_WEB_GPT_LAUNCHER || ''),
  bun: current.bun || option('bun', process.env.BUN_BIN || ''),
  node, npmCli,
};
json(settingsPath, settings);
if (!fs.existsSync(path.join(root, 'gateway-key'))) {
  fs.writeFileSync(path.join(root, 'gateway-key'), crypto.randomBytes(32).toString('base64url'), { mode: 0o600 });
}
const configPath = path.join(home, 'config.json');
if (!fs.existsSync(configPath)) json(configPath, {
  hostname: '127.0.0.1', port: settings.port, runtimeRole: 'hub',
  unauthenticatedLoopbackListener: { enabled: false },
  clientIntegrations: { codex: false }, codexAutoStart: false,
  codexShimAutoRestore: false, providers: {}, defaultProvider: undefined,
});
console.log(JSON.stringify({ root, settings: settingsPath, packageRoot: settings.packageRoot, copied: runtimeFiles }, null, 2));
