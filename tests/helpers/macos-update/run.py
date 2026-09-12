import pathlib,subprocess,json,os,time,sys,plistlib,signal,threading,urllib.request
root=pathlib.Path(sys.argv[1]);cfg=json.loads((root/'fixture.json').read_text());base=root.parent
app=root/'installed/CodexCommander.app';runtime=app/'Contents/Resources/runtime';bun=runtime/'node_modules/bun/bin/bun.exe'
env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(root/'home'),'CODEX_HOME':str(root/'codex'),'CODEXCOMMANDER_HOME':str(root/'state'),'TMPDIR':str(root/'tmp'),'CCX_DISABLE_COMPANION':'1','CCX_APP_RUNTIME':'1','QUALIFICATION_CPU':cfg['arch']}
assert root.is_absolute() and root.resolve()==root and not root.is_symlink()
assert cfg['root']==str(root) and cfg['bundleId'].startswith('org.ccx.u6.')
assert cfg['serviceLabel']==cfg['bundleId']+'.proxy'
for folder in ['installed','target']:
 fixtureapp=root/folder/'CodexCommander.app'
 assert fixtureapp.resolve()==fixtureapp
 info=plistlib.loads((fixtureapp/'Contents/Info.plist').read_bytes())
 assert info['CFBundleIdentifier']==cfg['bundleId'] and info['QualificationRoot']==str(root)
 identity=(fixtureapp/'Contents/Resources/runtime/src/identity.mjs').read_text()
 assert '"com.codexcommander.proxy"' not in identity and '"'+cfg['serviceLabel']+'"' in identity
steps=[]
scenario=cfg.get('scenario','success')
supervised=scenario.startswith('supervised')
if scenario=='supervised-cancel':scenario='cancel'
def log(kind,**data):
 steps.append({'time':time.time(),'kind':kind,**data});(root/'steps.json').write_text(json.dumps(steps,indent=2));print(kind,data,flush=True)
def wait(predicate,label,timeout=90):
 deadline=time.time()+timeout
 while time.time()<deadline:
  if predicate():return
  time.sleep(.25)
 raise Exception('Timeout: '+label+'; '+((root/'driver.log').read_text()[-2500:] if (root/'driver.log').exists() else 'no driver'))
def helper(*args):
 result=subprocess.run(['/usr/bin/arch','-'+cfg['arch'],str(bun),'--no-install','--no-env-file','--config=/dev/null',str(runtime/'src/cli/index.ts'),*args],env=env,cwd=runtime,text=True,capture_output=True,timeout=95)
 try:body=json.loads(result.stdout)
 except:body={'unparsed':result.stdout}
 log('helper',args=args,code=result.returncode,body=body,stderr=result.stderr)
 if args[:2]==('service','install'):assert result.returncode==0, 'service install must succeed before qualification'
 return {**body,'_exitCode':result.returncode}
serverlog=(root/'server.log').open('w');server=subprocess.Popen(['python3',str(pathlib.Path(__file__).with_name('server.py')),str(root)],stdout=serverlog,stderr=serverlog)
independent=None
if scenario=='independent':
 subprocess.run(['/usr/bin/ditto',str(runtime),str(root/'independent')],check=True)
 independentenv=dict(env);independentenv.pop('CCX_APP_RUNTIME',None)
 independentlog=(root/'independent.log').open('w')
 independent=subprocess.Popen([str(root/'independent/node_modules/bun/bin/bun.exe'),'--no-install','--no-env-file','--config=/dev/null',str(root/'independent/src/cli/index.ts'),'start','--port',str(cfg['proxyport'])],env=independentenv,cwd=root/'independent',stdout=independentlog,stderr=independentlog)
 threading.Thread(target=independent.wait,daemon=True).start()
 wait(lambda:(root/'state/runtime-port.json').exists(),'independent runtime')
menulog=(root/'menu.log').open('w');menu=subprocess.Popen(['/usr/bin/arch','-'+cfg['arch'],str(app/'Contents/MacOS/CodexCommanderMenuBar'),'--ccx-passive-launch'],env=env,stdout=menulog,stderr=menulog)
(root/'pids.json').write_text(json.dumps({'server':server.pid,'menu':menu.pid}));log('started',menu=menu.pid,server=server.pid)
def command(value):
 (root/'command').write_text(value);wait(lambda:not (root/'command').exists(),'consume '+value);log('command',value=value)
