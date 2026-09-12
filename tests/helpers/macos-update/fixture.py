import pathlib, subprocess, plistlib, json, os, sys, socket, uuid, shutil
base=pathlib.Path(os.environ['CCX_QUALIFICATION_WORKSPACE']).resolve()
base.mkdir(parents=True,exist_ok=True)
mode=sys.argv[1] if len(sys.argv)>1 else 'native'
arch=sys.argv[2] if len(sys.argv)>2 else 'arm64'
scenario=sys.argv[3] if len(sys.argv)>3 else 'success'
root=base/(mode+'-'+arch+'-'+scenario+'-'+uuid.uuid4().hex[:8]);root.mkdir()
for name in ['home','codex','state','tmp','feed','installed','target']: (root/name).mkdir()
def port():
 s=socket.socket();s.bind(('127.0.0.1',0));p=s.getsockname()[1];s.close();return p
httpport,proxyport=port(),port()
bid='org.ccx.u6.'+root.name
source=pathlib.Path(os.environ['CCX_QUALIFICATION_SOURCE_APP']).resolve()
assert source.name=='CodexCommander.app'
assert not (base/'driver-binary').is_symlink()
sourcebuild=int(plistlib.loads((source/'Contents/Info.plist').read_bytes())['CFBundleVersion']);targetbuild=sourcebuild+1
for folder,build in [('installed',sourcebuild),('target',targetbuild)]:
 app=root/folder/'CodexCommander.app';subprocess.run(['ditto',str(source),str(app)],check=True)
 shutil.copy2(base/'driver-binary',app/'Contents/MacOS/CodexCommanderMenuBar')
 p=app/'Contents/Info.plist';data=plistlib.loads(p.read_bytes());data.update(CFBundleIdentifier=bid,CFBundleVersion=str(build),SUFeedURL=f'http://127.0.0.1:{httpport}/appcast.xml',QualificationRoot=str(root),LSArchitecturePriority=[arch],NSAppTransportSecurity={'NSAllowsLocalNetworking':True,'NSAllowsArbitraryLoads':True})
 p.write_bytes(plistlib.dumps(data))
 # Every fixture service identity is namespaced even if this scenario is unsupervised.
 identity=app/'Contents/Resources/runtime/src/identity.mjs';identity.write_text(identity.read_text().replace('com.codexcommander.proxy',bid+'.proxy'))
 service=app/'Contents/Resources/runtime/src/service.ts'
 service.write_text(service.read_text().replace('  const envLines = [', '  const envLines = [\n    '+repr('    <key>HOME</key><string>'+str(root/'home')+'</string>')+',\n    '+repr('    <key>TMPDIR</key><string>'+str(root/'tmp')+'</string>')+','))
 subprocess.run(['codesign','--force','--sign','-',str(app)],check=True)
 subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
archive=root/'feed/update.zip';subprocess.run(['ditto','-c','-k','--sequesterRsrc','--keepParent',str(root/'target/CodexCommander.app'),str(archive)],check=True)
signer=pathlib.Path(os.environ['CCX_QUALIFICATION_SIGNER']).resolve();key=pathlib.Path(os.environ['CCX_QUALIFICATION_PRIVATE_KEY']).resolve()
assert not key.is_relative_to(root/'feed'), 'Private key must be outside asset directory'
sig=subprocess.check_output([str(signer),'--ed-key-file',str(key),str(archive)],text=True).strip()
feed=root/'feed/appcast.xml';feed.write_text(f'''<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Isolated installed qualification</title><item><title>Fixture build {targetbuild}</title><sparkle:version>{targetbuild}</sparkle:version><sparkle:shortVersionString>0.1.6</sparkle:shortVersionString><enclosure url="http://127.0.0.1:{httpport}/update.zip" {sig} type="application/octet-stream"/></item></channel></rss>''')
subprocess.run([str(signer),'--ed-key-file',str(key),str(feed)],check=True)
(root/'state/config.json').write_text(json.dumps({'port':proxyport,'providers':{'fixture':{'adapter':'openai-responses','baseUrl':f'http://127.0.0.1:{httpport}/provider','authMode':'forward','allowPrivateNetwork':True}},'defaultProvider':'fixture','clientIntegrations':{'codex':mode=='owned','grok':False},'codexAutoStart':True,'codexShimAutoRestore':False,'multiAgentGuidanceEnabled':False,'websockets':False}))
(root/'codex/config.toml').write_text('model = "gpt-5"\n')
(root/'codex/models_cache.json').write_text(json.dumps({'models':[{'slug':'gpt-5','display_name':'GPT-5','description':'Fixture native model','visibility':'list','supported_in_api':True,'default_reasoning_level':'medium','supported_reasoning_levels':[{'effort':'medium','description':'Medium'}]}]}))
(root/'fixture.json').write_text(json.dumps({'root':str(root),'scenario':scenario,'mode':mode,'arch':arch,'bundleId':bid,'httpport':httpport,'proxyport':proxyport,'sourceBuild':sourcebuild,'targetBuild':targetbuild,'sourceRevision':data.get('CodexCommanderSourceRevision'),'serviceLabel':bid+'.proxy'},indent=2))
(base/'latest').write_text(str(root));print(root)
