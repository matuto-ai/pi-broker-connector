"""Two genuine bundled Pi TUIs. All identities/mail are disposable local fixtures.
The official faux provider invokes native broker_send; this driver only types
human input and observes native journals, model calls, and real inbox receipts.
"""
import os, pty, subprocess, pathlib, select, time, json, signal, sys, sqlite3, fcntl, termios, struct
signal.signal(signal.SIGTERM,lambda *_: (_ for _ in ()).throw(InterruptedError('fixture canceled')))
control=json.loads(pathlib.Path(sys.argv[1]).read_text())
root=pathlib.Path(control['directory']);agent=root/'agent';agent.mkdir(mode=0o700)
clients=[]
def event(name,**data):print(json.dumps({'event':name,**data}),flush=True)
class Pi:
 def __init__(self,name):
  self.name=name;self.home=root/('home-'+name);self.home.mkdir(exist_ok=True)
  self.log=root/(name+'-events.jsonl');self.statefile=root/(name+'-state.json');self.output=b''
  self.master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,140,0,0))
  env={'PATH':os.environ['PATH'],'HOME':str(self.home),'PI_CODING_AGENT_DIR':str(agent),'PI_OFFLINE':'1','TERM':'xterm-256color','NODE_EXTRA_CA_CERTS':control['cert'],'FIXTURE_LOG':str(self.log),'FIXTURE_STATE':str(self.statefile)}
  args=['node',control['piCli'],'--offline','--no-extensions','--no-mcp','--no-skills','--no-context-files','--no-approve','--no-prompt-templates','--no-themes','-e',control['extension'],'-e',control['fixture'],'--model','faux/faux-1']
  self.proc=subprocess.Popen(args,stdin=slave,stdout=slave,stderr=slave,env=env,cwd=self.home,start_new_session=True);os.close(slave);clients.append(self)
 def read(self):
  if select.select([self.master],[],[],0)[0]:
   try:self.output+=os.read(self.master,65536)
   except OSError:pass
 def type(self,text):os.write(self.master,text.encode() if isinstance(text,str) else text)
 def command(self,text):self.type(text+'\r')
 def state(self):
  try:return json.loads(self.statefile.read_text())
  except (ValueError,FileNotFoundError):return {}
 def logs(self):
  try:return [json.loads(x) for x in self.log.read_text().splitlines()]
  except (ValueError,FileNotFoundError):return []
 def close(self):
  if self.proc.poll() is None:
   self.command('/quit');until(lambda:self.proc.poll() is not None,'clean Pi shutdown')
  self.read();(root/(self.name+'-terminal.bin')).write_bytes(self.output)
def pump(seconds=.05):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  for p in clients:p.read()
  time.sleep(.01)
def until(predicate,label,timeout=25):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  pump()
  if predicate():return
 raise RuntimeError('Timed out: '+label)
def identity(session):
 for file in agent.glob('psst/**/identity.json'):
  saved=json.loads(file.read_text())
  if saved.get('hostSessionId')==session:return saved['identity']['client_id']
def inbox(marker):
 for file in agent.glob('psst/**/inbox.sqlite'):
  con=sqlite3.connect('file:'+str(file)+'?mode=ro',uri=True,timeout=.1)
  try:
   for state,receipt,envelope in con.execute('SELECT state,native_receipt,envelope FROM inbox'):
    if json.loads(envelope)['content']['text']==marker:return state,receipt
  finally:con.close()
 return None
def rows(p):
 file=p.state().get('file')
 try:return [json.loads(x) for x in pathlib.Path(file).read_text().splitlines()]
 except (TypeError,ValueError,FileNotFoundError):return []
def received(p,marker):
 found=[r for r in rows(p) if r.get('type')=='custom_message' and r.get('customType')=='psst-agent-message' and marker in r.get('content','')]
 observed=any(x['event']=='model' and marker in json.dumps(x.get('last')) and 'Broker message from AI agent ' in json.dumps(x.get('last')) for x in p.logs())
 if found:assert found[0]['content'].startswith('Broker message from AI agent ')
 receipt=inbox(marker)
 return len(found)==1 and observed and receipt is not None and str(receipt[1]).startswith('pi:') and p.state().get('idle')
def send(p,recipient,marker):
 p.command('SEND '+json.dumps({'recipient_id':recipient,'text':marker}))
 def sent():
  journal=rows(p);calls=[c['id'] for r in journal for c in r.get('message',{}).get('content',[]) if isinstance(c,dict) and c.get('type')=='toolCall' and c.get('name')=='broker_send' and c.get('arguments',{}).get('text')==marker]
  results=[r['message'] for r in journal if r.get('message',{}).get('role')=='toolResult' and r['message'].get('toolCallId') in calls]
  if results:assert not results[-1].get('isError'),results[-1]
  return len(results)==1 and p.state().get('idle')
 until(sent,'native broker_send journal '+marker)
def guarded(p,marker,calls):
 until(lambda:inbox(marker) is not None,'transport queue '+marker)
 pump(1.2)
 assert inbox(marker)[0]=='pending',(marker,inbox(marker))
 assert p.state()['calls']==calls,(marker,'model ran across human boundary')
 assert not any(r.get('customType')=='psst-agent-message' and marker in r.get('content','') for r in rows(p))
