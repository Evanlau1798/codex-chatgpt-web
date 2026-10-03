import { evaluateAcceptance } from './benchmark-oracle.mjs';

export function evaluateParallelAcceptance({ mode, parallel, ...workflow }) {
  const acceptance = evaluateAcceptance(workflow);
  const evidence = ['parallel', 'sequential'].includes(mode)
    && parallel.owned_workers === 2 && parallel.workers_with_pro_receipts === 2
    && parallel.workers_with_generation_intervals === 2
    && Number.isFinite(parallel.observed_worker_overlap_ms)
    && (mode === 'parallel' ? parallel.observed_worker_overlap_ms > 0 : parallel.observed_worker_overlap_ms === 0);
  return { ...acceptance, parallel_evidence_verified: evidence, accepted: acceptance.accepted && evidence };
}
