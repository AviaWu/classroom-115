import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeProgress, applyOperation, createEditChanges} from '../public/game-operations.mjs';

const NOW = Date.parse('2026-09-15T02:00:00Z'); // Tuesday, 10:00 in Taiwan.
const clone = value => structuredClone(value);
function student(id, extra = {}) {
    return {id, gender:'M', tokens:100, lotteryTickets:2, doneTasks:[], petAffection:0,
        lastPetMoodDate:'', ownedClothes:[], equippedClothes:null, ownedLayout:[],
        equippedLayout:[], ownedBg:[], equippedBg:null, ...extra};
}
function state(extra = {}) {
    return {students:[student(1), student(2)], tasks:[{id:'a',title:'作業',reward:20}, {id:'b',title:'數學',reward:30}],
        clothesM:[{id:'shirt',name:'上衣',level:'R',price:50,active:true}], clothesF:[],
        layouts:[{id:'cat',name:'小貓',level:'SR',price:60,active:true}],
        backgrounds:[{id:'sky',name:'天空',level:'SSR',price:80,active:true}],
        coopTasks:[{id:'boss',monsterName:'怪獸',content:'一起完成',reward:10,rewardType:'token',completedBy:[],claimed:false}],
        coopTaskTemplates:[], dailyTaskTemplates:[], weeklyTaskTemplates:[], deletedTaskIds:[], deletedCoopTaskIds:[],
        drawings:[], globalBgImage:'', ...extra};
}
const run = (value, type, payload = {}, now = NOW) => applyOperation(value, {type,...payload}, now);
const edit = (before, after) => ({type:'edit',changes:createEditChanges(before,after)});

test('restore clones data, strips protocol metadata and preserves an intentionally empty catalogue', () => {
    const imported = state({syncVersion:3,revision:999,baseCommitId:'old',commitId:'old',updatedAt:123,clothesM:null,layouts:[]});
    delete imported.students[0].doneTasks;
    imported.students[0].ownedLayout = null;
    const restored = run(null,'restore',{value:imported});
    assert.equal(restored.changed,true);
    assert.deepEqual(restored.progress.clothesM,[]);
    assert.deepEqual(restored.progress.layouts,[]);
    assert.deepEqual(restored.progress.students[0].doneTasks,[]);
    assert.deepEqual(restored.progress.students[0].ownedLayout,[]);
    for (const key of ['syncVersion','revision','baseCommitId','commitId','updatedAt']) assert.equal(key in restored.progress,false);
    restored.progress.students[0].tokens = 0;
    assert.equal(imported.students[0].tokens,100);
    assert.equal(normalizeProgress(null),null);
});

test('initialization never replaces existing progress and commands cannot recreate deleted progress', () => {
    assert.equal(run(null,'initialize',{value:state()}).progress.students.length,2);
    assert.equal(run(state(),'initialize',{value:state({students:[student(9)]})}).changed,false);
    assert.throws(() => run(null,'completeTask',{studentId:1,taskId:'a'}),/進度|初始化/);
    assert.throws(() => run(null,'restore',{value:{students:[]}}),/學生|成員|進度/);
    assert.throws(() => run(state(),'not-a-command'),/操作/);
});

test('two devices completing different tasks accumulate rewards and each task pays once', () => {
    const original = state();
    const first = run(original,'completeTask',{studentId:1,taskId:'a'});
    const second = run(first.progress,'completeTask',{studentId:1,taskId:'b'});
    assert.equal(second.progress.students[0].tokens,150);
    assert.deepEqual(second.progress.students[0].doneTasks,['a','b']);
    assert.equal(run(second.progress,'completeTask',{studentId:1,taskId:'a'}).changed,false);
    assert.equal(original.students[0].tokens,100);
    assert.deepEqual(original.students[0].doneTasks,[]);
});

