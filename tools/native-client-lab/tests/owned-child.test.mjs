import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withOwnedChild } from '../src/owned-child.mjs';

test('real post-spawn metadata write failure retires the owned process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-child-'));
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("READY");setInterval(()=>{},10000);'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await assert.rejects(withOwnedChild(child, async () => {
      await once(child.stdout, 'data');
      fs.writeFileSync(root, 'cannot write a file over a directory');
    }), error => error.code === 'EISDIR' || error.code === 'EPERM');
    assert.notEqual(child.signalCode, null);
    assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('close'), 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ordinary live child is preserved beyond the exceptional cleanup interval', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),1100);'], { stdio: 'ignore' });
  const result = await withOwnedChild(child, async (_child, completion) => completion);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
});
