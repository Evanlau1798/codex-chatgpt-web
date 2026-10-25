#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { LAB_ROOT } from '../src/launch-args.mjs';
import { digest, nativeMetrics, ownedProviderMetrics } from '../src/benchmark-metrics.mjs';
import { evaluateAcceptance } from '../src/benchmark-oracle.mjs';

const argv = process.argv.slice(2);
const option = (key, fallback) => argv.includes(key) ? argv[argv.indexOf(key) + 1] : fallback;
const rounds = Number(option('--rounds', '2'));
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('--rounds must be 1..5 paired trials');
const providerLog = option('--provider-log');
if (!providerLog || !fs.statSync(providerLog).isFile()) throw new Error('--provider-log must name the existing private provider log before any trial');
const requestedRoot = option('--output-root', fs.mkdtempSync(path.join(os.tmpdir(), 'native-client-benchmark-')));
fs.mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
const root = fs.realpathSync(requestedRoot);
if (fs.readdirSync(root).length) throw new Error('Benchmark output directory must be empty; never reuse uncertain runs');
const fixtures = path.join(LAB_ROOT, 'assets', 'benchmark');
const original = fs.readFileSync(path.join(fixtures, 'scale.mjs'));
const tests = fs.readFileSync(path.join(fixtures, 'scale.test.mjs'));
const expected = digest(original.toString().replace('baseServings / targetServings', 'targetServings / baseServings'));
const results = [];
let activeChild;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (activeChild?.exitCode === null) activeChild.kill(signal); });
console.log(JSON.stringify({ benchmark_root: root, rounds, billing_cost: 'unmeasured' }));
for (let round = 0; round < rounds; round++) {
  for (const client of round % 2 === 0 ? ['codex', 'claude'] : ['claude', 'codex']) {
    const cwd = path.join(root, `${round + 1}-${client}`);
    fs.mkdirSync(cwd, { mode: 0o700 });
    fs.copyFileSync(path.join(fixtures, 'scale.mjs'), path.join(cwd, 'scale.mjs'));
    fs.copyFileSync(path.join(fixtures, 'scale.test.mjs'), path.join(cwd, 'scale.test.mjs'));
    const artifacts = path.join(root, `${round + 1}-${client}-artifacts`);
    const args = [path.join(LAB_ROOT, 'bin', `${client}-astrapro.mjs`), '--headless', '--diagnostic', '--cwd', cwd,
      '--prompt-file', path.join(fixtures, 'prompt.txt'), '--artifacts', artifacts];
    if (argv.includes('--unsafe')) args.push('--unsafe');
    if (option('--codex-path') && client === 'codex') args.push('--cli-path', option('--codex-path'));
    if (option('--claude-path') && client === 'claude') args.push('--cli-path', option('--claude-path'));
    if (option('--source-root')) args.push('--source-root', option('--source-root'));
    if (option('--bridge-config')) args.push('--bridge-config', option('--bridge-config'));
    const before = providerLog ? fs.statSync(providerLog).size : 0;
    const started = Date.now();
    const stdout = fs.openSync(path.join(root, `${round + 1}-${client}.launch.log`), 'wx', 0o600);
    activeChild = spawn(process.execPath, args, { stdio: ['ignore', stdout, stdout] });
    const code = await new Promise((resolve, reject) => { activeChild.once('error', reject); activeChild.once('close', resolve); });
    fs.closeSync(stdout); // No query timeout or automatic retry; wait for this same child.
    const elapsed_ms = Date.now() - started;
    const test = spawnSync(process.execPath, ['--test', 'scale.test.mjs'], { cwd, encoding: 'utf8' });
    fs.writeFileSync(path.join(root, `${round + 1}-${client}.independent-test.log`), test.stdout + test.stderr, { mode: 0o600 });
    const dirs = fs.existsSync(artifacts) ? fs.readdirSync(artifacts) : [];
    const metrics = dirs.length === 1 ? nativeMetrics(path.join(artifacts, dirs[0])) : { native_exit: null, client_final_observed: false };
    const wire = providerLog ? ownedProviderMetrics(fs.readFileSync(providerLog).subarray(before).toString(), cwd)
      : { served_model: null, provider_evidence: 'unavailable' };
    const exact_edit = digest(fs.readFileSync(path.join(cwd, 'scale.mjs'))) === expected;
    const tests_unchanged = digest(fs.readFileSync(path.join(cwd, 'scale.test.mjs'))) === digest(tests);
    const acceptance = evaluateAcceptance({ launcherExit: code, nativeExit: metrics.native_exit, clientFinal: metrics.client_final_observed,
      testExit: test.status, exactEdit: exact_edit, testsUnchanged: tests_unchanged, servedModel: wire.served_model });
    const result = { round: round + 1, client, elapsed_ms, launcher_exit: code, independent_test_exit: test.status,
      exact_edit, tests_unchanged, ...acceptance, original_source_sha256: digest(original), ...metrics, ...wire };
    results.push(result);
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ rounds, results, complete: results.length === rounds * 2 }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result));
    if (!acceptance.accepted) throw new Error('Benchmark stopped on the first failed oracle; diagnose, do not blindly retry');
  }
}