test('task completion uses the latest reward, rejects expiry and missing students', () => {
    const current = state({tasks:[{id:'a',reward:42,dueAt:NOW}]});
    assert.equal(run(current,'completeTask',{studentId:2,taskId:'a'}).progress.students[1].tokens,142);
    assert.throws(() => run(current,'completeTask',{studentId:2,taskId:'a'},NOW+1),/截止|過期/);
    assert.throws(() => run(current,'completeTask',{studentId:99,taskId:'a'}),/學生|成員/);
    assert.throws(() => run(current,'completeTask',{studentId:1,taskId:'deleted'}),/任務/);
});

test('two purchases accumulate ownership, reject overspend, and a duplicate charges once', () => {
    const initial = state({students:[student(1,{tokens:120})]});
    const first = run(initial,'purchase',{studentId:1,kind:'clothes',itemId:'shirt'});
    const duplicate = run(first.progress,'purchase',{studentId:1,kind:'clothes',itemId:'shirt'});
    assert.equal(duplicate.changed,false);
    assert.equal(duplicate.progress.students[0].tokens,70);
    const second = run(duplicate.progress,'purchase',{studentId:1,kind:'layout',itemId:'cat'});
    assert.equal(second.progress.students[0].tokens,10);
    assert.deepEqual(second.progress.students[0].ownedClothes,['shirt']);
    assert.deepEqual(second.progress.students[0].ownedLayout,['cat']);
    assert.throws(() => run(second.progress,'purchase',{studentId:1,kind:'background',itemId:'sky'}),/代幣不足/);
});

test('purchase checks current price, active status and the student gender catalogue', () => {
    const current = state(); current.clothesM[0].price = 90;
    assert.equal(run(current,'purchase',{studentId:1,kind:'clothes',itemId:'shirt'}).progress.students[0].tokens,10);
    current.clothesM[0].active = false;
    assert.throws(() => run(current,'purchase',{studentId:1,kind:'clothes',itemId:'shirt'}),/下架|商品/);
    current.students[0].gender = 'F';
    assert.throws(() => run(current,'purchase',{studentId:1,kind:'clothes',itemId:'shirt'}),/商品/);
});

test('lottery uses fixed command samples on retry and compensates duplicate ownership', () => {
    const initial = state();
    const command = {type:'lottery',studentId:1,roll:0.8,indexRoll:0.99};
    const speculative = applyOperation(initial,command,NOW);
    const newest = run(initial,'resources',{studentId:2,field:'tokens',mode:'add',amount:7}).progress;
    const committed = applyOperation(newest,command,NOW);
    assert.equal(speculative.result.item.id,'cat');
    assert.equal(committed.result.item.id,'cat');
    assert.equal(committed.result.duplicate,false);
    assert.equal(committed.progress.students[0].lotteryTickets,1);
    const duplicate = applyOperation(committed.progress,command,NOW);
    assert.equal(duplicate.result.duplicate,true);
    assert.equal(duplicate.progress.students[0].tokens,120);
    assert.equal(duplicate.progress.students[0].lotteryTickets,0);
    assert.deepEqual(duplicate.progress.students[0].ownedLayout,['cat']);
    assert.throws(() => applyOperation(duplicate.progress,command,NOW),/樂透券不足/);
});

test('lottery rarity boundaries and missing-rarity fallback use available active prizes', () => {
    const current = state({backgrounds:[{id:'ssr',level:'SSR',price:200},{id:'ur',level:'UR',price:300}]});
    for (const [roll,id] of [[0,'shirt'],[0.79999,'shirt'],[0.8,'cat'],[0.95,'ssr'],[0.99,'ur']]) {
        assert.equal(run(current,'lottery',{studentId:1,roll,indexRoll:0}).result.item.id,id);
    }
    current.backgrounds = [];
    assert.equal(run(current,'lottery',{studentId:1,roll:0.99,indexRoll:0.99}).result.item.id,'cat');
    current.layouts[0].active = false;
    assert.equal(run(current,'lottery',{studentId:1,roll:0.99,indexRoll:0.99}).result.item.id,'shirt');
    for (const roll of [-1,1,NaN]) assert.throws(() => run(current,'lottery',{studentId:1,roll,indexRoll:0}),/抽獎|亂數/);
    assert.throws(() => run(current,'lottery',{studentId:1,roll:0,indexRoll:1}),/抽獎|亂數/);
    assert.throws(() => run(state({clothesM:[],layouts:[],backgrounds:[]}),'lottery',{studentId:1,roll:0,indexRoll:0}),/商品/);
});

