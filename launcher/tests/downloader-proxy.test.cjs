const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { readFileSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tlsIdentity = require('./support/downloader-tls.cjs');

test('the resolved Electron downloader proxy removes vulnerable logging and forwards HTTP', async () => {
  const downloader = createRequire(require.resolve('app-builder-lib')).resolve('@electron/get');
  const downloaderRequire = createRequire(downloader);
  const manifest = JSON.parse(readFileSync(downloaderRequire.resolve('global-agent/package.json'), 'utf8'));
  assert.equal(manifest.dependencies.roarr, undefined);
  const requests = [];
  const proxy = http.createServer((request, response) => {
    requests.push(request.url);
    response.end('PROXY_OK');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const source = `
      require(${JSON.stringify(downloader)}).initializeProxy();
      require('node:http').get('http://artifact.invalid/electron.zip', response => {
        let text = '';
        response.on('data', chunk => text += chunk);
        response.on('end', () => process.stdout.write(text));
      }).on('error', error => { console.error(error); process.exitCode = 1; });
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', source], {
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, GLOBAL_AGENT_HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`,
        GLOBAL_AGENT_HTTPS_PROXY: '', GLOBAL_AGENT_NO_PROXY: '' },
    });
    assert.equal(stdout, 'PROXY_OK');
    assert.deepEqual(requests, ['http://artifact.invalid/electron.zip']);
  } finally {
    await new Promise(resolve => proxy.close(resolve));
  }
});

test('the resolved downloader proxy preserves HTTPS CONNECT and certificate validation', async () => {
  const downloader = createRequire(require.resolve('app-builder-lib')).resolve('@electron/get');
  const origin = https.createServer(tlsIdentity, (_request, response) => response.end('TLS_OK'));
  const tunnels = new Set();
  const destinations = [];
  const proxy = http.createServer();
  const root = mkdtempSync(join(tmpdir(), 'downloader-proxy-tls-'));
  const caFile = join(root, 'ca.pem');
  writeFileSync(caFile, tlsIdentity.cert);
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  proxy.on('connect', (request, downstream, head) => {
    destinations.push(request.url);
    const upstream = net.connect(origin.address().port, '127.0.0.1', () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      downstream.pipe(upstream).pipe(downstream);
    });
    for (const socket of [downstream, upstream]) {
      tunnels.add(socket);
      socket.on('close', () => tunnels.delete(socket));
      socket.on('error', () => { downstream.destroy(); upstream.destroy(); });
    }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const source = `
      require(${JSON.stringify(downloader)}).initializeProxy();
      require('node:https').get('https://localhost:${origin.address().port}/electron.zip', response => {
          let text = '';
          response.on('data', chunk => text += chunk);
          response.on('end', () => process.stdout.write(text));
        }).on('error', error => { console.error(error); process.exitCode = 1; });
    `;
    const environment = { ...process.env, GLOBAL_AGENT_HTTP_PROXY: '',
      GLOBAL_AGENT_HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, GLOBAL_AGENT_NO_PROXY: '',
      NODE_TLS_REJECT_UNAUTHORIZED: '1', NODE_EXTRA_CA_CERTS: caFile };
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', source], {
      timeout: 10_000, windowsHide: true,
      env: environment,
    });
    assert.equal(stdout, 'TLS_OK');
    await assert.rejects(promisify(execFile)(process.execPath, ['-e', source], {
      timeout: 10_000, windowsHide: true, env: { ...environment, NODE_EXTRA_CA_CERTS: '' },
    }), error => error.stderr.includes('DEPTH_ZERO_SELF_SIGNED_CERT'));
    assert.deepEqual(destinations, Array(2).fill(`localhost:${origin.address().port}`));
  } finally {
    for (const socket of tunnels) socket.destroy();
    await Promise.all([proxy, origin].map(server => new Promise(resolve => server.close(resolve))));
    rmSync(root, { recursive: true, force: true });
  }
});
