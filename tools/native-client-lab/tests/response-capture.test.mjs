import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { responseCapture } from '../src/response-capture.mjs';

test('response capture observes actual file-stream finish before declaring complete', async () => {
  let release;
  const stream = new Writable({ write(_chunk, _encoding, callback) { callback(); }, final(callback) { release = callback; } });
  const capture = responseCapture('fixture', () => stream);
  capture.write('redacted response');
  let completed = false;
  const final = capture.end().then(result => { completed = true; return result; });
  assert.equal(completed, false);
  release();
  assert.deepEqual(await final, { complete: true });
});
test('response sink failure is handled and cannot fabricate successful capture', async () => {
  const stream = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error('fixture'), { code: 'ENOSPC' })); } });
  const capture = responseCapture('fixture', () => stream);
  capture.write('data');
  assert.deepEqual(await capture.end(), { complete: false, error_code: 'ENOSPC' });
  capture.write('later data does not throw or cancel upstream');
});
