import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, ownedProviderMetrics } from '../src/benchmark-metrics.mjs';

test('owned rejected Send is counted without inventing a served-model receipt', () => {
  const cwd = '/disposable/fixture';
  const log = [
    'native_workflow ' + JSON.stringify({ phase: 'native_context_bound', traceId: 'owned', cwd_sha256: digest(cwd) }),
    'model_receipt_diagnostic ' + JSON.stringify({ traceId: 'owned', physicalSend: 1, ownedRequests: 1, outcome: 'unavailable', reason: 'missing_resolved_model' }),
    'model_receipt_diagnostic ' + JSON.stringify({ traceId: 'foreign', physicalSend: 2, ownedRequests: 1 }),
    'model_receipt_diagnostic ' + JSON.stringify({ traceId: 'owned', physicalSend: 2, ownedRequests: 0 }),
  ].join('\n');
  assert.deepEqual(ownedProviderMetrics(log, cwd), { served_model: null, provider_sends: 1, recovery_sends: 0,
    completion_committed: false, provider_evidence: 'owned_wire_diagnostics_no_model_identity' });
});