test('equipping sets an explicit owned item, repeats safely, and restores default pet', () => {
    const initial = state({students:[student(1,{ownedClothes:['shirt'],ownedLayout:['cat'],ownedBg:['sky']})]});
    let current = run(initial,'equip',{studentId:1,kind:'clothes',itemId:'shirt'}).progress;
    assert.equal(current.students[0].equippedClothes,'shirt');
    assert.equal(run(current,'equip',{studentId:1,kind:'clothes',itemId:'shirt'}).changed,false);
    current = run(current,'equip',{studentId:1,kind:'layout',itemId:'cat'}).progress;
    assert.deepEqual(current.students[0].equippedLayout,['cat']);
    current = run(current,'equip',{studentId:1,kind:'background',itemId:'sky'}).progress;
    assert.equal(current.students[0].equippedBg,'sky');
    current = run(current,'equip',{studentId:1,kind:'layout',itemId:null}).progress;
    assert.deepEqual(current.students[0].equippedLayout,[]);
    current = run(current,'equip',{studentId:1,kind:'clothes',itemId:null}).progress;
    assert.equal(current.students[0].equippedClothes,null);
    assert.throws(() => run(state(),'equip',{studentId:1,kind:'clothes',itemId:'shirt'}),/擁有|衣櫃/);
});

test('pet mood awards once per Taiwan day and pays each level bonus once', () => {
    const beforeMidnight = Date.parse('2026-09-14T15:59:59Z');
    const afterMidnight = Date.parse('2026-09-14T16:00:00Z');
    const initial = state({students:[student(1,{petAffection:9})]});
    const first = run(initial,'petMood',{studentId:1},beforeMidnight);
    assert.deepEqual(first.result,{awarded:true,bonus:10,level:2});
    assert.equal(first.progress.students[0].lastPetMoodDate,'2026-09-14');
    const duplicate = run(first.progress,'petMood',{studentId:1},beforeMidnight);
    assert.deepEqual(duplicate.result,{awarded:false,bonus:0,level:2});
    assert.equal(duplicate.changed,false);
    const tomorrow = run(duplicate.progress,'petMood',{studentId:1},afterMidnight);
    assert.equal(tomorrow.progress.students[0].petAffection,11);
    assert.equal(tomorrow.progress.students[0].tokens,110);
    assert.equal(tomorrow.progress.students[0].lastPetMoodDate,'2026-09-15');
});

test('the final two coop members cumulatively complete and the class is paid once', () => {
    const first = run(state(),'coopComplete',{studentId:1,taskId:'boss'});
    assert.equal(first.result.claimed,false);
    const last = run(first.progress,'coopComplete',{studentId:2,taskId:'boss'});
    assert.deepEqual(last.result,{claimed:true,reward:10,rewardType:'token',monsterName:'怪獸'});
    assert.deepEqual(last.progress.students.map(s=>s.tokens),[110,110]);
    assert.equal(last.progress.coopTasks[0].claimed,true);
    const retry = run(last.progress,'coopComplete',{studentId:2,taskId:'boss'});
    assert.equal(retry.changed,false);
    assert.equal(retry.result.claimed,false);
});

