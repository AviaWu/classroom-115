import test from 'node:test';
import assert from 'node:assert/strict';
import {createStudentProjections,studentProjectionToProgress} from '../public/student-projections.mjs';

const progress={
  students:[
    {id:1,tokens:10,lotteryTickets:2,petAffection:3,lastPetMoodDate:'2026-09-20',ownedLayout:['pet-a'],equippedLayout:['pet-a'],bossProgress:[]},
    {id:2,tokens:20,lotteryTickets:1,petAffection:0,lastPetMoodDate:'',ownedLayout:[],equippedLayout:[],bossProgress:[]},
    ...Array.from({length:25},(_,index)=>({id:index+3,tokens:0,lotteryTickets:0,petAffection:0,lastPetMoodDate:'',ownedLayout:[],equippedLayout:[],bossProgress:[]})),
    {id:28,tokens:280,lotteryTickets:8,petAffection:8,lastPetMoodDate:'2026-09-20',ownedLayout:['pet-a'],equippedLayout:['pet-a'],bossProgress:[]},
  ],
  layouts:[{id:'pet-a',name:'測試寵物',image:'/pet.png',level:'R',active:true}],
  bosses:[{id:'boss-a',name:'BOSS',image:'/boss.png',maxHp:10,reward:5,rewardTickets:1,attackPassword:'1234',paperId:'paper-a',active:true}],
  questionPapers:[{id:'paper-a',questions:[{id:'q1',text:'題目',options:['甲','乙'],answerIndex:0}],name:'考卷'}]
};

test('projects progress/students/0 to student 1 and progress/students/27 to student 28',()=>{
  const result=createStudentProjections(progress,{1:'uid-1',28:'uid-28'});
  assert.equal(result.studentStates['uid-1'].studentId,1);
  assert.equal(result.studentStates['uid-1'].tokens,10);
  assert.equal(Object.hasOwn(result.studentStates['uid-1'],'ownedLayout'),false);
  assert.equal(result.studentStates['uid-28'].studentId,28);
  assert.equal(result.studentStates['uid-28'].tokens,280);
});

test('only rostered students are projected and unassigned accounts have no state',()=>{
  const result=createStudentProjections(progress,{1:'uid-1',28:'uid-28'});
  assert.deepEqual(Object.keys(result.studentStates).sort(),['uid-1','uid-28']);
  assert.deepEqual(result.studentPets['uid-1'],{'pet-a':{id:'pet-a',name:'測試寵物',image:'/pet.png',level:'R'}});
  assert.equal(result.studentStates['uid-29'],undefined);
});

test('legacy students without an owned pet array project an empty pet catalogue',()=>{
  const result=createStudentProjections({students:[{id:1,tokens:0}],layouts:[],bosses:[],questionPapers:[]},{1:'uid-1'});
  assert.equal(Object.hasOwn(result.studentStates['uid-1'],'ownedLayout'),false);
  assert.deepEqual(result.studentPets['uid-1'],{});
});

test('a removed pet catalogue item cannot remain equipped in a student projection',()=>{
  const result=createStudentProjections({
    students:[{id:1,tokens:0,ownedLayout:['removed'],equippedLayout:['removed']}],
    layouts:[],bosses:[],questionPapers:[],
  },{1:'uid-1'});
  assert.deepEqual(result.studentStates['uid-1'].equippedLayout,[]);
  assert.deepEqual(result.studentPets['uid-1'],{});
});

test('public boss projection includes only active bosses and their referenced papers',()=>{
  const result=createStudentProjections(progress,{1:'uid-1'});
  assert.deepEqual(result.publicBosses,{'boss-a':{id:'boss-a',name:'BOSS',image:'/boss.png',maxHp:10,reward:5,rewardTickets:1,attackPassword:'1234',paperId:'paper-a',active:true}});
  assert.deepEqual(result.publicQuestionPapers['paper-a'],{id:'paper-a',questions:[{id:'q1',text:'題目',options:['甲','乙'],answerIndex:0}]});
});

test('student projection becomes an isolated pet and boss view state',()=>{
  const projection=createStudentProjections(progress,{1:'uid-1'});
  const state=studentProjectionToProgress({
    studentState:projection.studentStates['uid-1'],studentPets:projection.studentPets['uid-1'],
    publicBosses:projection.publicBosses,publicQuestionPapers:projection.publicQuestionPapers,
  });
  assert.deepEqual(state.students.map(student=>student.id),[1]);
  assert.deepEqual(state.students[0].ownedLayout,['pet-a']);
  assert.deepEqual(state.layouts,[{id:'pet-a',name:'測試寵物',image:'/pet.png',level:'R'}]);
  assert.equal(state.bosses[0].id,'boss-a');
  assert.equal(state.questionPapers[0].id,'paper-a');
  assert.deepEqual(state.tasks,[]);
});

test('student view omits the temporary teacher synchronization marker',()=>{
    const view=studentProjectionToProgress({studentState:{studentId:1,tokens:10,lotteryTickets:1,petAffection:0,lastPetMoodDate:'',
        equippedLayout:[],bossProgress:[],_teacherOperation:{id:'operation',createdAt:1,resultJson:'{"ok":true}'}}});
    assert.equal(view.students[0]._teacherOperation,undefined);
});
