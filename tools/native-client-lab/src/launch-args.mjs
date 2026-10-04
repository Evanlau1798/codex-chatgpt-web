import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CODEX_VERSION = '0.159.2';
export const CLAUDE_MIN_VERSION = [2, 1, 285];
export const CODEX_MODEL = 'chatgpt-web/gpt-6-pro';
export const CLAUDE_MODEL = 'claude-chatgpt-web-gpt-6-pro';
export function executableOnPath(name) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']) {
      const candidate = path.join(directory, name + suffix);
      try { fs.accessSync(candidate, fs.constants.X_OK); return path.resolve(candidate); } catch {}
    }
  }
  return path.join(os.homedir(), '.local', 'bin', name);
}
export const DEFAULT_CODEX_PATH = executableOnPath('codex');
export const DEFAULT_CLAUDE_PATH = executableOnPath('claude');
export const DEFAULT_BRIDGE_CONFIG = path.join(os.homedir(), '.codex-chatgpt-web', 'config.json');
export const LAB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_EMPTY_MCP = path.join(LAB_ROOT, 'assets', 'empty-mcp.json');
export const DEFAULT_SOURCE_ROOT = path.resolve(LAB_ROOT, '..', '..');

// Codex 0.159.2 uses UUIDv7 thread/session/installation identifiers; Claude commonly uses v4.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

export function assertUuid(value, label = 'UUID') {
  if (!isUuid(value)) throw new Error(`${label} must be a canonical UUID`);
  return value.toLowerCase();
}

export function assertDirectory(value, label) {
  const absolute = path.resolve(value);
  const stat = fs.statSync(absolute, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`${label} is not an existing directory: ${absolute}`);
  return absolute;
}

export function assertExecutable(value, label) {
  const absolute = path.resolve(value);
  const stat = fs.statSync(absolute, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`${label} is not an executable file: ${absolute}`);
  try {
    fs.accessSync(absolute, fs.constants.X_OK);
  } catch {
    throw new Error(`${label} is not executable: ${absolute}`);
  }
  return absolute;
}

export function nativeInvocation(executable, args, client) {
  if (!/\.(cmd|bat)$/i.test(executable)) return { command: executable, args };
  // Execute the npm package's JS entry directly; never interpolate user arguments into cmd.exe.
  const packageName = client === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';
  const root = path.join(path.dirname(executable), 'node_modules', packageName);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[client];
  if (typeof entry !== 'string') throw new Error(`Unsupported npm ${client} shim: missing package entry`);
  const script = path.resolve(root, entry);
  if (!script.startsWith(root + path.sep) || !fs.statSync(script).isFile()) throw new Error('Unsafe or missing npm CLI entry');
  return { command: process.execPath, args: [script, ...args] };
}

export function toml(value) {
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`).join(', ')} }`;
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  throw new Error(`Unsupported TOML override value: ${String(value)}`);
}

export function assertExactCodexCatalog(catalog) {
  const rows = Array.isArray(catalog?.models) ? catalog.models : [];
  const row = rows.length === 1 ? rows[0] : undefined;
  const levels = Array.isArray(row?.supported_reasoning_levels) ? row.supported_reasoning_levels : undefined;
  const efforts = levels?.map(level => level?.effort);
  if (rows.length !== 1 || row?.slug !== CODEX_MODEL || row?.default_reasoning_level !== 'max'
    || JSON.stringify(efforts) !== JSON.stringify(['max'])) {
    throw new Error('Codex catalog must contain only chatgpt-web/gpt-6-pro with max effort');
  }
  return catalog;
}

export function codexOverrides({ proxyUrl, catalogPath, catalog }) {
  assertExactCodexCatalog(catalog);
  const model = catalog?.models?.find(item => item?.slug === CODEX_MODEL);
  if (!model) throw new Error(`Generated catalog does not contain ${CODEX_MODEL}`);
  const contextWindow = Number.isSafeInteger(model.context_window) ? model.context_window : 272000;
  const autoCompact = Number.isSafeInteger(model.auto_compact_token_limit)
    ? model.auto_compact_token_limit
    : Math.floor(contextWindow * 0.9);
  return {
    model: CODEX_MODEL,
    model_provider: 'openai',
    openai_base_url: `${proxyUrl}/v1`,
    model_catalog_json: path.resolve(catalogPath),
    model_reasoning_effort: 'max',
    model_context_window: contextWindow,
    model_auto_compact_token_limit: autoCompact,
    mcp_servers: {},
    plugins: {},
    hooks: {},
    notify: [],
    check_for_update_on_startup: false,
    web_search: 'disabled',
    'features.multi_agent': false,
    'features.multi_agent_v2': false,
    'features.goals': false,
    'features.agent_message_board': false,
    'features.memories': false,
    'features.chronicle': false,
    'features.apps': false,
    'features.plugins': false,
    'features.hooks': false,
    'features.remote_compaction_v2': false,
    'features.context_management.experimental_mode': true,
  };
}