test('coop completion checks actual current membership, timing, and ticket rewards', () => {
    const initial = state();
    Object.assign(initial.coopTasks[0],{completedBy:[99],rewardType:'ticket',reward:2,startAt:NOW,dueAt:NOW+10});
    assert.throws(() => run(initial,'coopComplete',{studentId:99,taskId:'boss'}),/學生|成員/);
    assert.throws(() => run(initial,'coopComplete',{studentId:1,taskId:'boss'},NOW-1),/開始/);
    assert.throws(() => run(initial,'coopComplete',{studentId:1,taskId:'boss'},NOW+11),/截止|過期/);
    const first = run(initial,'coopComplete',{studentId:1,taskId:'boss'});
    assert.equal(first.result.claimed,false);
    assert.equal(run(first.progress,'coopComplete',{studentId:1,taskId:'boss'}).changed,false);
    const last = run(first.progress,'coopComplete',{studentId:2,taskId:'boss'});
    assert.deepEqual(last.progress.students.map(s=>s.lotteryTickets),[4,4]);
});

test('coop can pay the remaining completed class after an unfinished member is removed', () => {
    const current=state(); current.coopTasks[0].completedBy=[1];
    current.students=current.students.filter(s=>s.id===1);
    const completed=run(current,'coopComplete',{studentId:1,taskId:'boss'});
    assert.equal(completed.result.claimed,true);
    assert.equal(completed.progress.students[0].tokens,110);
    assert.deepEqual(completed.progress.coopTasks[0].completedBy,[1]);
    assert.equal(run(completed.progress,'coopComplete',{studentId:1,taskId:'boss'}).changed,false);
});

test('invalid ticket rewards are rejected before recording any coop member completion', () => {
    const current=state(); Object.assign(current.coopTasks[0],{rewardType:'ticket',reward:1.5});
    assert.throws(() => run(current,'coopComplete',{studentId:1,taskId:'boss'}),/樂透券|整數/);
    assert.deepEqual(current.coopTasks[0].completedBy,[]);
});

test('drawing indexes retain the latest three metadata records and queue evictions', () => {
    const meta = id => ({id:`drawing_${id}`,savedAt:`2026-09-16T00:00:0${id}.000Z`});
    let current = state({drawings:[meta('3'),meta('2'),meta('1')]});
    const saved = run(current,'saveDrawing',{drawing:meta('4')});
    assert.deepEqual(saved.progress.drawings.map(item=>item.id),['drawing_4','drawing_3','drawing_2']);
    assert.deepEqual(saved.progress.pendingArtworkDeletes,['drawing_1']);
    assert.deepEqual(saved.result,{evictedArtworkIds:['drawing_1']});
    assert.equal('data' in saved.progress.drawings[0],false);
    const confirmed = run(saved.progress,'confirmArtworkDeletion',{drawingId:'drawing_1'});
    assert.deepEqual(confirmed.progress.pendingArtworkDeletes,[]);
});

test('normalization keeps only drawing metadata and removes retired album data', () => {
    const normalized = normalizeProgress(state({
        drawings:[{id:'drawing_3',savedAt:'2026-09-16T00:00:03.000Z',data:'data:image/png;base64,three'}],
        drawingAlbum:[{id:'drawing_2',savedAt:'2026-09-16T00:00:02.000Z',data:'data:image/png;base64,two'}]
    }));
    assert.deepEqual(normalized.drawings,[{id:'drawing_3',savedAt:'2026-09-16T00:00:03.000Z'}]);
    assert.equal('drawingAlbum' in normalized,false);
    assert.throws(() => run(normalized,'migrateArtworks',{drawings:[]}),/不支援的遊戲操作/);
});

test('restore queues displaced external artwork while preserving cleanup already pending', () => {
    const meta = id => ({id:`drawing_${id}`,savedAt:`2026-09-16T00:00:0${id}.000Z`});
    const current = state({drawings:[meta('3'),meta('2'),meta('1')],pendingArtworkDeletes:['drawing_pending','drawing_3']});
    const restored = state({drawings:[meta('5'),meta('4'),meta('3')],pendingArtworkDeletes:['drawing_existing']});
    const result = run(current,'restore',{value:restored});
    assert.deepEqual(result.progress.drawings.map(item=>item.id),['drawing_5','drawing_4','drawing_3']);
    assert.deepEqual(result.progress.pendingArtworkDeletes,['drawing_existing','drawing_pending','drawing_2','drawing_1']);
});

