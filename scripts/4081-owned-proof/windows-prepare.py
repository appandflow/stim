import pathlib,subprocess,json,urllib.request,hashlib,base64,tarfile,io,shutil,os,time,sys
checkout=pathlib.Path(sys.argv[1]);base=pathlib.Path(sys.argv[2]);node24=sys.argv[3]
start=time.monotonic();deadline=start+max(0,(int(sys.argv[4])-int(time.time()*1000))/1000)
base.mkdir();evidence=base/'evidence';evidence.mkdir();private=base/'private-raw';private.mkdir()
meta=json.loads((checkout/'scripts/4081-owned-proof/template-metadata.json').read_text())
def run(command,cwd=checkout,env=None):
 remaining=deadline-time.monotonic();assert remaining>0,'Prerequisite15min deadline'
 with (private/('prerequisite-'+str(time.time_ns())+'.log')).open('w') as f:
  x=subprocess.run(command,cwd=cwd,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=remaining)
 assert x.returncode==0,command
try:
 archive=urllib.request.urlopen(meta['dist.tarball'],timeout=min(30,deadline-time.monotonic())).read()
 assert 'sha512-'+base64.b64encode(hashlib.sha512(archive).digest()).decode()==meta['dist.integrity']
 app=base/'app';app.mkdir()
 with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
  for item in tar:
   prefix='package/template/'
   if not item.isfile() or not item.name.startswith(prefix):continue
   relative=pathlib.PurePosixPath(item.name[len(prefix):]);assert '..' not in relative.parts
   dotfiles={'_buckconfig','_eslintrc.js','_flowconfig','_gitattributes','_gitignore','_prettierrc.js','_watchmanconfig','_editorconfig','_bundle','_ruby-version','_node-version','_xcode.env'};out=app.joinpath(*[('.'+p[1:] if p in dotfiles else p) for p in relative.parts]);out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(tar.extractfile(item).read())
 assert (app/'__tests__/App.test.tsx').exists() and not (app/'._tests__').exists()
 pkg=json.loads((app/'package.json').read_text());pkg['name']='owned-stim-4081';(app/'package.json').write_text(json.dumps(pkg,indent=2)+'\n')
 shutil.copyfile(checkout/'scripts/4081-owned-proof/package-lock.json',app/'package-lock.json')
 lock=json.loads((app/'package-lock.json').read_text());assert lock['packages']['node_modules/react-native']['version']=='0.87.0'
 sdk=pathlib.Path(os.environ['ANDROID_HOME']);manager=sdk/'cmdline-tools/latest/bin/sdkmanager.bat';assert manager.exists()
 cmake='3.30.5';ndk='27.1.12297006'
 needed=[name for name,file in [('ndk;'+ndk,sdk/'ndk'/ndk/'source.properties'),('cmake;'+cmake,sdk/'cmake'/cmake/'bin/cmake.exe'),('build-tools;37.0.0',sdk/'build-tools/37.0.0/aapt2.exe')] if not file.exists()]
 assert (sdk/'platforms/android-37/android.jar').exists() or (sdk/'platforms/android-37.0/android.jar').exists(),'exactSDK37 unavailable'
 if needed:run([os.environ.get('COMSPEC','cmd.exe'),'/d','/s','/c','""'+str(manager)+'" --install '+' '.join(needed)+'"'],env=os.environ.copy())
 assert (sdk/'ndk'/ndk/'source.properties').exists() and (sdk/'cmake'/cmake/'bin/cmake.exe').exists()
 npm=pathlib.Path(node24).parent/'node_modules/npm/bin/npm-cli.js';assert npm.exists()
 env=os.environ.copy();env['npm_config_cache']=str(base/'npm-cache')
 run([node24,str(npm),'ci','--no-audit','--no-fund'],cwd=app,env=env)
 result={'pass':True,'seconds':time.monotonic()-start,'template':meta,'reactNative':lock['packages']['node_modules/react-native']['version'],'gradlePlugin':lock['packages']['node_modules/@react-native/gradle-plugin']['version'],'sdk':str(sdk),'ndk':ndk,'cmake':cmake,'installedPinnedPrerequisites':needed,'effectivePathNotPinDiscovery':True}
 (evidence/'prerequisites.json').write_text(json.dumps(result,indent=2))
except Exception as error:
 (private/'prerequisite-failure.json').write_text(json.dumps({'pass':False,'error':str(error),'seconds':time.monotonic()-start},indent=2));(evidence/'prerequisite-failure.json').write_text(json.dumps({'pass':False,'stage':'prerequisites','seconds':time.monotonic()-start},indent=2));raise
