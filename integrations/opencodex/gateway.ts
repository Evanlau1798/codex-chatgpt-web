/** Process-local outbound transport for the official Codex Web GPT runtime. */
export const CODEX_ORIGIN = 'https://chatgpt.com';
export const CODEX_PREFIX = '/backend-api/codex/';
export type Transport = (input: RequestInfo | URL, init?: RequestInit & { proxy?: string }) => Promise<Response>;

export function createGateway(fetchOriginal: Transport, options: { endpoint: string; key: string; clientVersion: string; proxyResolver?: string }): Transport {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('OpenCodex must use a private loopback endpoint');
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if(options.proxyResolver && url.href===options.proxyResolver){
      const probe=new Request(input,init);
      if(probe.method==='POST'){
        try{
          const payload=await probe.clone().json() as {url?:string};
          const destination=new URL(payload.url||'');
          if(destination.origin===CODEX_ORIGIN&&destination.pathname.startsWith(CODEX_PREFIX)){
            probe.signal.throwIfAborted();
            // The outgoing request will be sent to loopback, so the remote
            // ChatGPT PAC route must not apply to the internal OpenCodex hop.
            return Response.json({proxy:'DIRECT'});
          }
        }catch(error){if(probe.signal.aborted)throw error;}
      }
    }
    // Exact origin and path, never arbitrary browser/control/provider requests.
    if (url.origin !== CODEX_ORIGIN || !url.pathname.startsWith(CODEX_PREFIX)) return fetchOriginal(input, init);
    const request = new Request(input, init);
    const path = url.pathname.slice(CODEX_PREFIX.length);
    const target = new URL('/v1/' + path, endpoint);
    target.search = url.search;
    if (path === 'models' && !target.searchParams.has('client_version')) target.searchParams.set('client_version', options.clientVersion);
    const headers = new Headers(request.headers);
    for (const name of ['host', 'connection', 'proxy-authorization', 'x-opencodex-api-key', 'content-length']) headers.delete(name);
    // Separate admission from the original Codex OAuth bearer. OpenCodex's official
    // forwarding/pool logic selects upstream credentials; this key never replaces OAuth.
    headers.set('x-opencodex-api-key', options.key);
    return fetchOriginal(new Request(target, {
      method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      signal: request.signal, redirect: 'error',
    }));
  };
}
