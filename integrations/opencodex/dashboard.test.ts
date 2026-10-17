import { test,expect } from 'bun:test';
import { mkdtempSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboard } from './dashboard';
test('official WebSocket features keep authentication, messages, and closure through the dashboard gateway',async()=>{
 const root=mkdtempSync(join(tmpdir(),'opencodex-gateway-test-'));
 writeFileSync(join(root,'manager.cjs'),'module.exports={};');
 let incomingAuthorization:string|null=null,closed=false;
 const backend=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req,s){incomingAuthorization=req.headers.get('authorization');if(incomingAuthorization!=='Bearer ws-fixture')return new Response('unauthorized',{status:401});if(s.upgrade(req))return;return new Response('no websocket',{status:426});},websocket:{message(socket,value){socket.send(value);},close(){closed=true;}}});
 writeFileSync(join(root,'settings.json'),JSON.stringify({port:backend.port,dashboardPort:0}));
 const dashboard=startDashboard(root,fetch);
 const BunSocket=WebSocket as unknown as {new(url:string,options:Bun.WebSocketOptions):WebSocket};
 const socket=new BunSocket(`ws://127.0.0.1:${dashboard.port}/v1/responses`,{headers:{authorization:'Bearer ws-fixture'}});
 try{
  const result=await new Promise<string>((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(Error('WebSocket relay timeout')),4000);
   socket.onopen=()=>socket.send('tool-event');
   socket.onmessage=event=>{clearTimeout(timeout);resolve(String(event.data));};
   socket.onerror=()=>{clearTimeout(timeout);reject(Error('WebSocket relay failed'));};
  });
  expect(result).toBe('tool-event');expect(incomingAuthorization).toBe('Bearer ws-fixture');
  socket.close();await Bun.sleep(100);expect(closed).toBe(true);
 }finally{socket.close();await dashboard.stop(true);await backend.stop(true);}
});
