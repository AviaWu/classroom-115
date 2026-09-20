import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

import {
  applyPhase2PlanToRoom,
  buildPhase2Plan,
  rollbackPhase2PlanToRoom,
  validatePhase2LiveData,
  validatePhase2Plan,
} from '../scripts/lib/progress-phase2.mjs';

const personalFields=['tokens','lotteryTickets','petAffection','lastPetMoodDate','equippedLayout','bossProgress'];
const personalState=(studentId,overrides={})=>({
  studentId,tokens:studentId*10,lotteryTickets:studentId%3,petAffection:studentId,
  lastPetMoodDate:'',...overrides,
});
const student=(studentId,overrides={})=>({
  id:studentId,gender:studentId%2?'M':'F',name:`student-${studentId}`,
  tokens:studentId*10,lotteryTickets:studentId%3,petAffection:studentId,
  lastPetMoodDate:'',equippedLayout:[],bossProgress:[],...overrides,
});
function fullRoot({studentOverrides={},stateOverrides={},roomOverrides={},rosterOverrides={}}={}){
  const students=Array.from({length:28},(_,index)=>student(index+1,studentOverrides[index+1]||{}));
  const studentRoster={},studentStates={};
  for(let studentId=1;studentId<=28;studentId++){
    const uid=`uid-${studentId}`;
    studentRoster[uid]={studentId,active:true};
    studentStates[uid]=personalState(studentId,stateOverrides[studentId]||{});
  }
  Object.assign(studentRoster,rosterOverrides);
  return {games:{'classroom-115':{progress:{students,theme:'night'},operations:{},...roomOverrides}},studentRoster,studentStates};
}
const roomFrom=root=>structuredClone(root.games['classroom-115']);

test('buildPhase2Plan lists each exact present deletion and reports authoritative divergence',()=>{
  const root=fullRoot({
    studentOverrides:{1:{equippedLayout:['cat'],bossProgress:[]},28:{tokens:999,equippedLayout:[],bossProgress:[]}},
    stateOverrides:{1:{equippedLayout:['cat']},28:{tokens:280}},
  });
  const plan=buildPhase2Plan(root);
  assert.equal(plan.kind,'classroom-115-progress-phase2');
  assert.equal(plan.schemaVersion,1);
  assert.equal(plan.deletions.length,168);
  assert.deepEqual(plan.deletions[0],{path:'games/classroom-115/progress/students/0/tokens',before:10});
  assert.deepEqual(plan.deletions.at(-1),{path:'games/classroom-115/progress/students/27/bossProgress',before:[]});
  assert.equal(plan.deletePatch['games/classroom-115/progress/students/0/tokens'],null);
  assert.deepEqual(plan.rollbackPatch['games/classroom-115/progress/students/0/equippedLayout'],['cat']);
  assert.deepEqual(plan.expectedRoster['uid-1'],{studentId:1,active:true});
  assert.deepEqual(plan.divergences,[{
    path:'games/classroom-115/progress/students/27/tokens',studentId:28,uid:'uid-28',field:'tokens',
    legacyValue:999,authoritativeValue:280,
  }]);
  assert.deepEqual(plan.summary.students,{expected:28,validated:28});
  assert.deepEqual(plan.summary.fields,{approved:168,present:168,absent:0,divergent:1});
  assert.equal(plan.summary.roomBytesBefore>plan.summary.roomBytesAfter,true);
  assert.equal(plan.summary.bytesRemoved,plan.summary.roomBytesBefore-plan.summary.roomBytesAfter);
  assert.match(plan.reviewDigest,/^[a-f0-9]{64}$/);
});

test('buildPhase2Plan accepts Firebase-omitted optional arrays in authoritative states',()=>{
  const plan=buildPhase2Plan(fullRoot());
  assert.equal(plan.summary.fields.present,168);
  assert.equal(plan.summary.fields.absent,0);
  assert.equal(plan.summary.fields.divergent,0);
});

test('buildPhase2Plan rejects missing, duplicate, swapped and out-of-range roster mappings',()=>{
  const cases=[];
  const missing=fullRoot();delete missing.studentRoster['uid-28'];cases.push(missing);
  const duplicate=fullRoot();duplicate.studentRoster['uid-28'].studentId=27;cases.push(duplicate);
  const swapped=fullRoot();[swapped.studentRoster['uid-1'].studentId,swapped.studentRoster['uid-2'].studentId]=[2,1];cases.push(swapped);
  const outOfRange=fullRoot();outOfRange.studentRoster['uid-28'].studentId=29;cases.push(outOfRange);
  for(const root of cases) assert.throws(()=>buildPhase2Plan(root),/roster/i);
});

