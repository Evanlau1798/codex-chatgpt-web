import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertExactCodexCatalog, buildClaudeArgs, buildCodexArgs, CLAUDE_MODEL, CODEX_MODEL, parseLauncherArgs, LAB_ROOT, nativeInvocation } from '../src/launch-args.mjs';
import { cleanEnvironment, forwardOwnedSignal, writeClaudeSettings } from '../src/launch.mjs';

const target = LAB_ROOT;
test('npm Windows shim invokes the package entry without a shell and preserves literal arguments', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-shim-'));
  try {
    const pkg = path.join(root, 'node_modules', '@openai', 'codex');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { codex: 'cli.mjs' } }));
    fs.writeFileSync(path.join(pkg, 'cli.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
    const args = ['space argument', '&echo NOT_A_COMMAND', 'quote"value'];
    const invocation = nativeInvocation(path.join(root, 'codex.cmd'), args, 'codex');
    const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
const catalog = {
  models: [{
    slug: CODEX_MODEL,
    default_reasoning_level: 'max',
    supported_reasoning_levels: [{ effort: 'max' }],
    context_window: 272000,
    auto_compact_token_limit: 244800,
  }],
};

test('Codex invocation is native interactive, exact route, openai provider, and no daemon', () => {
  const args = buildCodexArgs({
    cwd: target,
    proxyUrl: 'http://127.0.0.1:43210',
    catalogPath: '/private/tmp/gpt6.json',
    catalog,
    unsafe: false,
  });
  assert.equal(args.includes('--no-daemon'), true);
  assert.equal(args.includes('--no-alt-screen'), true);
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(args.includes('-p'), false);
  assert.equal(args.includes('exec'), false);
  assert.match(args.join('\n'), /--model\nchatgpt-web\/gpt-6-pro/);
  assert.match(args.join('\n'), /model_provider="openai"/);
  assert.match(args.join('\n'), /openai_base_url="http:\/\/127\.0\.0\.1:43210\/v1"/);
  assert.match(args.join('\n'), /model_reasoning_effort="max"/);
  assert.match(args.join('\n'), /mcp_servers=\{\}/);
  assert.match(args.join('\n'), /features\.memories=false/);
  assert.match(args.join('\n'), /features\.hooks=false/);
  assert.match(args.join('\n'), /features\.goals=false/);
  assert.match(args.join('\n'), /features\.agent_message_board=false/);
  assert.match(args.join('\n'), /check_for_update_on_startup=false/);
});

test('Codex unsafe mode is explicit and still pins exact route', () => {
  const args = buildCodexArgs({
    cwd: target,
    proxyUrl: 'http://127.0.0.1:1',
    catalogPath: '/private/tmp/gpt6.json',
    catalog,
    unsafe: true,
  });
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), true);
  assert.equal(args.includes('--sandbox'), false);
  assert.equal(args.filter(item => item === '--model').length, 1);
});

test('optional headless invocations use native JSON interfaces without changing interactive defaults', () => {
  const codex = buildCodexArgs({ cwd: target, proxyUrl: 'http://127.0.0.1:1', catalogPath: '/private/tmp/gpt6.json', catalog, unsafe: false, headless: true });
  assert.equal(codex[0], 'exec');
  assert.equal(codex.includes('--json'), true);
  assert.equal(codex.at(-1), '-');
  assert.equal(codex.includes('--no-daemon'), false);
  const claude = buildClaudeArgs({ cwd: target, settingsPath: '/private/tmp/astra6-settings.json', emptyMcpPath: '/private/tmp/empty-mcp.json', unsafe: false, headless: true }).args;
  assert.equal(claude.includes('--print'), true);
  assert.equal(claude.includes('--output-format') && claude[claude.indexOf('--output-format') + 1] === 'stream-json', true);
  assert.equal(claude.includes('--include-partial-messages'), true);
  assert.equal(claude.includes('--input-format') && claude[claude.indexOf('--input-format') + 1] === 'text', true);
  assert.equal(claude.includes('--disable-slash-commands'), true);
});

