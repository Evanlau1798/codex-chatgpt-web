import { describe, test, expect } from 'bun:test';
import { createGateway } from './gateway';
const options = { endpoint: 'http://127.0.0.1:10100', key: 'private-admission', clientVersion: '0.162.0' };
describe('Codex Web GPT / OpenCodex transport contract', () => {
  test('internal rerouting does not inherit a remote ChatGPT PAC/SOCKS route',async()=>{
    let networkCalls=0;const transport=createGateway(async()=>{networkCalls++;return Response.json({proxy:'SOCKS5 proxy:1080'});},{...options,proxyResolver:'http://127.0.0.1:4444/v1/network/resolve-proxy'});
    const response=await transport('http://127.0.0.1:4444/v1/network/resolve-proxy',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://chatgpt.com/backend-api/codex/responses'})});
    expect(await response.json()).toEqual({proxy:'DIRECT'});expect(networkCalls).toBe(0);
  });
  test('browser proxy policy remains untouched for actual browser requests',async()=>{
    let networkCalls=0;const transport=createGateway(async()=>{networkCalls++;return Response.json({proxy:'SOCKS5 proxy:1080'});},{...options,proxyResolver:'http://127.0.0.1:4444/v1/network/resolve-proxy'});
    const response=await transport('http://127.0.0.1:4444/v1/network/resolve-proxy',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://chatgpt.com/backend-api/conversation'})});
    expect(await response.json()).toEqual({proxy:'SOCKS5 proxy:1080'});expect(networkCalls).toBe(1);
  });
  test('preserves browser, native-tool control and unrelated upstream requests exactly', async () => {
    const seen: unknown[][] = [];
    const transport = createGateway(async (...args) => { seen.push(args); return new Response('ok'); }, options);
    for (const url of ['https://chatgpt.com/backend-api/conversation', 'https://chatgpt.com/backend-api/codexish/models', 'https://evil.test/backend-api/codex/responses', 'http://127.0.0.1:17841/mcp', 'https://api.anthropic.com/v1/messages']) {
      const init = { headers: { authorization: 'original' } };
      await transport(url, init);
      expect(seen.at(-1)).toEqual([url, init]);
    }
  });
  test('catalog keeps the Codex catalog selector and query', async () => {
    let sent!: Request;
    const transport = createGateway(async input => { sent = input as Request; return new Response('{"models":[]}'); }, options);
    await transport(new Request('https://chatgpt.com/backend-api/codex/models?client_version=0.155.1&extra=1'));
    expect(sent.url).toBe('http://127.0.0.1:10100/v1/models?client_version=0.155.1&extra=1');
    await transport('https://chatgpt.com/backend-api/codex/models');
    expect(new URL(sent.url).searchParams.get('client_version')).toBe('0.162.0');
  });
  test.each(['responses', 'responses/compact', 'alpha/search', 'images/generations', 'images/edits'])('%s preserves payload, reasoning, identities, and original OAuth separately from admission', async path => {
    let sent!: Request;
    const controller = new AbortController();
    const transport = createGateway(async input => { sent = input as Request; return new Response('ok'); }, options);
    const body = JSON.stringify({ model: 'anthropic/claude-opus-5', reasoning: { effort: 'medium' }, tools: [{ type: 'function', name: 'exec' }], input: [{ type: 'function_call_output', call_id: 'call_1', output: 'ok' }] });
    await transport(new Request('https://chatgpt.com/backend-api/codex/' + path, {
      method: 'POST', headers: { authorization: 'Bearer native-oauth', 'chatgpt-account-id': 'account', 'session-id': 'thread', 'content-type': 'application/json', 'x-opencodex-api-key': 'caller-key' }, body, signal: controller.signal,
    }), { proxy: 'http://irrelevant-proxy:1234' });
    expect(sent.url).toBe('http://127.0.0.1:10100/v1/' + path);
    expect(await sent.text()).toBe(body);
    expect(sent.headers.get('authorization')).toBe('Bearer native-oauth');
    expect(sent.headers.get('x-opencodex-api-key')).toBe('private-admission');
    expect(sent.headers.get('session-id')).toBe('thread');
    controller.abort(); expect(sent.signal.aborted).toBe(true);
  });
  test('SSE and tool calls are forwarded without buffering or rewriting', async () => {
    let released = false;
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: response.output_item.added\ndata: {"type":"function_call","call_id":"call_1"}\n\n')); }, cancel() { released = true; } });
    const original = new Response(stream, { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req1' } });
    const transport = createGateway(async () => original, options);
    const result = await transport('https://chatgpt.com/backend-api/codex/responses');
    expect(result).toBe(original); expect(result.headers.get('x-request-id')).toBe('req1');
    const reader = result.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('function_call');
    await reader.cancel(); expect(released).toBe(true);
  });
  test.each(['https://127.0.0.1:10100', 'http://example.com:10100', 'http://user:password@127.0.0.1:10100', 'http://127.0.0.1:10100/v1'])('refuses unsafe endpoint %s', endpoint => {
    expect(() => createGateway(fetch, { ...options, endpoint })).toThrow();
  });
});
