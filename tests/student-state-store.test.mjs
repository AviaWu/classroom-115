import test from 'node:test';
import assert from 'node:assert/strict';
import {createStudentStateStore} from '../public/student-state-store.mjs';

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
