import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyTeacherStudentPlan,
    createTeacherSyncPlan,
    stripTeacherOperationMarker,
} from '../public/teacher-sync-plan.mjs';

const student=(overrides={})=>({
    id:1,gender:'M',tokens:100,lotteryTickets:1,petAffection:0,lastPetMoodDate:'',
    ownedClothes:[],equippedClothes:null,ownedLayout:[],equippedLayout:[],ownedBg:[],equippedBg:null,
    doneTasks:[],bossProgress:[],...overrides,
});
const state=(overrides={})=>({
    studentId:1,tokens:100,lotteryTickets:1,petAffection:0,lastPetMoodDate:'',equippedLayout:[],bossProgress:[],...overrides,
});
const planFor=(before,after,command,result={ok:true})=>createTeacherSyncPlan({
    beforeProgress:{students:[before],layouts:[],bosses:[],questionPapers:[]},
    afterProgress:{students:[after],layouts:[],bosses:[],questionPapers:[]},
    command,result,uidByStudentId:{1:'uid-one'},clock:100000,
}).studentPlans['uid-one'];

test('additive teacher resources apply to the latest concurrent student value',()=>{
    const plan=planFor(student(),student({tokens:105}),{type:'resources',studentId:1,field:'tokens',mode:'add',amount:5});
    const applied=applyTeacherStudentPlan(state({tokens:110}),plan,'teacher-add');
    assert.equal(applied.state.tokens,115);
    assert.deepEqual(applied.result,{ok:true});
});

test('absolute resource reset preserves concurrent pet and BOSS fields it did not change',()=>{
    const before=student({tokens:100,lotteryTickets:3,ownedClothes:['shirt']});
    const after=student({tokens:0,lotteryTickets:0});
    const current=state({tokens:125,lotteryTickets:4,petAffection:7,lastPetMoodDate:'2026-09-20',
        equippedLayout:['cat'],bossProgress:[{bossId:'other',hp:5,passwordVerified:true,answeredQuestionIds:['q'],defeated:false,completedAt:null}]});
    const plan=planFor(before,after,{type:'resetResources'});
    const applied=applyTeacherStudentPlan(current,plan,'teacher-reset');
    assert.equal(applied.state.tokens,0);
    assert.equal(applied.state.lotteryTickets,0);
    assert.equal(applied.state.petAffection,7);
    assert.equal(applied.state.lastPetMoodDate,'2026-09-20');
    assert.deepEqual(applied.state.equippedLayout,['cat']);
    assert.equal(applied.state.bossProgress[0].bossId,'other');
});

test('pet mood plan recomputes inside the student transaction and cannot award twice',()=>{
    const before=student({tokens:100,petAffection:9});
    const after=student({tokens:110,petAffection:10,lastPetMoodDate:'1970-01-01'});
    const plan=planFor(before,after,{type:'petMood',studentId:1},{ok:true,awarded:true,bonus:10,level:2});
    const applied=applyTeacherStudentPlan(state({tokens:110,petAffection:10,lastPetMoodDate:'1970-01-01'}),plan,'teacher-mood');
    assert.equal(applied.state.tokens,110);
    assert.equal(applied.state.petAffection,10);
    assert.deepEqual(applied.result,{awarded:false,bonus:0,level:2});
});

test('final BOSS attack plan does not reward again when a student won the race',()=>{
    const boss={id:'boss',name:'王',maxHp:5,reward:20,rewardTickets:1,attackPassword:'1234',paperId:'paper',active:true};
    const paper={id:'paper',questions:[{id:'q',text:'?',options:['對','錯'],answerIndex:0}]};
    const before=student({bossProgress:[{bossId:'boss',hp:5,passwordVerified:true,answeredQuestionIds:[],defeated:false,completedAt:null}]});
    const after=student({tokens:120,lotteryTickets:2,bossProgress:[{bossId:'boss',hp:0,passwordVerified:true,answeredQuestionIds:['q'],defeated:true,completedAt:100000}]});
    const sync=createTeacherSyncPlan({beforeProgress:{students:[before],layouts:[],bosses:[boss],questionPapers:[paper]},
        afterProgress:{students:[after],layouts:[],bosses:[boss],questionPapers:[paper]},
        command:{type:'bossAttack',studentId:1,bossId:'boss',questionId:'q',answerIndex:0,password:'1234'},
        result:{ok:true,correct:true,damage:5,hp:0,defeated:true,reward:20,rewardTickets:1,passwordVerified:true},
        uidByStudentId:{1:'uid-one'},clock:100000});
    const applied=applyTeacherStudentPlan(state({tokens:120,lotteryTickets:2,bossProgress:after.bossProgress}),sync.studentPlans['uid-one'],'teacher-boss');
    assert.equal(applied.state.tokens,120);
    assert.equal(applied.state.lotteryTickets,2);
    assert.equal(applied.state.bossProgress[0].hp,0);
    assert.equal(applied.result.reward,0);
    assert.equal(applied.result.defeated,true);
});

test('student marker makes a retried projection return its original result without applying twice',()=>{
    const plan=planFor(student(),student({tokens:105}),{type:'resources',studentId:1,field:'tokens',mode:'add',amount:5},{ok:true,tokens:105});
    const first=applyTeacherStudentPlan(state(),plan,'same-operation');
    const second=applyTeacherStudentPlan(first.state,plan,'same-operation');
    assert.equal(second.state.tokens,105);
    assert.deepEqual(second.result,{ok:true,tokens:105});
    assert.equal(second.alreadyApplied,true);
    const cleaned=stripTeacherOperationMarker(second.state,'same-operation');
    assert.equal(cleaned._teacherOperation,undefined);
});

test('resize deletion plan remains idempotent without a marker',()=>{
    const sync=createTeacherSyncPlan({beforeProgress:{students:[student(),student({id:2})]},afterProgress:{students:[student()]},
        command:{type:'resizeStudents',count:1},result:{ok:true},uidByStudentId:{1:'uid-one',2:'uid-two'},clock:100000});
    assert.equal(sync.studentPlans['uid-two'].delete,true);
    assert.equal(applyTeacherStudentPlan(null,sync.studentPlans['uid-two'],'resize').state,null);
});

test('resetting one BOSS preserves a concurrent attack against another BOSS',()=>{
    const first={bossId:'first',hp:5,passwordVerified:true,answeredQuestionIds:['q1'],defeated:false,completedAt:null};
    const second={bossId:'second',hp:10,passwordVerified:true,answeredQuestionIds:[],defeated:false,completedAt:null};
    const plan=planFor(student({bossProgress:[first,second]}),student({bossProgress:[second]}),{type:'resetBossProgress',bossId:'first'});
    const concurrentSecond={...second,hp:4,answeredQuestionIds:['q2']};
    const applied=applyTeacherStudentPlan(state({bossProgress:[first,concurrentSecond]}),plan,'reset-first');
    assert.deepEqual(applied.state.bossProgress,[concurrentSecond]);
});
