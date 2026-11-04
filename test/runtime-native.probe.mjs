// Actual unsupported Node and the official bundled host, not a mocked version.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile),host=process.env.PI_TEST_INSTALL,node22=process.env.PI_TEST_UNSUPPORTED_NODE;
if(!host||!node22)throw Error('Set PI_TEST_INSTALL and PI_TEST_UNSUPPORTED_NODE to pinned official fixtures');
test('installed connector on actual Node22 reports unsupported before runtime graph or state effects',{timeout:30000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'pi-unsupported-native-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const extension=join(root,'package');for(const folder of ['extensions','src'])mkdirSync(join(extension,folder),{recursive:true});
 for(const file of ['package.json','extensions/psst.ts','src/runtime-support.mjs'])copyFileSync(resolve(file),join(extension,file));
 writeFileSync(join(extension,'src/extension.mjs'),"throw Error('FORBIDDEN_RUNTIME_GRAPH');");
 const agent=join(root,'agent'),state=join(agent,'psst');mkdirSync(state,{recursive:true});
 // Corrupt/private existing bytes must not even be opened as SQLite on this path.
 const sentinel='unchanged existing selection';writeFileSync(join(state,'selection.sqlite'),sentinel,{mode:0o600});
 const control={root,agent,node22:resolve(node22),cli:join(resolve(host),'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),extension:join(extension,'extensions/psst.ts')};
 const file=join(root,'control.json');writeFileSync(file,JSON.stringify(control));
 await execute('python3',['-c',String.raw`
import json,os,pathlib,pty,subprocess,select,time,signal,sys,re
signal.signal(signal.SIGTERM,lambda *_: (_ for _ in ()).throw(InterruptedError('fixture canceled')))
c=json.loads(pathlib.Path(sys.argv[1]).read_text());master,slave=pty.openpty();env={'PATH':os.environ['PATH'],'HOME':c['root'],'PI_CODING_AGENT_DIR':c['agent'],'PI_OFFLINE':'1','TERM':'xterm-256color'}
p=subprocess.Popen([c['node22'],c['cli'],'--offline','--no-extensions','--no-mcp','--no-skills','--no-context-files','--no-approve','--no-prompt-templates','--no-themes','--no-tools','-e',c['extension']],stdin=slave,stdout=slave,stderr=slave,cwd=c['root'],env=env,start_new_session=True);os.close(slave);output=b''
def read(seconds):
 global output
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if select.select([master],[],[],.1)[0]:
   try:output+=os.read(master,65536)
   except OSError:return
try:
 read(2)
 for command in ['/psst-setup','/psst-status','/psst-doctor','/psst-connect']:
  os.write(master,command.encode()+b'\r');read(.3)
 text=re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]',b'',output)
 assert b'Node 22.22.2' in text
 assert b'>=24.19.0 <25' in text
 assert b'Unsupported runtime' in text
 assert b'No enrollment or storage changes' in text
 assert b'FORBIDDEN_RUNTIME_GRAPH' not in text
 assert b'broker HTTPS URL' not in text
finally:
 if p.poll() is None:os.killpg(p.pid,signal.SIGTERM)
 try:p.wait(timeout=10)
 except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
 os.close(master)
`,file],{timeout:20000});
 assert.deepEqual(readdirSync(state),['selection.sqlite']);assert.equal(readFileSync(join(state,'selection.sqlite'),'utf8'),sentinel);
});