try:
 wait(lambda:(root/'driver.log').exists(),'driver launch')
 wait(lambda:(root/'state/runtime-port.json').exists(),'initial runtime',60)
 time.sleep(1)
 status=helper('__macos-lifecycle','status');assert status['state']=='running',status
 if supervised:
  helper('__macos-lifecycle','stop')
  helper('service','install')
  service=subprocess.run(['/bin/launchctl','print',f'gui/{os.getuid()}/'+cfg['serviceLabel']],capture_output=True,text=True)
  assert service.returncode==0,service.stderr
  log('supervisor-installed',label=cfg['serviceLabel'])
  if cfg['mode']=='native':helper('__macos-lifecycle','restore-native')
 if scenario=='independent' and cfg['mode']=='native':helper('__macos-lifecycle','restore-native')
 if cfg['mode']=='stopped':helper('__macos-lifecycle','stop')
 if cfg['mode']=='owned':helper('__macos-lifecycle','start')
 baseline=helper('__macos-lifecycle','status');log('baseline',state=baseline)
 for name,pid in [('menu',menu.pid),('runtime',baseline.get('pid'))]:
  if pid:
   subprocess.run(['/usr/bin/sample',str(pid),'1','1','-file',str(root/(name+'-sample.txt'))],capture_output=True,timeout=10)
 if scenario in ['latest-off','cancel','cold-restart']:(root/'slow-download').touch()
 if scenario=='download-failure':(root/'fail-download').touch()
 if scenario in ['active-later','active-anyway']:
  def request():
   try:
    token='fixture-local-only'
    req=urllib.request.Request(f'http://127.0.0.1:{cfg["proxyport"]}/v1/responses',data=b'{"model":"fixture/gpt-5","input":"qualification","stream":false}',headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    urllib.request.urlopen(req,timeout=120).read();log('active-request-completed')
   except Exception as error:log('active-request-ended',error=type(error).__name__)
  active=threading.Thread(target=request,daemon=True);active.start();wait(lambda:(root/'active-request').exists(),'backend active request')
 if scenario=='signature-failure':
  feed=root/'feed/appcast.xml';signed_feed=feed.read_bytes();feed.write_bytes(signed_feed.replace(b'Isolated installed qualification',b'Tampered installed qualification'))
 command('check')
 if scenario=='signature-failure':
  wait(lambda:('Cancel Update' in (root/'driver.log').read_text() or ':OK' in (root/'driver.log').read_text()),'signature error UI')
  command('click:Cancel Update' if 'Cancel Update' in (root/'driver.log').read_text() else 'click:OK')
  assert not (root/'state/macos-update-transaction.json').exists()
  assert helper('__macos-lifecycle','status')['state']=='running'
  assert 'GET /update.zip' not in (root/'server.log').read_text();log('signature-failure-preserved-runtime')
  feed.write_bytes(signed_feed);command('check')
 command('click:Install Update')
 if scenario in ['active-later','active-anyway']:
  command('click:Later' if scenario=='active-later' else 'click:Update Anyway')
  if scenario=='active-later':
   wait(lambda:not (root/'state/macos-update-transaction.json').exists(),'Later removes safe preparing intent')
   assert helper('__macos-lifecycle','status')['state']=='running'
   assert not (root/'server.log').read_text().count('GET /update.zip')
   log('active-later-preserved-runtime');(root/'active-release').touch();active.join(timeout=10)
   command('check');command('click:Install Update')
 wait(lambda:(root/'state/macos-update-transaction.json').exists(),'transaction')
 transaction=json.loads((root/'state/macos-update-transaction.json').read_text());log('transaction',phase=transaction.get('phase'),target=transaction.get('target'),original=transaction.get('original'))
 if scenario in ['cancel','cold-restart','download-failure']:
  wait(lambda:json.loads((root/'state/macos-update-transaction.json').read_text()).get('phase')=='armed','armed')
  if scenario=='cancel':
   wait(lambda:'Updating CodexCommander:Cancel' in (root/'driver.log').read_text(),'download UI');time.sleep(1);command('click:Cancel')
  elif scenario=='download-failure':command('click:Cancel Update')
  else:
   menu.kill();menu.wait(timeout=10);log('crash',pid=menu.pid)
   menu=subprocess.Popen(['/usr/bin/arch','-'+cfg['arch'],str(app/'Contents/MacOS/CodexCommanderMenuBar'),'--ccx-passive-launch'],env=env,stdout=menulog,stderr=menulog)
   time.sleep(3);log('cold-relaunch',pid=menu.pid)
  time.sleep(2)
  blocked=helper('__macos-update','reconcile');assert blocked['status']=='finish-required',blocked
  excluded=helper('__macos-lifecycle','ensure');assert excluded['state']!='running',excluded
  cli=helper('start','--port',str(cfg['proxyport']));assert cli['_exitCode']!=0,cli
  if supervised:
   service_attempt=helper('service','start');assert service_attempt['_exitCode']!=0,service_attempt
   check=subprocess.run(['/bin/launchctl','print',f'gui/{os.getuid()}/'+cfg['serviceLabel']],capture_output=True);assert check.returncode!=0,'guarded supervisor unexpectedly restarted'
  log('recovery-guard-confirmed')
  for flag in ['slow-download','fail-download']:(root/flag).unlink(missing_ok=True)
  command('check');command('click:Install Update')
 if scenario=='latest-off':
  wait(lambda:json.loads((root/'state/macos-update-transaction.json').read_text()).get('phase')=='armed','armed')
  settings=json.loads((root/'state/config.json').read_text());settings['clientIntegrations']['codex']=False;(root/'state/config.json').write_text(json.dumps(settings,indent=2));log('newer-off-written')
  (root/'slow-download').unlink()
 wait(lambda:plistlib.loads((app/'Contents/Info.plist').read_bytes())['CFBundleVersion']==str(cfg['targetBuild']),'real Sparkle replacement',180)
 wait(lambda:f'build={cfg["targetBuild"]} launch' in (root/'driver.log').read_text(),'Sparkle relaunch',60)
 wait(lambda:not (root/'state/macos-update-transaction.json').exists(),'target reconciliation',90)
 result=helper('__macos-lifecycle','status');assert result['state']==('stopped' if cfg['mode']=='stopped' else 'running'),result
 if scenario=='independent':
  assert result.get('pid')==baseline.get('pid'),'update must not replace independent runtime'
  log('independent-runtime-preserved',pid=result.get('pid'))
 settings=json.loads((root/'state/config.json').read_text());assert (settings.get('clientIntegrations',{}).get('codex')!=False)==(cfg['mode']=='owned' and scenario!='latest-off')
 assert ('codexcommander' in (root/'codex/config.toml').read_text())==(cfg['mode']=='owned' and scenario!='latest-off')
 assert not (root/'state/macos-update-transaction.json').exists(),'transaction not reconciled'
 for name,pid in [('target-runtime',result.get('pid'))]:
  if pid:subprocess.run(['/usr/bin/sample',str(pid),'1','1','-file',str(root/(name+'-sample.txt'))],capture_output=True,timeout=10)
 if supervised:
  service=subprocess.run(['/bin/launchctl','print',f'gui/{os.getuid()}/'+cfg['serviceLabel']],capture_output=True,text=True);assert service.returncode==0
  log('supervisor-resumed',label=cfg['serviceLabel'])
 log('PASS',build=cfg['targetBuild'],semantic=cfg['mode'])
finally:
 # Direct process inventory scopes menu/relaunched/runtime to the unique installed bundle.
 try:
  stopped=helper('__macos-lifecycle','stop');assert stopped.get('state')=='stopped',stopped
  if supervised:helper('service','uninstall')
 except Exception as e:log('cleanup-error',error=str(e))
 menu.poll()
 inventory=subprocess.check_output(['ps','-axo','pid=,command='],text=True)
 victims=[]
 for line in inventory.splitlines():
  parts=line.strip().split(None,1)
  if len(parts)==2 and (str(app) in parts[1] or str(root/'independent') in parts[1]):
   pid=int(parts[0]);victims.append(pid)
   try:os.kill(pid,signal.SIGTERM)
   except ProcessLookupError:pass
 server.terminate();server.wait(timeout=10)
 time.sleep(.5)
 remaining=[]
 inventory=subprocess.check_output(['ps','-axo','pid=,command='],text=True)
 for line in inventory.splitlines():
  parts=line.strip().split(None,1)
  if len(parts)==2 and (str(app) in parts[1] or str(root/'independent') in parts[1]):remaining.append(int(parts[0]))
 service=subprocess.run(['/bin/launchctl','print',f'gui/{os.getuid()}/'+cfg['serviceLabel']],capture_output=True)
 failures=[step for step in steps if step['kind']=='cleanup-error']
 log('cleanup',pids=victims,server=server.pid,survivors=remaining,serviceAbsent=service.returncode!=0)
 assert not remaining and service.returncode!=0 and not failures, 'fixture cleanup did not complete'
