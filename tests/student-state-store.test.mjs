import test from 'node:test';
import assert from 'node:assert/strict';
import {createStudentStateStore} from '../public/student-state-store.mjs';

test('student BOSS wrong answers persist five HP per transaction above initial maximum',async()=>{
  let current={studentId:1,tokens:0,lotteryTickets:0,petAffection:0,equippedLayout:[],bossProgress:[]};
  const paths=[];
  const publicData={studentPets:{},publicBosses:{boss:{id:'boss',active:true,maxHp:10,attackPassword:'1234',paperId:'paper'}},publicQuestionPapers:{paper:{questions:[{id:'q',options:['yes','no'],answerIndex:0}]}}};
  const store=createStudentStateStore({
    uid:'student-uid',
    transactState:async(update,path)=>{
      paths.push(path);
      update(structuredClone(current)); // A discarded transaction attempt must not double-heal.
      current=update(structuredClone(current));
      return {committed:true,value:structuredClone(current)};
    },
    getPublicData:()=>publicData,now:()=>0
  });
  const command={type:'bossAttack',bossId:'boss',questionId:'q',answerIndex:1,password:'1234'};
  for(const hp of [15,20,25]){
    const result=await store.perform(command);
    assert.equal(current.bossProgress[0].hp,hp);
    assert.equal(result.hp,hp);assert.equal(result.healing,5);
    assert.equal(result.correct,false);
    assert.equal(current.tokens,0);assert.equal(current.lotteryTickets,0);
  }
  assert.deepEqual(paths,Array(3).fill('studentStates/student-uid'));
});

test('student state store applies an operation inside the personal state transaction only',async()=>{
  let current={studentId:1,tokens:0,lotteryTickets:0,petAffection:0,lastPetMoodDate:'',ownedLayout:[],equippedLayout:[],bossProgress:[]};
  const paths=[];
  const store=createStudentStateStore({
    uid:'student-uid',
    transactState:async(update,path)=>{paths.push(path);current=update(structuredClone(current));return {committed:true,value:structuredClone(current)};},
    getPublicData:()=>({studentPets:{},publicBosses:{},publicQuestionPapers:{}}),now:()=>Date.parse('2026-09-20T01:00:00Z')
  });
  const outcome=await store.perform({type:'petMood'});
  assert.deepEqual(paths,['studentStates/student-uid']);
  assert.equal(current.petAffection,1);
  assert.equal(outcome.awarded,true);
});
