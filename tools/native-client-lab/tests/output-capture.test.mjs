import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureChildOutput } from '../src/output-capture.mjs';
import { StreamRedactor } from '../src/proxy.mjs';
import { nativeMetrics } from '../src/benchmark-metrics.mjs';

test('capture ENOSPC is handled while the source keeps running and draining', async () => {
  const input = new PassThrough();
  const failed = new Writable({ write(_chunk, _encoding, done) { done(Object.assign(new Error('disk full'), { code: 'ENOSPC' })); } });
  const captured = captureChildOutput(input, 'unused', 'stdout', new StreamRedactor(), () => failed);
  let settled = false; void captured.then(() => { settled = true; }, () => { settled = true; });
  input.write('first\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(input.destroyed, false);
  input.end('still-running-source\n');
  await assert.rejects(captured, error => error.code === 'ENOSPC');
});

test('partial recorded JSON is reported as incomplete, never accepted or discarded by a parser crash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-capture-'));
  try {
    fs.writeFileSync(path.join(root, 'stdout.jsonl'), JSON.stringify({ data: '{"type":"item.completed","item":{"text":"partial' }) + '\n');
    fs.writeFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ type: 'session_exit', code: 1 }) + '\n');
    const result = nativeMetrics(root);
    assert.equal(result.native_exit, 1);
    assert.equal(result.capture_parse_errors, 1);
    assert.equal(result.capture_complete, false);
    assert.equal(result.client_final_observed, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
