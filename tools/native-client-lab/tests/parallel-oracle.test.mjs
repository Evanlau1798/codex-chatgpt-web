import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateParallelAcceptance } from '../src/parallel-oracle.mjs';

const input = { mode: 'parallel', launcherExit: 0, nativeExit: 0, clientFinal: true,
  testExit: 0, exactEdit: true, testsUnchanged: true, servedModel: 'gpt-6-pro',
  parallel: { owned_workers: 2, workers_with_pro_receipts: 2, workers_with_generation_intervals: 2, observed_worker_overlap_ms: 10 } };
test('parallel oracle requires independent workflow and two observed worker intervals', () => {
  assert.equal(evaluateParallelAcceptance(input).accepted, true);
  for (const bad of [{ testExit: 1 }, { exactEdit: false }, { testsUnchanged: false }, { clientFinal: false },
    { servedModel: 'gpt-6' }, { parallel: { ...input.parallel, workers_with_pro_receipts: 1 } },
    { parallel: { ...input.parallel, workers_with_generation_intervals: 0 } },
    { parallel: { ...input.parallel, observed_worker_overlap_ms: 0 } }]) {
    assert.equal(evaluateParallelAcceptance({ ...input, ...bad }).accepted, false);
  }
});
test('zero overlap alone does not prove a sequential trial', () => {
  const sequential = { ...input, mode: 'sequential', parallel: { ...input.parallel, observed_worker_overlap_ms: 0 } };
  assert.equal(evaluateParallelAcceptance(sequential).accepted, true);
  for (const count of [0, 1, undefined]) {
    assert.equal(evaluateParallelAcceptance({ ...sequential,
      parallel: { ...sequential.parallel, workers_with_generation_intervals: count } }).accepted, false);
  }
});
