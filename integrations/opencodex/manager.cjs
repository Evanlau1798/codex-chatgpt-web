const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const ROOT=__dirname, SETTINGS=path.join(ROOT,'settings.json'), PACKAGE='@bitkyc08/opencodex';
const json=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const digest=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function rename(source,target){const delays=[25,50,100,150,250,350,500];for(let attempt=0;;attempt++){try{fs.renameSync(source,target);return;}catch(error){if(process.platform!=='win32'||!['EBUSY','EPERM','EACCES'].includes(error.code)||delays[attempt]===undefined)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,delays[attempt]);}}}
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true}); const next=file+'.next-'+crypto.randomUUID();const fd=fs.openSync(next,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}rename(next,file);}
function acquireUpdateLock(file){
 try{return fs.openSync(file,'wx');}catch(error){
  if(error.code!=='EEXIST')throw error;
  const bytes=fs.readFileSync(file,'utf8');let owner;
  try{owner=JSON.parse(bytes);}catch{if(bytes.trim()||Date.now()-fs.statSync(file).mtimeMs<300000)throw Error('An update lock needs time to settle');}
  if(owner){if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw Error('Invalid update lock owner');try{process.kill(owner.pid,0);throw Error('Another OpenCodex update is in progress');}catch(error){if(error.code!=='ESRCH')throw error;}}
  if(fs.readFileSync(file,'utf8')!==bytes)throw Error('Update lock owner changed');
  fs.unlinkSync(file);return fs.openSync(file,'wx');
 }
}
function owned(file){const p=path.resolve(file);if(!p.startsWith(path.resolve(ROOT)+path.sep))throw Error('Integration path outside managed home');return p;}
function assertOwnership(config){if(config.runtimeRole!=='hub'||config.hostname!=='127.0.0.1'||config.unauthenticatedLoopbackListener?.enabled===true||config.clientIntegrations?.codex!==false)throw Error('OpenCodex native configuration ownership is incompatible with the gateway');}
async function registry(channel='latest'){
 if(!['latest','preview'].includes(channel))throw Error('Unsupported update channel');
 const response=await fetch('https://registry.npmjs.org/@bitkyc08%2fopencodex/'+channel,{signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error('Official npm registry unavailable');
 const data=await response.json();
 if(data.name!==PACKAGE||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(data.version)||!/^sha512-[A-Za-z0-9+/]+=*$/.test(data.dist?.integrity||'')||new URL(data.dist.tarball).origin!=='https://registry.npmjs.org')throw Error('Invalid official npm package metadata');
 return data;
}
async function check(channel='latest'){
 const current=json(SETTINGS),next=await registry(channel);
 return {currentVersion:current.version,latestVersion:next.version,channel,installer:'npm',updateAvailable:current.version!==next.version,canUpdate:true,command:'Codex Web GPT — Mettre à jour OpenCodex',releaseNotesUrl:'https://github.com/lidge-jun/opencodex/releases/latest'};
}
async function run(command,args,options={}){
 return new Promise((resolve,reject)=>{let stderr='';const p=spawn(command,args,{windowsHide:true,stdio:['ignore','ignore','pipe'],...options});p.stderr?.on('data',b=>{stderr=(stderr+b).slice(-3000);});p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(Error('Package command failed ('+code+'): '+stderr.replace(/Bearer\s+[^\s]+/g,'Bearer [redacted]'))));});
}
async function installPackage(metadata){
 const settings=json(SETTINGS),prefix=owned(path.join(ROOT,'packages',metadata.version));
 const packageRoot=path.join(prefix,'node_modules/@bitkyc08/opencodex');
 if(!fs.existsSync(path.join(packageRoot,'package.json')))await run(settings.node,[settings.npmCli,'install','--prefix',prefix,'--no-audit','--no-fund','--ignore-scripts',PACKAGE+'@'+metadata.version]);
 const lock=json(path.join(prefix,'package-lock.json'));
 if(lock.packages['node_modules/'+PACKAGE]?.integrity!==metadata.dist.integrity||json(path.join(packageRoot,'package.json')).version!==metadata.version)throw Error('Installed package differs from the registry integrity/version');
 for(const name of ['src/index.ts','src/lib/system-restart-contract.ts','gui/dist/index.html'])if(!fs.existsSync(path.join(packageRoot,name)))throw Error('Required OpenCodex entry point is missing: '+name);
 return packageRoot;
}
async function waitHealth(endpoint,predicate,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){try{const r=await fetch(endpoint+'/healthz',{signal:AbortSignal.timeout(1500)});const h=await r.json();if(r.ok&&predicate(h))return h;}catch{}await delay(400);}throw Error('Runtime health contract timed out');}
async function validatePackage(packageRoot){
 const settings=json(SETTINGS),job=owned(path.join(ROOT,'checks',crypto.randomUUID())),home=path.join(job,'home'),codex=path.join(job,'codex');
 fs.mkdirSync(home,{recursive:true});fs.mkdirSync(codex,{recursive:true});
 const current=json(path.join(settings.home,'config.json'));assertOwnership(current);
 // No live credential or account is used by the candidate acceptance run.
 const port=10121;
 atomic(path.join(home,'config.json'),{...current,port,providers:{openai:{adapter:'openai-responses',baseUrl:'https://chatgpt.com/backend-api/codex',authMode:'forward',codexAccountMode:'pool'}},defaultProvider:'openai',combos:{},subagentModels:[],claudeCode:{enabled:false},clientIntegrations:{codex:false,claudeCode:false,claudeDesktop:false,grok:false},hub:undefined,apiKeys:undefined});
 const cfgHash=digest(path.join(settings.codexHome,'config.toml'));
 const log=fs.openSync(path.join(job,'backend.log'),'a');
 const child=spawn(settings.bun,[path.join(ROOT,'backend.ts'),packageRoot],{env:{...process.env,OPENCODEX_HOME:home,CODEX_HOME:codex,OPENCODEX_API_AUTH_TOKEN:'isolated-acceptance-key',OCX_DESKTOP_SUPERVISED:'1',OPENCODEX_GATEWAY_OWNER_PID:String(process.pid),OPENCODEX_GATEWAY_PORT:String(port)},windowsHide:true,stdio:['ignore',log,log]});
 try{
  const version=json(path.join(packageRoot,'package.json')).version;
  const h=await waitHealth('http://127.0.0.1:'+port,h=>h.pid===child.pid&&h.service==='opencodex'&&h.version===version);
  const headers={'x-opencodex-api-key':'isolated-acceptance-key'};
  const r=await fetch('http://127.0.0.1:'+port+'/v1/models?client_version='+settings.clientVersion,{headers,signal:AbortSignal.timeout(45000)});
  const catalog=await r.json();
  if(!r.ok||!Array.isArray(catalog.models)||!catalog.models.some(m=>typeof m.slug==='string'&&Array.isArray(m.supported_reasoning_levels)&&m.tool_mode))throw Error('Codex catalog/effort/tool metadata contract failed');
  const gui=await fetch('http://127.0.0.1:'+port+'/',{signal:AbortSignal.timeout(10000)});
  if(!gui.ok||!(await gui.text()).includes('<html'))throw Error('Official dashboard contract failed');
  if(digest(path.join(settings.codexHome,'config.toml'))!==cfgHash||fs.existsSync(path.join(codex,'config.toml')))throw Error('Candidate touched native Codex configuration');
  return {version,models:catalog.models.length,dashboard:true,nativeConfigUnchanged:true,health:true,checkDirectory:job};
 }finally{child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),delay(5000)]);fs.closeSync(log);}
}
async function control(action){const settings=json(SETTINGS),config=json(path.join(settings.coreHome,'config.json'));const response=await fetch(`http://${config.host}:${config.port}/admin/${action}`,{method:'POST',headers:{authorization:'Bearer '+config.controlToken},signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('Codex Web GPT maintenance refused: '+response.status);return response.json();}
async function waitForIdleDrain({request=control,pause=delay,now=Date.now,timeoutMs=30*60*1000,intervalMs=5000,onWaiting=()=>{}}={}){
 const deadline=now()+timeoutMs;let waiting=false;
 for(;;){
  // Only the server's atomic idle check may acquire maintenance. Never force a
  // drain while a task is active, or resume a drain held by another operation.
  const drain=await request('drain-if-idle');
  if(drain?.acquired===true&&drain.accepting_turns===false)return drain;
  if(!drain||drain.acquired!==false||!((drain.status==='busy'&&drain.accepting_turns===true)||(drain.status==='draining'&&drain.accepting_turns===false)))throw Error('Unexpected Codex Web GPT maintenance response');
  if(!waiting){onWaiting();waiting=true;}
  const remaining=deadline-now();
  if(remaining<=0)throw Error('Codex Web GPT remained busy; the verified candidate is staged. Retry the update after active tasks finish');
  await pause(Math.min(intervalMs,remaining));
  if(now()>=deadline)throw Error('Codex Web GPT remained busy; the verified candidate is staged. Retry the update after active tasks finish');
 }
}
async function restartBackend(settings,oldPid){
 const token=fs.readFileSync(path.join(settings.home,'admin-api-token'),'utf8').trim();
 const response=await fetch(`http://127.0.0.1:${settings.port}/api/system/restart`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','x-opencodex-restart-expected-pid':String(oldPid)},body:'{}',signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('OpenCodex graceful restart refused: '+response.status);
 return waitHealth('http://127.0.0.1:'+settings.port,h=>h.pid!==oldPid&&h.version===settings.version,90000);
}
async function update(channel='latest',restart=true,jobId=crypto.randomUUID()){
 const lockFile=path.join(ROOT,'update.lock');let lock;
 lock=acquireUpdateLock(lockFile);
 const before=json(SETTINGS),jobFile=path.join(ROOT,'update-job.json');
 const job={id:jobId,status:'running',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),currentVersion:before.version,latestVersion:null,channel,installer:'npm',restart,command:'gateway-managed update',releaseNotesUrl:'https://github.com/lidge-jun/opencodex/releases/latest',log:[],pid:process.pid};
 const publish=(status,message)=>{job.status=status;job.updatedAt=new Date().toISOString();job.log.push(message);atomic(jobFile,job);};
 fs.writeFileSync(lock,JSON.stringify({pid:process.pid,startedAt:job.startedAt}));
 let drained=false,committed=false,backup;
 try{
  publish('running','Downloading the official package into a separate version directory');
  const metadata=await registry(channel);job.latestVersion=metadata.version;
  const packageRoot=await installPackage(metadata);
  const validation=await validatePackage(packageRoot);job.validation=validation;
  if(metadata.version===before.version&&packageRoot===before.packageRoot){publish('succeeded','The current version passed the compatibility checks');return job;}
  const next={...before,version:metadata.version,packageRoot,integrity:metadata.dist.integrity};
  atomic(path.join(ROOT,'pending-update.json'),next);
  if(!restart){publish('succeeded','Candidate validated and staged; use the update command to apply it when idle');return job;}
  await waitForIdleDrain({onWaiting:()=>{job.waitingForIdle=true;publish('running','Codex Web GPT is busy; waiting up to 30 minutes for active tasks to finish before updating OpenCodex');}});
  drained=true;
  job.waitingForIdle=false;
  if(JSON.stringify(json(SETTINGS))!==JSON.stringify(before))throw Error('Integration settings changed while the update was waiting; retry with the current settings');
  const config=json(path.join(before.home,'config.json'));assertOwnership(config);
  backup=owned(path.join(ROOT,'backups','update-'+Date.now()));fs.mkdirSync(backup,{recursive:true});
  fs.cpSync(before.home,path.join(backup,'home'),{recursive:true});atomic(path.join(backup,'settings.json'),before);
  const health=await waitHealth('http://127.0.0.1:'+before.port,h=>h.version===before.version);
  atomic(SETTINGS,next);committed=true;
  publish('restarting','Restarting only the drained internal OpenCodex service');
  await restartBackend(next,health.pid);
  fs.unlinkSync(path.join(ROOT,'pending-update.json'));
  publish('succeeded','New version healthy; existing provider configuration retained');job.restarted=true;atomic(jobFile,job);
  return job;
 }catch(error){
  if(committed){
   atomic(SETTINGS,before);
   // Restore the pre-migration provider settings before asking the supervisor to
   // retry the previous official package. Usage/history files are never deleted.
   if(backup)fs.copyFileSync(path.join(backup,'home/config.json'),path.join(before.home,'config.json'));
   try{const h=await waitHealth('http://127.0.0.1:'+before.port,()=>true,5000);await restartBackend(before,h.pid);}catch{ /* supervisor reads the restored pointer on its next retry */ }
  }
  job.waitingForIdle=false;job.error=error.message;publish('failed','Update refused or rolled back; see the error above');throw error;
 }finally{try{if(drained)await control('resume');}finally{fs.closeSync(lock);fs.unlinkSync(lockFile);}}
}
async function prepareLauncher(executable,activate=false){
 const asar=require('@electron/asar'),installed=path.join(path.dirname(executable),'resources/app.asar');
 const before=digest(installed),job=owned(path.join(ROOT,'launcher-builds',Date.now()+'-'+before.slice(0,12)));
 fs.mkdirSync(job,{recursive:true});const backup=path.join(job,'official.asar');fs.copyFileSync(installed,backup);
 if(fs.existsSync(installed+'.unpacked'))fs.cpSync(installed+'.unpacked',backup+'.unpacked',{recursive:true});
 const extracted=path.join(job,'app');asar.extractAll(backup,extracted);
 const commandFile=path.join(extracted,'electron/runtime-command.cjs'),workerFile=path.join(extracted,'electron/update-worker.cjs');
 let command=fs.readFileSync(commandFile,'utf8'),worker=fs.readFileSync(workerFile,'utf8');
 const ui=require('./launcher-ui-patch.cjs');
 if(fs.readFileSync(path.join(extracted,'electron/main.cjs'),'utf8').includes(ui.REVISION))return {alreadyIntegrated:true,installed};
 const marker=/  runtimeInvocation,\r?\n};/g;
 if(!command.includes('opencodex-gateway-hook')){
  if([...command.matchAll(marker)].length!==1)throw Error('Official launcher invocation changed; integration not applied');
  command=command.replace(marker,`  // opencodex-gateway-hook: official runtime and embedded helper remain intact.\n  runtimeInvocation: options => require(${JSON.stringify(path.join(ROOT,'launcher-hook.cjs'))})(runtimeInvocation(options), options.args),\n};`);
 }
 const anchor='  launch(job.target);';
 if(worker.split(anchor).length!==2)throw Error('Official Windows updater changed; integration not applied');
 if(worker.includes('const gatewayUpdate = spawnSync('))worker=worker.replace('timeout: 120000','timeout: 600000');
 else worker=worker.replace(anchor,`  const gatewayUpdate = spawnSync(${JSON.stringify(json(SETTINGS).bun)}, [${JSON.stringify(__filename)}, 'apply-launcher', job.target], { windowsHide: true, encoding: 'utf8', timeout: 600000 });\n  if (gatewayUpdate.error || gatewayUpdate.status !== 0) throw new Error('OpenCodex gateway integration could not be preserved after the official update');\n${anchor}`);
 fs.writeFileSync(commandFile,command);fs.writeFileSync(workerFile,worker);
 const renderer=await ui.prepareRenderer({root:ROOT,extracted,job,settings:json(SETTINGS)});
 const candidate=path.join(job,'app.asar');await asar.createPackageWithOptions(extracted,candidate,{unpack:'**/linux-appimage-runner.sh'});
 const plan={installed,original:backup,originalHash:before,candidate,candidateHash:digest(candidate),renderer,preparedAt:new Date().toISOString()};atomic(path.join(ROOT,'launcher-plan.json'),plan);
 if(activate)activateLauncher(plan);
 return plan;
}
function activateLauncher(plan){if(digest(plan.installed)!==plan.originalHash||digest(plan.candidate)!==plan.candidateHash)throw Error('Launcher changed since preparation');fs.copyFileSync(plan.candidate,plan.installed+'.gateway-next');rename(plan.installed+'.gateway-next',plan.installed);atomic(path.join(ROOT,'launcher-state.json'),plan);}
module.exports={check,update,validatePackage,prepareLauncher,activateLauncher,assertOwnership,installPackage,registry,acquireUpdateLock,waitForIdleDrain};
if(require.main===module){(async()=>{const command=process.argv[2];let result;if(command==='check')result=await check(process.argv[3]);else if(command==='update')result=await update(process.argv[3]||'latest',!process.argv.includes('--stage-only'),process.argv[4]&&!process.argv[4].startsWith('--')?process.argv[4]:undefined);else if(command==='validate')result=await validatePackage(json(SETTINGS).packageRoot);else if(command==='prepare-launcher')result=await prepareLauncher(json(SETTINGS).launcher);else if(command==='apply-launcher')result=await prepareLauncher(process.argv[3]||json(SETTINGS).launcher,true);else throw Error('Expected check, update, validate, prepare-launcher or apply-launcher');console.log(JSON.stringify(result,null,2));})().catch(error=>{console.error(error.message);process.exitCode=1;});}
