import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import * as zlib from 'node:zlib';
import { createRecordingProxy, CODEX_MODEL, QUOTA_CODES } from '../src/proxy.mjs';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'astra6-proxy-test-'));
}

function serverListen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function collect(req) {
  return new Promise(async (resolve, reject) => {
    const chunks = [];
    try { for await (const chunk of req) chunks.push(chunk); resolve(Buffer.concat(chunks)); } catch (error) { reject(error); }
  });
}

function codexHeaders(marker, metadata, bearer = marker) {
  return {
    authorization: `Bearer ${bearer}`,
    'openai-project': marker,
    originator: 'codex-tui',
    'user-agent': 'codex-tui/0.159.2 (test)',
    'content-type': 'application/json',
    'x-codex-turn-metadata': JSON.stringify(metadata),
  };
}

function codexMeta({ thread, installation, session, source = 'user', model = CODEX_MODEL } = {}) {
  return {
    installation_id: installation,
    session_id: session,
    thread_id: thread,
    turn_id: randomUUID(),
    thread_source: source,
    request_kind: 'turn',
    turn_started_at_unix_ms: Date.now(),
    model,
  };
}

function codexClientMetadata(metadata, overrides = {}) {
  return {
    'x-codex-turn-metadata': JSON.stringify(metadata),
    installation_id: metadata.installation_id,
    session_id: metadata.session_id,
    thread_id: metadata.thread_id,
    turn_id: metadata.turn_id,
    ...overrides,
  };
}

function codexBody(metadata, model = CODEX_MODEL) {
  return {
    model,
    client_metadata: codexClientMetadata(metadata),
    input: [{ type: 'message', content: [{ type: 'input_text', text: '<cwd>/private/tmp/project</cwd>' }] }],
  };
}

async function startFixture(responseBody, { status = 200, onRequest, responseHeaders = {} } = {}) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const bytes = await collect(req);
    seen.push({ req, bytes });
    onRequest?.({ req, bytes, seen });
    const headers = typeof responseHeaders === 'function' ? responseHeaders({ req, seen }) : responseHeaders;
    const responseStatus = typeof status === 'function' ? status({ req, seen }) : status;
    res.writeHead(responseStatus, { 'content-type': 'text/event-stream', ...headers });
    const produced = typeof responseBody === 'function' ? responseBody({ req, seen }) : responseBody;
    if (Array.isArray(produced)) {
      for (const chunk of produced) { res.write(chunk); await new Promise(resolve => setTimeout(resolve, 1)); }
      res.end();
    } else res.end(produced);
  });
  const port = await serverListen(upstream);
  return { upstream, port, seen };
}

async function stop(proxy, upstream) {
  await proxy.close();
  await new Promise(resolve => upstream.close(() => resolve()));
}

test('explicit parallel harness admits only current owned flat native descendants', async t => {
  const fixture = await startFixture('data: [DONE]\n\n');
  const artifact = tempRoot(), marker = randomUUID(), installation = randomUUID(), rootThread = randomUUID();
  const rootMeta = codexMeta({ thread: rootThread, installation, session: rootThread });
  const proxy = createRecordingProxy({ client: 'codex', artifactRoot: artifact, childToken: marker,
    controlToken: randomUUID(), upstreamHost: '127.0.0.1', upstreamPort: fixture.port,
    cwd: '/private/tmp/project', launchedAt: Date.now() - 1000, parallelAgents: true });
  t.after(() => stop(proxy, fixture.upstream));
  const endpoint = await proxy.listen();
  const send = (meta, body = codexBody(meta), token = marker) => fetch(endpoint.url + '/v1/responses', {
    method: 'POST', headers: codexHeaders(token, meta), body: JSON.stringify(body),
  });
  assert.equal((await send(rootMeta)).status, 200);
  const childThread = randomUUID();
  const child = { ...codexMeta({ thread: childThread, installation, session: childThread, source: 'subagent' }),
    parent_thread_id: rootThread, parent_turn_id: rootMeta.turn_id, root_turn_id: rootMeta.turn_id,
    subagent_kind: 'thread_spawn', agent_name: '/root/left' };
  assert.equal((await send(child)).status, 200);
  assert.equal(proxy.state.codexRootThreadId, rootThread);
  for (const invalid of [
    { ...child, parent_thread_id: randomUUID() },
    { ...child, agent_name: '/root/left/nested' },
    { ...child, installation_id: randomUUID() },
    { ...child, session_id: randomUUID() },
  ]) assert.equal((await send(invalid)).status, 403);
  const outside = codexBody(child); outside.input = [{ type: 'message', content: '<cwd>/outside</cwd>' }];
  assert.equal((await send(child, outside)).status, 403);
  const mismatch = codexBody(child);
  mismatch.client_metadata['x-codex-turn-metadata'] = JSON.stringify({ ...child, parent_thread_id: randomUUID() });
  assert.equal((await send(child, mismatch)).status, 403);
  assert.equal((await send(child, codexBody(child), 'unowned')).status, 403);
  assert.equal(fixture.seen.length, 2);
});