try:
 a=Pi('a');until(lambda:a.state().get('session'),'first native startup')
 a.command('/psst-setup');until(lambda:b'broker HTTPS URL' in a.output,'setup URL');a.command(control['brokerUrl'])
 until(lambda:b'pending administrator approval' in a.output,'pending request');event('pending')
 until(lambda:b'installation connected' in a.output,'approved connection')
 a.command('SESSION_A');until(lambda:a.state().get('calls',0)>=1 and a.state().get('idle'),'first saved conversation')
 aid=a.state()['session'];until(lambda:identity(aid),'first identity');ac=identity(aid)
 b=Pi('b');until(lambda:b.state().get('session') and b'Psst: connected' in b.output,'second native startup')
 b.command('SESSION_B');until(lambda:b.state().get('calls',0)>=1 and b.state().get('idle'),'second saved conversation')
 bc=identity(b.state()['session']);assert ac and bc and ac!=bc
 send(a,bc,'A_TO_B');until(lambda:received(b,'A_TO_B'),'automatic native B receipt/model')
 send(b,ac,'B_TO_A');until(lambda:received(a,'B_TO_A'),'automatic native A receipt/model');event('roundtrip')
 # Actual TUI draft stays untouched while transport accepts the next message.
 a.type('unfinished human draft');until(lambda:a.state().get('draft')=='unfinished human draft','human draft')
 count=a.state()['calls'];send(b,ac,'DRAFT_BLOCKED');guarded(a,'DRAFT_BLOCKED',count)
 assert a.state()['draft']=='unfinished human draft';a.type(b'\x15');until(lambda:a.state().get('draft')=='','clear draft')
 until(lambda:received(a,'DRAFT_BLOCKED'),'draft recovery');event('draft_guard')
 prompts=sum(x['event']=='prompt_start' for x in a.logs());ends=sum(x['event']=='prompt_end' for x in a.logs())
 a.command('/fixture-confirm');until(lambda:sum(x['event']=='prompt_start' for x in a.logs())==prompts+1,'real confirmation opens')
 count=a.state()['calls'];send(b,ac,'PROMPT_BLOCKED');guarded(a,'PROMPT_BLOCKED',count)
 a.type(b'\x1b');until(lambda:sum(x['event']=='prompt_end' for x in a.logs())==ends+1,'human closes prompt')
 until(lambda:received(a,'PROMPT_BLOCKED'),'prompt recovery');event('prompt_guard')
 a.command('HOLD_FOR_ABORT');until(lambda:any(x['event']=='holding' for x in a.logs()),'model running before abort')
 a.type(b'\x1b');until(lambda:any(x['event']=='settled' and x.get('aborted') for x in a.logs()),'real human Escape abort')
 until(lambda:a.state().get('idle'),'abort idle');count=a.state()['calls']
 send(b,ac,'ABORT_BLOCKED');guarded(a,'ABORT_BLOCKED',count)
 a.command('continue');until(lambda:received(a,'ABORT_BLOCKED'),'explicit human recovery');event('abort_guard')
 # Reopen through the real /resume picker, not --session or a fixture SDK call.
 original=a.state()['file'];a.close();send(b,ac,'OFFLINE_QUEUED');pump(.5)
 a=Pi('a');until(lambda:a.state().get('session')!=aid and b'Psst: connected' in a.output,'fresh reopened UI')
 a.command('/resume');until(lambda:b'Resume Session' in a.output,'actual resume selector');a.type('SESSION_A');pump(.3);a.type(b'\r')
 until(lambda:a.state().get('session')==aid,'same conversation selected');assert a.state()['file']==original
 until(lambda:received(a,'OFFLINE_QUEUED'),'queued offline automatic native receipt')
 assert identity(aid)==ac;event('resumed_offline',sameSession=True)
 for marker in ['B_TO_A','DRAFT_BLOCKED','PROMPT_BLOCKED','ABORT_BLOCKED','OFFLINE_QUEUED']:
  assert len([r for r in rows(a) if r.get('customType')=='psst-agent-message' and marker in r.get('content','')])==1
 a.type('preserve draft after revocation');until(lambda:a.state().get('draft')=='preserve draft after revocation','revocation draft')
 count=a.state()['calls'];send(b,ac,'REVOKED_PENDING');guarded(a,'REVOKED_PENDING',count)
 event('revoke_pending');until(lambda:(root/'revoked').exists(),'admin revocation')
 until(lambda:b'Psst: unauthenticated' in a.output or b'Psst: forbidden' in a.output or b'Psst: session_closed' in a.output,'revoked transport stops')
 assert a.state()['draft']=='preserve draft after revocation';a.type(b'\x15');until(lambda:a.state().get('draft')=='','clear revoked draft')
 guarded(a,'REVOKED_PENDING',count);assert identity(aid)==ac;event('revoked_guard')
 a.close();b.close();event('complete')
except BaseException as error:
 event('failure',reason=str(error));raise
finally:
 for p in clients:
  p.read();(root/(p.name+'-terminal.bin')).write_bytes(p.output)
  if p.proc.poll() is None:
   os.killpg(p.proc.pid,signal.SIGTERM)
   try:p.proc.wait(timeout=5)
   except subprocess.TimeoutExpired:os.killpg(p.proc.pid,signal.SIGKILL);p.proc.wait()
  os.close(p.master)
