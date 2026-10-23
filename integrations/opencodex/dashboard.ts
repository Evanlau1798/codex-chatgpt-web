import { readFileSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { Transport } from './gateway';
const HOP_HEADERS = ['host','connection','content-length','transfer-encoding','content-encoding'];
type SocketData = { upstream: WebSocket; queue: Array<string | Buffer>; bytes: number };
const BunWebSocket = WebSocket as unknown as { new(url:string,options:Bun.WebSocketOptions):WebSocket };
export function startDashboard(root: string, fetchOriginal: Transport) {
  const settings = () => JSON.parse(readFileSync(resolve(root,'settings.json'),'utf8'));
  const target = (path: string) => new URL(path, `http://127.0.0.1:${settings().port}`);
  const forward = (req: Request, path?: string) => {
    const url = new URL(req.url); const headers = new Headers(req.headers);
    // Preserve the public Host for OpenCodex's own Origin/GUI session authority.
    for(const name of ['connection','content-length','transfer-encoding']) headers.delete(name);
    return fetchOriginal(new Request(target(path ?? url.pathname+url.search), {
      method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:req.body,
      signal:req.signal,redirect:'manual',
    }));
  };
  const manager = require(resolve(root,'manager.cjs'));
  const server = Bun.serve<SocketData>({
    hostname:'127.0.0.1',port:settings().dashboardPort,idleTimeout:255,maxRequestBodySize:512*1024*1024,
    async fetch(req, server) {
      const url=new URL(req.url);
      if(url.pathname==='/api/config'&&req.method==='PUT'){
        let candidate;try{candidate=await req.clone().json() as any;}catch{return Response.json({error:'invalid JSON body'},{status:400});}
        if((candidate.runtimeRole!==undefined&&candidate.runtimeRole!=='hub')||candidate.unauthenticatedLoopbackListener?.enabled===true||candidate.clientIntegrations?.codex===true||candidate.client!==undefined){
          return Response.json({error:'Codex Web GPT owns the Codex connection. This internal OpenCodex service must remain in hub mode.'},{status:409});
        }
      }
      if(req.method==='PUT'&&['/api/native-integrations/codex','/api/client-integrations/codex'].includes(url.pathname))return Response.json({error:'Codex integration is managed by Codex Web GPT. OpenCodex model changes are picked up through its model catalog.'},{status:409});
      if(req.headers.get('upgrade')?.toLowerCase()==='websocket'){
        const headers=new Headers(req.headers);
        for(const name of ['connection','upgrade','sec-websocket-key','sec-websocket-version','sec-websocket-extensions','sec-websocket-protocol'])headers.delete(name);
        const protocols=req.headers.get('sec-websocket-protocol')?.split(',').map(v=>v.trim());
        const upstream=new BunWebSocket(target(url.pathname+url.search).href.replace(/^http:/,'ws:'),{headers:Object.fromEntries(headers),...(protocols?{protocols}:{})});
        if(server.upgrade(req,{data:{upstream,queue:[],bytes:0}}))return;
        upstream.close();return new Response('WebSocket upgrade failed',{status:426});
      }
      // Versioned package updates are owned by this supervisor. Authorize against
      // the official management pipeline, including its CSRF/Origin checks.
      if(['/api/update/check','/api/update/run','/api/update/status'].includes(url.pathname)){
        const probe=new Request(req.clone(),{method:req.method});
        const authority=await forward(probe,'/api/__gateway_update_authority__');
        if(authority.status!==404)return authority;
        if(url.pathname==='/api/update/check'&&req.method==='GET'){
          try{return Response.json(await manager.check(url.searchParams.get('tag')||'latest'));}catch{return Response.json({error:'Official update metadata unavailable'},{status:502});}
        }
        if(url.pathname==='/api/update/status'&&req.method==='GET'){
          try{const job=JSON.parse(readFileSync(resolve(root,'update-job.json'),'utf8'));if(url.searchParams.get('jobId')!==job.id)return Response.json({error:'update job not found'},{status:404});return Response.json({ok:true,job});}catch{return Response.json({error:'update job not found'},{status:404});}
        }
        if(url.pathname==='/api/update/run'&&req.method==='POST'){
          let body;try{body=await req.json() as {tag?:string;restart?:boolean};}catch{return Response.json({error:'invalid JSON body'},{status:400});}
          if((body.tag!==undefined&&!['latest','preview'].includes(body.tag))||(body.restart!==undefined&&typeof body.restart!=='boolean'))return Response.json({error:'Invalid update options'},{status:400});
          try{const current=JSON.parse(readFileSync(resolve(root,'update-job.json'),'utf8'));if(['running','restarting'].includes(current.status)){try{process.kill(current.pid,0);return Response.json({error:'Update in progress'},{status:409});}catch{}}}catch{}
          const id=crypto.randomUUID(),now=new Date().toISOString();
          const job={id,status:'running',startedAt:now,updatedAt:now,currentVersion:settings().version,latestVersion:null,channel:body.tag||'latest',installer:'npm',restart:body.restart!==false,command:'gateway-managed update',releaseNotesUrl:'https://github.com/lidge-jun/opencodex/releases/latest',log:['Starting compatibility checks']};
          const log=openSync(resolve(root,'logs/update.log'),'a');
          const child=spawn(settings().bun,[resolve(root,'manager.cjs'),'update',body.tag||'latest',id,...(body.restart===false?['--stage-only']:[])],{windowsHide:true,stdio:['ignore',log,log]});
          closeSync(log);
          child.on('error',()=>console.error('[opencodex] Update process could not start'));
          return Response.json({ok:true,job:{...job,pid:child.pid}});
        }
        return new Response('Method not allowed',{status:405});
      }
      const response=await forward(req);
      const headers=new Headers(response.headers);
      for(const name of HOP_HEADERS)headers.delete(name);
      return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
    },
    websocket:{
      open(socket){
        const upstream=socket.data.upstream;
        upstream.binaryType='arraybuffer';
        upstream.onopen=()=>{for(const message of socket.data.queue)upstream.send(message);socket.data.queue=[];socket.data.bytes=0;};
        upstream.onmessage=event=>{if(socket.send(typeof event.data==='string'?event.data:new Uint8Array(event.data as ArrayBuffer))===0){upstream.close(1011,'Backpressure');socket.close(1011,'Backpressure');}};
        upstream.onclose=event=>socket.close(event.code===1006?1011:event.code,event.reason);
        upstream.onerror=()=>socket.close(1011,'Upstream unavailable');
      },
      message(socket,message){if(socket.data.upstream.readyState===WebSocket.OPEN)socket.data.upstream.send(message);else{socket.data.bytes+=typeof message==='string'?Buffer.byteLength(message):message.byteLength;if(socket.data.bytes>1024*1024){socket.close(1009,'Queue limit');return;}socket.data.queue.push(message);}},
      close(socket){socket.data.upstream.close();},
      maxPayloadLength:16*1024*1024,backpressureLimit:1024*1024,
    },
  });
  return server;
}
