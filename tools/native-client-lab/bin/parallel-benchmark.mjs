#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { LAB_ROOT } from '../src/launch-args.mjs';
import { digest, nativeMetrics, ownedProviderMetrics } from '../src/benchmark-metrics.mjs';
import { parallelEvidence } from '../src/parallel-evidence.mjs';
const argv = process.argv.slice(2);
const option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const client = option('--client', 'codex'), mode = option('--mode', 'parallel');
if (!['codex', 'claude'].includes(client) || !['parallel', 'sequential'].includes(mode)) throw new Error('Invalid client/mode');
const providerLog = option('--provider-log');
if (!providerLog || !fs.statSync(providerLog).isFile()) throw new Error('Existing private --provider-log required before inference');
const root = option('--output-root', fs.mkdtempSync(path.join(os.tmpdir(), 'native-parallel-')));
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
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
console.log(JSON.stringify({ benchmark_root: root, client, mode, query_timeout: null, automatic_retry: false }));
const launchExit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
fs.closeSync(fd);
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
const accepted = launchExit === 0 && native.native_exit === 0 && native.client_final_observed === true && test.status === 0
  && exact && immutable && wire.served_model === 'gpt-6-pro' && parallel.owned_workers === 2 && parallel.workers_with_pro_receipts === 2
  && (mode === 'parallel' ? parallel.observed_worker_overlap_ms > 0 : parallel.observed_worker_overlap_ms === 0);
const result = { accepted, client, mode, elapsed_ms: Date.now() - started, launcher_exit: launchExit, test_exit: test.status,
  exact_edits: exact, tests_unchanged: immutable, ...native, ...wire, ...parallel, billing_cost: 'unmeasured' };
fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(result));
process.exitCode = accepted ? 0 : 1;
