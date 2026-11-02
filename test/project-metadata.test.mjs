import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMetadata } from '../src/project-metadata.mjs';
test('project label uses explicit configuration then one configured environment value then native basename', () => {
 const env={AI_AGENTS_SANDBOX_PROJECT_NAME:'ai-agents-sandbox-prj',CUSTOM_PROJECT:'custom'};
 assert.equal(projectMetadata({},env,'/private/workspace'),'ai-agents-sandbox-prj');
 assert.equal(projectMetadata({project:'explicit'},env),'explicit');
 assert.equal(projectMetadata({projectEnv:'CUSTOM_PROJECT'},env),'custom');
 assert.equal(projectMetadata({projectEnv:'missing'},{...env,PSST_PROJECT_ENV:'CUSTOM_PROJECT'}),'custom');
 assert.equal(projectMetadata({}, {}, '/private/project'),'project');
 assert.equal(projectMetadata({}, {}),null);
 assert.equal(projectMetadata({}, {}, '/'),null);
 assert.equal(projectMetadata({}, {AI_AGENTS_SANDBOX_PROJECT_NAME:'  '}),null);
});
test('project selection never enumerates environment or reads unrelated secrets', () => {
 const reads=[]; const env=new Proxy({AI_AGENTS_SANDBOX_PROJECT_NAME:'project'}, {get(o,k){reads.push(k);return o[k];},ownKeys(){throw Error('no enumeration');}});
 assert.equal(projectMetadata({},env),'project');
 assert.deepEqual(reads,['PSST_PROJECT_ENV','AI_AGENTS_SANDBOX_PROJECT_NAME']);
});
test('invalid selector and malformed project values fail without including the value in errors', () => {
 for(const key of ['', 'TOKEN/KEY', 'x'.repeat(129)])assert.throws(()=>projectMetadata({projectEnv:key},{}),/^Error: invalid_project_environment$/);
 for(const value of ['secret\nvalue','x'.repeat(257),'bad\u202ename','\ud800',17])assert.throws(()=>projectMetadata({}, {AI_AGENTS_SANDBOX_PROJECT_NAME:value}),/^Error: invalid_project_metadata$/);
});
