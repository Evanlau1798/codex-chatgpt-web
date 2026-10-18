import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { preflightBridge } from '../src/launch.mjs';

function sourceFixture(version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astra6-source-version-'));
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ version })}\n`, { mode: 0o600 });
  return root;
}

async function healthFixture(payload, status = 200) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: server.address().port, seen };
}

async function stop(server) {
  await new Promise(resolve => server.close(() => resolve()));
}

test('health preflight accepts matched candidate version and does not require idle counters', async () => {
  const version = '6.1.3-Enhanced.9001';
  const sourceRoot = sourceFixture(version);
  const fixture = await healthFixture({
    status: 'ok', service: 'codex-chatgpt-web', mode: 'full', version, accepting_turns: true,
    active_http_turns: 2, active_browser_turns: 3,
  });
  try {
    const result = await preflightBridge({ bridge: { host: '127.0.0.1', port: fixture.port, mode: 'full', releaseVersion: version }, sourceRoot });
    assert.deepEqual(result, { sourceVersion: version, healthVersion: version });
    assert.equal(fixture.seen[0].method, 'GET');
    assert.equal(fixture.seen[0].url, '/healthz');
    assert.equal(fixture.seen[0].headers.authorization, undefined);
    assert.equal(fixture.seen[0].headers.cookie, undefined);
  } finally {
    await stop(fixture.server);
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test('health preflight rejects config/source version mismatch before contacting the service', async () => {
  const sourceRoot = sourceFixture('6.1.3-Enhanced.9001');
  let contacted = false;
  const fetchImpl = async () => { contacted = true; throw new Error('should not fetch'); };
  await assert.rejects(
    preflightBridge({ bridge: { host: '127.0.0.1', port: 1, mode: 'full', releaseVersion: '6.1.3-Enhanced.2' }, sourceRoot, fetchImpl }),
    /Bridge\/source version mismatch/,
  );
  assert.equal(contacted, false);
  fs.rmSync(sourceRoot, { recursive: true, force: true });
});

test('health preflight rejects live version mismatch and draining service', async () => {
  const sourceRoot = sourceFixture('6.1.3-Enhanced.9001');
  const version = '6.1.3-Enhanced.9001';
  const mismatch = await healthFixture({ status: 'ok', service: 'codex-chatgpt-web', mode: 'full', version: '6.1.3-Enhanced.old', accepting_turns: true });
  try {
    await assert.rejects(
      preflightBridge({ bridge: { host: '127.0.0.1', port: mismatch.port, mode: 'full', releaseVersion: version }, sourceRoot }),
      /Bridge health version mismatch/,
    );
  } finally { await stop(mismatch.server); }
  const draining = await healthFixture({ status: 'ok', service: 'codex-chatgpt-web', mode: 'full', version, accepting_turns: false });
  try {
    await assert.rejects(
      preflightBridge({ bridge: { host: '127.0.0.1', port: draining.port, mode: 'full', releaseVersion: version }, sourceRoot }),
      /Bridge healthz is draining/,
    );
  } finally {
    await stop(draining.server);
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test('health preflight reports an unreachable bridge explicitly', async () => {
  const sourceRoot = sourceFixture('6.1.3-Enhanced.9001');
  const reserve = http.createServer();
  await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
  const port = reserve.address().port;
  await stop(reserve);
  try {
    await assert.rejects(
      preflightBridge({ bridge: { host: '127.0.0.1', port, mode: 'full', releaseVersion: '6.1.3-Enhanced.9001' }, sourceRoot, timeoutMs: 250 }),
      /Bridge healthz unreachable/,
    );
  } finally { fs.rmSync(sourceRoot, { recursive: true, force: true }); }
});
