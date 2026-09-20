import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('projection build script writes a reviewable Firebase payload without network access',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'classroom-projection-'));
  const progress={students:[{id:1,tokens:10,ownedLayout:[],equippedLayout:[],bossProgress:[]}],layouts:[],bosses:[],questionPapers:[]};
  const input=join(directory,'progress.json'),roster=join(directory,'roster.json'),output=join(directory,'payload.json');
  await writeFile(input,JSON.stringify(progress));
  await writeFile(roster,JSON.stringify({'1':'uid-one'}));
  const result=spawnSync(process.execPath,['scripts/build-student-projections.mjs','--progress',input,'--roster',roster,'--output',output],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/dry-run/);
  const payload=JSON.parse(await readFile(output,'utf8'));
  assert.deepEqual(payload.studentRoster['uid-one'],{studentId:1,active:true});
  assert.equal(payload.studentStates['uid-one'].tokens,10);
  await rm(directory,{recursive:true,force:true});
});

test('projection apply script refuses writes until its explicit apply gate and payload checks pass',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'classroom-projection-apply-'));
  const payload=join(directory,'payload.json');
  await writeFile(payload,JSON.stringify({studentRoster:{},studentStates:{},studentPets:{},publicBosses:{},publicQuestionPapers:{}}));
  const base=['scripts/apply-student-projections.mjs','--payload',payload,'--database-url','https://example.firebaseio.com'];
  const blocked=spawnSync(process.execPath,base,{cwd:new URL('..',import.meta.url),encoding:'utf8'});
  assert.equal(blocked.status,1,blocked.stderr);
  assert.match(blocked.stderr,/--apply/);
  await writeFile(payload,JSON.stringify({games:{'classroom-115':{progress:{}}}}));
  const malformed=spawnSync(process.execPath,[...base,'--apply'],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,FIREBASE_ID_TOKEN:'test-token'}});
  assert.equal(malformed.status,1,malformed.stderr);
  assert.match(malformed.stderr,/must contain exactly/);
  await rm(directory,{recursive:true,force:true});
});

test('auth export builds an exact student 1 through 28 UID map',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'classroom-auth-roster-'));
  const input=join(directory,'auth.json'),output=join(directory,'roster.json');
  const users=Array.from({length:28},(_,index)=>({localId:`uid-${index+1}`,email:`student-${index+1}@classroom-115.local`}));
  users.push({localId:'teacher',email:'teacher@classroom-115.local'},{localId:'anonymous'});
  await writeFile(input,JSON.stringify({users}));
  const result=spawnSync(process.execPath,['scripts/build-student-uid-map.mjs','--auth-export',input,'--output',output],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const roster=JSON.parse(await readFile(output,'utf8'));
  assert.equal(Object.keys(roster).length,28);
  assert.equal(roster['1'],'uid-1');assert.equal(roster['28'],'uid-28');
  await rm(directory,{recursive:true,force:true});
});