test('teacher edit changes cannot replace drawing indexes', () => {
    const before = state({drawings:[{id:'drawing_1',savedAt:'2026-09-16T00:00:01.000Z'}]});
    const after = clone(before);
    after.drawings = [{id:'drawing_2',savedAt:'2026-09-16T00:00:02.000Z'}];
    assert.deepEqual(createEditChanges(before,after),[]);
});

test('resource additions apply to current values and intentional sets apply to all current students', () => {
    let current = run(state(),'resources',{studentId:1,field:'tokens',mode:'add',amount:7}).progress;
    current = run(current,'resources',{studentId:1,field:'tokens',mode:'add',amount:11}).progress;
    assert.equal(current.students[0].tokens,118);
    current.students.push(student(3));
    current = run(current,'resources',{all:true,field:'tokens',mode:'set',amount:42}).progress;
    assert.deepEqual(current.students.map(s=>s.tokens),[42,42,42]);
    current = run(current,'resources',{studentId:1,field:'lotteryTickets',mode:'add',amount:-10}).progress;
    assert.equal(current.students[0].lotteryTickets,0);
    assert.throws(() => run(current,'resources',{all:true,field:'lotteryTickets',mode:'set',amount:-1}),/整數|樂透券/);
    assert.throws(() => run(current,'resources',{all:true,field:'lotteryTickets',mode:'add',amount:0.5}),/整數|樂透券/);
    assert.throws(() => run(current,'resources',{all:true,field:'tokens',mode:'set',amount:Infinity}),/數字|數值/);
});

test('explicit closet reset clears latest purchases even when the requesting device saw an empty closet', () => {
    const old=state();
    const latest=run(old,'purchase',{studentId:1,kind:'clothes',itemId:'shirt'}).progress;
    Object.assign(latest.students[0],{equippedClothes:'shirt',ownedLayout:['cat'],equippedLayout:['cat'],ownedBg:['sky'],equippedBg:'sky',petAffection:9,doneTasks:['a']});
    const result=run(latest,'resetCloset',{studentId:1}).progress;
    assert.deepEqual(result.students[0].ownedClothes,[]);
    assert.deepEqual(result.students[0].ownedLayout,[]);
    assert.deepEqual(result.students[0].ownedBg,[]);
    assert.deepEqual(result.students[0].equippedLayout,[]);
    assert.equal(result.students[0].equippedClothes,null);
    assert.equal(result.students[0].equippedBg,null);
    assert.equal(result.students[0].tokens,50);
    assert.equal(result.students[0].lotteryTickets,2);
    assert.equal(result.students[0].petAffection,9);
    assert.deepEqual(result.students[0].doneTasks,['a']);
    assert.equal(result.students[1].tokens,100);
    assert.equal(run(result,'resetCloset',{studentId:1}).changed,false);
    assert.throws(() => run(result,'resetCloset',{studentId:99}),/學生|成員/);
});

test('explicit all-resource reset includes newest students and preserves mood and task progress', () => {
    const latest=state(); latest.students.push(student(3,{tokens:500,lotteryTickets:8,ownedClothes:['shirt'],equippedClothes:'shirt',petAffection:12,lastPetMoodDate:'2026-09-15',doneTasks:['a']}));
    const result=run(latest,'resetResources').progress;
    assert.deepEqual(result.students.map(s=>s.tokens),[0,0,0]);
    assert.deepEqual(result.students.map(s=>s.lotteryTickets),[0,0,0]);
    assert.deepEqual(result.students[2].ownedClothes,[]);
    assert.equal(result.students[2].equippedClothes,null);
    assert.equal(result.students[2].petAffection,12);
    assert.equal(result.students[2].lastPetMoodDate,'2026-09-15');
    assert.deepEqual(result.students[2].doneTasks,['a']);
    assert.equal(run(result,'resetResources').changed,false);
});