test('buildPhase2Plan rejects wrong progress ids and malformed or marked authoritative states',()=>{
  const wrongId=fullRoot();wrongId.games['classroom-115'].progress.students[27].id=27;
  assert.throws(()=>buildPhase2Plan(wrongId),/student.*28|index 27/i);
  const missingScalar=fullRoot();delete missingScalar.studentStates['uid-1'].tokens;
  assert.throws(()=>buildPhase2Plan(missingScalar),/tokens/i);
  const malformedArray=fullRoot({stateOverrides:{1:{bossProgress:[{bossId:'boss',hp:-1,passwordVerified:true,defeated:false}]}}});
  assert.throws(()=>buildPhase2Plan(malformedArray),/bossProgress/i);
  const marked=fullRoot({stateOverrides:{1:{_teacherOperation:{id:'busy',createdAt:1,resultJson:'{}'}}}});
  assert.throws(()=>buildPhase2Plan(marked),/_teacherOperation/i);
});

test('buildPhase2Plan refuses active room projection work and in-progress receipts',()=>{
  assert.throws(()=>buildPhase2Plan(fullRoot({roomOverrides:{_projectionSync:{operationId:'busy'}}})),/_projectionSync/i);
  assert.throws(()=>buildPhase2Plan(fullRoot({roomOverrides:{operations:{busy:{phase:'projecting'}}}})),/projecting|receipt/i);
});

test('validatePhase2Plan rejects tampered digests, patches, paths and room identity',()=>{
  const plan=buildPhase2Plan(fullRoot());
  assert.equal(validatePhase2Plan(plan),plan);
  const badDigest=structuredClone(plan);badDigest.reviewDigest='0'.repeat(64);
  assert.throws(()=>validatePhase2Plan(badDigest),/digest/i);
  const badPatch=structuredClone(plan);badPatch.deletePatch[badPatch.deletions[0].path]=false;
  assert.throws(()=>validatePhase2Plan(badPatch),/deletePatch/i);
  const badPath=structuredClone(plan);
  const oldPath=badPath.deletions[0].path,badPathValue=badPath.deletions[0].before;
  badPath.deletions[0].path='games/classroom-115/progress/students/0/name';
  delete badPath.deletePatch[oldPath];delete badPath.rollbackPatch[oldPath];
  badPath.deletePatch[badPath.deletions[0].path]=null;badPath.rollbackPatch[badPath.deletions[0].path]=badPathValue;
  assert.throws(()=>validatePhase2Plan(badPath),/path|approved/i);
  const wrongRoom=structuredClone(plan);wrongRoom.roomPath='games/another-room';
  assert.throws(()=>validatePhase2Plan(wrongRoom),/room/i);
});

test('validatePhase2LiveData detects swapped mappings but accepts newer authoritative values',()=>{
  const preview=fullRoot(),plan=buildPhase2Plan(preview),live=fullRoot();
  live.studentStates['uid-28'].tokens=12345;
  assert.equal(validatePhase2LiveData({room:roomFrom(live),studentRoster:live.studentRoster,studentStates:live.studentStates},plan).status,'ready');
  [live.studentRoster['uid-1'].studentId,live.studentRoster['uid-2'].studentId]=[2,1];
  [live.studentStates['uid-1'].studentId,live.studentStates['uid-2'].studentId]=[2,1];
  assert.throws(()=>validatePhase2LiveData({room:roomFrom(live),studentRoster:live.studentRoster,studentStates:live.studentStates},plan),/roster|mapping/i);
});

test('applyPhase2PlanToRoom deletes only approved copies and is idempotent',()=>{
  const root=fullRoot({studentOverrides:{28:{tokens:999,bossProgress:[{bossId:'boss',hp:5,passwordVerified:true,defeated:false}]}}});
  const plan=buildPhase2Plan(root),beforeRoom=roomFrom(root);
  const compact=applyPhase2PlanToRoom(beforeRoom,plan);
  assert.equal(compact.progress.theme,'night');
  assert.equal(compact.progress.students[27].id,28);
  assert.equal(compact.progress.students[27].name,'student-28');
  for(const member of compact.progress.students) for(const field of personalFields) assert.equal(field in member,false,`${member.id}/${field}`);
  assert.deepEqual(applyPhase2PlanToRoom(compact,plan),compact);
  assert.equal(root.studentStates['uid-28'].tokens,280);
});

test('applyPhase2PlanToRoom rejects stale values, unexpected approved fields and active sync',()=>{
  const root=fullRoot();delete root.games['classroom-115'].progress.students[0].bossProgress;
  const plan=buildPhase2Plan(root);
  const stale=roomFrom(root);stale.progress.students[27].tokens=777;
  assert.throws(()=>applyPhase2PlanToRoom(stale,plan),/changed|stale|tokens/i);
  const extra=roomFrom(root);extra.progress.students[0].bossProgress=[];
  assert.throws(()=>applyPhase2PlanToRoom(extra,plan),/unexpected|bossProgress/i);
  const busy=roomFrom(root);busy._projectionSync={operationId:'busy'};
  assert.throws(()=>applyPhase2PlanToRoom(busy,plan),/_projectionSync/i);
});

