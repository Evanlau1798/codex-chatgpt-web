import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, ownedProviderMetrics } from '../src/benchmark-metrics.mjs';
import { evaluateAcceptance } from '../src/benchmark-oracle.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('benchmark refuses absent provider evidence before creating or launching a trial', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/benchmark.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--provider-log must name/);
  assert.equal(result.stdout.includes('benchmark_root'), false);
});

test('successful artifact workflow without exact wire model identity never passes Pro acceptance', () => {
  const base = { launcherExit: 0, nativeExit: 0, clientFinal: true, testExit: 0, exactEdit: true, testsUnchanged: true };
  for (const servedModel of [undefined, null, 'gpt-6-thinking']) {
    assert.deepEqual(evaluateAcceptance({ ...base, servedModel }), { workflow_accepted: true, provider_verified: false, accepted: false });
  }
  assert.equal(evaluateAcceptance({ ...base, servedModel: 'gpt-6-pro' }).accepted, true);
  assert.equal(evaluateAcceptance({ ...base, testExit: 1, servedModel: 'gpt-6-pro' }).accepted, false);
});

test('owned rejected Send is counted without inventing a served-model receipt', () => {
  const cwd = '/disposable/fixture';
  const log = [
    'native_workflow ' + JSON.stringify({ phase: 'native_context_bound', traceId: 'owned', cwd_sha256: digest(cwd) }),
    'model_receipt_diagnostic ' + JSON.stringify({ traceId: 'owned', physicalSend: 1, ownedRequests: 1, outcome: 'unavailable', reason: 'missing_resolved_model' }),
    'model_receipt_diagnostic ' + JSON.stringify({ traceId: 'foreign', physicalSend: 2, ownedRequests: 1 }),
    'model_receipt_diagnostic ' + JSON.stringify({ traceId: 'owned', physicalSend: 2, ownedRequests: 0 }),
  ].join('\n');
  assert.deepEqual(ownedProviderMetrics(log, cwd), { served_model: null, provider_sends: 1, recovery_sends: 0,
    returned_native_tool_results: 0, errored_native_tool_results: 0,
    completion_committed: false, provider_evidence: 'owned_wire_diagnostics_no_model_identity' });
});

test('shared-boundary native results are correlated and deduplicated independently of client item coverage', () => {
  const cwd = '/disposable/fixture';
  const returned = { phase: 'tool_result_returned', result_state: 'returned', traceId: 'owned', call_id_hash: 'a'.repeat(24), is_error: true };
  const log = [
    'native_workflow ' + JSON.stringify({ phase: 'native_context_bound', traceId: 'owned', cwd_sha256: digest(cwd) }),
    ...[returned, returned, { ...returned, traceId: 'foreign' }].map(event => 'native_workflow ' + JSON.stringify(event)),
  ].join('\n');
  const metrics = ownedProviderMetrics(log, cwd);
  assert.equal(metrics.returned_native_tool_results, 1);
  assert.equal(metrics.errored_native_tool_results, 1);
  assert.equal(metrics.served_model, null);
});

test('one resolved receipt cannot attest an additional unidentified Send or conflicting duplicate', () => {
  const cwd = '/disposable/identity-completeness';
  const bound = 'native_workflow ' + JSON.stringify({ phase: 'native_context_bound', traceId: 'owned', cwd_sha256: digest(cwd) });
  const receipt = { traceId: 'owned', physicalSend: 1, source: 'network.resolved_model_slug', servedModel: 'gpt-6-pro' };
  const first = 'model_receipt ' + JSON.stringify(receipt);
  const unknown = 'model_receipt_diagnostic ' + JSON.stringify({ traceId: 'owned', physicalSend: 2, ownedRequests: 1 });
  assert.equal(ownedProviderMetrics([bound, first, unknown].join('\n'), cwd).served_model, null);
  for (const reversed of [false, true]) {
    const conflict = 'model_receipt ' + JSON.stringify({ ...receipt, servedModel: 'gpt-6-thinking' });
    const rows = reversed ? [conflict, first] : [first, conflict];
    assert.equal(ownedProviderMetrics([bound, ...rows].join('\n'), cwd).served_model, null);
  }
});
