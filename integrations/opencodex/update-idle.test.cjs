const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {waitForIdleDrain}=require('./manager.cjs');

const idle={status:'ok',acquired:true,accepting_turns:false,active_http_turns:0,active_browser_turns:0};
const busy={status:'busy',acquired:false,accepting_turns:true,active_http_turns:1,active_browser_turns:1};

test('busy tasks and another maintenance owner are left alone until atomic idle acquisition',async()=>{
 const responses=[busy,{status:'draining',acquired:false,accepting_turns:false},busy,idle];
 const calls=[];let clock=0,notifications=0;
 const result=await waitForIdleDrain({
  request:async action=>{calls.push(action);return responses.shift();},
  pause:async ms=>{clock+=ms;},now:()=>clock,intervalMs:10,timeoutMs:100,
  onWaiting:()=>{notifications++;},
 });
 assert.equal(result,idle);
 assert.deepEqual(calls,Array(4).fill('drain-if-idle'));
 assert.equal(notifications,1);
 assert.equal(clock,30);
});

test('an already idle service is acquired without delay or a waiting notification',async()=>{
 assert.equal(await waitForIdleDrain({request:async()=>idle,pause:()=>assert.fail('unexpected wait'),onWaiting:()=>assert.fail('unexpected notification')}),idle);
});

test('timeout does not acquire maintenance after the deadline or resume a busy service',async()=>{
 let clock=0,calls=0;const pauses=[];
 await assert.rejects(waitForIdleDrain({
  request:async action=>{assert.equal(action,'drain-if-idle');calls++;return busy;},
  now:()=>clock,timeoutMs:25,intervalMs:10,pause:async ms=>{pauses.push(ms);clock+=ms;},
 }),/remained busy.*candidate is staged/);
 assert.equal(calls,3);
 assert.deepEqual(pauses,[10,10,5]);
});

test('authentication and network failures stop immediately without forcing or resuming maintenance',async()=>{
 const error=new Error('Codex Web GPT maintenance refused: 401');
 await assert.rejects(waitForIdleDrain({request:async action=>{assert.equal(action,'drain-if-idle');throw error;},pause:()=>assert.fail('unexpected retry')}),e=>e===error);
});

test('malformed maintenance responses cannot authorize a backend restart',async()=>{
 for(const response of [null,{}, {status:'ok',acquired:false,accepting_turns:false}, {status:'busy',acquired:false,accepting_turns:false}]){
  await assert.rejects(waitForIdleDrain({request:async()=>response,pause:()=>assert.fail('unexpected retry')}),/Unexpected.*response/);
 }
});

function updateFixture(t,{stageOnly=false,failRestart=false,nativeConfig=true,touchConfig}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-idle-update-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
 const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
 const settingsFile=path.join(root,'settings.json');
 const pendingFile=path.join(root,'pending-update.json');
 const jobFile=path.join(root,'update-job.json');
 const packageRoot=path.join(root,'packages','2.81.0','node_modules','@bitkyc08','opencodex');
 const integrity='sha512-dGVzdA==';
 const before={version:'2.80.0',port:10110,home:path.join(root,'home'),coreHome:path.join(root,'core'),codexHome:path.join(root,'codex'),packageRoot:path.join(root,'old-package'),bun:'mock-bun',clientVersion:'test'};
 write(settingsFile,before);
 write(path.join(before.coreHome,'config.json'),{host:'127.0.0.1',port:17841,controlToken:'test-control-token'});
 const providerConfig={runtimeRole:'hub',hostname:'127.0.0.1',clientIntegrations:{codex:false},providers:{preserved:{adapter:'test-provider'}}};
 write(path.join(before.home,'config.json'),providerConfig);
 fs.writeFileSync(path.join(before.home,'admin-api-token'),'test-admin-token');
 fs.mkdirSync(before.codexHome);if(nativeConfig)fs.writeFileSync(path.join(before.codexHome,'config.toml'),'model="unchanged"');
 write(path.join(packageRoot,'package.json'),{name:'@bitkyc08/opencodex',version:'2.81.0'});
 write(path.join(root,'packages','2.81.0','package-lock.json'),{packages:{'node_modules/@bitkyc08/opencodex':{integrity}}});
 for(const file of ['src/index.ts','src/lib/system-restart-contract.ts','gui/dist/index.html']){const target=path.join(packageRoot,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'fixture');}
 let probeCalls=0,restartCalls=0,resumeCalls=0,backendPid=601;const spawnCalls=[];
 const fakeFetch=async(input,options={})=>{
  const url=new URL(input);
  if(url.hostname==='registry.npmjs.org')return Response.json({name:'@bitkyc08/opencodex',version:'2.81.0',dist:{integrity,tarball:'https://registry.npmjs.org/package.tgz'}});
  if(url.port==='10121'){
   if(url.pathname==='/healthz')return Response.json({service:'opencodex',pid:501,version:'2.81.0'});
   if(url.pathname==='/v1/models'){
    if(touchConfig){
     const target=touchConfig==='native'?before.codexHome:spawnCalls[0].codexHome;
     fs.writeFileSync(path.join(target,'config.toml'),'model="unexpected"');
    }
    return Response.json({models:[{slug:'model',supported_reasoning_levels:[],tool_mode:'native'}]});
   }
   if(url.pathname==='/')return new Response('<html>Official dashboard fixture</html>');
  }
  if(url.pathname==='/admin/drain-if-idle'){
   assert.equal(stageOnly,false);assert.deepEqual(read(settingsFile),before);
   assert.equal(read(pendingFile).version,'2.81.0');
   assert.equal(restartCalls,0);
   probeCalls++;
   if(probeCalls===1)return Response.json(busy);
   const job=read(jobFile);assert.equal(job.status,'running');assert.equal(job.waitingForIdle,true);assert.equal(job.error,undefined);
   return Response.json(idle);
  }
  if(url.port==='10110'&&url.pathname==='/healthz')return Response.json({service:'opencodex',pid:backendPid,version:backendPid===601?'2.80.0':read(settingsFile).version});
  if(url.pathname==='/api/system/restart'){
   assert.equal(probeCalls,2);restartCalls++;
   assert.equal(options.method,'POST');
   if(failRestart&&restartCalls===1){write(path.join(before.home,'config.json'),{migrated:true});return new Response('refused',{status:503});}
   backendPid++;return Response.json({ok:true});
  }
  if(url.pathname==='/admin/resume'){resumeCalls++;return Response.json({accepting_turns:true});}
  throw Error('Unexpected request '+url.pathname);
 };
 const mockSpawn=(command,args,options)=>{
  spawnCalls.push({args,codexHome:options.env.CODEX_HOME});assert.equal(path.basename(args[0]),'backend.ts');assert.equal(args[1],packageRoot);
  const child=new EventEmitter();child.pid=501;child.kill=()=>queueMicrotask(()=>child.emit('exit',0));return child;
 };
 const exports={};
 const context={require:name=>name==='node:child_process'?{spawn:mockSpawn}:require(name),module:{exports},__dirname:root,__filename:path.join(root,'manager.cjs'),process,Buffer,URL,fetch:fakeFetch,AbortSignal,console,
  // Virtualize delays; requests and filesystem effects still run in their real order.
  setTimeout:(callback)=>{queueMicrotask(callback);return 1;},
 };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'manager.cjs'),'utf8'),context);
 return {run:()=>context.module.exports.update('latest',!stageOnly,'fixture-job'),root,read,before,settingsFile,pendingFile,jobFile,providerConfig,counts:()=>({probeCalls,restartCalls,resumeCalls,spawns:spawnCalls.length})};
}

