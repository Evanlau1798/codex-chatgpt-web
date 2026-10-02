import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_MIN_VERSION,
  CLAUDE_MODEL,
  CODEX_MODEL,
  CODEX_VERSION,
  DEFAULT_EMPTY_MCP,
  assertDirectory,
  assertExecutable,
  assertExactCodexCatalog,
  buildClaudeArgs,
  buildCodexArgs,
  canonicalCodexHome,
  parseLauncherArgs,
  nativeInvocation,
  printHelp,
} from './launch-args.mjs';
import { bridgeConfig, createRecordingProxy, sha256, StreamRedactor } from './proxy.mjs';

const SENSITIVE_ENV = /^(?:OPENAI_|ANTHROPIC_|CLAUDE_|OTEL_|CODEX_API_KEY$|CODEX_ACCESS_TOKEN$|AZURE_|AWS_|GOOGLE_|GEMINI_|GITHUB_TOKEN$|GH_TOKEN$)/;
const LAUNCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_SCRIPT = path.resolve(LAUNCH_DIR, '..', 'scripts', 'model-catalog.ts');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function writePrivate(file, data, flag = 'w') {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, data, { mode: 0o600, flag });
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function cleanEnvironment(base, client, childToken, controlToken, proxyUrl, configDir, { headless = false } = {}) {
  const env = { ...base };
  for (const key of Object.keys(env)) if (SENSITIVE_ENV.test(key)) delete env[key];
  delete env.NODE_OPTIONS;
  delete env.CODEX_WEB_TEST_TOKEN;
  delete env.ASTRA6_CODEX_CHILD_TOKEN;
  delete env.OPENAI_PROJECT;
  env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';
  delete env.CODEX_CHATGPT_WEB_LAUNCHER_CONTROL_TOKEN;
  env.ASTRA6_NATIVE_CLIENT = client;
  env.ASTRA6_NATIVE_MODEL = client === 'codex' ? CODEX_MODEL : CLAUDE_MODEL;
  env.ASTRA6_PROXY_URL = proxyUrl;
  if (client === 'codex') {
    // Built-in OpenAI uses this invocation-only project marker for ownership. It is not an
    // account project and is stripped before the local bridge; API-key env names stay unset.
    env.OPENAI_PROJECT = childToken;
    env.CODEX_HOME = canonicalCodexHome();
    env.CODEX_CHATGPT_WEB_CONTROL_TOKEN = controlToken;
  } else {
    env.ANTHROPIC_BASE_URL = proxyUrl;
    env.ANTHROPIC_AUTH_TOKEN = childToken;
    env.CLAUDE_CONFIG_DIR = configDir;
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1';
    // Claude's documented child-only switches avoid background traffic, marketplace installation,
    // and updater work for this disposable invocation. They do not change global settings or
    // security updates outside this child; steering HTTP hooks remain enabled.
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = '1';
    env.DISABLE_AUTOUPDATER = '1';
    if (headless) env.CLAUDE_CODE_MAX_RETRIES = '0';
    env.CODEX_CHATGPT_WEB_CONTROL_TOKEN = controlToken;
  }
  return env;
}

