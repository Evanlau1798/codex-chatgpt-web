import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/config";
import { installCodexIntegration, uninstallCodexIntegration } from "../src/codex-integration";
import { responseRequest } from "../src/server";
import { resolveLifecycleExecutable } from "./lifecycle-smoke/paths";

// Real Codex process + production install/HTTP primitives; synthetic adapter, no live account.
const codex = process.argv[2] ?? resolveLifecycleExecutable("codex");
const temporary = resolve(import.meta.dir,"../tmp"); mkdirSync(temporary,{recursive:true});
const root = mkdtempSync(join(temporary,"web-provider-smoke-"));
process.env.CODEX_HOME = join(root,"codex");
process.env.CODEX_CHATGPT_WEB_HOME = join(root,"bridge");
mkdirSync(process.env.CODEX_HOME);
const config = defaultConfig("browser-only");
const bundled = Bun.spawnSync([codex,"debug","models","--bundled"],{timeout:15_000});
assert.equal(bundled.exitCode,0,"Bundled native model catalog unavailable");
writeFileSync(join(process.env.CODEX_HOME,"models_cache.json"),bundled.stdout);
writeFileSync(join(process.env.CODEX_HOME,"auth.json"),JSON.stringify({OPENAI_API_KEY:"synthetic-unused-native-key"}));
const original = 'cli_auth_credentials_store = "file"\nmodel = "gpt-5.6-sol"\n';
const configPath = join(process.env.CODEX_HOME,"config.toml"); writeFileSync(configPath,original);
let requests = 0, credentialsSent = false, nativeRequests = 0;
const server = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req) {
  if (new URL(req.url).pathname !== "/v1/responses") { nativeRequests++; return new Response("Unexpected route",{status:400}); }
  requests++; credentialsSent ||= req.headers.has("authorization");
  return responseRequest(req,config,()=>({name:"web-provider-fixture",async runTurn(_p,_s,emit) {
    emit({type:"text_delta",text:"WEB_PROVIDER_COMPLETED",phase:"final_answer"});
    emit({type:"done",stopReason:"stop",endTurn:true});
  }}));
}});
config.port = server.port!;
installCodexIntegration(config,{providerMode:"web-only"});
const selected = Bun.TOML.parse(readFileSync(configPath,"utf8")) as {model:string};
const env = {...process.env}; delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
const child = Bun.spawn([codex,"app-server","--listen","stdio://"],{cwd:root,env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
type Rpc = {id?:number;method?:string;params?:any;result?:any;error?:unknown};
const messages: Rpc[] = [], pending = new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
let id = 0;
const output = (async()=>{let buffer="";const decoder=new TextDecoder();for await(const chunk of child.stdout){
  buffer+=decoder.decode(chunk,{stream:true});let end:number;
  while((end=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
    const message=JSON.parse(line) as Rpc;messages.push(message);
    if(message.id!==undefined){const p=pending.get(message.id);if(message.error)p?.reject(new Error("RPC failed: "+JSON.stringify(message.error)));else p?.resolve(message.result);}
  }
}})();
const stderr = new Response(child.stderr).text();
async function rpc(method:string,params:unknown):Promise<any>{
  const key=++id;let timer:Timer;
  const result=new Promise((resolve,reject)=>{pending.set(key,{resolve,reject});timer=setTimeout(()=>reject(new Error(`RPC timed out: ${method}`)),30_000);});
  child.stdin.write(JSON.stringify({id:key,method,params})+"\n");await child.stdin.flush();
  try{return await result;}finally{clearTimeout(timer!);pending.delete(key);}
}
try {
  await rpc("initialize",{clientInfo:{name:"web_provider_smoke",version:"1"},capabilities:{experimentalApi:true}});
  child.stdin.write('{"method":"initialized"}\n');
  const account=await rpc("account/read",{refreshToken:false});
  assert.equal(account.requiresOpenaiAuth,false); assert.equal(account.account,null);
  const auth=await rpc("getAuthStatus",{includeToken:true,refreshToken:false});
  assert.equal(auth.authMethod,null); assert.equal(auth.authToken,null);
  const models=await rpc("model/list",{includeHidden:true});
  assert(models.data.length>0); assert(models.data.every((m:{model:string})=>m.model.startsWith("chatgpt-web/")));
  const {thread}=await rpc("thread/start",{cwd:root,model:selected.model,approvalPolicy:"never",sandbox:"read-only"});
  const {turn}=await rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Reply with the verification sentinel."}]});
  const deadline=Date.now()+30_000;
  while(!messages.some(m=>m.method==="turn/completed"&&m.params?.turn?.id===turn.id)&&Date.now()<deadline) await Bun.sleep(25);
  const completed=messages.find(m=>m.method==="turn/completed"&&m.params?.turn?.id===turn.id);
  assert.equal(completed?.params.turn.status,"completed",JSON.stringify(messages.filter(m=>m.method==="error")));
  assert(messages.some(m=>m.method==="item/completed"&&m.params?.item?.text==="WEB_PROVIDER_COMPLETED"));
  assert.equal(requests,1); assert.equal(nativeRequests,0); assert.equal(credentialsSent,false);
  console.log("CODEX_WEB_PROVIDER_ACCOUNT_MODELS_AND_TURN_OK");
} finally {
  child.stdin.end(); const timer=setTimeout(()=>child.kill(),5_000); await child.exited; clearTimeout(timer);
  await output; await stderr; await server.stop(true);
  uninstallCodexIntegration(); assert.equal(readFileSync(configPath,"utf8"),original);
  rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