function validateExtras(extras, model, client) {
  const normalizedClient = String(client).toLowerCase();
  const allowed = normalizedClient === 'codex' ? new Set(['--verbose', '--no-alt-screen'])
    : new Set(['--verbose', '--ax-screen-reader']);
  for (const arg of extras) {
    if (!allowed.has(arg)) {
      throw new Error(`${client} launcher rejects extra flag ${arg}; model, permissions, routing, config, and session state are wrapper-owned`);
    }
  }
  void model;
}

export function parseLauncherArgs(argv, client) {
  const result = {
    cwd: process.cwd(),
    resume: undefined,
    unsafe: false,
    bridgeConfig: process.env.CODEX_CHATGPT_WEB_CONFIG || DEFAULT_BRIDGE_CONFIG,
    artifacts: process.env.ASTRA6_ARTIFACTS || path.join(LAB_ROOT, 'artifacts'),
    sourceRoot: process.env.ASTRA6_SOURCE_ROOT || DEFAULT_SOURCE_ROOT,
    cliPath: client === 'codex' ? (process.env.ASTRA6_CODEX_PATH || DEFAULT_CODEX_PATH)
      : (process.env.ASTRA6_CLAUDE_PATH || DEFAULT_CLAUDE_PATH),
    bunPath: process.env.ASTRA6_BUN_PATH || executableOnPath('bun'),
    catalog: undefined,
    headless: false,
    diagnostic: false,
    parallelAgents: false,
    promptFile: undefined,
    extraArgs: [],
    showHelp: false,
  };
  const args = [...argv];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      if (index + 1 >= args.length) throw new Error(`${arg} requires a value`);
      index += 1;
      return args[index];
    };
    if (arg === '--') {
      result.extraArgs.push(...args.slice(index + 1));
      break;
    }
    if (arg === '--cwd') result.cwd = next();
    else if (arg === '--resume') result.resume = assertUuid(next(), '--resume');
    else if (arg === '--unsafe') result.unsafe = true;
    else if (arg === '--bridge-config') result.bridgeConfig = next();
    else if (arg === '--artifacts') result.artifacts = next();
    else if (arg === '--source-root') result.sourceRoot = next();
    else if (arg === '--catalog') result.catalog = next();
    else if (arg === '--headless') result.headless = true;
    else if (arg === '--diagnostic') result.diagnostic = true;
    else if (arg === '--parallel-agents') result.parallelAgents = true;
    else if (arg === '--prompt-file') result.promptFile = next();
    else if (arg === '--cli-path') result.cliPath = next();
    else if (arg === '--bun-path') result.bunPath = next();
    else if (arg === '--help' || arg === '-h') result.showHelp = true;
    else result.extraArgs.push(arg);
  }
  result.cwd = assertDirectory(result.cwd, '--cwd');
  result.cliPath = path.resolve(result.cliPath);
  result.bridgeConfig = path.resolve(result.bridgeConfig);
  result.artifacts = path.resolve(result.artifacts);
  result.sourceRoot = path.resolve(result.sourceRoot);
  if (result.catalog) result.catalog = path.resolve(result.catalog);
  if (result.promptFile) {
    result.promptFile = path.resolve(result.promptFile);
    const stat = fs.statSync(result.promptFile, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error('--prompt-file is not a regular file');
    if (!result.headless) throw new Error('--prompt-file requires --headless');
  }
  validateExtras(result.extraArgs, client === 'codex' ? CODEX_MODEL : CLAUDE_MODEL, client);
  return result;
}

export function newSessionId(resume) {
  return resume ? assertUuid(resume, '--resume') : randomUUID();
}