test('explicit resize keeps latest existing progress and creates contiguous students with empty resources', () => {
    const latest=state(); latest.students[0].tokens=999;
    const grown=run(latest,'resizeStudents',{count:4}).progress;
    assert.deepEqual(grown.students.map(s=>s.id),[1,2,3,4]);
    assert.equal(grown.students[0].tokens,999);
    assert.equal(grown.students[2].gender,'M');
    assert.equal(grown.students[3].gender,'F');
    assert.equal(grown.students[2].tokens,0);
    assert.equal(grown.students[2].lotteryTickets,0);
    assert.deepEqual(grown.students[2].doneTasks,[]);
    assert.deepEqual(grown.students[2].ownedClothes,[]);
    assert.deepEqual(grown.students[2].equippedLayout,[]);
    const shrunk=run(grown,'resizeStudents',{count:1}).progress;
    assert.deepEqual(shrunk.students.map(s=>s.id),[1]);
    assert.equal(shrunk.students[0].tokens,999);
    assert.equal(run(shrunk,'resizeStudents',{count:1}).changed,false);
    for (const count of [0,-1,1.5,1001,Infinity,'2']) assert.throws(() => run(latest,'resizeStudents',{count}),/人數|學生|整數/);
});

test('explicit gender change uses newest equipment even when the old device saw the requested gender already', () => {
    const latest=state({clothesF:[{id:'dress',name:'洋裝',price:50}]});
    Object.assign(latest.students[0],{gender:'F',ownedClothes:['shirt','dress'],equippedClothes:'dress'});
    const result=run(latest,'gender',{studentId:1,gender:'M'}).progress;
    assert.equal(result.students[0].gender,'M');
    assert.equal(result.students[0].equippedClothes,null);
    assert.deepEqual(result.students[0].ownedClothes,['shirt','dress']);
    result.students[0].equippedClothes='shirt';
    assert.equal(run(result,'gender',{studentId:1,gender:'M'}).progress.students[0].equippedClothes,'shirt');
    assert.throws(() => run(result,'gender',{studentId:1,gender:'X'}),/性別/);
});

test('teacher field edits merge unrelated latest fields, students, and nested object leaves', () => {
    const before = state(); before.clothesM[0].metadata={credit:'舊',color:'red'};
    const after = clone(before); after.clothesM[0].name='新名字'; after.clothesM[0].metadata.credit='新'; after.students[0].gender='F';
    const latest = clone(before); latest.clothesM[0].price=77; latest.clothesM[0].metadata.color='blue'; latest.students[0].tokens=180; latest.students.push(student(3));
    const result = applyOperation(latest,JSON.parse(JSON.stringify(edit(before,after))),NOW).progress;
    assert.equal(result.clothesM[0].name,'新名字');
    assert.equal(result.clothesM[0].price,77);
    assert.deepEqual(result.clothesM[0].metadata,{credit:'新',color:'blue'});
    assert.equal(result.students[0].tokens,180);
    assert.equal(result.students[0].gender,'F');
    assert.equal(result.students.length,3);
});

test('teacher edits reject a concurrently edited field or a deleted record without mutating input', () => {
    const before = state(), after = clone(before); after.clothesM[0].name='甲';
    const changed = clone(before); changed.clothesM[0].name='乙';
    assert.throws(() => applyOperation(changed,edit(before,after),NOW),/衝突|更新|修改/);
    assert.equal(changed.clothesM[0].name,'乙');
    const deleted = clone(before); deleted.clothesM=[];
    assert.throws(() => applyOperation(deleted,edit(before,after),NOW),/刪除|不存在/);
    assert.deepEqual(deleted.clothesM,[]);
});

