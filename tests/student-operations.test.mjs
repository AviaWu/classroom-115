import test from 'node:test';
import assert from 'node:assert/strict';
import {applyStudentOperation} from '../public/student-operations.mjs';

const state=()=>({studentId:1,tokens:0,lotteryTickets:0,petAffection:9,lastPetMoodDate:'',ownedLayout:['pet'],equippedLayout:['pet'],bossProgress:[]});
const publicData={
  studentPets:{pet:{id:'pet',level:'R'}},
  publicBosses:{boss:{id:'boss',maxHp:10,reward:5,rewardTickets:1,attackPassword:'1234',paperId:'paper',active:true}},
  publicQuestionPapers:{paper:{id:'paper',questions:[{id:'q',text:'題目',options:['甲','乙'],answerIndex:0}]}}
};

test('daily pet mood increases affection once and awards the level bonus',()=>{
  const result=applyStudentOperation(state(),{type:'petMood'},publicData,Date.parse('2026-09-20T01:00:00Z'));
  assert.equal(result.state.petAffection,10);assert.equal(result.state.tokens,10);
  assert.deepEqual(result.result,{awarded:true,bonus:10,level:2});
});

test('student can equip only an owned pet',()=>{
  const withoutOwnedList={...state()};delete withoutOwnedList.ownedLayout;
  const equipped=applyStudentOperation(withoutOwnedList,{type:'equipPet',petId:'pet'},publicData,0);
  assert.deepEqual(equipped.state.equippedLayout,['pet']);
  const result=applyStudentOperation(withoutOwnedList,{type:'equipPet',petId:null},publicData,0);
  assert.deepEqual(result.state.equippedLayout,[]);
  assert.throws(()=>applyStudentOperation(withoutOwnedList,{type:'equipPet',petId:'other'},publicData,0),/尚未擁有/);
});

test('student wrong answers add five to current boss HP repeatedly without a maximum',()=>{
  const command={type:'bossAttack',bossId:'boss',password:'1234',questionId:'q',answerIndex:1};
  for(const initialHp of [3,10,14]){
    const original={...state(),bossProgress:[{bossId:'boss',hp:initialHp,passwordVerified:false,defeated:false}]};
    let current=original;
    for(let attempt=1;attempt<=3;attempt++){
      const outcome=applyStudentOperation(current,command,publicData,0);
      assert.equal(outcome.state.bossProgress[0].hp,initialHp+5*attempt);
      assert.deepEqual(outcome.result,{correct:false,damage:0,healing:5,hp:initialHp+5*attempt,defeated:false,reward:0,rewardTickets:0,passwordVerified:true});
      assert.deepEqual(outcome.state.bossProgress[0].answeredQuestionIds,[]);
      assert.equal(outcome.state.tokens,0);assert.equal(outcome.state.lotteryTickets,0);
      current=outcome.state;
    }
    assert.equal(original.bossProgress[0].hp,initialHp);
  }
  const first=applyStudentOperation(state(),command,publicData,0);
  assert.equal(first.state.bossProgress[0].hp,15);
});

test('boss attack verifies the first password and grants personal completion rewards',()=>{
  const result=applyStudentOperation(state(),{type:'bossAttack',bossId:'boss',password:'1234',questionId:'q',answerIndex:0},publicData,0);
  assert.equal(result.state.bossProgress[0].hp,5);assert.equal(result.result.correct,true);
});

test('boss attack restores an answered-question array omitted by Firebase',()=>{
  const current={...state(),bossProgress:[{bossId:'boss',hp:10,passwordVerified:true,defeated:false}]};
  const result=applyStudentOperation(current,{type:'bossAttack',bossId:'boss',password:'',questionId:'q',answerIndex:0},publicData,0);
  assert.equal(result.state.bossProgress[0].hp,5);
  assert.deepEqual(result.state.bossProgress[0].answeredQuestionIds,['q']);
});