export function buildCodexArgs({ cwd, resume, proxyUrl, catalogPath, catalog, unsafe, headless = false, parallelAgents = false, extraArgs = [] }) {
  validateExtras(extraArgs, CODEX_MODEL, 'Codex');
  const overrides = codexOverrides({ proxyUrl, catalogPath, catalog });
  if (parallelAgents) {
    delete overrides['features.multi_agent_v2'];
    overrides['features.multi_agent_v2.enabled'] = true;
    overrides['features.multi_agent_v2.max_concurrent_threads_per_session'] = 3;
    // A canonical home can choose another worker default absent from this
    // invocation's one-row Pro catalogue. Pin only the native child default.
    overrides['agents.default_subagent_model'] = CODEX_MODEL;
    overrides['agents.default_subagent_reasoning_effort'] = 'max';
    overrides['agents.max_depth'] = 1;
  }
  const args = headless
    ? ['exec', '--cd', path.resolve(cwd), '--json', '--model', CODEX_MODEL]
    : [];
  if (!headless && resume) args.push('resume', assertUuid(resume, '--resume'));
  if (!headless) args.push('--cd', path.resolve(cwd), '--no-alt-screen', '--no-daemon', '--model', CODEX_MODEL);
  if (headless) args.push('--skip-git-repo-check');
  if (unsafe) args.push('--dangerously-bypass-approvals-and-sandbox');
  else if (headless) args.push('--sandbox', 'read-only', '--config', 'approval_policy="never"');
  else args.push('--sandbox', 'read-only', '--ask-for-approval', 'on-request');
  for (const [key, value] of Object.entries(overrides)) args.push('--config', `${key}=${toml(value)}`);
  if (headless && resume) args.push('resume', assertUuid(resume, '--resume'), '-');
  if (headless && !resume) args.push('-');
  args.push(...extraArgs);
  return args;
}

export function buildClaudeArgs({ cwd, resume, sessionId, settingsPath, emptyMcpPath = DEFAULT_EMPTY_MCP, unsafe, headless = false, extraArgs = [] }) {
  validateExtras(extraArgs, CLAUDE_MODEL, 'Claude');
  const id = newSessionId(resume || sessionId);
  const args = [
    '--model', CLAUDE_MODEL,
    '--setting-sources', '',
    '--settings', path.resolve(settingsPath),
    '--strict-mcp-config', '--mcp-config', path.resolve(emptyMcpPath),
    '--no-chrome',
    '--permission-mode', unsafe ? 'bypassPermissions' : 'plan',
    '--add-dir', path.resolve(cwd),
  ];
  if (headless) args.push('--disable-slash-commands');
  if (headless) args.push('--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--input-format', 'text');
  if (resume) args.push('--resume', assertUuid(resume, '--resume'));
  else args.push('--session-id', id);
  args.push(...extraArgs);
  return { args, sessionId: id };
}

export function printHelp(client) {
  const binary = client === 'codex' ? 'bin/codex-astrapro.mjs' : 'bin/claude-astrapro.mjs';
  process.stdout.write(`Usage: ${binary} [options] [-- native-option ...]\n\n`);
  process.stdout.write('  --cwd PATH             Interactive project root (default: current directory)\n');
  process.stdout.write('  --resume UUID          Resume only this owned session\n');
  process.stdout.write('  --headless             Use native JSON/stream-json output (prompt from --prompt-file or stdin)\n');
  process.stdout.write('  --parallel-agents      Opt-in native Codex v2: coordinator plus two workers, flat delegation\n');
  process.stdout.write('  --prompt-file PATH     Owned prompt input for --headless mode\n');
  process.stdout.write('  --diagnostic           Latch on owned upstream 5xx/typed failure events\n');
  process.stdout.write('  --unsafe               Disposable test mode (bypasses client permissions)\n');
  process.stdout.write('  --cli-path PATH        Native client binary override\n');
  process.stdout.write('  --bridge-config PATH   Read current bridge endpoint/token at runtime\n');
  process.stdout.write('  --artifacts PATH       Capture root (default: lab/artifacts)\n');
  process.stdout.write('  --catalog PATH         Reuse a generated Codex catalog\n');
  process.stdout.write('  --                     Pass additional safe interactive flags\n');
  process.stdout.write('\nThe wrapper never writes ~/.codex/config.toml or ~/.claude/settings.json.\n');
}

export function canonicalCodexHome() {
  return path.join(os.homedir(), '.codex');
}
