import test from 'node:test';
import assert from 'node:assert/strict';
import {applyOperation,normalizeProgress} from '../public/game-operations.mjs';
import {validateBatchJob,batchResultFor} from '../public/coop-batch.mjs';
const command=()=>({type:'coopCompleteBatch',taskId:'a',members:[1,2].map(studentId=>({id:`click-${studentId}`,studentId,createdAt:100}))});
const progress=()=>normalizeProgress({students:[1,2,3].map(id=>({id,tokens:0})),coopTasks:[{id:'a',reward:10,completedBy:[]}]});
for(const [name,change] of Object.entries({
    'missing task':c=>delete c.taskId,'object task':c=>c.taskId={},'empty members':c=>c.members=[],
    'one member':c=>c.members.pop(),'too many members':c=>c.members=Array(1001).fill(c.members[0]),
    'duplicate student':c=>c.members[1].studentId=1,'duplicate ID':c=>c.members[1].id='click-1',
    'invalid ID':c=>c.members[1].id='bad/path','prototype ID':c=>c.members[1].id='__proto__',
    'empty ID':c=>c.members[1].id='','long ID':c=>c.members[1].id='x'.repeat(129),
    'string student':c=>c.members[1].studentId='2','negative student':c=>c.members[1].studentId=-1,
    'missing time':c=>delete c.members[1].createdAt,'invalid time':c=>c.members[1].createdAt=NaN,
    'negative time':c=>c.members[1].createdAt=-1,'extra command field':c=>c.studentId=1,
    'extra member field':c=>c.members[1].taskId='b',
}))test(`strict batch validation rejects ${name} without changing input`,()=>{
    const c=command(),p=progress(),before=structuredClone(p);change(c);
    assert.throws(()=>applyOperation(p,c,1000));assert.deepEqual(p,before);
});
test('invalid later member atomically rejects earlier valid completion',()=>{
    const c=command(),p=progress();c.members[1].studentId=99;
    assert.throws(()=>applyOperation(p,c,1000),/不存在/);assert.deepEqual(p.coopTasks[0].completedBy,[]);
});
test('completed members noop even past deadline; remaining invalid member rejects whole batch',()=>{
    const p=progress();p.coopTasks[0].completedBy=[1,2];p.coopTasks[0].dueAt=500;
    const result=applyOperation(p,command(),1000);assert.equal(result.changed,false);assert.equal(result.result.members.length,2);
    const c=command();c.members[1].studentId=3;assert.throws(()=>applyOperation(p,c,1000),/截止/);assert.deepEqual(p.coopTasks[0].completedBy,[1,2]);
});
test('only threshold member gets claimed and rewards stay additive',()=>{
    const p=progress();p.coopTasks[0].completedBy=[3];const outcome=applyOperation(p,command(),1000);
    assert.deepEqual(outcome.result.members.map(m=>m.result.claimed),[false,true]);
    for(const s of outcome.progress.students)assert.equal(s.tokens,10);
    const replay=applyOperation(outcome.progress,command(),1000);assert.ok(replay.result.members.every(m=>!m.result.claimed));
    for(const s of replay.progress.students)assert.equal(s.tokens,10);
});
test('transport identity and timestamp must match immutable original members',()=>{
    const c=command();assert.throws(()=>validateBatchJob({id:'new-id',createdAt:100,command:c}),/識別碼/);
    assert.throws(()=>validateBatchJob({id:'click-1',createdAt:200,command:c}),/時間/);
    validateBatchJob({id:'click-1',createdAt:100,command:c});
});
test('missing member result fails closed as retryable',()=>{
    assert.throws(()=>batchResultFor({members:[{}]},{id:'missing'},{members:[]}),e=>e.retryable===true);
});
