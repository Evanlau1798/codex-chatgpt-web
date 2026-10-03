import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
function decodeLines(text) {
  const rows = []; let errors = 0;
  for (const line of text.trim().split('\n').filter(Boolean)) {
    try { rows.push(JSON.parse(line)); } catch { errors++; }
  }
  return { rows, errors };
}

export function nativeMetrics(artifact) {
  if (!fs.existsSync(path.join(artifact, 'stdout.jsonl'))) return { native_exit: null, quota_latched: null, diagnostic_error_latched: null,
    client_final_observed: false, tool_calls: null, read_calls: null, repeat_reads: null,
    client_inference_http_requests: 0, recorded_response_bytes: 0, transport_heartbeats: 0,
    failure_stage: 'launcher_preflight', billing_cost: null };
  const chunks = decodeLines(fs.readFileSync(path.join(artifact, 'stdout.jsonl'), 'utf8'));
  const decoded = decodeLines(chunks.rows.map(row => row?.data || '').join(''));
  const eventCapture = decodeLines(fs.readFileSync(path.join(artifact, 'events.jsonl'), 'utf8'));
  const captureErrors = chunks.errors + decoded.errors + eventCapture.errors
    + eventCapture.rows.filter(row => row.type === 'response_capture_failed').length;
  const records = decoded.rows;
  const events = eventCapture.rows;
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
  if (captureErrors) finalObserved = false;
  const reads = new Map();
  for (const call of calls) {
    const file = call.tool === 'Read' ? call.file : /\bcat\s+--\s+['"]([^'"]+)['"]/.exec(call.command || '')?.[1];
    if (file) reads.set(file, (reads.get(file) || 0) + 1);
  }
  const exit = events.findLast(event => event.type === 'session_exit');
  const latches = events.filter(event => event.type === 'quota_latch');
  const responseEvents = events.filter(event => event.type === 'response_end' && event.scope === 'gpt-6-pro-inference');
  return { native_exit: exit?.code ?? null,
    capture_parse_errors: captureErrors, capture_complete: captureErrors === 0,
    quota_latched: latches.some(event => !event.reason?.startsWith('diagnostic_')),
    diagnostic_error_latched: latches.some(event => event.reason?.startsWith('diagnostic_')),
    client_final_observed: finalObserved, tool_calls: calls.length,
    tool_metric_coverage: 'Codex_command_file_completions_and_Claude_tool_use', tool_calls_are_lower_bound: true,
    read_metric_coverage: 'explicit_Read_and_simple_quoted_cat_only',
    read_calls_are_lower_bound: true,
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
  const receipts = new Map(); const sends = new Map(); const returnedTools = new Set(); const erroredTools = new Set();
  let recoverySends = 0; let committed = false;
  for (const line of rows) {
    const text = line.split('model_receipt ')[1];
    if (text) try {
      const receipt = JSON.parse(text);
      if (traces.has(receipt.traceId) && receipt.source === 'network.resolved_model_slug') {
        receipts.set(`${receipt.traceId}/${receipt.physicalSend}`, receipt);
        sends.set(`${receipt.traceId}/${receipt.physicalSend}`, receipt);
      }
    } catch {}
    const diagnosticText = line.split('model_receipt_diagnostic ')[1];
    if (diagnosticText) try {
      const diagnostic = JSON.parse(diagnosticText);
      if (traces.has(diagnostic.traceId) && diagnostic.ownedRequests > 0
        && Number.isInteger(diagnostic.physicalSend) && diagnostic.physicalSend > 0) {
        sends.set(`${diagnostic.traceId}/${diagnostic.physicalSend}`, diagnostic);
      }
    } catch {}
    const eventText = line.split('native_workflow ')[1];
    if (eventText) try {
      const event = JSON.parse(eventText);
      if (traces.has(event.traceId)) {
        if (event.phase === 'completion_committed') committed = true;
        if (event.phase === 'tool_result_returned' && event.result_state === 'returned' && /^[a-f0-9]{24}$/.test(event.call_id_hash || '')) {
          const id = event.traceId + '/' + event.call_id_hash;
          returnedTools.add(id);
          if (event.is_error === true) erroredTools.add(id);
        }
      }
    } catch {}
  }
  for (const send of sends.values()) if (send.physicalSend > 1) recoverySends++;
  const models = new Set([...receipts.values()].map(receipt => receipt.servedModel));
  return { served_model: models.size === 1 ? [...models][0] : null,
    provider_sends: sends.size || null, recovery_sends: sends.size ? recoverySends : null,
    returned_native_tool_results: returnedTools.size, errored_native_tool_results: erroredTools.size,
    completion_committed: committed, provider_evidence: receipts.size ? 'owned_wire_receipts' : sends.size ? 'owned_wire_diagnostics_no_model_identity' : 'unavailable' };
}