test('ordinary harness remains root-only even for a native child with the same marker', async t => {
  const fixture = await startFixture('data: [DONE]\n\n');
  const marker = randomUUID(), installation = randomUUID(), thread = randomUUID();
  const proxy = createRecordingProxy({ client: 'codex', artifactRoot: tempRoot(), childToken: marker,
    controlToken: randomUUID(), upstreamHost: '127.0.0.1', upstreamPort: fixture.port,
    cwd: '/private/tmp/project', launchedAt: Date.now() - 1000 });
  t.after(() => stop(proxy, fixture.upstream));
  const endpoint = await proxy.listen();
  const send = meta => fetch(endpoint.url + '/v1/responses', { method: 'POST',
    headers: codexHeaders(marker, meta), body: JSON.stringify(codexBody(meta)) });
  const root = codexMeta({ thread, installation, session: thread });
  assert.equal((await send(root)).status, 200);
  const id = randomUUID();
  const child = { ...codexMeta({ thread: id, installation, session: id, source: 'subagent' }),
    parent_thread_id: thread, subagent_kind: 'thread_spawn', agent_name: '/root/left' };
  assert.equal((await send(child)).status, 403);
  assert.equal(fixture.seen.length, 1);
});

function findArtifact(root, suffix) {
  return fs.readdirSync(root).find(file => file.endsWith(suffix));
}

test('recorded native Responses deltas count real text and never label messages or heartbeats as tools', async t => {
  const recording = fs.readFileSync(new URL('./fixtures/codex-recorded-ready.sse', import.meta.url), 'utf8');
  const fixture = await startFixture(recording);
  const root = tempRoot();
  const marker = 'recorded-ready-child-1234567890';
  const proxy = createRecordingProxy({
    client: 'codex', artifactRoot: root, childToken: marker, controlToken: 'recorded-ready-control-1234567890',
    upstreamHost: '127.0.0.1', upstreamPort: fixture.port, cwd: '/private/tmp/project', launchedAt: Date.now() - 1000,
  });
  t.after(() => stop(proxy, fixture.upstream));
  const endpoint = await proxy.listen();
  const metadata = codexMeta({ thread: randomUUID(), installation: randomUUID(), session: randomUUID() });
  const response = await fetch(`${endpoint.url}/v1/responses`, {
    method: 'POST', headers: codexHeaders(marker, metadata), body: JSON.stringify(codexBody(metadata)),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), recording);
  const frames = fs.readFileSync(proxy.eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(event => event.type === 'sse');
  const delta = frames.find(event => event.eventType === 'response.output_text.delta');
  assert.equal(delta?.deltaChars, 5);
  assert.equal(frames.filter(event => event.toolCall || event.toolResult).length, 0);
  assert.ok(frames.some(event => event.eventType === 'response.heartbeat'));
  assert.ok(frames.filter(event => event.eventType === 'response.heartbeat').every(event => event.deltaChars === 0));
  assert.ok(frames.some(event => event.eventType === 'response.completed'));
  assert.equal(JSON.stringify(frames).includes('READY'), false, 'summaries record lengths, not content');
});

test('typed tool and thinking summaries distinguish call, result, and real partial characters', async t => {
  const payloads = [
    { type: 'response.output_item.added', item: { type: 'custom_tool_call', id: 'ctc_call', call_id: 'call_edit', name: 'apply_patch' } },
    { type: 'response.custom_tool_call_input.delta', delta: 'patch' },
    { type: 'response.output_item.done', item: { type: 'custom_tool_call', id: 'ctc_call', call_id: 'call_edit', name: 'apply_patch' } },
    { type: 'response.output_item.done', item: { type: 'custom_tool_call_output', call_id: 'call_edit' } },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'real' } },
    { type: 'response.completed', response: { status: 'completed' } },
  ];
  const fixture = await startFixture(payloads.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''));
  const root = tempRoot();
  const marker = 'typed-delta-child-1234567890';
  const proxy = createRecordingProxy({
    client: 'codex', artifactRoot: root, childToken: marker, controlToken: 'typed-delta-control-1234567890',
    upstreamHost: '127.0.0.1', upstreamPort: fixture.port, cwd: '/private/tmp/project', launchedAt: Date.now() - 1000,
  });
  t.after(() => stop(proxy, fixture.upstream));
  const endpoint = await proxy.listen();
  const metadata = codexMeta({ thread: randomUUID(), installation: randomUUID(), session: randomUUID() });
  const response = await fetch(`${endpoint.url}/v1/responses`, {
    method: 'POST', headers: codexHeaders(marker, metadata), body: JSON.stringify(codexBody(metadata)),
  });
  await response.text();
  const frames = fs.readFileSync(proxy.eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(event => event.type === 'sse');
  assert.equal(frames[0].toolCall, true);
  assert.equal(frames[0].callId, 'call_edit');
  assert.equal(frames[1].deltaChars, 5);
  assert.equal(frames[1].toolCall, true);
  assert.equal(frames[2].toolResult, false, 'finished call is not its result');
  assert.equal(frames[3].toolResult, true);
  assert.equal(frames[3].toolCall, false);
  assert.equal(frames[4].deltaChars, 4);
  assert.equal(frames[4].toolCall, false);
});

