import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudSync} from '../public/cloud-sync.mjs';
import {applyOperation,normalizeProgress} from '../public/game-operations.mjs';
import {queuedCoopBatch,freezeCoopBatch} from '../public/coop-batch.mjs';
const clone=structuredClone,tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const command=(studentId,taskId='a')=>({type:'coopComplete',studentId,taskId});
function harness(t,{pending=[],execute,persist}={}){
    let emit,id=0,clock=100000,stored=clone(pending);
    const usedIds=new Set(pending.flatMap(job=>[job.id,...(job.members||[]).map(member=>member.id)]));
    let progress=normalizeProgress({students:Array.from({length:8},(_,i)=>({id:i+1,tokens:10,gender:'M'})),clothesM:[{id:'shirt',price:1}],coopTasks:['a','b'].map(id=>({id,reward:10,completedBy:[]}))});
    const calls=[],queries=[],recovered=[],errors=[],receipts=new Map();
    const sync=createCloudSync({subscribeRemote:next=>{emit=next;return ()=>{};},readRemote:async()=>progress,
        loadPending:()=>pending,persistPending:jobs=>{persist?.(jobs);stored=clone(jobs);},
        execute:async(job,ids)=>{calls.push({job:clone({id:job.id,createdAt:job.createdAt,command:job.command}),ids});await execute?.(job,calls.length);
            if(receipts.has(job.id)) return receipts.get(job.id);
            const outcome=applyOperation(progress,job.command,clock);progress=outcome.progress;receipts.set(job.id,outcome);return outcome;},
        readReceipt:async id=>{queries.push(id);return receipts.get(id)||null;},recovered:(command,result)=>recovered.push({command,result}),
        applyState(){},lock(){},status(){},error:error=>errors.push(error),newId:()=>{do{id++;}while(usedIds.has(`click-${id}`));return `click-${id}`;},now:()=>clock++,setInterval:()=>0,clearInterval(){}});
    t.after(()=>sync.dispose());sync.setConnected(true);emit(progress);
    return {sync,calls,queries,recovered,errors,receipts,emit:()=>emit(progress),get stored(){return stored;},setClock:value=>clock=value,
        click:(id,task='a',key=`coop:${task}:${id}`)=>sync.perform(command(id,task),key)};
}
test('first execute is synchronous; blocked first permits exactly one frozen four-member batch and per-member promises',async t=>{
    const gate=deferred(),batchGate=deferred();const h=harness(t,{execute:(_,n)=>n===1?gate.promise:batchGate.promise});
    const a=h.click(1);assert.equal(h.calls.length,1);
    const pending=[2,3,4,5].map(id=>h.click(id));assert.equal(h.calls.length,1);gate.resolve();await a;await tick();
    assert.equal(h.calls.length,2);const batch=h.calls[1].job;
    assert.equal(batch.command.type,'coopCompleteBatch');assert.deepEqual(batch.command.members.map(m=>m.id),['click-2','click-3','click-4','click-5']);
    assert.deepEqual(batch.command.members.map(m=>m.createdAt),[100001,100002,100003,100004]);
    assert.equal(h.sync.pendingActions().length,4);assert.equal(h.stored.length,1);assert.equal(h.stored[0].started,true);
    assert.equal(h.click(4),pending[2]);batchGate.resolve();const results=await Promise.all(pending);
    assert.equal(results.length,4);assert.ok(results.every(result=>result.claimed===false));assert.equal(h.sync.hasPendingSave(),false);
});
for(const barrier of ['purchase','restore','different-task'])test(`queue never coalesces across ${barrier}`,async t=>{
    const gate=deferred();const h=harness(t,{execute:(_,n)=>n===1?gate.promise:undefined});
    const first=h.click(1),a=h.click(2);let middle;
    if(barrier==='different-task')middle=h.click(3,'b');
    else if(barrier==='purchase')middle=h.sync.perform({type:'purchase',studentId:1,kind:'clothes',itemId:'shirt'},'purchase-barrier');
    else if(barrier==='restore')middle=h.sync.perform({type:'restore',value:{students:[1,2,3,4,5,6,7,8].map(id=>({id,tokens:0})),coopTasks:['a','b'].map(id=>({id,reward:10,completedBy:[]}))}},'restore');
    const b=h.click(4),c=h.click(5);gate.resolve();await Promise.all([first,a,middle,b,c]);
    assert.deepEqual(h.calls.map(c=>c.job.command.type),['coopComplete','coopComplete',barrier==='purchase'?'purchase':barrier==='restore'?'restore':'coopComplete','coopCompleteBatch']);
    assert.deepEqual(h.calls.at(-1).job.command.members.map(m=>m.studentId),[4,5]);
});
test('sent unknown singleton retries its original ID and cannot absorb waiting newcomers',async t=>{
    const gate=deferred();let failed=false;const h=harness(t,{execute:async(_,n)=>{if(n===1){await gate.promise;failed=true;throw new TypeError('unknown');}}});
    const first=h.click(1),a=h.click(2),b=h.click(3);gate.resolve();await tick();assert.equal(failed,true);
    h.emit();await Promise.all([first,a,b]);assert.equal(h.calls.length,3);
    assert.equal(h.calls[0].job.id,h.calls[1].job.id);assert.equal(h.calls[1].job.command.type,'coopComplete');assert.equal(h.calls[2].job.command.type,'coopCompleteBatch');
});
test('frozen batch survives reload, queries one receipt, explicit member retry retains whole batch, new click stays separate',async t=>{
    const gate=deferred(),unknown=deferred();const h=harness(t,{execute:(_,n)=>n===1?gate.promise:unknown.promise});
    const first=h.click(1),a=h.click(2),b=h.click(3);gate.resolve();await first;await tick();const saved=clone(h.stored);
    h.sync.dispose();unknown.reject(new TypeError('unknown'));await tick();void a;void b;
    const retryGate=deferred(),next=harness(t,{pending:saved,execute:(_,n)=>n===1?retryGate.promise:undefined});await tick();
    assert.equal(next.calls.length,0);assert.deepEqual(next.queries,['click-2']);assert.equal(next.sync.pendingActions().length,2);
    const retry=next.click(3),newcomer=next.click(4);assert.deepEqual(next.calls[0].job.command,saved[0].command);
    retryGate.resolve();await Promise.all([retry,newcomer]);assert.equal(next.calls.length,2);assert.equal(next.calls[1].job.command.type,'coopComplete');
});
for(const transition of ['hide','disconnect','dispose'])test(`frozen batch acknowledgement after ${transition} settles every promise without stale UI`,async t=>{
    const gate=deferred(),batchGate=deferred();const h=harness(t,{execute:(_,n)=>n===1?gate.promise:batchGate.promise});
    const first=h.click(1),a=h.click(2),b=h.click(3);gate.resolve();await first;await tick();
    if(transition==='hide')h.sync.setActive(false);else if(transition==='disconnect')h.sync.setConnected(false);else h.sync.dispose();
    batchGate.resolve();await Promise.all([a,b]);assert.equal(h.sync.hasPendingSave(),false);assert.equal(h.sync.canManage(),false);
});
test('freeze persistence failure rejects every member, sends none, and does not strand the worker',async t=>{
    const gate=deferred();let fail=true;const h=harness(t,{execute:(_,n)=>n===1?gate.promise:undefined,persist:jobs=>{if(fail&&jobs.some(job=>job.members))throw new Error('storage failed');}});
    const first=h.click(1),a=h.click(2),b=h.click(3);const settled=Promise.allSettled([a,b]);gate.resolve();await first;
    assert.ok((await settled).every(r=>r.status==='rejected'));assert.equal(h.calls.length,1);assert.equal(h.sync.hasPendingSave(),false);
    fail=false;await h.click(4);assert.equal(h.calls.length,2);
});
test('explicit retry save failure retains unknown frozen batch and rejects only its newly attached promise',async t=>{
    const pending=[{id:'old-1',key:'coop:a:1',createdAt:99900,started:true,command:{type:'coopCompleteBatch',taskId:'a',members:[1,2].map(i=>({id:`old-${i}`,createdAt:99900,studentId:i}))},members:[1,2].map(i=>({id:`old-${i}`,key:`coop:a:${i}`,createdAt:99900,command:command(i)}))}];
    let fail=true;const h=harness(t,{pending,persist:()=>{if(fail)throw new Error('save failed');}});await tick();
    await assert.rejects(h.click(2),/save failed/);assert.equal(h.calls.length,0);assert.equal(h.sync.pendingActions().length,2);assert.deepEqual(h.stored,pending);
    fail=false;await h.click(2);assert.equal(h.calls.length,1);assert.equal(h.calls[0].job.id,'old-1');assert.equal(h.sync.hasPendingSave(),false);
});
test('batch ack followed by local clear failure preserves success and persisted frozen receipt identity',async t=>{
    const gate=deferred(),batchGate=deferred();let fail=false;const h=harness(t,{execute:(_,n)=>n===1?gate.promise:batchGate.promise,persist:()=>{if(fail)throw new Error('clear failed');}});
    const first=h.click(1),a=h.click(2),b=h.click(3);gate.resolve();await first;await tick();const saved=clone(h.stored);
    fail=true;batchGate.resolve();await Promise.all([a,b]);assert.equal(h.sync.hasPendingSave(),false);assert.deepEqual(h.stored,saved);assert.equal(h.errors.length,1);
});
for(const flag of ['restored','started'])test(`contiguous scanner cannot cross a ${flag} same-task barrier`,()=>{
    const jobs=[1,2,3,4].map(id=>({id:`member-${id}`,createdAt:100,command:command(id)}));jobs[1][flag]=true;
    assert.deepEqual(queuedCoopBatch(jobs,jobs[0]),[jobs[0]]);
    assert.deepEqual(queuedCoopBatch(jobs,jobs[1]),[jobs[1]]);
    assert.deepEqual(queuedCoopBatch(jobs,jobs[2]),jobs.slice(2));
});
test('restored same-task explicit retry is sent alone before fresh queued members',async t=>{
    const gate=deferred(),pending=[{id:'restored-1',createdAt:99999,key:'coop:a:1',command:command(1)}];
    const h=harness(t,{pending,execute:(_,n)=>n===1?gate.promise:undefined});await tick();assert.equal(h.calls.length,0);
    const old=h.click(1),a=h.click(2),b=h.click(3);assert.equal(h.calls[0].job.id,'restored-1');
    gate.resolve();await Promise.all([old,a,b]);assert.deepEqual(h.calls.map(c=>c.job.command.type),['coopComplete','coopCompleteBatch']);
});
test('unknown frozen batch retries unchanged and cannot absorb newcomers',async t=>{
    const firstGate=deferred(),batchGate=deferred();
    const h=harness(t,{execute:async(_,n)=>{if(n===1)await firstGate.promise;if(n===2){await batchGate.promise;throw new TypeError('unknown batch');}}});
    const first=h.click(1),a=h.click(2),b=h.click(3);firstGate.resolve();await first;await tick();
    const newcomer=h.click(4);batchGate.resolve();await tick();h.emit();await Promise.all([a,b,newcomer]);
    assert.deepEqual(h.calls[1].job,h.calls[2].job);assert.equal(h.calls[3].job.command.studentId,4);
});
test('restored batch receipt fans out only its own member results and queries the transport once',async t=>{
    const pending=[freezeCoopBatch([1,2].map(id=>({id:`receipt-${id}`,key:`coop:a:${id}`,createdAt:99999,command:command(id)})))];
    const h=harness(t,{pending});h.receipts.set('receipt-1',{result:{members:[{id:'receipt-1',result:{claimed:false}},{id:'receipt-2',result:{claimed:true,reward:10}}]}});
    await tick();assert.deepEqual(h.queries,['receipt-1']);assert.equal(h.calls.length,0);assert.equal(h.recovered.length,2);
    assert.equal(h.recovered.filter(r=>r.result.claimed).length,1);assert.equal(h.sync.pendingActions().length,0);
});
test('new queued member save failure leaves no promise or queue hole',async t=>{
    const gate=deferred();let fail=false;const h=harness(t,{execute:(_,n)=>n===1?gate.promise:undefined,persist:()=>{if(fail)throw new Error('storage full');}});
    const first=h.click(1);fail=true;await assert.rejects(h.click(2),/storage full/);fail=false;
    const a=h.click(3),b=h.click(4);gate.resolve();await Promise.all([first,a,b]);
    assert.deepEqual(h.calls[1].job.command.members.map(m=>m.studentId),[3,4]);assert.equal(h.sync.hasPendingSave(),false);
});
test('persistent freeze and cleanup storage failure rejects all promises without sending a partial batch',async t=>{
    const gate=deferred();let fail=false;const h=harness(t,{execute:(_,n)=>n===1?gate.promise:undefined,persist:()=>{if(fail)throw new Error('storage unavailable');}});
    const first=h.click(1),a=h.click(2),b=h.click(3),settled=Promise.allSettled([a,b]);fail=true;gate.resolve();await first;
    assert.ok((await settled).every(r=>r.status==='rejected'));assert.equal(h.calls.length,1);assert.equal(h.sync.hasPendingSave(),false);
    const reloaded=harness(t,{pending:h.stored});await tick();assert.equal(reloaded.calls.length,0);
    assert.equal(reloaded.sync.pendingActions().length,3); // disk may retain pre-ack identities, never auto-resend them
});
for(const stale of ['success','failure'])test(`explicit batch retry owns settlement over older receipt ${stale}`,async t=>{
    const saved=freezeCoopBatch([1,2].map(studentId=>({id:`race-${studentId}`,key:`coop:a:${studentId}`,createdAt:100,command:command(studentId)})));
    const receipt=deferred(),execute=deferred();let emit,calls=0,recovered=0;
    const sync=createCloudSync({loadPending:()=>[saved],persistPending(){},subscribeRemote:next=>{emit=next;return ()=>{};},
        readReceipt:()=>receipt.promise,execute:()=>{calls++;return execute.promise;},applyState(){},lock(){},status(){},
        recovered:()=>recovered++,newId:()=>{throw new Error('must retain original IDs');},setInterval:()=>0,clearInterval(){}});
    t.after(()=>sync.dispose());sync.setConnected(true);emit({students:[]});await tick();
    const retry=sync.perform(command(2),'coop:a:2');assert.equal(calls,1);
    const result={members:[{id:'race-1',result:{claimed:false}},{id:'race-2',result:{claimed:true}}]};
    if(stale==='success')receipt.resolve({result});else receipt.reject(new Error('stale receipt failure'));
    await tick();assert.equal(sync.pendingActions().length,2);assert.equal(recovered,0);
    execute.resolve({progress:{students:[]},result});assert.equal((await retry).claimed,true);
    assert.equal(sync.pendingActions().length,0);assert.equal(recovered,1);
});
