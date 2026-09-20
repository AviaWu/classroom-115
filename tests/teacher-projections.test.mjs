import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeStudentStatesIntoProgress} from '../public/teacher-projections.mjs';

test('teacher view overlays only student-controlled personal fields',()=>{
  const progress={students:[{id:1,name:'甲',tokens:1,lotteryTickets:0,petAffection:0,lastPetMoodDate:'',ownedLayout:['dog'],equippedLayout:[],bossProgress:[],gender:'M'},{id:2,tokens:2,gender:'F'}],bosses:[{id:'boss'}]};
  const view=mergeStudentStatesIntoProgress(progress,{uidOne:{studentId:1,tokens:9,lotteryTickets:3,petAffection:12,lastPetMoodDate:'2026-09-20',ownedLayout:['cat'],equippedLayout:['cat'],bossProgress:[{bossId:'boss',hp:2}]}});
  assert.equal(view.students[0].tokens,9);
  assert.equal(view.students[0].name,'甲');
  assert.equal(view.students[0].gender,'M');
  assert.deepEqual(view.students[0].ownedLayout,['dog']);
  assert.deepEqual(view.students[0].bossProgress,[{bossId:'boss',hp:2}]);
  assert.deepEqual(view.students[1],progress.students[1]);
  assert.equal(progress.students[0].tokens,1);
});

test('teacher view treats Firebase-omitted personal arrays as empty',()=>{
  const progress={students:[{id:1,tokens:1,lotteryTickets:0,petAffection:0,lastPetMoodDate:'',ownedLayout:['cat'],equippedLayout:['cat'],bossProgress:[{bossId:'boss'}]}]};
  const view=mergeStudentStatesIntoProgress(progress,{uidOne:{studentId:1,tokens:1,lotteryTickets:0,petAffection:0,lastPetMoodDate:''}});
  assert.deepEqual(view.students[0].ownedLayout,['cat']);
  assert.deepEqual(view.students[0].equippedLayout,[]);
  assert.deepEqual(view.students[0].bossProgress,[]);
});
