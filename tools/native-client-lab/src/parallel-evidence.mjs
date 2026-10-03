import { digest } from './benchmark-metrics.mjs';

export function parallelEvidence(log, cwd) {
  const workflow = [], admissions = [], receipts = [];
  for (const line of log.split('\n')) {
    for (const [marker, rows] of [['native_workflow ', workflow], ['parallel_admission ', admissions], ['model_receipt ', receipts]]) {
      const value = line.split(marker)[1];
      if (value) try { rows.push(JSON.parse(value)); } catch {}
    }
  }
  const owned = new Set(workflow.filter(row => row.phase === 'native_context_bound' && row.cwd_sha256 === digest(cwd)).map(row => row.traceId));
  const workers = new Set(admissions.filter(row => row.role === 'worker' && owned.has(row.traceId)).map(row => row.traceId));
  const intervals = [];
  for (const traceId of workers) {
    let start;
    for (const event of workflow.filter(row => row.traceId === traceId && Number.isFinite(row.at)).sort((a, b) => a.at - b.at)) {
      if (event.phase === 'provider_running' && event.source === 'visible_stop_control') start ??= event.at;
      else if (start !== undefined && ['tool_running', 'waiting_unobserved', 'completion_committed'].includes(event.phase)) {
        if (event.at > start) intervals.push({ traceId, start, end: event.at });
        start = undefined;
      }
    }
  }
  const served = new Set(receipts.filter(row => owned.has(row.traceId) && row.source === 'network.resolved_model_slug' && row.servedModel === 'gpt-6-pro').map(row => row.traceId));
  let overlap = 0;
  for (let i = 0; i < intervals.length; i++) for (let j = i + 1; j < intervals.length; j++) {
    const a = intervals[i], b = intervals[j];
    if (a.traceId !== b.traceId && served.has(a.traceId) && served.has(b.traceId)) overlap = Math.max(overlap, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  }
  return { owned_workers: workers.size, workers_with_pro_receipts: [...workers].filter(id => served.has(id)).length,
    observed_worker_overlap_ms: Math.max(0, overlap), overlap_evidence: 'owned_visible_generation_intervals_and_wire_receipts',
    hardware_inference_scheduling: 'unobserved' };
}
