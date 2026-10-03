import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../src/benchmark-metrics.mjs';
import { parallelEvidence } from '../src/parallel-evidence.mjs';

test('parallel evidence requires owned worker intervals and exact served model receipts', () => {
  const rows = [];
  for (const [traceId, start, end] of [['a', 10, 40], ['b', 20, 50], ['foreign', 0, 99]]) {
    rows.push('native_workflow ' + JSON.stringify({ phase: 'native_context_bound', traceId, cwd_sha256: digest(traceId === 'foreign' ? '/foreign' : '/owned') }));
    rows.push('parallel_admission ' + JSON.stringify({ role: 'worker', traceId }));
    rows.push('native_workflow ' + JSON.stringify({ phase: 'provider_running', source: 'visible_stop_control', traceId, at: start }));
    rows.push('native_workflow ' + JSON.stringify({ phase: 'completion_committed', traceId, at: end }));
    rows.push('model_receipt ' + JSON.stringify({ traceId, source: 'network.resolved_model_slug', servedModel: 'gpt-6-pro' }));
  }
  assert.equal(parallelEvidence(rows.join('\n'), '/owned').observed_worker_overlap_ms, 20);
  assert.equal(parallelEvidence(rows.filter(row => !row.startsWith('model_receipt')).join('\n'), '/owned').observed_worker_overlap_ms, 0);
  assert.equal(parallelEvidence(rows.join('\n'), '/wrong').owned_workers, 0);
});