test('426 negotiation is local and wrong models fail closed without upstream traffic', async () => {
  const fixture = await startFixture('data: [DONE]\n\n');
  const root = tempRoot();
  const proxy = createRecordingProxy({
    client: 'codex', artifactRoot: root, childToken: 'child-secret-1234567890', controlToken: 'control-secret-1234567890',
    upstreamHost: '127.0.0.1', upstreamPort: fixture.port, cwd: '/private/tmp/project', launchedAt: Date.now() - 1000,
  });
  const endpoint = await proxy.listen();
  const negotiation = await fetch(`${endpoint.url}/v1/responses`);
  assert.equal(negotiation.status, 426);
  const thread = randomUUID(), installation = randomUUID(), session = randomUUID();
  const wrongMeta = codexMeta({ thread, installation, session });
  const wrong = await fetch(`${endpoint.url}/v1/responses`, {
    method: 'POST', headers: codexHeaders('child-secret-1234567890', wrongMeta),
    body: JSON.stringify(codexBody(wrongMeta, 'chatgpt-web/high')),
  });
  assert.equal(wrong.status, 400);
  assert.equal(fixture.seen.length, 0);
  await stop(proxy, fixture.upstream);
});

test('Codex body/header identity copies must agree before inference is forwarded', async () => {
  const fixture = await startFixture('data: [DONE]\n\n');
  const root = tempRoot();
  const proxy = createRecordingProxy({
    client: 'codex', artifactRoot: root, childToken: 'identity-child-1234567890', controlToken: 'identity-control-1234567890',
    upstreamHost: '127.0.0.1', upstreamPort: fixture.port, cwd: '/private/tmp/project', launchedAt: Date.now() - 1000,
  });
  const endpoint = await proxy.listen();
  const owned = codexMeta({ thread: randomUUID(), installation: randomUUID(), session: randomUUID() });
  const unowned = codexMeta({ thread: randomUUID(), installation: randomUUID(), session: randomUUID() });
  const body = { ...codexBody(owned), client_metadata: codexClientMetadata(unowned) };
  const response = await fetch(`${endpoint.url}/v1/responses`, {
    method: 'POST', headers: codexHeaders('identity-child-1234567890', owned), body: JSON.stringify(body),
  });
  assert.equal(response.status, 403);
  assert.equal(fixture.seen.length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').includes('codex_metadata_copy_mismatch'), true);
  await stop(proxy, fixture.upstream);
});

test('Codex requires the loopback OpenAI-Project marker and strips marker/bearer upstream', async () => {
  const fixture = await startFixture('data: [DONE]\n\n');
  const root = tempRoot();
  const marker = 'marker-child-1234567890';
  const canonicalBearer = 'canonical-auth-from-codex-abcdef';
  const proxy = createRecordingProxy({
    client: 'codex', artifactRoot: root, childToken: marker, controlToken: 'marker-control-1234567890',
    upstreamHost: '127.0.0.1', upstreamPort: fixture.port, cwd: '/private/tmp/project', launchedAt: Date.now() - 1000,
  });
  const endpoint = await proxy.listen();
  const metadata = codexMeta({ thread: randomUUID(), installation: randomUUID(), session: randomUUID() });
  const body = JSON.stringify(codexBody(metadata));
  const valid = await fetch(`${endpoint.url}/v1/responses`, {
    method: 'POST', headers: codexHeaders(marker, metadata, canonicalBearer), body,
  });
  assert.equal(valid.status, 200);
  await valid.text();
  assert.equal(fixture.seen.length, 1);
  assert.equal(fixture.seen[0].req.headers.authorization, undefined);
  assert.equal(fixture.seen[0].req.headers['openai-project'], undefined);
  const requestCapture = fs.readFileSync(path.join(root, findArtifact(root, '.request.json')), 'utf8');
  assert.equal(requestCapture.includes(marker), false);
  assert.equal(requestCapture.includes(canonicalBearer), false);
  const wrongMarker = await fetch(`${endpoint.url}/v1/responses`, {
    method: 'POST', headers: codexHeaders('wrong-marker-1234567890', metadata, canonicalBearer), body,
  });
  const missingMarkerHeaders = codexHeaders(marker, metadata, canonicalBearer);
  delete missingMarkerHeaders['openai-project'];
  const missingMarker = await fetch(`${endpoint.url}/v1/responses`, {
    method: 'POST', headers: missingMarkerHeaders, body,
  });
  assert.equal(wrongMarker.status, 403);
  assert.equal(missingMarker.status, 403);
  assert.equal(fixture.seen.length, 1);
  await stop(proxy, fixture.upstream);
});

test('gzip and zstd request bytes pass through exactly while response redaction spans chunks', { timeout: 10000 }, async t => {
  const childToken = 'child-secret-abcdef0123456789';
  const controlToken = 'control-secret-fedcba9876543210';
  const bodyCore = { model: CODEX_MODEL, input: [{ type: 'message', content: [{ type: 'input_text', text: '<cwd>/private/tmp/project</cwd>' }] }] };
  const response = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: `hello ${childToken} ${controlToken}` })}\n\n`;
  const failedText = `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`;
  const fixture = await startFixture([Buffer.from(response.slice(0, response.indexOf(childToken) + 4)), Buffer.from(response.slice(response.indexOf(childToken) + 4)), Buffer.from(failedText), 'data: [DONE]\n\n'], {
    responseHeaders: { 'retry-after': '11', 'x-bridge-provenance': 'local-auxiliary', 'x-auth-token': 'should-not-capture' },
    onRequest: ({ req, bytes, seen }) => { seen[seen.length - 1].encoding = req.headers['content-encoding']; seen[seen.length - 1].exact = bytes.equals(compressed); },
  });
  const root = tempRoot();
  const proxy = createRecordingProxy({
    client: 'codex', artifactRoot: root, childToken, controlToken, upstreamHost: '127.0.0.1', upstreamPort: fixture.port,
    cwd: '/private/tmp/project', launchedAt: Date.now() - 1000,
  });
  t.after(async () => { await stop(proxy, fixture.upstream); });
  const endpoint = await proxy.listen();
  const thread = randomUUID(), installation = randomUUID(), session = randomUUID();
  const metadata = codexMeta({ thread, installation, session });
  const body = JSON.stringify({ ...bodyCore, client_metadata: codexClientMetadata(metadata) });
  const compressed = zlib.gzipSync(Buffer.from(body));
  const first = await fetch(`${endpoint.url}/v1/responses`, {
    method: 'POST', headers: { ...codexHeaders(childToken, metadata), 'content-encoding': 'gzip', 'content-length': String(compressed.length) },
    body: compressed,
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('retry-after'), '11');
  assert.equal(first.headers.get('x-bridge-provenance'), 'local-auxiliary');
  assert.equal(first.headers.get('x-auth-token'), null);
  await first.text();
  assert.equal(fixture.seen[0].exact, true);
  assert.equal(fixture.seen[0].encoding, 'gzip');
  const responseFile = path.join(root, findArtifact(root, '.response.txt'));
  const captured = fs.readFileSync(responseFile, 'utf8');
  assert.equal(captured.includes(childToken), false);
  assert.equal(captured.includes(controlToken), false);
  assert.equal(captured.includes('<redacted>'), true);
  const events = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8');
  assert.equal(events.includes(childToken), false);
  const requestCapture = fs.readFileSync(path.join(root, findArtifact(root, '.request.json')), 'utf8');
  assert.equal(requestCapture.toLowerCase().includes('authorization'), false);
  assert.equal(requestCapture.toLowerCase().includes('cookie'), false);
  assert.equal(events.includes('gpt-6-pro-inference'), true);
  const zstd = typeof zlib.zstdCompressSync === 'function' ? zlib.zstdCompressSync(Buffer.from(body)) : undefined;
  if (zstd) {
    const second = await fetch(`${endpoint.url}/v1/responses`, {
      method: 'POST', headers: { ...codexHeaders(childToken, metadata), 'content-encoding': 'zstd', 'content-length': String(zstd.length) }, body: zstd,
    });
    assert.equal(second.status, 200);
    assert.equal(fixture.seen[1].bytes.equals(zstd), true);
    assert.equal(fixture.seen[1].encoding, 'zstd');
  }
});

test('owned Codex title auxiliary without cwd is handled locally and marked non-authoritative', { timeout: 10000 }, async t => {
  const fixture = await startFixture('data: response.completed\n\n', {
    status: ({ seen }) => seen.length === 3 ? 429 : 200,
    responseHeaders: ({ seen }) => seen.length === 1 || seen.length === 3
      ? { 'x-codex-local-handling': 'codex-thread-title', 'x-codex-response-provenance': 'local-auxiliary' }
      : { 'x-codex-local-handling': 'codex-thread-title' },
  });
  const root = tempRoot();
  const proxy = createRecordingProxy({
    client: 'codex', artifactRoot: root, childToken: 'title-child-1234567890', controlToken: 'title-control-1234567890',
    upstreamHost: '127.0.0.1', upstreamPort: fixture.port, cwd: '/private/tmp/project', launchedAt: Date.now() - 1000,
  });
  t.after(async () => { await stop(proxy, fixture.upstream); });
  const endpoint = await proxy.listen();
  const metadata = codexMeta({ thread: randomUUID(), installation: randomUUID(), session: randomUUID(), source: 'thread_title', model: 'chatgpt-web/high' });
  // Simulate a normal root turn already owning a different SDK session; title turns may use an
  // explicitly correlated ephemeral session while retaining installation/metadata proof.
  proxy.state.codexSessionId = randomUUID();
  proxy.state.codexInstallationId = metadata.installation_id;
  const schema = {
    type: 'object', additionalProperties: false, required: ['title'],
    properties: { title: { type: 'string', minLength: 1, maxLength: 36 } },
  };
  const titleBody = {
      model: 'chatgpt-web/high', stream: true, instructions: 'Title helper', tool_choice: 'auto',
      text: { format: { type: 'json_schema', name: 'task_title', strict: true, schema } },
      tools: [
        { type: 'function', name: 'request_user_input_async' },
        { type: 'namespace', name: 'clock', tools: [{ type: 'function', name: 'curr_time' }, { type: 'function', name: 'sleep' }] },
        { type: 'tool_search', execution: 'client' },
      ],
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify(metadata) },
      input: [
        { type: 'message', id: 'dev_title', role: 'developer', content: [{ type: 'input_text', text: 'Title developer context' }] },
        { type: 'message', id: 'env_title', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/private/tmp/project</cwd>\n</environment_context>' }] },
        { type: 'message', id: 'prompt_title', role: 'user', content: [{ type: 'input_text', text: 'Generate a concise task title' }] },
      ],
  };
  const titleRequest = () => fetch(`${endpoint.url}/v1/responses`, {
    method: 'POST', headers: codexHeaders('title-child-1234567890', metadata), body: JSON.stringify(titleBody),
  });
  const response = await titleRequest();
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes('response.completed'), true);
  assert.equal(fixture.seen.length, 1);
  const events = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8');
  assert.equal(events.includes('local_auxiliary'), true);
  assert.equal(events.includes('bridge-local-title-handler-no-authority'), true);
  assert.equal(events.includes('gpt-6-pro-inference'), false);
  assert.equal(proxy.state.quotaLatched, false);
  const missingProvenance = await titleRequest();
  assert.equal(missingProvenance.status, 502);
  await missingProvenance.text();
  assert.equal(fixture.seen.length, 2);
  assert.equal(fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').includes('rejected_title_provenance'), true);
  const titleRateLimited = await titleRequest();
  assert.equal(titleRateLimited.status, 429);
  await titleRateLimited.text();
  assert.equal(proxy.state.quotaLatched, false);
});

test('Claude steering accepts only the bridge control token on a narrow local-control route', async () => {
  const fixture = await startFixture('data: [DONE]\n\n');
  const root = tempRoot();
  const childToken = 'steering-child-1234567890';
  const controlToken = 'steering-control-1234567890';
  const sessionId = randomUUID();
  const proxy = createRecordingProxy({
    client: 'claude', artifactRoot: root, childToken, controlToken, sessionId,
    minimumClaudeVersion: [2, 1, 285], upstreamHost: '127.0.0.1', upstreamPort: fixture.port,
    cwd: '/private/tmp/project', launchedAt: Date.now() - 1000,
  });
  const endpoint = await proxy.listen();
  const body = JSON.stringify({ session_id: sessionId, message: 'Steer current task' });
  const accepted = await fetch(`${endpoint.url}/v1/messages/steering`, {
    method: 'POST', headers: {
      authorization: `Bearer ${controlToken}`, 'user-agent': 'claude-code/2.1.286 (test)', 'content-type': 'application/json',
    }, body,
  });
  assert.equal(accepted.status, 200);
  await accepted.text();
  const rejected = await fetch(`${endpoint.url}/v1/messages/steering`, {
    method: 'POST', headers: {
      authorization: `Bearer ${childToken}`, 'user-agent': 'claude-code/2.1.286 (test)', 'content-type': 'application/json',
    }, body,
  });
  assert.equal(rejected.status, 403);
  const wrongSession = await fetch(`${endpoint.url}/v1/messages/steering`, {
    method: 'POST', headers: {
      authorization: `Bearer ${controlToken}`, 'user-agent': 'claude-code/2.1.286 (test)', 'content-type': 'application/json',
    }, body: JSON.stringify({ session_id: randomUUID(), message: 'wrong session' }),
  });
  const emptySession = await fetch(`${endpoint.url}/v1/messages/steering`, {
    method: 'POST', headers: {
      authorization: `Bearer ${controlToken}`, 'user-agent': 'claude-code/2.1.286 (test)', 'content-type': 'application/json',
    }, body: JSON.stringify({ message: 'missing session' }),
  });
  assert.equal(wrongSession.status, 403);
  assert.equal(emptySession.status, 403);
  assert.equal(fixture.seen.length, 1);
  const events = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8');
  assert.equal(events.includes('local-control'), true);
  assert.equal(events.includes(controlToken), false);
  await stop(proxy, fixture.upstream);
});

test('Codex title no-search question+clock scaffold is local-only and work tools are rejected', async () => {
  const fixture = await startFixture('data: response.completed\n\n', {
    responseHeaders: { 'x-codex-local-handling': 'codex-thread-title', 'x-codex-response-provenance': 'local-auxiliary' },
  });
  const root = tempRoot();
  const marker = 'title-two-child-1234567890';
  const proxy = createRecordingProxy({
    client: 'codex', artifactRoot: root, childToken: marker, controlToken: 'title-two-control-1234567890',
    upstreamHost: '127.0.0.1', upstreamPort: fixture.port, cwd: '/private/tmp/project', launchedAt: Date.now() - 1000,
  });
  const endpoint = await proxy.listen();
  const metadata = codexMeta({ thread: randomUUID(), installation: randomUUID(), session: randomUUID(), source: 'thread_title', model: 'chatgpt-web/high' });
  const schema = {
    type: 'object', additionalProperties: false, required: ['title'],
    properties: { title: { type: 'string', minLength: 1, maxLength: 36 } },
  };
  const body = (tools) => JSON.stringify({
    model: 'chatgpt-web/high', stream: true, instructions: 'Title helper', tool_choice: 'auto',
    text: { format: { type: 'json_schema', name: 'task_title', strict: true, schema } },
    tools, client_metadata: { 'x-codex-turn-metadata': JSON.stringify(metadata) },
    input: [
      { type: 'message', id: 'dev_title', role: 'developer', content: [{ type: 'input_text', text: 'Title developer context' }] },
      { type: 'message', id: 'env_title', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/private/tmp/project</cwd>\n</environment_context>' }] },
      { type: 'message', id: 'prompt_title', role: 'user', content: [{ type: 'input_text', text: 'Generate a concise task title' }] },
    ],
  });
  const questionClock = [
    { type: 'function', name: 'request_user_input_async' },
    { type: 'namespace', name: 'clock', tools: [{ type: 'function', name: 'curr_time' }, { type: 'function', name: 'sleep' }] },
  ];
  const accepted = await fetch(`${endpoint.url}/v1/responses`, {
    method: 'POST', headers: codexHeaders(marker, metadata), body: body(questionClock),
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('x-codex-response-provenance'), 'local-auxiliary');
  await accepted.text();
  assert.equal(proxy.state.codexSessionId, undefined);
  const malformed = await fetch(`${endpoint.url}/v1/responses`, {
    method: 'POST', headers: codexHeaders(marker, metadata), body: body([
      questionClock[0], { type: 'function', name: 'exec_command' },
    ]),
  });
  assert.equal(malformed.status, 403);
  assert.equal(fixture.seen.length, 1);
  await stop(proxy, fixture.upstream);
});

test('Claude native cli UA and user_id session metadata are cross-checked and redacted in captures', async () => {
  const fixture = await startFixture('data: [DONE]\n\n');
  const root = tempRoot();
  const childToken = 'native-cli-child-1234567890';
  const controlToken = 'native-cli-control-1234567890';
  const sessionId = randomUUID();
  const proxy = createRecordingProxy({
    client: 'claude', artifactRoot: root, childToken, controlToken, sessionId,
    minimumClaudeVersion: [2, 1, 285], upstreamHost: '127.0.0.1', upstreamPort: fixture.port,
    cwd: '/private/tmp/project', launchedAt: Date.now() - 1000,
  });
  const endpoint = await proxy.listen();
  const headers = {
    authorization: `Bearer ${childToken}`, 'x-claude-code-session-id': sessionId,
    'user-agent': 'claude-cli/2.1.286 (external, cli)', 'content-type': 'application/json',
  };
  const makeBody = userSession => JSON.stringify({ model: 'claude-chatgpt-web-gpt-6-pro', max_tokens: 16,
    metadata: { user_id: JSON.stringify({ device_id: 'device-not-persisted', account_uuid: 'account-not-persisted', session_id: userSession }) },
    messages: [{ role: 'user', content: 'test' }] });
  const accepted = await fetch(`${endpoint.url}/v1/messages`, { method: 'POST', headers, body: makeBody(sessionId) });
  assert.equal(accepted.status, 200);
  await accepted.text();
  const capture = fs.readFileSync(path.join(root, findArtifact(root, '.request.json')), 'utf8');
  assert.equal(capture.includes('device-not-persisted'), false);
  assert.equal(capture.includes('account-not-persisted'), false);
  const mismatch = await fetch(`${endpoint.url}/v1/messages`, { method: 'POST', headers, body: makeBody(randomUUID()) });
  assert.equal(mismatch.status, 403);
  assert.equal(fixture.seen.length, 1);
  await stop(proxy, fixture.upstream);
});

test('Claude HTTP 200 event:error quota codes latch, while text mentioning 429 does not', async () => {
  const childToken = 'claude-quota-child-1234567890';
  const controlToken = 'claude-quota-control-1234567890';
  const sessionId = randomUUID();
  const fixture = await startFixture(({ seen }) => seen.length === 1
    ? [`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'User text says 429; not an error' } })}\n\n`, 'data: [DONE]\n\n']
    : [`event: error\ndata: ${JSON.stringify({ type: 'error', error: { code: 'verification_limit', message: 'verification limit reached' } })}\n\n`, 'data: [DONE]\n\n']);
  const root = tempRoot();
  const proxy = createRecordingProxy({
    client: 'claude', artifactRoot: root, childToken, controlToken, sessionId,
    minimumClaudeVersion: [2, 1, 285], upstreamHost: '127.0.0.1', upstreamPort: fixture.port,
    cwd: '/private/tmp/project', launchedAt: Date.now() - 1000,
  });
  const latches = []; proxy.on(event => { if (event.type === 'quota_latch') latches.push(event); });
  const endpoint = await proxy.listen();
  const makeRequest = () => fetch(`${endpoint.url}/v1/messages`, {
    method: 'POST', headers: {
      authorization: `Bearer ${childToken}`, 'x-claude-code-session-id': sessionId,
      'user-agent': 'claude-cli/2.1.286 (external, cli)', 'content-type': 'application/json',
    }, body: JSON.stringify({ model: 'claude-chatgpt-web-gpt-6-pro', max_tokens: 16,
      metadata: { user_id: JSON.stringify({ device_id: 'fixture-device-id', account_uuid: 'fixture-account-id', session_id: sessionId }) },
      messages: [{ role: 'user', content: 'test' }] }),
  });
  const first = await makeRequest();
  assert.equal(first.status, 200);
  await first.text();
  assert.equal(latches.length, 0);
  const second = await makeRequest();
  assert.equal(second.status, 200);
  await second.text();
  assert.equal(latches.length, 1);
  assert.equal(latches[0].code, 'verification_limit');
  assert.equal(fixture.seen.length, 2);
  await stop(proxy, fixture.upstream);
});

test('HTTP 429 latches inference and does not spend retry quota', async () => {
  const fixture = await startFixture(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'limit' } }), { status: 429 });
  const root = tempRoot();
  const proxy = createRecordingProxy({
    client: 'codex', artifactRoot: root, childToken: 'quota-child-1234567890', controlToken: 'quota-control-1234567890',
    upstreamHost: '127.0.0.1', upstreamPort: fixture.port, cwd: '/private/tmp/project', launchedAt: Date.now() - 1000,
  });
  const latches = []; proxy.on(event => { if (event.type === 'quota_latch') latches.push(event); });
  const endpoint = await proxy.listen();
  const metadata = codexMeta({ thread: randomUUID(), installation: randomUUID(), session: randomUUID() });
  const request = () => fetch(`${endpoint.url}/v1/responses`, {
    method: 'POST', headers: codexHeaders('quota-child-1234567890', metadata),
    body: JSON.stringify(codexBody(metadata)),
  });
  assert.equal((await request()).status, 429);
  assert.equal((await request()).status, 429);
  assert.equal(fixture.seen.length, 1);
  assert.equal(latches.length, 1);
  assert.equal(latches[0].reason, 'upstream_http_429');
  const latch = fs.readFileSync(path.join(root, 'quota-latch.json'), 'utf8');
  assert.equal(latch.includes('rate_limit_exceeded'), true);
  assert.equal(latch.includes('limit'), true);
  await stop(proxy, fixture.upstream);
});

test('diagnostic mode latches owned upstream 5xx inference errors without latching auxiliary traffic', { timeout: 10000 }, async t => {
  const marker = 'diagnostic-child-1234567890';
  const fixture = await startFixture(JSON.stringify({ error: { code: 'server_error', message: 'upstream 500' } }), { status: 500 });
  const root = tempRoot();
  const proxy = createRecordingProxy({
    client: 'codex', artifactRoot: root, childToken: marker, controlToken: 'diagnostic-control-1234567890',
    diagnostic: true, upstreamHost: '127.0.0.1', upstreamPort: fixture.port, cwd: '/private/tmp/project', launchedAt: Date.now() - 1000,
  });
  t.after(async () => { await stop(proxy, fixture.upstream); });
  const latches = []; proxy.on(event => { if (event.type === 'quota_latch') latches.push(event); });
  const endpoint = await proxy.listen();
  const metadata = codexMeta({ thread: randomUUID(), installation: randomUUID(), session: randomUUID() });
  const body = JSON.stringify(codexBody(metadata));
  const makeRequest = () => fetch(`${endpoint.url}/v1/responses`, { method: 'POST', headers: codexHeaders(marker, metadata), body });
  const first = await makeRequest();
  assert.equal(first.status, 500);
  await first.text();
  assert.equal(latches.length, 1);
  assert.equal(latches[0].reason, 'diagnostic_upstream_http_5xx');
  const second = await makeRequest();
  assert.equal(second.status, 429);
  await second.text();
  assert.equal(fixture.seen.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'quota-latch.json'), 'utf8').includes('upstream 500'), true);
});

test('known response.failed code latches, but user text mentioning 429 does not', async () => {
  assert.equal(QUOTA_CODES.has('rate_limit_exceeded'), true);
  let failed = false;
  const fixture = await startFixture(({ seen }) => seen.length === 1
    ? [`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'User text says 429; not an error' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`, 'data: [DONE]\n\n']
    : [`data: ${JSON.stringify({ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'quota reached' } } })}\n\n`, 'data: [DONE]\n\n'],
  { onRequest: ({ seen }) => { failed = seen.length > 1; } });
  const root = tempRoot();
  const proxy = createRecordingProxy({
    client: 'codex', artifactRoot: root, childToken: 'sse-child-1234567890', controlToken: 'sse-control-1234567890',
    upstreamHost: '127.0.0.1', upstreamPort: fixture.port, cwd: '/private/tmp/project', launchedAt: Date.now() - 1000,
  });
  const latches = []; proxy.on(event => { if (event.type === 'quota_latch') latches.push(event); });
  const endpoint = await proxy.listen();
  const metadata = codexMeta({ thread: randomUUID(), installation: randomUUID(), session: randomUUID() });
  const body = JSON.stringify(codexBody(metadata));
  const first = await fetch(`${endpoint.url}/v1/responses`, { method: 'POST', headers: codexHeaders('sse-child-1234567890', metadata), body });
  assert.equal(first.status, 200);
  await first.arrayBuffer();
  assert.equal(latches.length, 0);
  const second = await fetch(`${endpoint.url}/v1/responses`, { method: 'POST', headers: codexHeaders('sse-child-1234567890', metadata), body });
  assert.equal(second.status, 200);
  await second.arrayBuffer();
  assert.equal(failed, true);
  assert.equal(latches.length, 1);
  assert.equal(latches[0].reason, 'sse_response_failed');
  await stop(proxy, fixture.upstream);
});
