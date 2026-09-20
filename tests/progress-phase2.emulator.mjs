import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeProgress} from '../public/game-operations.mjs';
import {createStudentProjections} from '../public/student-projections.mjs';
import {createFirebaseStore} from '../public/firebase-store.mjs';
import {createFirebaseRestClient} from '../public/firebase-rest-client.mjs';
import {createStudentStateStore} from '../public/student-state-store.mjs';
import {buildPhase2Plan,validatePhase2LiveData,applyPhase2PlanToRoom,rollbackPhase2PlanToRoom} from '../scripts/lib/progress-phase2.mjs';

const host=process.env.FIREBASE_DATABASE_EMULATOR_HOST;
if(!host||!/^127\.0\.0\.1:\d+$/.test(host)) throw new Error('Local database emulator required');
const project='demo-classroom-sync',namespace=`${project}-default-rtdb`,origin=`http://${host}`,roomPath='games/classroom-115';
const endpoint=path=>`${origin}/${path}.json?ns=${namespace}`;
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
function token(uid,email){
  const now=Math.floor(Date.now()/1000);
  return `${encode({alg:'none',typ:'JWT'})}.${encode({iss:`https://securetoken.google.com/${project}`,aud:project,iat:now,exp:now+3600,auth_time:now,sub:uid,user_id:uid,email,firebase:{sign_in_provider:'password',identities:{email:[email]}}})}.`;
}
const teacherToken=token('teacher','teacher@classroom-115.local');
const client=auth=>createFirebaseRestClient({databaseURL:origin,getToken:async()=>auth,fetch:(input,options)=>{
  const url=new URL(input);url.searchParams.set('ns',namespace);return fetch(url,options);
}});
const teacher=client(teacherToken);
const fields=['tokens','lotteryTickets','petAffection','lastPetMoodDate','equippedLayout','bossProgress'];
function fixture(){
  const progress=normalizeProgress({students:Array.from({length:28},(_,index)=>({
    id:index+1,gender:'M',tokens:100,lotteryTickets:2,petAffection:9,lastPetMoodDate:'',
    ownedClothes:['shirt'],equippedClothes:'shirt',ownedBg:['sky'],equippedBg:'sky',ownedLayout:['cat'],equippedLayout:['cat'],
    bossProgress:[{bossId:'retired',hp:Number.MAX_SAFE_INTEGER,passwordVerified:false,defeated:false}],
  })),clothesM:[{id:'shirt',name:'上衣',price:0},{id:'new-shirt',name:'新衣',price:40}],
    layouts:[{id:'cat',name:'貓',image:'/cat.png',level:'R',price:30},{id:'dog',name:'狗',image:'/dog.png',level:'R',price:30}],
    backgrounds:[{id:'sky',name:'天空',price:0},{id:'new-bg',name:'新背景',price:20}],
    tasks:[{id:'task',title:'任務',reward:15}],
    bosses:[{id:'boss',name:'王',image:'/boss.png',maxHp:5,reward:20,rewardTickets:1,attackPassword:'1234',paperId:'paper',active:true}],
    questionPapers:[{id:'paper',name:'試卷',questions:[{id:'q',text:'題目',options:['對','錯'],answerIndex:0}]}]});
  const mapping=Object.fromEntries(progress.students.map(student=>[student.id,`uid-${student.id}`]));
  return {games:{'classroom-115':{progress}},...createStudentProjections(progress,mapping),unrelated:{keep:'unchanged'}};
}
async function ownerPut(path,value){
  const response=await fetch(endpoint(path),{method:'PUT',headers:{Authorization:'Bearer owner'},body:typeof value==='string'?value:JSON.stringify(value)});
  assert.equal(response.status,200,await response.text());
}
before(async()=>ownerPut('.settings/rules',await readFile(new URL('../database.rules.phase1.json',import.meta.url),'utf8')));
function createTeacherStore(){
  return createFirebaseStore({databaseURL:origin,getToken:async()=>teacherToken,getUid:()=> 'teacher',
    readRoot:()=>teacher.read(''),readProgress:()=>teacher.read(`${roomPath}/progress`),
    readRoomMetadata:async()=>({restoredAt:await teacher.read(`${roomPath}/restoredAt`)}),
    readEquipmentCatalogues:()=>teacher.read(`${roomPath}/progress`),
    writeRoot:async updates=>{
      const response=await fetch(`${endpoint('')}&auth=${encodeURIComponent(teacherToken)}`,{method:'PATCH',body:JSON.stringify(updates)});
      assert.equal(response.status,200,await response.text());
    },
    transactRoom:updater=>teacher.transact(roomPath,updater),
    transactProgressStudent:(id,updater)=>teacher.transact(`${roomPath}/progress/students/${id-1}`,updater),
    transactStudentState:(uid,updater)=>teacher.transact(`studentStates/${uid}`,updater)});
}
async function assertCompact(){
  const progress=await teacher.read(`${roomPath}/progress`);
  assert.equal(progress.students.length,28);
  for(const [index,student] of progress.students.entries()){
    assert.equal(student.id,index+1);
    for(const field of fields) assert.equal(Object.hasOwn(student,field),false,`${student.id}/${field}`);
  }
}