test('rollbackPhase2PlanToRoom restores only original copies, preserves later unrelated data and is idempotent',()=>{
  const root=fullRoot({studentOverrides:{1:{tokens:444},28:{equippedLayout:['cat']}}}),plan=buildPhase2Plan(root);
  const compact=applyPhase2PlanToRoom(roomFrom(root),plan);
  compact.progress.theme='dawn';compact.progress.students[0].ownedClothes=['new-shirt'];
  const restored=rollbackPhase2PlanToRoom(compact,plan);
  assert.equal(restored.progress.students[0].tokens,444);
  assert.deepEqual(restored.progress.students[27].equippedLayout,['cat']);
  assert.equal(restored.progress.theme,'dawn');
  assert.deepEqual(restored.progress.students[0].ownedClothes,['new-shirt']);
  assert.deepEqual(rollbackPhase2PlanToRoom(restored,plan),restored);
});

test('rollbackPhase2PlanToRoom refuses conflicting approved values',()=>{
  const root=fullRoot(),plan=buildPhase2Plan(root),compact=applyPhase2PlanToRoom(roomFrom(root),plan);
  compact.progress.students[0].tokens=999;
  assert.throws(()=>rollbackPhase2PlanToRoom(compact,plan),/conflict|tokens|unexpected/i);
});

test('phase-two CLI builds an offline review plan without credentials',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'progress-phase2-preview-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const input=join(directory,'full-root.json'),output=join(directory,'plan.json');
  await writeFile(input,JSON.stringify(fullRoot()));
  const env={...process.env};delete env.FIREBASE_ID_TOKEN;
  const result=spawnSync(process.execPath,['scripts/progress-phase2.mjs','--input',input,'--output',output],{
    cwd:new URL('..',import.meta.url),encoding:'utf8',env,
  });
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/offline preview|review/i);
  const plan=JSON.parse(await readFile(output,'utf8'));
  assert.equal(validatePhase2Plan(plan),plan);
  assert.equal(plan.deletions.length,168);
});

test('offline preview cannot overwrite the full backup or a previously reviewed plan',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'progress-phase2-preserve-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const input=join(directory,'full-root.json'),output=join(directory,'plan.json');
  const backup=JSON.stringify(fullRoot());await writeFile(input,backup);await writeFile(output,'reviewed-plan-to-preserve');
  for(const target of [input,output]){
    const result=spawnSync(process.execPath,['scripts/progress-phase2.mjs','--input',input,'--output',target],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
    assert.equal(result.status,1,result.stderr);
    assert.equal(await readFile(input,'utf8'),backup);
    assert.equal(await readFile(output,'utf8'),'reviewed-plan-to-preserve');
  }
});

test('phase-two CLI refuses every online mode without the explicit apply gate',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'progress-phase2-gate-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const planPath=join(directory,'plan.json');await writeFile(planPath,JSON.stringify(buildPhase2Plan(fullRoot())));
  const base=['scripts/progress-phase2.mjs','--plan',planPath,'--database-url','https://classroom-115-default-rtdb.asia-southeast1.firebasedatabase.app'];
  for(const args of [base,[...base,'--rollback']]){
    const result=spawnSync(process.execPath,args,{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,FIREBASE_ID_TOKEN:'must-not-be-used'}});
    assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/--apply/);
  }
});

test('phase-two CLI requires the exact production URL and teacher token before online access',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'progress-phase2-auth-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const planPath=join(directory,'plan.json');await writeFile(planPath,JSON.stringify(buildPhase2Plan(fullRoot())));
  const badUrl=spawnSync(process.execPath,['scripts/progress-phase2.mjs','--plan',planPath,'--database-url','https://example.firebaseio.com','--apply'],{
    cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,FIREBASE_ID_TOKEN:'secret-value'},
  });
  assert.equal(badUrl.status,1,badUrl.stderr);assert.match(badUrl.stderr,/exact production/i);assert.doesNotMatch(badUrl.stderr,/secret-value/);
  const env={...process.env};delete env.FIREBASE_ID_TOKEN;
  const noToken=spawnSync(process.execPath,['scripts/progress-phase2.mjs','--plan',planPath,'--database-url','https://classroom-115-default-rtdb.asia-southeast1.firebasedatabase.app','--apply'],{
    cwd:new URL('..',import.meta.url),encoding:'utf8',env,
  });
  assert.equal(noToken.status,1,noToken.stderr);assert.match(noToken.stderr,/FIREBASE_ID_TOKEN/);
});
