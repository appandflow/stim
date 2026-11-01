import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import vm from 'node:vm';
assert.equal(process.platform,'win32');
const tree=process.cwd(),base=join(process.env.RUNNER_TEMP,'stim-4081-private-dirs-'+randomUUID());
const source=readFileSync(join(tree,'packages/stim-cli/src/offload/worker.ts'),'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'53ae3b645c041010f92d89bed22018de288b5767987467813e7783aa137b36fb');
const literal=/const PRIVATE_DIRS = (\[[\s\S]*?\])\.join\('\\n'\);/u.exec(source)?.[1];assert(literal);
const script=vm.runInNewContext(literal,{},{timeout:1000}).join('\n');
const errors=['CouldNotAutoloadMatchingModule','FormatXmlUpdateException','Modules_InsufficientPowerShellVersion','UnauthorizedAccessException','DirectoryNotFoundException'];
const classify=text=>errors.find(code=>text.includes(code))??'unknown';
const rows=[],pids=[];mkdirSync(base);
try{
 for(const omitModulePath of [false,true]){
  const root=join(base,omitModulePath?'omitted':'inherited'),key='owned4081-'+randomUUID();
  const env={...process.env};if(omitModulePath)for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
  const started=Date.now();const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',input:root+'\n'+join(root,'checkout')+'\t'+key+'\n'+join(root,'gradle')+'\t'+key,env,timeout:15000});
  if(result.pid)pids.push(result.pid);
  const row={omitModulePath,exitCode:result.status,errorCategory:result.status===0?'none':classify(String(result.stderr??'')+'\n'+String(result.error?.message??'')),elapsedMs:Date.now()-started};rows.push(row);
  if(result.status===0){
   const check="$ErrorActionPreference='Stop';$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$rows=@();foreach($line in [Console]::In.ReadToEnd().Split([char]10)){if(!$line){continue};$dir,$key=$line.Split([char]9);$acl=[IO.Directory]::GetAccessControl($dir);$foreign=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{$_.IdentityReference.Value -notin @($me,'S-1-5-18')});$rows+=@{protected=$acl.AreAccessRulesProtected;foreignRules=$foreign.Count;ownerAllowed=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -in @($me,'S-1-5-18','S-1-5-32-544');markerMatches=(!$key -or [IO.File]::ReadAllText($dir+'.owner') -eq $key)}};ConvertTo-Json -Compress -InputObject $rows";
   const verify=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',check],{encoding:'utf8',input:root+'\n'+join(root,'checkout')+'\t'+key+'\n'+join(root,'gradle')+'\t'+key,env:Object.fromEntries(Object.entries(env).filter(([key])=>key.toLowerCase()!=='psmodulepath')),timeout:15000});if(verify.pid)pids.push(verify.pid);
   assert.equal(verify.status,0,'fixed ACL verification failed');row.acls=JSON.parse(verify.stdout);assert.equal(row.acls.length,3);assert(row.acls.every(v=>v.protected&&v.foreignRules===0&&v.ownerAllowed&&v.markerMatches));
  }
 }
}finally{
 rmSync(base,{recursive:true,force:true});
 const check=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ids=@(${pids.join(',')});$alive=0;foreach($id in $ids){try{$p=[Diagnostics.Process]::GetProcessById($id);if(!$p.HasExited){$alive++}}catch{}};[Console]::WriteLine('{\"remaining\":'+$alive+'}')`],{encoding:'utf8',timeout:15000});
 assert.equal(check.status,0,'own PowerShell PID check failed');const clean=JSON.parse(check.stdout).remaining===0&&!existsSync(base);
 const evidence={sourceCommit:'840d46da2b6194cdfbfe9f2eef5cf990d4ddc55d',scriptExtractedUnchanged:true,rows,cleanup:{clean,privateRootGone:!existsSync(base)},noNativeBuild:true,noServer:true};
 writeFileSync(join(process.env.RUNNER_TEMP,'owned4081-private-dirs.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));assert(clean);
}