test('phase two: preview, ETag migration, teacher/student play, full backup restore, scoped rollback',async()=>{
  await ownerPut('',fixture());
  const original=await teacher.read(''),plan=buildPhase2Plan(original),store=createTeacherStore();
  assert.equal(plan.deletions.length,168);
  validatePhase2LiveData({room:original.games['classroom-115'],studentRoster:original.studentRoster,studentStates:original.studentStates},plan);
  await teacher.transact(roomPath,current=>applyPhase2PlanToRoom(current,plan));
  await assertCompact();
  assert.deepEqual(await teacher.read('studentStates'),original.studentStates);
  for(const studentId of [27,28]){
    for(const [kind,items] of [['clothes',[null,'shirt']],['background',[null,'sky']]]) for(const itemId of items){
      await store.execute({id:`equip-${studentId}-${kind}-${itemId}`,createdAt:Date.now(),command:{type:'equip',studentId,kind,itemId}});
    }
  }
  const perform=async(id,command)=>{
    const result=await store.execute({id,createdAt:Date.now(),command:{studentId:28,...command}});
    await assertCompact();return result;
  };
  for(const [kind,itemId] of [['clothes','new-shirt'],['layout','dog'],['background','new-bg']]) await perform(`buy-${kind}`,{type:'purchase',kind,itemId});
  await perform('complete-task',{type:'completeTask',taskId:'task'});
  const lottery=await perform('lottery',{type:'lottery',roll:0,indexRoll:0});
  assert.equal(lottery.result.duplicate,true);
  assert.equal((await teacher.read('studentStates/uid-28')).tokens,45);
  await perform('teacher-mood',{type:'petMood'});
  assert.equal((await teacher.read('studentStates/uid-28')).tokens,55);
  const student=client(token('uid-28','student-28@classroom-115.local'));
  const publicData={studentPets:await student.read('studentPets/uid-28'),publicBosses:await student.read('publicBosses'),publicQuestionPapers:await student.read('publicQuestionPapers')};
  const studentStore=createStudentStateStore({uid:'uid-28',transactState:(updater,path)=>student.transact(path,updater),getPublicData:()=>publicData});
  assert.equal((await studentStore.perform({type:'petMood'})).awarded,false);
  await studentStore.perform({type:'equipPet',petId:'dog'});
  const attack={type:'bossAttack',bossId:'boss',questionId:'q',answerIndex:0};
  await assert.rejects(studentStore.perform({...attack,password:'0000'}),/密碼/);
  assert.equal((await studentStore.perform({...attack,password:'1234'})).reward,20);
  await assertCompact();
  const backup=await store.readCompleteProgress();
  assert.equal(backup.students[27].tokens,75);
  assert.deepEqual(backup.students[27].equippedLayout,['dog']);
  assert.equal(backup.students[27].bossProgress.find(item=>item.bossId==='boss').hp,0);
  assert.equal(backup.students[27].bossProgress.find(item=>item.bossId==='retired').hp,Number.MAX_SAFE_INTEGER);
  await perform('teacher-resources',{type:'resources',field:'tokens',mode:'add',amount:100});
  const restored=await perform('full-restore',{type:'restore',value:backup});
  assert.equal(restored.progress.students[27].tokens,75);
  assert.deepEqual(restored.progress.students[27].equippedLayout,['dog']);
  assert.deepEqual(restored.progress.students[27].ownedClothes,['shirt','new-shirt']);
  assert.deepEqual(restored.progress.students[27].ownedBg,['sky','new-bg']);
  const beforeRollback=await teacher.read('');
  await teacher.transact(roomPath,current=>rollbackPhase2PlanToRoom(current,plan));
  const rolled=await teacher.read('');
  assert.deepEqual(rolled.studentStates,beforeRollback.studentStates);
  assert.deepEqual(rolled.studentPets,beforeRollback.studentPets);
  assert.deepEqual(rolled.publicBosses,beforeRollback.publicBosses);
  assert.deepEqual(rolled.publicQuestionPapers,beforeRollback.publicQuestionPapers);
  assert.deepEqual(rolled.studentRoster,original.studentRoster);
  assert.deepEqual(rolled.unrelated,original.unrelated);
  assert.equal(rolled.games['classroom-115'].progress.students[27].tokens,100); // Original legacy copy only.
  assert.equal((await store.readCompleteProgress()).students[27].tokens,75); // Personal state stays authoritative.
  assert.deepEqual(rolled.games['classroom-115'].progress.students[27].ownedClothes,['shirt','new-shirt']);
  assert.equal(rolled.studentStates['uid-29'],undefined);assert.equal(rolled.studentStates['uid-30'],undefined);
});

test('compact backup restore can re-own and equip a pet removed after the backup',async()=>{
  await ownerPut('',fixture());
  const original=await teacher.read(''),plan=buildPhase2Plan(original),store=createTeacherStore();
  await teacher.transact(roomPath,current=>applyPhase2PlanToRoom(current,plan));
  const backup=await store.readCompleteProgress();
  await store.execute({id:'remove-owned-pets',createdAt:Date.now(),command:{type:'resetCloset',studentId:28}});
  assert.equal(await teacher.read('studentPets/uid-28'),null);
  const restored=await store.execute({id:'restore-removed-pet',createdAt:Date.now(),command:{type:'restore',value:backup}});
  assert.deepEqual(restored.progress.students[27].equippedLayout,['cat']);
  assert.deepEqual((await teacher.read('studentStates/uid-28')).equippedLayout,['cat']);
  assert.equal((await teacher.read('studentPets/uid-28')).cat.id,'cat');
  assert.equal((await teacher.read(roomPath))._projectionSync,undefined);
  await assertCompact();
});
