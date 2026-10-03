const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const vendorPath = require.resolve('../vendor/http-cache-semantics');
const actualPath = createRequire(require.resolve('cacheable-request')).resolve('http-cache-semantics');

test('the real downloader dependency resolves to the reviewed mitigation bytes', () => {
  const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  assert.equal(digest(actualPath), digest(vendorPath));
});

for (const [label, path] of [['vendor', vendorPath], ['resolved downloader', actualPath]]) {
  const Policy = require(path);
  const req = { url: 'https://example.test/file', method: 'GET', headers: { host: 'example.test' } };
  for (const directive of ['max-stale', 'max-stale=999999']) {
    for (const headers of [
      { 'cache-control': 'max-age=1', 'set-cookie': 'session=private' },
      { 'cache-control': 'max-age=1, proxy-revalidate' },
      { 'cache-control': 'max-age=1, no-cache' },
      { 'cache-control': 'max-age=1, no-store' },
      { 'cache-control': 'max-age=1, private' },
    ]) {
      test(`${label}: ${directive} cannot override ${JSON.stringify(headers)}`, () => {
        const policy = new Policy(req, { status: 200, headers }, { shared: true });
        policy.now = () => policy._responseTime + 10000;
        const incoming = { ...req, headers: { ...req.headers, 'cache-control': directive } };
        assert.equal(policy.satisfiesWithoutRevalidation(incoming), false);
        assert.equal(policy.evaluateRequest(incoming).response, undefined);
        const restored = Policy.fromObject(policy.toObject());
        restored.now = policy.now;
        assert.equal(restored.satisfiesWithoutRevalidation(incoming), false);
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
