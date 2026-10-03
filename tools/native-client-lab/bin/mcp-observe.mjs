#!/usr/bin/env node
// Diagnostic pass-through only. No rewriting, retry, cancellation deadline, or auth recording.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { LAB_ROOT } from '../src/launch-args.mjs';
const root = path.join(process.env.ASTRA6_ARTIFACTS || path.join(LAB_ROOT, 'artifacts'), 'mcp-observation');
mkdirSync(root, { recursive: true, mode: 0o700 });
const log = createWriteStream(`${root}/wire-${Date.now()}-${process.pid}.jsonl`, { flags: 'wx', mode: 0o600 });
const executable = process.env.ASTRA6_MCP_EXECUTABLE;
const args = JSON.parse(process.env.ASTRA6_MCP_ARGS_JSON || 'null');
if (!executable || !Array.isArray(args) || args.some(value => typeof value !== 'string')) {
  throw new Error('Set ASTRA6_MCP_EXECUTABLE and ASTRA6_MCP_ARGS_JSON for the existing native MCP command; no runtime is guessed.');
}
const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'inherit'] });
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout);
const pending = new Map(); let sequence = 0;
const allowed = new Set(['apply_patch','codex_apply_patch','codex_tool_call','codex_tool_inventory','codex_exec','codex_write_stdin','Edit','edit','native edit','output','final','codex.control.output','exec_command','Bash','Read','Write']);
const write = entry => log.write(JSON.stringify({ at: new Date().toISOString(), ...entry })+'\n');
function queryInfo(q) {
  if (typeof q !== 'string') return { kind: 'absent' };
  if (allowed.has(q.trim())) return { kind: 'known', query: q.trim() };
  const prefix = ['__codex_tool_search__:','__codex_read_file__:','__codex_context__:','__codex_wait_result__:'].find(p => q.startsWith(p));
  return { kind: prefix ?? 'other', chars: q.length, hash: createHash('sha256').update(q).digest('hex').slice(0,12) };
}
function observe(stream, direction) {
  let buffer = ''; let oversized = false;
  stream.on('data', chunk => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,i); buffer = buffer.slice(i+1);
      if (oversized || line.length > 2_000_000) { oversized = false; write({ direction, skipped: 'oversized' }); continue; }
      let frame; try { frame = JSON.parse(line); } catch { continue; }
      if (direction === 'request' && frame.method === 'tools/call') {
        const call = ++sequence, tool = frame.params?.name;
        const previous = pending.get(frame.id); pending.set(frame.id, previous ? { ambiguous: true } : { call, tool });
        write({ direction, call, tool, ...(tool === 'codex_tool_inventory' ? queryInfo(frame.params?.arguments?.query) : {}) });
      } else if (direction === 'response' && frame.id !== undefined) {
        const request = pending.get(frame.id); pending.delete(frame.id); if (!request) continue;
        const result = frame.result, entry = { direction, ...request, isError: result?.isError === true, rpcError: Boolean(frame.error) };
        if (request.tool === 'codex_tool_inventory') {
          let catalog = result?.structuredContent;
          if (!catalog) for (const c of result?.content ?? []) if (c.type === 'text') { try { const j = JSON.parse(c.text); if (j.tools) { catalog = j; break; } } catch {} }
          if (catalog) Object.assign(entry, { total: catalog.total, workToolsClosed: catalog.work_tools_closed === true,
            tools: catalog.tools?.slice(0,50).map(t => ({ wire: t.wire_name, kind: t.kind, properties: Object.keys(t.parameters?.properties ?? {}) })) });
        }
        write(entry);
      }
    }
    if (buffer.length > 2_000_000) { buffer = ''; oversized = true; }
  });
}
observe(process.stdin, 'request'); observe(child.stdout, 'response');
child.on('error', error => { write({ errorType: error.name }); log.end(); process.exitCode = 1; });
child.on('exit', (code, signal) => { write({ exit: code, signal }); log.end(); process.exitCode = code ?? 1; });
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => child.kill(signal));
