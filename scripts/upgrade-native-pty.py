"""Official bundled Pi upgrade/reload proof with synthetic local model and broker.
The parent owns disposable TLS credentials. Only source/fixture paths enter control.
"""
import json,os,pathlib,shutil,subprocess,pty,select,time,signal,hashlib,sys,fcntl,termios,struct,re
signal.signal(signal.SIGTERM,lambda *_: (_ for _ in ()).throw(InterruptedError('fixture canceled')))
control=json.loads(pathlib.Path(sys.argv[1]).read_text());root=pathlib.Path(control['directory']);live=root/'connector';agent=root/'agent';home=root/'home';home.mkdir();agent.mkdir(exist_ok=True)
ignore=shutil.ignore_patterns('.git','node_modules','.ci','__pycache__');shutil.copytree(control['oldSource'],live,ignore=ignore)
env={'PATH':os.environ['PATH'],'HOME':str(home),'PI_CODING_AGENT_DIR':str(agent),'PI_OFFLINE':'1','TERM':'xterm-256color','NODE_EXTRA_CA_CERTS':control['cert'],'UPGRADE_LIVE':str(live),'UPGRADE_EVIDENCE':str(root),'npm_config_cache':str(root/'npm-cache')}
cli=control['piCli'];transcript=b''
helper=root/'evidence.ts';helper.write_text("import {fauxProvider,fauxAssistantMessage} from "+json.dumps(control['fauxModule'])+";\n"+'''import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
export default function(pi){const faux=fauxProvider({provider:'upgrade-fixture'});faux.setResponses(Array.from({length:100},()=>fauxAssistantMessage('fixture response')));pi.registerProvider(faux.provider);pi.registerCommand('upgrade-capture',{description:'Disposable upgrade evidence',handler:async(label,ctx)=>{
 if(!ctx.sessionManager.getEntries().some(e=>e.type==='custom'&&e.customType==='upgrade-marker'))pi.appendEntry('upgrade-marker',{value:'retained'});
 writeFileSync(join(process.env.UPGRADE_EVIDENCE,label+'.json'),JSON.stringify({stage:label,installed:JSON.parse(readFileSync(join(process.env.UPGRADE_LIVE,'package.json'),'utf8')).version,sessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile(),markers:ctx.sessionManager.getEntries().filter(e=>e.type==='custom'&&e.customType==='upgrade-marker').length,setupDescription:pi.getCommands().find(c=>c.name==='psst-setup')?.description,hasDoctor:pi.getCommands().some(c=>c.name==='psst-doctor'),reloadGraph:globalThis.__psstReloadGraph,loadedVersion:globalThis.__psstLoadedVersion}));
}});}
''')
def install():
 r=subprocess.run(['node',cli,'install',str(live)],cwd=home,env=env,capture_output=True,timeout=30)
 if r.returncode:raise RuntimeError('official installer failed: '+r.stderr.decode())
def event(name,**values):print(json.dumps({'event':name,**values}),flush=True)
def checkpoint(name):
 event(name);deadline=time.monotonic()+15
 while not (root/(name+'.ready')).exists():
  if time.monotonic()>deadline:raise RuntimeError('parent checkpoint timeout: '+name)
  time.sleep(.05)
def instrument(label):
 for name in ['src/runtime-support.mjs','src/session-metadata.mjs','vendor/broker/reference/approval.mjs','vendor/broker/reference/enrollment.mjs']:
  p=live/name;contents=p.read_text()
  if name=='src/runtime-support.mjs':contents=contents.replace("export const NODE_RANGE","globalThis.__psstLoadedVersion = CONNECTOR_VERSION;\nexport const NODE_RANGE")
  p.write_text('globalThis.__psstReloadGraph ??= {}; globalThis.__psstReloadGraph['+json.dumps(name)+'] = '+json.dumps(label)+';\n'+contents)
install();assert len(json.loads((agent/'settings.json').read_text())['packages'])==1

def cycle(session=None):
 global transcript
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',50,200,0,0));args=['node',cli,'--offline','--no-mcp','--no-skills','--no-context-files','--no-approve','--no-prompt-templates','--no-themes','--no-tools','--provider','upgrade-fixture','--model','faux-1','-e',str(helper)]
 if session:args+=['--session',session]
 proc=subprocess.Popen(args,stdin=slave,stdout=slave,stderr=slave,cwd=home,env=env,start_new_session=True);os.close(slave);output=b''
 def read(seconds=.1):
  nonlocal output
  end=time.monotonic()+seconds
  while time.monotonic()<end:
   if select.select([master],[],[],.1)[0]:
    try:output+=os.read(master,65536)
    except OSError:return
 def send(text):os.write(master,text.encode()+b'\r');read(.2)
 def until(pred,label,timeout=20):
  end=time.monotonic()+timeout
  while time.monotonic()<end:
   read()
   if pred():return
   if proc.poll() is not None:raise RuntimeError('Pi exited before '+label)
  raise RuntimeError('timeout '+label)
 def capture(label):
  send('/psst-status');send('/upgrade-capture '+label);file=root/(label+'.json');until(file.exists,label)
  result=json.loads(file.read_text());event('capture',**result);return result
 try:
  read(2)
  if session:
   until(lambda:b'Psst: connected' in output,'same-session reconnect');last=capture('restarted');checkpoint('restarted');return last
  send('persist this disposable fixture conversation');until(lambda:any(agent.glob('sessions/**/*.jsonl')),'durable native conversation')
  send('/psst-connect '+control['connectionFile']);until(lambda:b'Psst connected. Selection saved' in output,'initial saved connection')
  send('/psst-mode manual');first=capture('old');assert 'native private input' in first['setupDescription'];checkpoint('old_connected')
  for source,label in [('urlSource','url'),('currentSource','current')]:
   shutil.rmtree(live);shutil.copytree(control[source],live,ignore=ignore)
   if label=='current':instrument('first')
   install();before=capture(label+'_before_reload');assert not before['hasDoctor']
   send('/reload');read(1);after=capture(label+'_after_reload');assert after['sessionId']==first['sessionId'];assert after['markers']==1
   if label=='url':assert 'only the broker URL' in after['setupDescription'];checkpoint('url_reloaded')
   else:
    assert after['hasDoctor'];assert set(after['reloadGraph'].values())=={'first'};checkpoint('current_reloaded')
  # Same-path, same-process second upgrade proves transitive modules/version refresh,
  # not merely that the changed top-level entry was re-evaluated.
  shutil.rmtree(live);shutil.copytree(control['currentSource'],live,ignore=ignore);instrument('second')
  manifest=live/'package.json';data=json.loads(manifest.read_text());data['version']='0.6.0-reload-fixture';manifest.write_text(json.dumps(data));install()
  send('/reload');read(1);after=capture('second_reload');assert set(after['reloadGraph'].values())=={'second'};assert after['loadedVersion']=='0.6.0-reload-fixture';assert b'Psst connector 0.6.0-reload-fixture' in output;checkpoint('second_reloaded')
  return first
 finally:
  transcript+=output
  if proc.poll() is None:os.killpg(proc.pid,signal.SIGTERM)
  try:proc.wait(timeout=10)
  except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=5)
  os.close(master)
try:
 first=cycle();last=cycle(first['sessionFile']);assert first['sessionId']==last['sessionId'];assert last['markers']==1;event('complete')
finally:(root/'terminal-output.bin').write_bytes(transcript)
