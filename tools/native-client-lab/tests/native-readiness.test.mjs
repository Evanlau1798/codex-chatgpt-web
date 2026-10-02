import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightNativePlugin, preflightRuntimeArtifact } from '../src/launch.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digest, ownedProviderMetrics, nativeMetrics } from '../src/benchmark-metrics.mjs';
const bridge = { host: '127.0.0.1', port: 17841, controlToken: 'fixture-local-control-token' };
const ready = { version: 1, source: 'chatgpt_settings_dom', observedAt: Date.now(),
  permission: 'all_tools', advertised: ['codex_read_context', 'codex_exec', 'codex_write_stdin', 'codex_apply_patch', 'codex_view_image', 'codex_tool_inventory', 'codex_tool_call'], missing: [] };
test('permission preflight requires fresh observed settings and never upgrades them', async () => {
  const seen = [];
  const fetchImpl = async (url, request) => { seen.push({ url, request }); return Response.json(ready); };
  assert.equal((await preflightNativePlugin({ bridge, fetchImpl })).permission, 'all_tools');
  assert.equal(seen[0].url, 'http://127.0.0.1:17841/admin/native-readiness');
  assert.equal(seen[0].request.body, '{}');
  for (const value of [ { ...ready, permission: 'low_risk' }, { ...ready, permission: 'unknown' },
    { ...ready, missing: ['codex_apply_patch'] }, { ...ready, observedAt: 0 } ]) {
    await assert.rejects(preflightNativePlugin({ bridge, fetchImpl: async () => Response.json(value) }));
  }
  await assert.rejects(preflightNativePlugin({ bridge, fetchImpl: async () => new Response('', { status: 409 }) }));
});
test('benchmark model identity is correlated by bound cwd hash, never client banners or unrelated receipts', () => {
  const cwd = '/private/tmp/fixture';
  const bind = { phase: 'native_context_bound', cwd_sha256: digest(cwd), traceId: 'owned' };
  const receipt = { traceId: 'owned', physicalSend: 1, servedModel: 'gpt-6-pro', source: 'network.resolved_model_slug' };
  const log = `[chatgpt-web] native_workflow ${JSON.stringify(bind)}\n[chatgpt-web] model_receipt ${JSON.stringify(receipt)}`;
  assert.deepEqual(ownedProviderMetrics(log, cwd), { served_model: 'gpt-6-pro', provider_sends: 1,
    recovery_sends: 0, completion_committed: false, provider_evidence: 'owned_wire_receipts' });
  assert.equal(ownedProviderMetrics(log, '/other').served_model, null);
  assert.equal(ownedProviderMetrics(log.replace('network.resolved_model_slug', 'client.banner'), cwd).served_model, null);
});

test('same-version stale runtime bytes are rejected before launching a native client', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-bytes-test-'));
  const sourceRoot = path.join(root, 'source');
  const configured = path.join(root, 'installed', 'app', 'cli.js');
  const built = path.join(sourceRoot, 'dist', 'runtime', 'app', 'cli.js');
  fs.mkdirSync(path.dirname(configured), { recursive: true }); fs.mkdirSync(path.dirname(built), { recursive: true });
  fs.writeFileSync(configured, 'same'); fs.writeFileSync(built, 'same');
  try {
    const value = preflightRuntimeArtifact({ bridge: { runtimeCommand: ['bun', configured] }, sourceRoot });
    assert.equal(value.source_runtime_sha256, value.installed_runtime_sha256);
    fs.writeFileSync(configured, 'stale');
    assert.throws(() => preflightRuntimeArtifact({ bridge: { runtimeCommand: ['bun', configured] }, sourceRoot }), /runtime bytes differ/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a stopped launcher preflight is a measured failure, not a missing-file exception or completion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prelaunch-metrics-test-'));
  try { assert.deepEqual(nativeMetrics(root), { native_exit: null, quota_latched: null, diagnostic_error_latched: null,
    client_final_observed: false, tool_calls: null, read_calls: null, repeat_reads: null,
    client_inference_http_requests: 0, recorded_response_bytes: 0, transport_heartbeats: 0,
    failure_stage: 'launcher_preflight', billing_cost: null }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});