test('update stages while busy, preserves providers, restarts only the backend after idle, then resumes',async t=>{
 const f=updateFixture(t);const job=await f.run();
 assert.equal(job.status,'succeeded');assert.equal(job.waitingForIdle,false);assert.equal(job.restarted,true);
 assert.equal(f.read(f.settingsFile).version,'2.81.0');
 assert.deepEqual(f.read(path.join(f.before.home,'config.json')),f.providerConfig);
 assert.equal(fs.readFileSync(path.join(f.before.codexHome,'config.toml'),'utf8'),'model="unchanged"');
 assert.equal(fs.existsSync(f.pendingFile),false);assert.equal(fs.existsSync(path.join(f.root,'update.lock')),false);
 assert.deepEqual(f.counts(),{probeCalls:2,restartCalls:1,resumeCalls:1,spawns:1});
});

test('stage-only validates and persists a candidate without acquiring maintenance or restarting',async t=>{
 const f=updateFixture(t,{stageOnly:true});const job=await f.run();
 assert.equal(job.status,'succeeded');assert.deepEqual(f.read(f.settingsFile),f.before);
 assert.equal(f.read(f.pendingFile).version,'2.81.0');
 assert.deepEqual(f.counts(),{probeCalls:0,restartCalls:0,resumeCalls:0,spawns:1});
});

test('candidate validation accepts a fresh native profile without creating its config',async t=>{
 const f=updateFixture(t,{stageOnly:true,nativeConfig:false});const job=await f.run();
 assert.equal(job.status,'succeeded');
 assert.equal(fs.existsSync(path.join(f.before.codexHome,'config.toml')),false);
 assert.deepEqual(f.read(f.settingsFile),f.before);
 assert.equal(f.read(f.pendingFile).version,'2.81.0');
 assert.deepEqual(f.counts(),{probeCalls:0,restartCalls:0,resumeCalls:0,spawns:1});
});

for(const [name,nativeConfig,touchConfig] of [['creates a missing native config',false,'native'],['changes an existing native config',true,'native'],['creates an isolated native config',false,'isolated']]){
 test('candidate is rejected before maintenance when it '+name,async t=>{
  const f=updateFixture(t,{stageOnly:true,nativeConfig,touchConfig});
  await assert.rejects(f.run(),/Candidate touched native Codex configuration/);
  assert.deepEqual(f.read(f.settingsFile),f.before);
  assert.equal(fs.existsSync(f.pendingFile),false);
  assert.deepEqual(f.counts(),{probeCalls:0,restartCalls:0,resumeCalls:0,spawns:1});
 });
}

test('a rejected restart restores the old version and providers, retains the candidate, and resumes',async t=>{
 const f=updateFixture(t,{failRestart:true});await assert.rejects(f.run(),/restart refused: 503/);
 assert.deepEqual(f.read(f.settingsFile),f.before);
 assert.deepEqual(f.read(path.join(f.before.home,'config.json')),f.providerConfig);
 assert.equal(f.read(f.pendingFile).version,'2.81.0');assert.equal(f.read(f.jobFile).status,'failed');
 assert.deepEqual(f.counts(),{probeCalls:2,restartCalls:2,resumeCalls:1,spawns:1});
});