test('task deletion cleans every latest student without conflicting with newer completions', () => {
    const before=state(), after=clone(before); after.tasks=after.tasks.filter(t=>t.id!=='a'); after.deletedTaskIds.push('a');
    const latest = run(before,'completeTask',{studentId:1,taskId:'a'}).progress;
    latest.students[0].doneTasks.push('b'); latest.students.push(student(3,{doneTasks:['a','b']}));
    const result = applyOperation(latest,edit(before,after),NOW).progress;
    assert.deepEqual(result.students[0].doneTasks,['b']);
    assert.deepEqual(result.students[2].doneTasks,['b']);
    assert.equal(result.students[0].tokens,120);
    assert.deepEqual(result.deletedTaskIds,['a']);
    assert.equal(result.tasks.some(t=>t.id==='a'),false);
});

test('numeric task identifiers keep tombstones and cannot be re-added by a stale edit', () => {
    const before=state({tasks:[{id:7,title:'舊任務',reward:5}]}), after=clone(before); after.tasks=[];
    const deleted=applyOperation(before,edit(before,after),NOW).progress;
    assert.deepEqual(deleted.deletedTaskIds,[7]);
    const resurrected=applyOperation(deleted,edit(after,before),NOW).progress;
    assert.deepEqual(resurrected.tasks,[]);
});

test('deleting an already completed task does not turn its derived cleanup into an array conflict', () => {
    const before=state(); before.students[0].doneTasks=['a'];
    const after=clone(before); after.tasks=after.tasks.filter(t=>t.id!=='a'); after.students[0].doneTasks=[];
    const latest=clone(before); latest.students[0].doneTasks.push('b');
    const result=applyOperation(latest,edit(before,after),NOW).progress;
    assert.deepEqual(result.students[0].doneTasks,['b']);
});

test('closet reset clears the selected student arrays while preserving other students and detects concurrent purchases', () => {
    const before=state(); Object.assign(before.students[0],{ownedClothes:['shirt'],equippedClothes:'shirt',ownedLayout:['cat'],equippedLayout:['cat']});
    const after=clone(before); Object.assign(after.students[0],{ownedClothes:[],equippedClothes:null,ownedLayout:[],equippedLayout:[]});
    const latest=clone(before); latest.students[1].tokens=500;
    const result=applyOperation(latest,edit(before,after),NOW).progress;
    assert.deepEqual(result.students[0].ownedClothes,[]);
    assert.deepEqual(result.students[0].equippedLayout,[]);
    assert.equal(result.students[0].equippedClothes,null);
    assert.equal(result.students[1].tokens,500);
    latest.students[0].ownedClothes.push('new-shirt');
    assert.throws(() => applyOperation(latest,edit(before,after),NOW),/衝突|更新|修改/);
});

test('catalogue reorder and additions retain concurrently added items', () => {
    const before=state(); before.layouts.push({id:'dog',name:'小狗',price:50});
    const after=clone(before); after.layouts.reverse(); after.layouts.push({id:'bird',name:'小鳥',price:50});
    const latest=clone(before); latest.layouts.splice(1,0,{id:'fish',name:'小魚',price:50});
    const result=applyOperation(latest,edit(before,after),NOW).progress;
    assert.deepEqual(new Set(result.layouts.map(x=>x.id)),new Set(['cat','dog','bird','fish']));
    assert.ok(result.layouts.findIndex(x=>x.id==='dog')<result.layouts.findIndex(x=>x.id==='cat'));
    assert.equal(result.layouts.find(x=>x.id==='fish').name,'小魚');
});

test('catalogue reorder rejects conflicting changes to the same existing item order', () => {
    const before=state({layouts:[{id:'a'},{id:'b'},{id:'c'}]});
    const after=clone(before); after.layouts=[after.layouts[2],after.layouts[0],after.layouts[1]];
    const latest=clone(before); latest.layouts=[latest.layouts[1],latest.layouts[2],latest.layouts[0]];
    assert.throws(() => applyOperation(latest,edit(before,after),NOW),/衝突|更新|修改/);
    assert.deepEqual(latest.layouts.map(item=>item.id),['b','c','a']);
});

