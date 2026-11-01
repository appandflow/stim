import pathlib,subprocess,os,json,time,sys
base=pathlib.Path(os.environ['RUNNER_TEMP'])/'stim-4081-sdk-diagnostic';base.mkdir()
(base/'echo-argv.bat').write_text('@echo off\necho argv=%*\nexit /b 0\n')
(base/'invoke-inert.ps1').write_text("param([string]$Tool)\n& $Tool --install 'ndk;27.1.12297006'\nexit $LASTEXITCODE\n")
(base/'invoke-version.ps1').write_text("param([string]$Tool)\n& $Tool --version\nexit $LASTEXITCODE\n")
results=[]
def observe(name,command,env):
 start=time.monotonic();p=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
 timed_out=False
 try:out,err=p.communicate(timeout=20)
 except subprocess.TimeoutExpired:
  timed_out=True
  subprocess.run(['taskkill.exe','/PID',str(p.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
  out,err=p.communicate(timeout=5)
 results.append({'name':name,'seconds':time.monotonic()-start,'exitCode':p.returncode,'timedOut':timed_out,'stdout':out[:16384],'stderr':err[:16384]})
 (base/'results.json').write_text(json.dumps(results,indent=2))
env=os.environ.copy();inert=base/'echo-argv.bat';manager=pathlib.Path(env['ANDROID_HOME'])/'cmdline-tools/latest/bin/sdkmanager.bat'
assert manager.exists()
observe('python-current-cmd-inert',[env.get('COMSPEC','cmd.exe'),'/d','/s','/c','""'+str(inert)+'" --install ndk;27.1.12297006"'],env)
observe('powershell-direct-inert',['powershell.exe','-NoProfile','-NonInteractive','-File',str(base/'invoke-inert.ps1'),str(inert)],env)
for label,home in [('image-default',env['JAVA_HOME']),('jdk17',env['JAVA_HOME_17_X64'])]:
 selected={**env,'JAVA_HOME':home}
 observe(label+'-java-version',[str(pathlib.Path(home)/'bin/java.exe'),'-version'],selected)
 observe(label+'-sdkmanager-version',['powershell.exe','-NoProfile','-NonInteractive','-File',str(base/'invoke-version.ps1'),str(manager)],selected)
