const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const REVISION = 'opencodex-launcher-surface-v1';
const SOURCE = 'https://github.com/Evanlau1798/codex-chatgpt-web.git';

function replaceOnce(text, anchor, replacement, label) {
  if (text.split(anchor).length !== 2) throw new Error(`Official launcher ${label} changed; dashboard integration was not applied`);
  return text.replace(anchor, replacement);
}

function patchSources(launcher, addonRoot) {
  const appFile = path.join(launcher, 'src/App.tsx');
  let app = fs.readFileSync(appFile, 'utf8');
  app = replaceOnce(app, '    firstRunZeroRiskSetup ? "mcp"', '    window.openCodexLauncher?.openOnLaunch ? "opencodex" : firstRunZeroRiskSetup ? "mcp"', 'initial surface');
  app = replaceOnce(app, 'import { SettingsSurface }', 'import { OpenCodexSurface } from "./OpenCodexSurface";\nimport { SettingsSurface }', 'surface imports');
  app = replaceOnce(app, 'const browserSurfaceActive = surface === "browser"', 'const openCodexActive = surface === "opencodex" && !(compactSidebar && sidebarOpen);\n  const browserSurfaceActive = surface === "browser"', 'surface visibility');
  app = replaceOnce(app, '              <SidebarGroup label={copy.configuration}>', `              {window.openCodexLauncher ? <SidebarGroup label="OpenCodex">
                <SidebarItem active={surface === "opencodex"} icon="globe" label="OpenCodex" onClick={() => navigateSurface("opencodex")} />
              </SidebarGroup> : null}
              <SidebarGroup label={copy.configuration}>`, 'sidebar navigation');
  app = replaceOnce(app, '            {surface === "setup" ? (', `            {surface === "opencodex" ? (
              <OpenCodexSurface active={openCodexActive} language={language} setError={setError} />
            ) : null}
            {surface === "setup" ? (`, 'surface rendering');
  // Hide the native OpenCodex view before React's exit animation, then let the
  // existing ChatGPT effect decide whether its own surface should be shown.
  app = replaceOnce(app, '  const activateBrowser = useCallback', `  useLayoutEffect(() => {
    if (surface !== "opencodex") void window.openCodexLauncher?.setSurface({ active: false }).catch(cause => setError(messageOf(cause)));
  }, [surface, setError]);

  const activateBrowser = useCallback`, 'surface lifecycle');
  fs.writeFileSync(appFile, app);
  const typesFile = path.join(launcher, 'src/types.ts');
  let types = fs.readFileSync(typesFile, 'utf8');
  types = replaceOnce(types, 'export type Surface = "browser"', 'export type Surface = "opencodex" | "browser"', 'surface types');
  types = replaceOnce(types, '    codexWebLauncher?: LauncherApi;', `    codexWebLauncher?: LauncherApi;
    openCodexLauncher?: {
      openOnLaunch: boolean;
      setSurface(input: { active: boolean; bounds?: { x: number; y: number; width: number; height: number } }): Promise<boolean>;
      reload(): Promise<boolean>;
    };`, 'dashboard API types');
  fs.writeFileSync(typesFile, types);
  fs.copyFileSync(path.join(addonRoot, 'OpenCodexSurface.tsx'), path.join(launcher, 'src/OpenCodexSurface.tsx'));
  fs.appendFileSync(path.join(launcher, 'src/styles.css'), '\n' + fs.readFileSync(path.join(addonRoot, 'launcher-ui.css'), 'utf8'));
}

function patchElectron(extracted, addonRoot) {
  const mainFile = path.join(extracted, 'electron/main.cjs');
  let main = fs.readFileSync(mainFile, 'utf8');
  const anchor = '  window.setMenuBarVisibility(false);';
  main = replaceOnce(main, anchor, `  // ${REVISION}: same-window, isolated official OpenCodex dashboard.
  require(${JSON.stringify(path.join(addonRoot, 'launcher-surface.cjs'))}).createLauncherSurface({
    window, getBrowserHost: () => browserHost, logger,
  });
${anchor}`, 'window creation');
  fs.writeFileSync(mainFile, main);
  fs.appendFileSync(path.join(extracted, 'electron/preload.cjs'), `
// ${REVISION}: this API is exposed only to the trusted launcher renderer.
contextBridge.exposeInMainWorld("openCodexLauncher", {
  openOnLaunch: ipcRenderer.sendSync("launcher:opencodex-open-on-launch"),
  setSurface: input => ipcRenderer.invoke("launcher:opencodex-surface", input),
  reload: () => ipcRenderer.invoke("launcher:opencodex-reload"),
});
`);
}

async function run(executable, args, cwd, settings) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
        PATH: path.dirname(settings.node) + path.delimiter + process.env.PATH },
    });
    let tail = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { tail = (tail + value).slice(-6000); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Launcher renderer preparation failed (${code}): ${tail}`)));
  });
}

async function prepareRenderer({ root, extracted, job, settings }) {
  const version = JSON.parse(fs.readFileSync(path.join(extracted, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid official launcher version');
  const cache = path.join(root, 'renderer-sources', 'v' + version);
  const cachedLauncher = path.join(cache, 'launcher');
  if (!fs.existsSync(path.join(cachedLauncher, 'package.json'))) {
    const temporary = cache + '.next-' + Date.now();
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    const git = settings.git || (process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git');
    await run(git, ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', 'v' + version, SOURCE, temporary], root, settings);
    await run(git, ['sparse-checkout', 'set', 'launcher'], temporary, settings);
    fs.renameSync(temporary, cache);
  }
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(cachedLauncher, 'package.json'), 'utf8'));
  const installedPackage = JSON.parse(fs.readFileSync(path.join(extracted, 'package.json'), 'utf8'));
  if (sourcePackage.name !== installedPackage.name || sourcePackage.version !== version
      || Object.entries(installedPackage.dependencies || {}).some(([name, value]) => sourcePackage.dependencies?.[name] !== value)) {
    throw new Error('Official launcher sources do not match the installed release');
  }
  if (!fs.existsSync(path.join(cachedLauncher, 'node_modules/vite'))) {
    await run(settings.bun, ['install', '--frozen-lockfile', '--ignore-scripts'], cachedLauncher, settings);
  }
  const build = path.join(job, 'renderer');
  fs.cpSync(cachedLauncher, build, { recursive: true, filter: file => !['node_modules', 'dist', '.git', 'build', 'release'].includes(path.basename(file)) });
  fs.symlinkSync(path.join(cachedLauncher, 'node_modules'), path.join(build, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  patchSources(build, root);
  await run(settings.bun, ['run', 'build'], build, settings);
  // Hash names may change. Retain the official files and replace only index.html
  // plus the freshly built assets, avoiding recursive deletion of app contents.
  fs.cpSync(path.join(build, 'dist'), path.join(extracted, 'dist'), { recursive: true });
  patchElectron(extracted, root);
  return { version, rendererSource: cache, rendererBuild: build, revision: REVISION };
}

module.exports = { REVISION, SOURCE, replaceOnce, patchSources, patchElectron, prepareRenderer };