test('edit diff ignores absent empty arrays and legacy metadata but preserves global fields', () => {
    const before={students:[{id:1,tokens:0}],lastSaved:'old',revision:3};
    const after=normalizeProgress(before); after.lastSaved='new'; after.revision=99;
    assert.deepEqual(createEditChanges(before,after),[]);
    after.globalBgImage='data:image/png;base64,new';
    const changed=applyOperation(before,edit(before,after),NOW).progress;
    assert.equal(changed.globalBgImage,'data:image/png;base64,new');
});

function scheduledState() {
    return state({tasks:[],coopTasks:[],
        dailyTaskTemplates:[{id:'d',title:'每日',reward:5,enabled:true,appearTime:'08:00',dueTime:'07:00'}],
        weeklyTaskTemplates:[{id:'w',title:'每週',reward:9,enabled:true,appearWeekday:1,appearTime:'09:00',dueWeekday:1,dueTime:'08:00'}],
        coopTaskTemplates:[{id:'c',monsterName:'日王',content:'合作',reward:2,rewardType:'ticket',appearTime:'08:00',dueTime:'23:59',enabled:true},
            {id:'cw',monsterName:'週王',content:'合作',reward:3,scheduleType:'weekly',appearWeekday:1,appearTime:'08:00',dueWeekday:5,dueTime:'17:00',enabled:true}]});
}

test('schedule uses Taiwan daily dates and Monday week keys with rollover deadlines', () => {
    const scheduled=run(scheduledState(),'schedule');
    assert.deepEqual(scheduled.progress.tasks.map(t=>t.id),['daily_d_2026-09-15','weekly_w_2026-09-14']);
    assert.equal(scheduled.progress.tasks[0].dueAt,Date.parse('2026-09-15T23:00:00Z'));
    assert.equal(scheduled.progress.tasks[1].dueAt,Date.parse('2026-09-21T00:00:00Z'));
    assert.deepEqual(scheduled.progress.coopTasks.map(t=>t.id),['coop_daily_c_2026-09-15','coop_weekly_cw_2026-09-14']);
    assert.equal(scheduled.progress.coopTasks[0].startAt,Date.parse('2026-09-15T00:00:00Z'));
    assert.equal(run(scheduled.progress,'schedule').changed,false);
    const midnight=scheduledState(); midnight.dailyTaskTemplates[0].appearTime='00:00';
    assert.equal(run(midnight,'schedule',{},Date.parse('2026-09-14T16:01:00Z')).progress.tasks[0].id,'daily_d_2026-09-15');
});

test('schedule respects deleted IDs, disabled templates and templates removed on another device', () => {
    const current=scheduledState(); current.deletedTaskIds=['daily_d_2026-09-15']; current.deletedCoopTaskIds=['coop_daily_c_2026-09-15'];
    current.weeklyTaskTemplates[0].enabled=false; current.coopTaskTemplates[1].enabled=false;
    const result=run(current,'schedule');
    assert.deepEqual(result.progress.tasks,[]);
    assert.deepEqual(result.progress.coopTasks,[]);
    assert.equal(result.changed,false);
    const before=scheduledState(), after=run(before,'schedule').progress;
    const latest=clone(before); latest.dailyTaskTemplates=[]; latest.coopTaskTemplates=[]; latest.deletedTaskIds=['weekly_w_2026-09-14'];
    const replayed=applyOperation(latest,edit(before,after),NOW).progress;
    assert.deepEqual(replayed.tasks,[]);
    assert.deepEqual(replayed.coopTasks,[]);
});

test('concurrent deterministic schedule additions do not overwrite the current record', () => {
    const before=scheduledState(), after=run(before,'schedule').progress;
    const latest=clone(after); latest.tasks[0].reward=99;
    const result=applyOperation(latest,edit(before,after),NOW);
    assert.equal(result.progress.tasks.length,2);
    assert.equal(result.progress.tasks[0].reward,99);
});
