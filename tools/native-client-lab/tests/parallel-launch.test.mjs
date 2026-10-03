import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexArgs, CODEX_MODEL } from '../src/launch-args.mjs';
const catalog = { models: [{ slug: CODEX_MODEL, default_reasoning_level: 'max',
  supported_reasoning_levels: [{ effort: 'max' }], context_window: 272000, auto_compact_token_limit: 244800 }] };
test('native parallel acceptance enables only invocation-scoped flat v2 delegation', () => {
  const options = { cwd: process.cwd(), proxyUrl: 'http://127.0.0.1:10000', catalogPath: '/fixture/catalog.json', catalog,
    unsafe: false, headless: true };
  const ordinary = buildCodexArgs(options).join('\n');
  assert.match(ordinary, /features.multi_agent_v2=false/);
  const parallel = buildCodexArgs({ ...options, parallelAgents: true }).join('\n');
  assert.match(parallel, /features.multi_agent_v2.enabled=true/);
  assert.match(parallel, /features.multi_agent_v2.max_concurrent_threads_per_session=3/);
  assert.match(parallel, /agents.max_depth=1/);
  assert.match(parallel, /approval_policy="never"/);
  assert.ok(parallel.includes(CODEX_MODEL));
  assert.doesNotMatch(parallel, /dangerously/);
});