export function readSourceVersion(sourceRoot) {
  const packagePath = path.join(path.resolve(sourceRoot), 'package.json');
  let value;
  try { value = JSON.parse(fs.readFileSync(packagePath, 'utf8')); }
  catch (error) { throw new Error(`Astra6 source package version is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  if (typeof value?.version !== 'string' || !value.version.trim()) {
    throw new Error(`Astra6 source package has no usable version: ${packagePath}`);
  }
  return value.version;
}

export async function preflightBridge({ bridge, sourceRoot, fetchImpl = fetch, timeoutMs = 3_000 }) {
  const sourceVersion = readSourceVersion(sourceRoot);
  const configVersion = bridge.releaseVersion;
  if (typeof configVersion !== 'string' || !configVersion.trim()) {
    throw new Error('Bridge config has no releaseVersion; refusing launch');
  }
  if (configVersion !== sourceVersion) {
    throw new Error(`Bridge/source version mismatch: config=${configVersion} source=${sourceVersion}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `http://${bridge.host}:${bridge.port}/healthz`;
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
  } catch (error) {
    throw new Error(`Bridge healthz unreachable at ${bridge.host}:${bridge.port}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`Bridge healthz unavailable: HTTP ${response.status}`);
  let health;
  try { health = await response.json(); }
  catch (error) { throw new Error(`Bridge healthz returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (health?.status !== 'ok' || health?.service !== 'codex-chatgpt-web') {
    throw new Error(`Bridge healthz is not ready: service=${String(health?.service)} status=${String(health?.status)}`);
  }
  if (health?.mode !== undefined && health.mode !== bridge.mode) {
    throw new Error(`Bridge health mode mismatch: live=${String(health.mode)} config=${String(bridge.mode)}`);
  }
  if (health.version !== configVersion || health.version !== sourceVersion) {
    throw new Error(`Bridge health version mismatch: live=${String(health.version)} config=${configVersion} source=${sourceVersion}`);
  }
  if (health.accepting_turns !== true) throw new Error('Bridge healthz is draining; accepting_turns is false');
  return { sourceVersion, healthVersion: health.version };
}

export async function preflightNativePlugin({ bridge, fetchImpl = fetch }) {
  const response = await fetchImpl(`http://${bridge.host}:${bridge.port}/admin/native-readiness`, {
    method: 'POST', headers: { authorization: `Bearer ${bridge.controlToken}`, 'content-type': 'application/json' },
    body: '{}', signal: AbortSignal.timeout(100_000),
  });
  if (!response.ok) throw new Error(`Native preflight could not observe idle permission/catalog state: HTTP ${response.status}`);
  const result = await response.json();
  const required = ['codex_read_context', 'codex_exec', 'codex_write_stdin', 'codex_apply_patch', 'codex_view_image', 'codex_tool_inventory', 'codex_tool_call'];
  if (result?.version !== 1 || result.source !== 'chatgpt_settings_dom'
    || !Number.isFinite(result.observedAt) || Math.abs(Date.now() - result.observedAt) > 120_000
    || !Array.isArray(result.advertised) || !Array.isArray(result.missing)
    || required.some(name => !result.advertised.includes(name) && !result.missing.includes(name))) throw new Error('Native preflight evidence is invalid or stale');
  if (result.missing.length) throw new Error(`Native plugin is missing attached tools: ${result.missing.join(', ')}`);
  if (result.permission !== 'all_tools') throw new Error(`Native plugin permission=${result.permission}; write tools may be denied. Review the app setting yourself; this launcher will not elevate it.`);
  return result;
}

export function preflightRuntimeArtifact({ bridge, sourceRoot }) {
  const configured = bridge.runtimeCommand?.[1];
  const built = path.join(sourceRoot, 'dist', 'runtime', 'app', 'cli.js');
  if (typeof configured !== 'string' || !path.isAbsolute(configured) || !configured.replaceAll('\\', '/').endsWith('/app/cli.js')) {
    throw new Error('Native preflight requires an explicit installed runtime CLI path');
  }
  if (!fs.existsSync(built) || !fs.existsSync(configured)) throw new Error('Build the matching source checkout before running native acceptance');
  const expected = sha256(fs.readFileSync(built));
  const observed = sha256(fs.readFileSync(configured));
  if (expected !== observed) throw new Error('Installed runtime bytes differ from the built source; refusing native acceptance');
  return { source_runtime_sha256: expected, installed_runtime_sha256: observed };
}

function nativeVersion(executable, client, env) {
  const invocation = nativeInvocation(executable, ['--version'], client);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 15_000,
  });
  if (result.error) throw new Error(`${client} version probe failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${client} version probe failed: ${String(result.stderr || '').trim() || `exit ${result.status}`}`);
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (client === 'codex') {
    if (!new RegExp(`(?:^|\\s)${CODEX_VERSION.replaceAll('.', '\\.')}(?:\\s|$)`).test(output)) {
      throw new Error(`Codex ${CODEX_VERSION} is required; probe reported ${output.slice(0, 160)}`);
    }
    return CODEX_VERSION;
  }
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  const actual = match ? match.slice(1).map(Number) : undefined;
  if (!actual || actual[0] !== CLAUDE_MIN_VERSION[0] || actual[1] !== CLAUDE_MIN_VERSION[1]
    || actual[2] < CLAUDE_MIN_VERSION[2]) {
    throw new Error(`Claude Code >=2.1.285 is required; probe reported ${output.slice(0, 160)}`);
  }
  return actual.join('.');
}

function generateCatalog({ output, sourceRoot, codexPath, bunPath, env, bridge }) {
  assertDirectory(sourceRoot, 'Astra6 source root');
  assertExecutable(bunPath, 'Bun runtime');
  const generatorArgs = [CATALOG_SCRIPT, '--source-root', sourceRoot, '--codex-path', codexPath, '--output', output,
    '--pro-available', String(bridge.proAvailable), '--sol-available', String(bridge.solAvailable),
    '--extra-high-available', String(bridge.extraHighAvailable), '--bigger-context', String(bridge.experimentalBiggerContext),
    '--no-auto-compact', String(bridge.experimentalNoAutoCompact), '--subagent-protocol', bridge.subagentProtocol,
    '--enhanced-web', String(bridge.useEnhancedWebSessionMode), '--enhanced-output', String(bridge.useEnhancedOutputTunnel)];
  const result = spawnSync(bunPath, generatorArgs, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 30_000,
  });
  if (result.error) throw new Error(`Model catalog generator failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Model catalog generator failed: ${String(result.stderr || result.stdout || '').trim().slice(0, 1000)}`);
  const catalog = JSON.parse(fs.readFileSync(output, 'utf8'));
  const rows = Array.isArray(catalog.models) ? catalog.models : [];
  if (rows.length !== 1 || rows[0]?.slug !== CODEX_MODEL || rows[0]?.default_reasoning_level !== 'max'
    || JSON.stringify(rows[0]?.supported_reasoning_levels?.map(level => level?.effort)) !== JSON.stringify(['max'])) {
    throw new Error('Generated Codex catalog is not the exact single-row GPT-6 Pro/max catalog');
  }
  return catalog;
}

