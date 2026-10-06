const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');

const actualPath = createRequire(require.resolve('cacheable-request')).resolve('http-cache-semantics');

test('the actual downloader resolves to the reviewed patched registry artifact', () => {
  assert.equal(require('http-cache-semantics/package.json').version, '4.3.0');
  assert.equal(createHash('sha256').update(readFileSync(actualPath)).digest('hex'),
    'd2fab3018e8b95d228548a26e0a061e38716fb1d43fc97b87524d330551e78b2');
});
for (const [label, path] of [['resolved downloader', actualPath]]) {
  const Policy = require(path);
  const req = { url: 'https://example.test/file', method: 'GET', headers: { host: 'example.test' } };
  for (const directive of ['max-stale', 'max-stale=999999']) {
    for (const headers of [
      { 'cache-control': 'max-age=1', 'set-cookie': 'session=private' },
      { 'cache-control': 'max-age=1, proxy-revalidate' },
      { 'cache-control': 'max-age=1, no-cache' },
      { 'cache-control': 'max-age=1, no-store' },
      { 'cache-control': 'max-age=1, private' },
    ].flatMap(headers => [headers, { ...headers,
      'cache-control': `${headers['cache-control']}, stale-while-revalidate=999999` }])) {
      test(`${label}: ${directive} cannot override ${JSON.stringify(headers)}`, () => {
        const policy = new Policy(req, { status: 200, headers }, { shared: true });
        policy.now = () => policy._responseTime + 10000;
        const incoming = { ...req, headers: { ...req.headers, 'cache-control': directive } };
        assert.equal(policy.satisfiesWithoutRevalidation(incoming), false);
        assert.equal(policy.evaluateRequest(incoming).response, undefined);
        const restored = Policy.fromObject(policy.toObject());
        restored.now = policy.now;
        assert.equal(restored.satisfiesWithoutRevalidation(incoming), false);
        assert.equal(restored.evaluateRequest(incoming).response, undefined);
      });
    }
  }
  test(`${label}: ordinary expiry and private cookie caches retain stale reuse`, () => {
    for (const shared of [true, false]) {
      const policy = new Policy(req, { status: 200, headers: { 'cache-control': 'max-age=1',
        ...(shared ? {} : { 'set-cookie': 'session=private' }) } }, { shared });
      policy.now = () => policy._responseTime + 10000;
      assert.equal(policy.satisfiesWithoutRevalidation({ ...req, headers: { ...req.headers, 'cache-control': 'max-stale=999999' } }), true);
    }
  });
}

test('explicit shared-cookie opt-in and private proxy policies retain stale reuse', () => {
  const Policy = require(actualPath);
  const request = { url: 'https://example.test/file', method: 'GET', headers: { host: 'example.test' } };
  for (const [shared, directive] of [[true, 'public'], [true, 'immutable'], [false, 'proxy-revalidate']]) {
    const policy = new Policy(request, { status: 200, headers: {
      'cache-control': `max-age=1, ${directive}`, 'set-cookie': 'session=private',
    } }, { shared });
    policy.now = () => policy._responseTime + 10000;
    const incoming = { ...request, headers: { ...request.headers, 'cache-control': 'max-stale=999999' } };
    assert.equal(policy.satisfiesWithoutRevalidation(incoming), true);
    const restored = Policy.fromObject(policy.toObject());
    restored.now = policy.now;
    assert.equal(restored.satisfiesWithoutRevalidation(incoming), true);
  }
});