test('headless Codex argument sets are accepted by the installed native parser', { skip: !process.env.NATIVE_LAB_CODEX_INTEGRATION_PATH }, () => {
  const version = nativeInvocation(process.env.NATIVE_LAB_CODEX_INTEGRATION_PATH, ['--version'], 'codex');
  const observed = spawnSync(version.command, version.args, { encoding: 'utf8', timeout: 15_000 });
  assert.equal(observed.status, 0, observed.stderr);
  const expectedVersion = process.env.NATIVE_LAB_CODEX_INTEGRATION_VERSION || '0.159.2';
  assert.equal(observed.stdout.trim(), `codex-cli ${expectedVersion}`);
  const variants = [
    buildCodexArgs({ cwd: target, proxyUrl: 'http://127.0.0.1:1', catalogPath: '/private/tmp/gpt6.json', catalog, headless: true, unsafe: false }),
    buildCodexArgs({ cwd: target, proxyUrl: 'http://127.0.0.1:1', catalogPath: '/private/tmp/gpt6.json', catalog, headless: true, unsafe: true }),
    buildCodexArgs({ cwd: target, resume: '2f6d3d6c-7d88-4b14-8d85-e0ab2d8f9e4c', proxyUrl: 'http://127.0.0.1:1', catalogPath: '/private/tmp/gpt6.json', catalog, headless: true, unsafe: false }),
  ];
  for (const args of variants) {
    const invocation = nativeInvocation(process.env.NATIVE_LAB_CODEX_INTEGRATION_PATH, [...args, '--help'], 'codex');
    const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, `${result.stderr}\n${args.join(' ')}`);
  }
});

test('supplied Codex catalogs cannot weaken the max-only route contract', () => {
  assert.doesNotThrow(() => assertExactCodexCatalog(catalog));
  assert.throws(() => assertExactCodexCatalog({ models: [{ ...catalog.models[0], supported_reasoning_levels: [] }] }), /max effort/);
  assert.throws(() => assertExactCodexCatalog({ models: [{ ...catalog.models[0], supported_reasoning_levels: [{ effort: 'max' }, { effort: 'low' }] }] }), /max effort/);
});

test('Claude invocation is interactive, discovery-enforced, exact route, strict empty MCP, and no Chrome', () => {
  const { args, sessionId } = buildClaudeArgs({
    cwd: target,
    settingsPath: '/private/tmp/astra6-settings.json',
    emptyMcpPath: '/private/tmp/empty-mcp.json',
    unsafe: false,
  });
  assert.match(args.join('\n'), /--model\nclaude-chatgpt-web-gpt-6-pro/);
  assert.equal(args.includes('--strict-mcp-config'), true);
  assert.equal(args.includes('--no-chrome'), true);
  assert.equal(args.includes('--disable-slash-commands'), false);
  assert.equal(args.includes('--print'), false);
  assert.equal(args.includes('-p'), false);
  assert.equal(args.includes('--setting-sources'), true);
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args.includes('--permission-mode'), true);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
});

test('Claude resume owns the UUID and unsafe bypass is invocation-only', () => {
  const resume = '2f6d3d6c-7d88-4b14-8d85-e0ab2d8f9e4c';
  const { args, sessionId } = buildClaudeArgs({
    cwd: target, resume, sessionId: resume, settingsPath: '/private/tmp/astra6-settings.json',
    emptyMcpPath: '/private/tmp/empty-mcp.json', unsafe: true,
  });
  assert.equal(sessionId, resume);
  assert.equal(args[args.indexOf('--resume') + 1], resume);
  assert.equal(args.includes('--session-id'), false);
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
});

test('wrapper parser rejects a native model or non-interactive override', () => {
  assert.throws(() => parseLauncherArgs(['--cwd', target, '--', '--model', 'gpt-5.6-pro'], 'codex'), /rejects extra flag/);
  assert.throws(() => parseLauncherArgs(['--cwd', target, '--', '--print'], 'claude'), /rejects extra flag/);
  assert.throws(() => parseLauncherArgs(['--cwd', target, '--', '--dangerously-skip-permissions'], 'claude'), /rejects extra flag/);
  for (const flag of ['--config', '-c', '--settings', '--setting-sources', '--mcp-config', '--continue', '--cd', '-C', '--permission-mode', '--resume', '--session-id']) {
    assert.throws(() => parseLauncherArgs(['--cwd', target, '--', flag], 'claude'), /rejects extra flag/);
  }
  assert.throws(() => parseLauncherArgs(['--cwd', target, '--resume', 'not-a-uuid'], 'codex'), /canonical UUID/);
});

test('only explicitly whitelisted UI extras are accepted', () => {
  assert.doesNotThrow(() => parseLauncherArgs(['--cwd', target, '--', '--verbose'], 'codex'));
  assert.doesNotThrow(() => parseLauncherArgs(['--cwd', target, '--', '--no-alt-screen'], 'codex'));
  assert.doesNotThrow(() => parseLauncherArgs(['--cwd', target, '--', '--ax-screen-reader'], 'claude'));
  assert.throws(() => parseLauncherArgs(['--cwd', target, '--', '--config=model="other"'], 'codex'), /rejects extra flag/);
});