export function writeClaudeSettings(configDir, bridge, proxyUrl, clientVersion) {
  ensureDir(configDir);
  const templatePath = path.resolve(LAUNCH_DIR, '..', 'assets', 'claude-settings.template.json');
  const settings = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  const replacement = `${proxyUrl}/v1/messages/steering`;
  const replace = value => {
    if (typeof value === 'string') return value.replaceAll('http://127.0.0.1:17841/v1/messages/steering', replacement);
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    return value;
  };
  const rendered = replace(settings);
  for (const event of ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure']) {
    const matcher = rendered.hooks?.[event]?.[0];
    const hook = matcher?.hooks?.[0];
    if (hook && clientVersion) hook.headers['User-Agent'] = `claude-code/${clientVersion} astra6-client-lab`;
  }
  const encoded = `${JSON.stringify(rendered, null, 2)}\n`;
  if (encoded.includes(bridge.controlToken)) throw new Error('Claude settings would persist the bridge control token');
  const settingsPath = path.join(configDir, 'settings.json');
  writePrivate(settingsPath, encoded);
  return settingsPath;
}

function writeLaunchMetadata(file, value) {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  if (/(?:Bearer\s+|controlToken|OPENAI_API_KEY|ANTHROPIC_AUTH_TOKEN)/i.test(encoded)) {
    throw new Error('Launch metadata unexpectedly contains a credential');
  }
  writePrivate(file, encoded);
}

