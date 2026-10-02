import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
const lines = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

export function nativeMetrics(artifact) {
  if (!fs.existsSync(path.join(artifact, 'stdout.jsonl'))) return { native_exit: null, quota_latched: null, diagnostic_error_latched: null,
    client_final_observed: false, tool_calls: null, read_calls: null, repeat_reads: null,
    client_inference_http_requests: 0, recorded_response_bytes: 0, transport_heartbeats: 0,
    failure_stage: 'launcher_preflight', billing_cost: null };
  const chunks = lines(path.join(artifact, 'stdout.jsonl'));
  const records = chunks.map(row => row.data || '').join('').trim().split('\n').filter(Boolean).map(JSON.parse);
  const events = lines(path.join(artifact, 'events.jsonl'));
  const calls = []; let finalObserved = false; let lastTool = -1; let lastAnswer = -1; let turnCompleted = false;
  for (const [index, record] of records.entries()) {
    if (record.type === 'item.completed' && ['command_execution', 'file_change'].includes(record.item?.type)) {
      calls.push({ tool: record.item.type, command: record.item.command });
      lastTool = index;
    }
    if (record.type === 'item.completed' && record.item?.type === 'agent_message' && record.item.text?.trim()) lastAnswer = index;
    if (record.type === 'turn.completed') turnCompleted = true;
    if (record.type === 'assistant') for (const part of record.message?.content || []) {
      if (part.type === 'tool_use') calls.push({ tool: part.name, command: part.input?.command, file: part.input?.file_path });
    }
    if (record.type === 'result' && record.subtype === 'success' && record.is_error === false && record.result?.trim()) finalObserved = true;
  }
  finalObserved ||= turnCompleted && lastAnswer > lastTool;
  const reads = new Map();
  for (const call of calls) {
    const file = call.tool === 'Read' ? call.file : /\bcat\s+--\s+['"]([^'"]+)['"]/.exec(call.command || '')?.[1];
    if (file) reads.set(file, (reads.get(file) || 0) + 1);
  }
  const exit = events.findLast(event => event.type === 'session_exit');
  const latches = events.filter(event => event.type === 'quota_latch');
  const responseEvents = events.filter(event => event.type === 'response_end' && event.scope === 'gpt-6-pro-inference');
  return { native_exit: exit?.code ?? null,
    quota_latched: latches.some(event => !event.reason?.startsWith('diagnostic_')),
    diagnostic_error_latched: latches.some(event => event.reason?.startsWith('diagnostic_')),
    client_final_observed: finalObserved, tool_calls: calls.length,
    read_calls: [...reads.values()].reduce((a, b) => a + b, 0),
    repeat_reads: [...reads.values()].reduce((a, b) => a + Math.max(0, b - 1), 0),
    client_inference_http_requests: responseEvents.length,
    recorded_response_bytes: fs.readdirSync(artifact).filter(file => file.endsWith('.response.txt'))
      .reduce((n, file) => n + fs.statSync(path.join(artifact, file)).size, 0),
    transport_heartbeats: events.filter(event => event.eventType === 'response.heartbeat' || event.eventType === 'ping').length,
    billing_cost: null }; // Bridge token counters are not provider billing evidence.
}

export function ownedProviderMetrics(log, cwd) {
  const rows = log.split('\n'); const traces = new Set();
  for (const line of rows) {
    const text = line.split('native_workflow ')[1]; if (!text) continue;
    try { const event = JSON.parse(text); if (event.phase === 'native_context_bound' && event.cwd_sha256 === digest(cwd)) traces.add(event.traceId); } catch {}
  }
  const receipts = new Map(); let recoverySends = 0; let committed = false;
  for (const line of rows) {
    const text = line.split('model_receipt ')[1];
    if (text) try {
      const receipt = JSON.parse(text);
      if (traces.has(receipt.traceId) && receipt.source === 'network.resolved_model_slug') {
        receipts.set(`${receipt.traceId}/${receipt.physicalSend}`, receipt);
      }
    } catch {}
    const eventText = line.split('native_workflow ')[1];
    if (eventText) try { const event = JSON.parse(eventText); if (traces.has(event.traceId) && event.phase === 'completion_committed') committed = true; } catch {}
  }
  for (const receipt of receipts.values()) if (receipt.physicalSend > 1) recoverySends++;
  const models = new Set([...receipts.values()].map(receipt => receipt.servedModel));
  return { served_model: models.size === 1 ? [...models][0] : null,
    provider_sends: receipts.size || null, recovery_sends: receipts.size ? recoverySends : null,
    completion_committed: committed, provider_evidence: receipts.size ? 'owned_wire_receipts' : 'unavailable' };
}
