"""Real native confirmation/cancellation/replacement against disposable authority."""
import json,os,pathlib,pty,subprocess,select,time,signal,sys,re
signal.signal(signal.SIGTERM,lambda *_: (_ for _ in ()).throw(InterruptedError('fixture canceled')))
c=json.loads(pathlib.Path(sys.argv[1]).read_text());root=pathlib.Path(c['directory']);agent=root/'agent';home=root/'home';home.mkdir();agent.mkdir(exist_ok=True)
env={'PATH':os.environ['PATH'],'HOME':str(home),'PI_CODING_AGENT_DIR':str(agent),'PI_OFFLINE':'1','TERM':'xterm-256color','NODE_EXTRA_CA_CERTS':c['cert']}
master,slave=pty.openpty();p=subprocess.Popen(['node',c['piCli'],'--offline','--no-extensions','--no-mcp','--no-skills','--no-context-files','--no-approve','--no-prompt-templates','--no-themes','--no-tools','-e',c['extension']],stdin=slave,stdout=slave,stderr=slave,cwd=home,env=env,start_new_session=True);os.close(slave);output=b''
def read(seconds=.1):
 global output
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if select.select([master],[],[],.05)[0]:
   try:output+=os.read(master,65536)
   except OSError:return

def send(text):os.write(master,text.encode()+b'\r');read(.2)
def until(text,start=0):
 end=time.monotonic()+20
 while time.monotonic()<end:
  read()
  if text in re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]',b'',output[start:]):return
  if p.poll() is not None:raise RuntimeError('native CLI exited')
 raise RuntimeError('native terminal state timed out: '+text.decode())
def checkpoint(name):
 print(json.dumps({'event':name}),flush=True);end=time.monotonic()+15
 while not (root/(name+'.ready')).exists():
  if time.monotonic()>end:raise RuntimeError('parent checkpoint timed out')
  read()
def replacement():
 start=len(output);send('/psst-setup');until(b'broker HTTPS URL',start);send(c['brokerUrl']);until(b'Request replacement authorization?',start)
try:
 read(2);send('/psst-connect '+c['connectionFile']);until(b'Psst connected. Selection saved');checkpoint('connected')
 replacement();os.write(master,b'\x1b');read(.4);checkpoint('cancelled')
 replacement();send('');until(b'pending administrator approval');checkpoint('pending')
 until(b'authorization denied');checkpoint('denied')
 send('/reload');read(1);send('/psst-status');read(.5);checkpoint('reloaded')
 print(json.dumps({'event':'complete'}),flush=True)
finally:
 (root/'terminal-output.bin').write_bytes(output)
 if p.poll() is None:os.killpg(p.pid,signal.SIGTERM)
 try:p.wait(timeout=10)
 except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
 os.close(master)
