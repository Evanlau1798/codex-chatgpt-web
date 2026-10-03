#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { LAB_ROOT } from '../src/launch-args.mjs';
import { digest, nativeMetrics, ownedProviderMetrics } from '../src/benchmark-metrics.mjs';
import { parallelEvidence } from '../src/parallel-evidence.mjs';
import { evaluateParallelAcceptance } from '../src/parallel-oracle.mjs';
import { withOwnedChild } from '../src/owned-child.mjs';
const argv = process.argv.slice(2);
const option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const client = option('--client', 'codex'), mode = option('--mode', 'parallel');
if (!['codex', 'claude'].includes(client) || !['parallel', 'sequential'].includes(mode)) throw new Error('Invalid client/mode');
const providerLog = option('--provider-log');
if (!providerLog || !fs.statSync(providerLog).isFile()) throw new Error('Existing private --provider-log required before inference');
const requestedRoot = option('--output-root', fs.mkdtempSync(path.join(os.tmpdir(), 'native-parallel-')));
fs.mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
const root = fs.realpathSync(requestedRoot);
if (fs.readdirSync(root).length) throw new Error('Benchmark output directory must be empty; never reuse uncertain runs');
const cwd = path.join(root, 'project'), artifacts = path.join(root, 'artifacts');
fs.mkdirSync(cwd, { mode: 0o700 });
const assets = path.join(LAB_ROOT, 'assets', 'parallel');
for (const name of ['left.mjs', 'right.mjs', 'integration.mjs', 'parallel.test.mjs']) fs.copyFileSync(path.join(assets, name), path.join(cwd, name));
const testHash = digest(fs.readFileSync(path.join(cwd, 'parallel.test.mjs')));
let prompt = fs.readFileSync(path.join(assets, 'prompt.txt'), 'utf8');
if (mode === 'sequential') prompt = prompt.replace('exactly two native child agents concurrently', 'exactly two native child agents sequentially, completing the left worker before starting the right worker');
const promptFile = path.join(root, 'prompt.txt'); fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
const args = [path.join(LAB_ROOT, 'bin', `${client}-astrapro.mjs`), '--headless', '--diagnostic', '--parallel-agents',
  '--cwd', cwd, '--prompt-file', promptFile, '--artifacts', artifacts];
for (const name of ['--bridge-config', '--source-root', '--cli-path']) if (option(name)) args.push(name, option(name));
if (argv.includes('--unsafe')) args.push('--unsafe');
const before = fs.statSync(providerLog).size, started = Date.now();
const fd = fs.openSync(path.join(root, 'launch.log'), 'wx', 0o600);
const child = spawn(process.execPath, args, { stdio: ['ignore', fd, fd] });
const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);
console.log(JSON.stringify({ benchmark_root: root, client, mode, query_timeout: null, automatic_retry: false }));
let launchExit;
try {
  const completion = await withOwnedChild(child, async (_child, completed) => completed);
  if (completion.error) throw completion.error;
  launchExit = completion.code;
} finally {
  fs.closeSync(fd);
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}
const elapsed = Date.now() - started;
const verificationStarted = Date.now();
const test = spawnSync(process.execPath, ['--test', 'parallel.test.mjs'], { cwd, encoding: 'utf8' });
fs.writeFileSync(path.join(root, 'independent-test.log'), test.stdout + test.stderr, { mode: 0o600 });
const dirs = fs.existsSync(artifacts) ? fs.readdirSync(artifacts) : [];
const native = dirs.length === 1 ? nativeMetrics(path.join(artifacts, dirs[0])) : { native_exit: null, client_final_observed: false };
const log = fs.readFileSync(providerLog).subarray(before).toString();
const wire = ownedProviderMetrics(log, cwd), parallel = parallelEvidence(log, cwd);
const expected = { 'left.mjs': 'export const left = n => n * 2;\n', 'right.mjs': 'export const right = n => n * 3;\n',
  'integration.mjs': "import { left } from './left.mjs';\nimport { right } from './right.mjs';\nexport const combine = n => left(n) + right(n);\n" };
const fileDigest = name => { try { return digest(fs.readFileSync(path.join(cwd, name))); } catch { return null; } };
const exact = Object.entries(expected).every(([name, text]) => fileDigest(name) === digest(text));
const immutable = fileDigest('parallel.test.mjs') === testHash;
const acceptance = evaluateParallelAcceptance({ mode, parallel, launcherExit: launchExit, nativeExit: native.native_exit,
  clientFinal: native.client_final_observed, testExit: test.status, exactEdit: exact, testsUnchanged: immutable, servedModel: wire.served_model });
const result = { ...acceptance, client, mode, elapsed_ms: elapsed,
  verification_elapsed_ms: Date.now() - verificationStarted, total_elapsed_ms: Date.now() - started,
  launcher_exit: launchExit, test_exit: test.status,
  exact_edits: exact, tests_unchanged: immutable, ...native, ...wire, ...parallel, billing_cost: 'unmeasured' };
fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(result));
process.exitCode = acceptance.accepted ? 0 : 1;
