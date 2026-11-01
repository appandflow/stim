import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync,realpathSync,copyFileSync,lstatSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const [tree,base,node22,node24,deadlineText]=process.argv.slice(2);
const mode='candidate';assert.equal(process.platform,'win32');
const deadline=Number(deadlineText);assert(Number.isFinite(deadline)&&deadline>Date.now(),'one shared acceptance deadline');
assert(tree&&base&&['baseline','candidate'].includes(mode));
const run=(file,args,opt={})=>{const r=spawnSync(file,args,{encoding:'utf8',timeout:30_000,killSignal:'SIGKILL',...opt});assert.equal(r.status,0,`${file} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);return r.stdout;};
const save=(name,value)=>{
 const raw=join(base,'private-raw');mkdirSync(raw,{recursive:true});writeFileSync(join(raw,name),JSON.stringify(value,null,2));
 let summary;
 if(name==='events.json')summary=value.map(v=>({at:v.at,wave:['22-first','24-switch','22-return'].includes(v.wave)?v.wave:null,phase:['sync','deps','prebuild','build','compile','fingerprint','package'].includes(v.phase)?v.phase:null,jobStarted:typeof v.job==='string',budgetExpired:v.budgetExpired===true,admission:v.classification==='load-only'?'load-only':v.classification==='stop'?'stop':null,capacity:v.capacity?{running:v.capacity.running,max:v.capacity.max,builds:v.capacity.builds,maxBuilds:v.capacity.maxBuilds,loadPerCore:v.capacity.loadPerCore,maxLoadPerCore:v.capacity.maxLoadPerCore}:null}));
 else if(name==='result.json')summary={mode:value.mode,pass:value.pass===true,partial:value.partial===true,effectivePathNotPinDiscovery:true,rows:value.rows.map(v=>({wave:v.wave,selectedNode:v.selectedNode,identity:{execPath:v.identity.execPath,version:v.identity.version,wave:v.identity.wave},nativeDexMarker:v.nativeDexMarker===true,settings:{node:JSON.parse(v.settings.node),pid:v.settings.pid,home:v.settings.home,at:v.settings.at},elapsedMs:v.elapsedMs,apkBytes:v.apkBytes,fingerprint:v.fingerprint}))};
 else if(name==='cleanup.json')summary={clean:value.clean,errorCount:value.errors.length,remainingPids:value.remaining.map(v=>v.pid),serverClosed:value.serverClosed,clientAreasGone:value.clientAreasGone,shortHomesRemoved:(!value.parentHome||!existsSync(value.parentHome))&&(!value.checkoutHome||!existsSync(value.checkoutHome)),ownerMarkersRemoved:(!value.parentHome||!existsSync(value.parentHome+'.owner'))&&(!value.checkoutHome||!existsSync(value.checkoutHome+'.owner')),slots:value.slots.map(v=>({live:v.live.length,unresolved:v.unresolved.length})),identities:value.identities.map(v=>({pid:v.pid,state:v.state}))};
 else if(name==='versions.json')summary={reactNative:value.reactNative,lockedReactNative:value.lockedReactNative,versions:value.versions,toolchain:{compat:value.toolchain.compat,arch:value.toolchain.arch,jdk:value.toolchain.jdk,androidSdk:value.toolchain.androidSdk},effectivePathNotPinDiscovery:true};
 else if(name==='budget.json')summary={deadline:value.deadline,modeStartedAt:value.modeStartedAt,remainingMs:value.remainingMs};
 else if(/^acl-(22-first|24-switch|22-return)\.json$/.test(name))summary={owner:value.owner,me:value.me,rules:value.rules};
 else if(name==='failure.json')summary={failed:true,kind:'native-observation',checkpoint,workerCode,workerFailure,budgetExpired:Date.now()>=deadline};
 else if(name==='diagnosis.json')summary={diagnosisOnly:true,reachedSync:value.reachedSync===true,cancelAcknowledged:value.cancelAcknowledged===true,workerCode,workerFailure,phaseCounts};
 else if(name==='worker-diagnostics.json')summary={checkpoint,wave:waveNow,workerCode,workerFailure,workerOk,phaseCounts,workerTimings};
 if(summary!==undefined){const out=join(base,'evidence');mkdirSync(out,{recursive:true});writeFileSync(join(out,name),JSON.stringify(summary,null,2));}
};
const put=(n,v)=>{mkdirSync(dirname(n),{recursive:true});writeFileSync(n,v);};
const home=join(base,'stim-home');mkdirSync(home,{recursive:true});process.env.STIM_HOME=home;
process.env.HOME=join(base,'home');mkdirSync(process.env.HOME,{recursive:true});
process.env.USERPROFILE=process.env.HOME;
assert(process.env.JAVA_HOME&&process.env.ANDROID_HOME);
const originalPath=process.env.PATH;assert(originalPath);
process.env.npm_config_cache=join(base,'npm-cache');
const workerEnv={...process.env};for(const key of Object.keys(workerEnv))if(key.toLowerCase()==='path')delete workerEnv[key];
workerEnv.PATH=dirname(node22)+';'+originalPath;
const versions=[node22,node24].map(binary=>JSON.parse(run(binary,['-p','JSON.stringify([process.execPath,process.versions.node])'])));
assert(versions[0][1].startsWith('22.')&&versions[1][1].startsWith('24.'));
const cli=join(tree,'packages/stim-cli/dist/cli.mjs');
for(const k of ['iosSimulatorApp','androidEmulatorApp'])run(process.execPath,[cli,'settings','set',k,'stim-desktop']);
for(const [k,v] of [['concurrency.maxBuilds','2'],['server.gradleDaemonIdleMinutes','45']])run(process.execPath,[cli,'settings','set',k,v]);
const load=p=>import(pathToFileURL(join(tree,p)));
const {startServer}=await load('packages/server/src/server.ts');
const {serverIdentity,storeSetupSecret,spendSecret,revokeDevice}=await load('packages/server/src/registry.ts');
const {clientIdentity}=await load('packages/core/state/client-identity.ts');
const {newSecret,secretValues}=await load('packages/core/noise-session.ts');
const {BuildConnection,chooseBuildMachine,offloadBuild}=await load('packages/stim-cli/src/offload/client.ts');
const {fingerprintProject,gitignoredFingerprintInputs}=await load('packages/stim-cli/src/cache/build-cache.ts');
const {androidLayoutSetting}=await load('packages/stim-cli/src/workspace/settings.ts');
const {androidRequirements}=await load('packages/stim-cli/src/offload/toolchain.ts');
const {captureProcessIdentity,inspectProcessIdentity}=await load('packages/core/process-identity.ts');
const {readClaimSet}=await load('packages/core/ownership-claim.ts');
const {windowsShortDir,windowsShortDirKey}=await load('packages/core/state/config.ts');
const {listCommandLines}=await load('packages/server/src/processes.ts');
const {workerGradleDaemons}=await load('packages/server/src/build.ts');
const events=[],connections=[],jobs=[],identities=[],homes=new Set();let repo,parentHome,checkoutHome;
const record=v=>{events.push({at:Date.now(),...v});save('events.json',events);};
const codes=new Set(['worker-crashed','worker-exited','cancelled','cleanup-unresolved','bad-project','deps-failed','build-refused','bad-request','no-fingerprint','fingerprint-mismatch','fingerprint-moved','prebuild-refused','prebuild-failed','build-failed','timeout','closed','dropped']);
const phases=['sync','deps','prebuild','pods','build','cache','package'];
const classifyWorkerFailure=message=>{
 if(typeof message!=='string')return 'unknown';
 if(message.startsWith('Could not prepare the private Windows build directories:'))return 'private-windows-directories';
 if(message.startsWith('Command failed: git '))return 'git-command-failed';
 const code=/^(?:spawnSync (?:git|powershell\.exe) )?(ENOENT|EACCES|EPERM|EINVAL|ENAMETOOLONG|ENOTDIR|EEXIST|EBUSY|ENOSPC|ETIMEDOUT)(?=[: ])/u.exec(message)?.[1];
 return code?'os-'+code.toLowerCase():'unknown';
};
let checkpoint='bootstrap',waveNow=null,workerCode='none',workerFailure='none',workerOk=false,phaseCounts=Object.fromEntries(phases.map(p=>[p,0])),workerTimings={};
const diagnostics=()=>save('worker-diagnostics.json',{});
let diagnosticSyncReached=false,diagnosticCancel=null,diagnosticCancelAcknowledged=false;
let server,serverClosed=false,clientId,observer,timer,clean=false;
const wait=async(p,why,ms=30_000)=>{const until=Date.now()+ms;while(!p()){assert(Date.now()<until,why);await new Promise(r=>setTimeout(r,25));}};
const inventory=async()=>{const text=await listCommandLines();return {text,daemons:clientId&&repo?workerGradleDaemons(text,join(home,'build-worker'),'win32',[{client:clientId,repo}]):[]};};
const capture=async()=>{const current=await inventory();for(const d of current.daemons)if(!identities.some(i=>i.pid===d.pid)){const c=captureProcessIdentity(d.pid);assert(c.ok,'capture owned live '+d.pid);identities.push({pid:d.pid,processToken:c.token});}return current;};
try{
const ticket=Buffer.from(newSecret(),'base64url');storeSetupSecret(ticket,['build'],new Date(Date.now()+60_000).toISOString());
const approved=spendSecret(secretValues(ticket).lookup.toString('hex'),clientIdentity().publicKey.toString('base64url'),'Owned4081','private-fixture');assert(approved?.build);clientId=approved.build.id;
server=await startServer({name:'Owned4081 '+mode,hosts:['127.0.0.1'],port:0,loopbackOnly:true,localSocket:null,hostsDevices:false,stimCli:cli,stimVersion:'proof',serverVersion:'proof',env:workerEnv,tailscale:null,tailscaleState:{state:'not-running',backendState:'Stopped'},statusAtBoot:false});await server.ready;
const port=server.addresses[0].port,machine='local:127.0.0.1:'+port;
const endpoint={url:'ws://127.0.0.1:'+port,servername:'127.0.0.1',host:'127.0.0.1:'+port};
const credential={machine,transport:'local',address:'127.0.0.1',state:'approved',requestedAt:new Date().toISOString(),serverKey:serverIdentity().publicKey.toString('base64url'),deviceId:clientId};
observer=await BuildConnection.open(endpoint,credential.serverKey,10_000);assert(observer instanceof BuildConnection);connections.push(observer);
const offered=await observer.request('build.offer',{repo:'probe'});assert(offered.result);const toolchain=offered.result.toolchain;
checkpoint='source-preparation';diagnostics();
const source=join(base,'app');assert(existsSync(join(source,'node_modules/react-native/package.json')));
const pkg=JSON.parse(readFileSync(join(source,'package.json'))),lock=JSON.parse(readFileSync(join(source,'package-lock.json')));assert.equal(pkg.dependencies['react-native'],'0.87.0');assert.equal(lock.packages['node_modules/react-native'].version,'0.87.0');
save('versions.json',{reactNative:pkg.dependencies['react-native'],lockedReactNative:lock.packages['node_modules/react-native'].version,toolchain,versions,effectivePathNotPinDiscovery:true});
const layout=androidLayoutSetting({},source,source),target={platform:'android',local:{stimBuild:toolchain.stimBuild,compat:toolchain.compat,arch:toolchain.arch,jdk:'17'},requires:androidRequirements(source)};
const here={cpus:10,loadPerCore:0,builds:0,maxBuilds:0,maxLoadPerCore:2};
const settingsLog=join(base,'settings.jsonl');
put(join(source,'scripts/probe4081.cjs'),`const fs=require('fs');fs.mkdirSync(require('path').dirname(process.argv[2]),{recursive:true});fs.writeFileSync(process.argv[2],JSON.stringify({execPath:process.execPath,version:process.versions.node,wave:fs.readFileSync(process.argv[3],'utf8').trim()}));`);
const original=readFileSync(join(source,'android/settings.gradle'),'utf8');
writeFileSync(join(source,'android/settings.gradle'),original+`\ndef stim4081Node = providers.exec { commandLine('node','-p','JSON.stringify([process.execPath,process.versions.node])') }.standardOutput.asText.get().trim()\nnew File(${JSON.stringify(settingsLog)}).append(groovy.json.JsonOutput.toJson([node:stim4081Node,pid:ProcessHandle.current().pid(),home:gradle.gradleUserHomeDir.canonicalPath,at:System.currentTimeMillis()])+'\\n')\n`);
const appGradle=join(source,'android/app/build.gradle');
writeFileSync(appGradle,readFileSync(appGradle,'utf8')+`\ndef stim4081Dir = layout.buildDirectory.dir('generated/stim4081/assets')\ndef stim4081 = tasks.register('stim4081Node',Exec) { inputs.files(rootProject.file('../scripts/probe4081.cjs'),rootProject.file('../probe4081-wave.txt')); outputs.file(stim4081Dir.map{it.file('node4081.json')}); commandLine 'node',rootProject.file('../scripts/probe4081.cjs').absolutePath,stim4081Dir.get().file('node4081.json').asFile.absolutePath,rootProject.file('../probe4081-wave.txt').absolutePath }\nandroid.sourceSets.main.assets.srcDir(stim4081Dir.get().asFile)\ntasks.named('preBuild').configure { dependsOn(stim4081) }\n`);
run('git',['init','-q','--initial-branch=main'],{cwd:source});run('git',['add','.'],{cwd:source});run('git',['add','-f','android'],{cwd:source});run('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','owned4081'],{cwd:source});
const rows=[];
save('budget.json',{deadline,modeStartedAt:Date.now(),remainingMs:deadline-Date.now()});
timer=setTimeout(()=>{record({budgetExpired:true});for(const j of jobs)void j.connection.request('build.cancel',{job:j.id}).catch(()=>{});},Math.max(1,deadline-Date.now()));
for(const [wave,version] of [['22-first',versions[0][1]]]){
 checkpoint='wave-preparation';waveNow=wave;workerCode='none';workerFailure='none';workerOk=false;phaseCounts=Object.fromEntries(phases.map(p=>[p,0]));workerTimings={};diagnostics();
 assert(Date.now()<deadline,'shared acceptance budget remains');
 workerEnv.PATH=dirname(version===versions[0][1]?node22:node24)+';'+originalPath;
 assert(!existsSync(join(source,'.nvmrc'))&&!existsSync(join(source,'.node-version')),'no pin-discovery claim');put(join(source,'probe4081-wave.txt'),wave+'\n');
 const java=join(source,'android/app/src/main/java/com/helloworld/Node4081.java');put(java,`package com.helloworld; public final class Node4081 { public static String wave() { return ${JSON.stringify(wave)}; } }\n`);
 run('git',['add','.'],{cwd:source});
 checkpoint='waiting-admission';diagnostics();let c;
 for(;;){
  assert(Date.now()<deadline,'shared deadline before offer');
  c=await chooseBuildMachine({projectRoot:source,target,here,machines:[credential],selected:machine,note:n=>record({wave,note:n})});
  if(typeof c!=='string'){if(Date.now()>=deadline){c.connection.close();throw new Error('Shared deadline expired after offer');}break;}
  const diagnostic=await observer.request('build.offer',{repo:repo??'probe'});
  const cap=diagnostic.result?.capacity;
  const refused=c.startsWith(machine+': busy (')?c.slice((machine+': busy (').length):'';
  const loadText=/^load at or above [0-9.]+\/core; load [0-9.]+\/core, [0-9]+ of [0-9]+ build slots busy\)$/.test(refused);
  const loadOnly=loadText&&cap&&cap.maxLoadPerCore>0&&cap.diskFreeBytes>=cap.minDiskFreeBytes&&(cap.max===0||cap.running<cap.max)&&(cap.maxBuilds===0||cap.builds<cap.maxBuilds)&&(cap.declined===null||/^load at or above [0-9.]+\/core$/.test(cap.declined));
  record({wave,admissionRefusal:c,classification:loadOnly?'load-only':'stop',capacity:cap??null,remainingMs:deadline-Date.now()});
  assert(loadOnly,c);assert(deadline-Date.now()>15_000,'shared budget allows next ordinary offer');
  await new Promise(resolve=>setTimeout(resolve,15_000));
 }
 connections.push(c.connection);repo??=c.identity.repo;assert.equal(repo,c.identity.repo);
 const area=join(home,'build-worker',clientId,'repos',repo);
 const parent=windowsShortDir(join(area,'cache','gradle'));parentHome=parent;checkoutHome=windowsShortDir(area);
 const nodeBin=version===versions[0][1]?node22:node24;
 const actual=run(nodeBin,['-p','JSON.stringify([process.execPath,process.versions.node])']).trim();
 const gh=join(parent,'n'+createHash('sha256').update('canonical-node-path\0').update(actual).digest('hex').slice(0,12));homes.add(gh);
 const onProgress=c.connection.onProgress.bind(c.connection);
 c.connection.onProgress=listener=>onProgress(listener===null?null:event=>{
  if(phases.includes(event.phase))phaseCounts[event.phase]++;
  if(event.outcome){workerFailure=event.outcome.ok?'none':classifyWorkerFailure(event.outcome.message);workerOk=event.outcome.ok===true;workerCode=codes.has(event.outcome.code)?event.outcome.code:(workerOk?'none':'other');const t=event.outcome.timings;workerTimings=Object.fromEntries(['syncMs','depsMs','prebuildMs','podsMs','fingerprintMs','buildMs','packageMs'].filter(k=>Number.isFinite(t?.[k])).map(k=>[k,t[k]]));}
  if(event.phase==='sync'&&!diagnosticSyncReached){diagnosticSyncReached=true;assert.equal(typeof event.job,'string');diagnosticCancel=c.connection.request('build.cancel',{job:event.job}).then(ack=>{diagnosticCancelAcknowledged=Boolean(ack.result);},()=>{});}
  diagnostics();return listener(event);
 });
 const request=c.connection.request.bind(c.connection);c.connection.request=async(m,p,...rest)=>{
  if(m==='build.start')assert(Date.now()<deadline,'shared deadline before build.start');
  const r=await request(m,p,...rest);
  if(m==='build.start'&&r.result?.job){
   jobs.push({id:r.result.job,connection:c.connection});record({wave,job:r.result.job});
   if(Date.now()>=deadline){record({wave,lateAdmittedJob:r.result.job,deadline});await request('build.cancel',{job:r.result.job});throw new Error('Late job cancelled at shared deadline');}
  }
  return r;
 };
 checkpoint='fingerprint';diagnostics();const fp=await fingerprintProject(source,{platform:'android',androidLayout:layout});assert(fp);
 const ignored=await gitignoredFingerprintInputs(source,fp.sources,{platform:'android',androidLayout:layout});
 const began=Date.now();
 checkpoint='offload';diagnostics();const result=await offloadBuild({choice:c,expectedFingerprint:fp.hash,fingerprintInputs:async()=>({sources:fp.sources,ignored}),request:{platform:'android',isExpo:false,cacheArtifact:true,android:{variant:'debug',abi:'arm64-v8a',gradleBuildCache:true,pch:'off',compilerCache:'none',gradleRoot:null,module:':app'}},stagingDir:join(base,'apk-'+wave),onPhase:(phase,msg)=>record({wave,phase,msg}),onEnter:()=>{},onRecord:r=>record({wave,record:r}),note:n=>record({wave,note:n})});
 checkpoint='offload-returned';diagnostics();await capture();record({wave,result,elapsedMs:Date.now()-began});if(diagnosticCancel)await diagnosticCancel;
 save('diagnosis.json',{reachedSync:diagnosticSyncReached,cancelAcknowledged:diagnosticCancelAcknowledged});
 if(diagnosticSyncReached){assert(diagnosticCancelAcknowledged);assert.equal(result.ok,false);assert.equal(workerCode,'cancelled');}
 else assert(result.ok,'first-job failed before sync; fixed category retained');
}
checkpoint='diagnosis-complete';diagnostics();
}catch(e){diagnostics();save('failure.json',{message:String(e),stack:e.stack});process.exitCode=1;}
finally{
 checkpoint='cleanup';diagnostics();clearTimeout(timer);const errors=[];
 try{await capture();}catch(e){errors.push(String(e));}
 for(const job of jobs)try{await job.connection.request('build.cancel',{job:job.id});}catch{}
 if(clientId)try{revokeDevice(clientId);}catch(e){errors.push(String(e));}
 if(clientId)await wait(()=>!existsSync(join(home,'build-worker',clientId)),'owned client removed',180_000).catch(e=>errors.push(String(e)));
 for(const c of connections)c.close();if(server)await server.close().then(()=>{serverClosed=true}).catch(e=>errors.push(String(e)));
 const remaining=(await inventory()).daemons,slots=[0,1].map(i=>readClaimSet(join(home,'build-slots','slot-'+i)));
 clean=errors.length===0&&remaining.length===0&&(!server||serverClosed)&&slots.every(s=>s.live.length===0&&s.unresolved.length===0)&&(!clientId||!existsSync(join(home,'build-worker',clientId)));
 if(parentHome&&(existsSync(parentHome)||existsSync(parentHome+'.owner')))errors.push('Short Gradle home or owner remains');
 if(checkoutHome&&(existsSync(checkoutHome)||existsSync(checkoutHome+'.owner')))errors.push('Short checkout or owner remains');
 clean=clean&&errors.length===0&&identities.every(i=>['gone','different'].includes(inspectProcessIdentity(i)));
 save('cleanup.json',{clean,errors,parentHome,checkoutHome,remaining,slots,serverClosed,identities:identities.map(i=>({...i,state:inspectProcessIdentity(i)})),clientAreasGone:!clientId||!existsSync(join(home,'build-worker',clientId))});assert(clean,'owned cleanup required');
}