test('headless prompt-file and diagnostic options are explicit and bounded to the wrapper', () => {
  const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'astra6-prompt-')), 'prompt.txt');
  fs.writeFileSync(promptFile, 'fixture prompt\n', { mode: 0o600 });
  const parsed = parseLauncherArgs(['--cwd', target, '--headless', '--diagnostic', '--prompt-file', promptFile], 'codex');
  assert.equal(parsed.headless, true);
  assert.equal(parsed.diagnostic, true);
  assert.equal(parsed.promptFile, promptFile);
  assert.throws(() => parseLauncherArgs(['--cwd', target, '--prompt-file', promptFile], 'claude'), /requires --headless/);
  fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
});

test('signal forwarding passes the actual signal to the owned child', () => {
  const signals = [];
  const child = { exitCode: null, kill(signal) { signals.push(signal); return true; } };
  forwardOwnedSignal(child, 'SIGINT');
  forwardOwnedSignal(child, 'SIGTERM');
  assert.deepEqual(signals, ['SIGINT', 'SIGTERM']);
});

test('constructed child environments disable Claude background traffic and scrub inherited OTEL', () => {
  const base = {
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'inherited-openai-secret',
    ANTHROPIC_API_KEY: 'inherited-anthropic-secret',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://telemetry.invalid',
    OTEL_EXPORTER_OTLP_HEADERS: 'authorization=should-not-inherit',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0',
    DISABLE_AUTOUPDATER: '0',
  };
  const claude = cleanEnvironment(base, 'claude', 'child-token', 'control-token', 'http://127.0.0.1:1', '/lab/runtime/claude');
  assert.equal(claude.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(claude.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL, '1');
  assert.equal(claude.DISABLE_AUTOUPDATER, '1');
  assert.equal(claude.CODEX_CHATGPT_WEB_CONTROL_TOKEN, 'control-token');
  assert.equal(Object.keys(claude).some(key => key.startsWith('OTEL_')), false);
  assert.equal(claude.OPENAI_API_KEY, undefined);
  assert.equal(claude.ANTHROPIC_API_KEY, undefined);
  const codex = cleanEnvironment(base, 'codex', 'child-token', 'control-token', 'http://127.0.0.1:1', '/lab/runtime/claude');
  assert.equal(Object.keys(codex).some(key => key.startsWith('OTEL_')), false);
  assert.equal(codex.OPENAI_PROJECT, 'child-token');
  assert.equal(codex.OPENAI_API_KEY, undefined);
  assert.equal(codex.CODEX_API_KEY, undefined);
  assert.equal(codex.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
});

test('headless Claude environment disables native retry loops only for that child', () => {
  const env = cleanEnvironment({}, 'claude', 'child-token', 'control-token', 'http://127.0.0.1:1', '/lab/runtime/claude', { headless: true });
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, '0');
});

test('launcher paths stay scoped to the lab and never name global settings files', () => {
  const text = fs.readFileSync(path.join(target, 'src', 'launch.mjs'), 'utf8');
  assert.doesNotMatch(text, /~\/\.claude\/settings\.json/);
  assert.doesNotMatch(text, /writeFileSync\([^\n]*\.codex\/config\.toml/);
  assert.equal(os.homedir().length > 0, true);
});

test('Claude steering settings persist only an environment placeholder', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(target, 'assets', 'claude-settings.template.json'), 'utf8'));
  const encoded = JSON.stringify(settings);
  assert.match(encoded, /\$CODEX_CHATGPT_WEB_CONTROL_TOKEN/);
  assert.doesNotMatch(encoded, /control-secret|Bearer [A-Za-z0-9_-]{40,}/);
  assert.deepEqual(settings.availableModels, [CLAUDE_MODEL]);
  assert.equal(settings.enforceAvailableModels, true);
});

test('generated Claude hooks use the ephemeral proxy, probed User-Agent, and placeholder token', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra6-claude-settings-'));
  const settingsPath = writeClaudeSettings(configDir, {
    host: '127.0.0.1', port: 17841, controlToken: 'control-token-never-written',
  }, 'http://127.0.0.1:45678', '2.1.286');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const event of ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure']) {
    const matcher = settings.hooks[event][0];
    assert.equal(Array.isArray(settings.hooks[event]), true);
    assert.equal(Array.isArray(matcher.hooks), true);
    const hook = matcher.hooks[0];
    assert.equal(hook.url, 'http://127.0.0.1:45678/v1/messages/steering');
    assert.equal(hook.headers.Authorization, 'Bearer $CODEX_CHATGPT_WEB_CONTROL_TOKEN');
    assert.equal(hook.headers['User-Agent'], 'claude-code/2.1.286 astra6-client-lab');
    assert.equal(hook.allowedEnvVars.includes('CODEX_CHATGPT_WEB_CONTROL_TOKEN'), true);
  }
  assert.equal(JSON.stringify(settings).includes('control-token-never-written'), false);
  fs.rmSync(configDir, { recursive: true, force: true });
});