function appendLaunchEvent(file, value) {
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`, { mode: 0o600 });
}

function captureChildOutput(stream, file, streamName, redactor) {
  if (!stream) return Promise.resolve();
  const output = fs.createWriteStream(file, { mode: 0o600, flags: 'wx' });
  return new Promise(resolve => {
    const write = piece => output.write(`${JSON.stringify({ at: new Date().toISOString(), stream: streamName, data: piece })}\n`);
    stream.on('data', chunk => redactor.push(Buffer.from(chunk).toString('utf8'), write));
    stream.once('end', () => { redactor.end(write); output.end(resolve); });
    stream.once('error', () => { redactor.end(write); output.end(resolve); });
  });
}

function readPromptFile(promptFile) {
  if (!promptFile) return undefined;
  const stat = fs.statSync(promptFile);
  if (stat.size > 8 * 1024 * 1024) throw new Error('--prompt-file exceeds the 8 MiB headless prompt bound');
  return fs.readFileSync(promptFile);
}

export function forwardOwnedSignal(child, signal, record = () => {}) {
  record(signal);
  if (child?.exitCode === null) child.kill(signal);
}

export async function runLauncher(client, argv) {
  const options = parseLauncherArgs(argv, client);
  if (options.showHelp) { printHelp(client); return 0; }
  const cliPath = assertExecutable(options.cliPath, `${client} CLI`);
  const bridge = bridgeConfig(options.bridgeConfig);
  await preflightBridge({ bridge, sourceRoot: options.sourceRoot });
  const runtimeIdentity = preflightRuntimeArtifact({ bridge, sourceRoot: options.sourceRoot });
  const nativeReadiness = await preflightNativePlugin({ bridge });
  const launchId = `${Date.now()}-${randomUUID()}`;
  const artifactRoot = path.join(options.artifacts, `${client}-${launchId}`);
  ensureDir(artifactRoot);
  writePrivate(path.join(artifactRoot, 'readiness.json'), JSON.stringify({ ...nativeReadiness, runtimeIdentity }));
  const childToken = randomUUID();
  const launchedAt = Date.now();
  const proxy = createRecordingProxy({
    client,
    artifactRoot,
    childToken,
    controlToken: bridge.controlToken,
    upstreamHost: bridge.host,
    upstreamPort: bridge.port,
    cwd: options.cwd,
    expectedRootThreadId: client === 'codex' ? options.resume : undefined,
    sessionId: client === 'claude' ? (options.resume || randomUUID()) : undefined,
    minimumClaudeVersion: CLAUDE_MIN_VERSION,
    headless: options.headless,
    diagnostic: options.diagnostic,
    launchedAt,
  });
  try {
  const endpoint = await proxy.listen();
  // The child process keeps this parent alive during the interactive session. If a preflight
  // fails before spawn, an unref'ed listener cannot leave a zombie launcher behind.
  proxy.server.unref();
  const proxyUrl = endpoint.url;
  const env = cleanEnvironment(process.env, client, childToken, bridge.controlToken, proxyUrl,
    path.join(path.resolve(LAUNCH_DIR, '..', 'runtime', 'claude')), { headless: options.headless });
  const clientVersion = nativeVersion(cliPath, client, env);
  proxy.setClientVersion(clientVersion);
  let catalog;
  let catalogPath;
  if (client === 'codex') {
    catalogPath = options.catalog || path.join(artifactRoot, 'codex-models-gpt-6-pro.json');
    if (options.catalog) {
      catalog = JSON.parse(fs.readFileSync(options.catalog, 'utf8'));
      assertExactCodexCatalog(catalog);
    } else {
      catalog = generateCatalog({ output: catalogPath, sourceRoot: options.sourceRoot, codexPath: cliPath, bunPath: options.bunPath, env, bridge });
    }
  }
  const configDir = path.join(path.resolve(LAUNCH_DIR, '..', 'runtime', 'claude'));
  let settingsPath;
  if (client === 'claude') settingsPath = writeClaudeSettings(configDir, bridge, proxyUrl, clientVersion);
  const args = client === 'codex'
    ? buildCodexArgs({ cwd: options.cwd, resume: options.resume, proxyUrl, catalogPath, catalog, unsafe: options.unsafe, headless: options.headless, extraArgs: options.extraArgs })
    : buildClaudeArgs({ cwd: options.cwd, resume: options.resume, sessionId: proxy.state.sessionId, settingsPath, emptyMcpPath: DEFAULT_EMPTY_MCP, unsafe: options.unsafe, headless: options.headless, extraArgs: options.extraArgs }).args;
  const promptBytes = readPromptFile(options.promptFile);
  writeLaunchMetadata(path.join(artifactRoot, 'launch.json'), {
    schema: 1,
    client,
    clientVersion,
    model: client === 'codex' ? CODEX_MODEL : CLAUDE_MODEL,
    cwd: options.cwd,
    resume: options.resume || null,
    sessionId: client === 'claude' ? proxy.state.sessionId : null,
    cliPath,
    args,
    bridge: { host: bridge.host, port: bridge.port, releaseVersion: bridge.releaseVersion || null },
    proxy: { host: endpoint.host, port: endpoint.port },
    catalogPath: catalogPath || null,
    catalogSha256: catalogPath ? sha256(fs.readFileSync(catalogPath)) : null,
    settingsPath: settingsPath || null,
    configIsolation: client === 'codex' ? 'canonical CODEX_HOME; invocation-only overrides' : 'lab-owned CLAUDE_CONFIG_DIR',
    permissionMode: options.unsafe ? 'unsafe invocation flag' : 'safe defaults',
    mode: options.headless ? (options.diagnostic ? 'headless-diagnostic' : 'headless') : 'interactive',
    diagnostic: options.diagnostic,
    promptFile: options.promptFile || null,
    stdio: options.headless ? 'capture-json' : 'inherit',
    startedAt: new Date(launchedAt).toISOString(),
  });
  appendLaunchEvent(proxy.eventsPath, {
    type: 'session_start', client, model: client === 'codex' ? CODEX_MODEL : CLAUDE_MODEL,
    clientVersion, cwd: options.cwd, proxyPort: endpoint.port, bridgePort: bridge.port,
    resume: options.resume || undefined, unsafe: options.unsafe, diagnostic: options.diagnostic,
    mode: options.headless ? (options.diagnostic ? 'headless-diagnostic' : 'headless') : 'interactive',
    stdio: options.headless ? 'capture-json' : 'inherit',
  });
  const invocation = nativeInvocation(cliPath, args, client);
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    env,
    stdio: options.headless ? [promptBytes ? 'pipe' : 'inherit', 'pipe', 'pipe'] : 'inherit',
  });
  const childCapturePromises = [];
  if (options.headless) {
    childCapturePromises.push(captureChildOutput(child.stdout, path.join(artifactRoot, 'stdout.jsonl'), 'stdout', new StreamRedactor([childToken, bridge.controlToken])));
    childCapturePromises.push(captureChildOutput(child.stderr, path.join(artifactRoot, 'stderr.jsonl'), 'stderr', new StreamRedactor([childToken, bridge.controlToken])));
    if (promptBytes) child.stdin.end(promptBytes);
  }
  writeLaunchMetadata(path.join(artifactRoot, 'launch.json'), {
    schema: 1,
    client,
    clientVersion,
    model: client === 'codex' ? CODEX_MODEL : CLAUDE_MODEL,
    cwd: options.cwd,
    resume: options.resume || null,
    sessionId: client === 'claude' ? proxy.state.sessionId : null,
    cliPath,
    args,
    pid: child.pid,
    bridge: { host: bridge.host, port: bridge.port, releaseVersion: bridge.releaseVersion || null },
    proxy: { host: endpoint.host, port: endpoint.port },
    catalogPath: catalogPath || null,
    catalogSha256: catalogPath ? sha256(fs.readFileSync(catalogPath)) : null,
    settingsPath: settingsPath || null,
    configIsolation: client === 'codex' ? 'canonical CODEX_HOME; invocation-only overrides' : 'lab-owned CLAUDE_CONFIG_DIR',
    permissionMode: options.unsafe ? 'unsafe invocation flag' : 'safe defaults',
    mode: options.headless ? (options.diagnostic ? 'headless-diagnostic' : 'headless') : 'interactive',
    diagnostic: options.diagnostic,
    promptFile: options.promptFile || null,
    stdio: options.headless ? 'capture-json' : 'inherit',
    startedAt: new Date(launchedAt).toISOString(),
  });
  let interruptSent = false;
  const unsubscribe = proxy.on(event => {
    if (event.type !== 'quota_latch' || interruptSent) return;
    interruptSent = true;
    appendLaunchEvent(proxy.eventsPath, { type: 'owned_child_interrupt', signal: 'SIGINT', pid: child.pid, reason: event.reason });
    forwardOwnedSignal(child, 'SIGINT');
  });
  const signalHandler = signal => {
    appendLaunchEvent(proxy.eventsPath, { type: 'launcher_signal', signal });
    forwardOwnedSignal(child, signal);
  };
  const onSigint = () => signalHandler('SIGINT');
  const onSigterm = () => signalHandler('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  const exit = await new Promise(resolve => {
    child.once('error', error => {
      appendLaunchEvent(proxy.eventsPath, { type: 'child_error', message: String(error.message || error) });
      resolve(1);
    });
    child.once('exit', (code, signal) => {
      appendLaunchEvent(proxy.eventsPath, { type: 'session_exit', code, signal, quotaLatched: proxy.state.quotaLatched });
      resolve(code ?? (signal ? 128 : 1));
    });
  });
  unsubscribe();
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);
  await Promise.all(childCapturePromises);
  return exit;
  } finally {
    await proxy.close();
  }
}

export function cliMain(client, argv = process.argv.slice(2)) {
  return runLauncher(client, argv).catch(error => {
    process.stderr.write(`astra6 ${client} launcher: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  });
}
