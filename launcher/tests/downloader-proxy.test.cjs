const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const http = require('node:http');

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
