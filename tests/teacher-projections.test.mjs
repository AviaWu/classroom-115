import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeStudentStatesIntoProgress} from '../public/teacher-projections.mjs';
import * as projections from '../public/teacher-projections.mjs';

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

test('stored normalization keeps compact personal fields absent until hydrated',()=>{
  const compact={students:[{id:28,gender:'F',ownedClothes:['shirt'],ownedLayout:['cat']}]};
  const stored=projections.normalizeStoredProgress(compact);
  for(const field of ['tokens','lotteryTickets','petAffection','lastPetMoodDate','equippedLayout','bossProgress']) assert.equal(Object.hasOwn(stored.students[0],field),false);
  const hydrated=mergeStudentStatesIntoProgress(stored,{'uid-28':{studentId:28,tokens:90,lotteryTickets:2,petAffection:3,lastPetMoodDate:''}});
  assert.equal(hydrated.students[0].tokens,90);
  assert.deepEqual(hydrated.students[0].ownedLayout,['cat']);
});

test('serializing a hydrated view preserves legacy copies until migration and never recreates deleted fields',()=>{
  const previous={students:[{id:1,tokens:10,ownedClothes:[]},{id:2,ownedClothes:[]},{id:3,tokens:7}]};
  const view={students:[{id:1,tokens:99,ownedClothes:['shirt'],equippedLayout:['cat']},{id:2,tokens:55,ownedClothes:[],bossProgress:[]},{id:3,tokens:8}]};
  const stored=projections.progressForStorage(view,previous,{1:'one',2:'two'});
  assert.equal(stored.students[0].tokens,10);
  assert.deepEqual(stored.students[0].ownedClothes,['shirt']);
  assert.equal(Object.hasOwn(stored.students[0],'equippedLayout'),false);
  assert.equal(Object.hasOwn(stored.students[1],'tokens'),false);
  assert.equal(Object.hasOwn(stored.students[1],'bossProgress'),false);
  assert.equal(stored.students[2].tokens,8);
  assert.equal(view.students[0].tokens,99);
});

test('a compact student without authoritative personal state fails instead of becoming a zero-balance student',()=>{
  assert.throws(()=>mergeStudentStatesIntoProgress({students:[{id:28,ownedClothes:['shirt']}]},{}),/28.*個人資料/);
});

test('teacher hydration rejects duplicate identities and incomplete mapped states',()=>{
  const progress={students:[{id:1,tokens:99,lotteryTickets:1}]};
  assert.throws(()=>mergeStudentStatesIntoProgress(progress,{a:{studentId:1,tokens:1},b:{studentId:1,tokens:2}}),/重複/);
  assert.throws(()=>mergeStudentStatesIntoProgress(progress,{a:{studentId:1,tokens:1}},{1:'a'}),/個人資料不完整/);
  assert.throws(()=>mergeStudentStatesIntoProgress(progress,{a:{studentId:1,tokens:1,lotteryTickets:1,petAffection:0,lastPetMoodDate:''}},{}),/對照|編號/);
});
