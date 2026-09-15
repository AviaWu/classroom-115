import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudSync} from '../public/cloud-sync.mjs';
import {applyOperation,normalizeProgress} from '../public/game-operations.mjs';
const clone = x => structuredClone(x);
const progress = tokens => ({students:[{id:1,tokens}],tasks:[]});
function harness(options={}) {
    let remote=progress(20),local=progress(999),writes=0,reads=0,nextId=0,readHook,executeHook;
    const messages=[],locks=[],errors=[],receipts=new Map(),stored=[];
    let tick,interval;
    const sync=createCloudSync({
        readRemote:async()=>{reads++;return readHook ? readHook() : clone(remote);},
        execute:async job=>{
            if(executeHook) await executeHook(job);
            if(receipts.has(job.id)) return clone(receipts.get(job.id));
            remote.students[0].tokens+=job.command.amount;
            writes++;
            const outcome={progress:clone(remote),result:{tokens:remote.students[0].tokens}};
            receipts.set(job.id,outcome);return outcome;
        },
        readReceipt:async id=>receipts.has(id)?{result:receipts.get(id).result}:null,
        applyState:value=>{local=clone(value);},lock:x=>locks.push(x),status:x=>messages.push(x),error:e=>errors.push(e),
        newId:()=>`operation-${++nextId}`,now:()=>1000,
        persistPending:jobs=>{stored.splice(0,stored.length,...clone(jobs));},loadPending:()=>options.pending||[],
        setInterval:(fn,ms)=>{tick=fn;interval=ms;return 1;},clearInterval:()=>{},
    });
    return {sync,messages,locks,errors,stored,receipts,
        get remote(){return remote;},set remote(v){remote=clone(v);},get local(){return local;},get writes(){return writes;},get reads(){return reads;},get interval(){return interval;},
        setRead:fn=>readHook=fn,setExecute:fn=>executeHook=fn,tick:()=>tick(),
        async start(){sync.setConnected(true);await sync.refresh();}
    };
}
test('opening and refreshing reads cloud without uploading local state or migrating metadata',async()=>{
    const h=harness();h.remote={...progress(42),revision:7,syncVersion:3};await h.start();
    assert.equal(h.local.students[0].tokens,42);assert.equal(h.writes,0);
    await h.sync.refresh();assert.equal(h.writes,0);
});
test('polling reads changed cloud data at five seconds and emits no processing message',async()=>{
    const h=harness();await h.start();assert.equal(h.interval,5000);
    h.remote=progress(50);await h.tick();assert.equal(h.local.students[0].tokens,50);
    assert.ok(h.messages.every(x=>x==='' || x==='離線中'));
});
test('actions write immediately while other controls remain available',async()=>{
    const h=harness();await h.start();let release;
    h.setExecute(()=>new Promise(r=>release=r));
    const pending=h.sync.perform({type:'resources',amount:5},'one');await Promise.resolve();
    assert.equal(h.sync.canEdit(),true);release();await pending;
    assert.equal(h.remote.students[0].tokens,25);assert.equal(h.writes,1);
});
test('double clicks reuse one in-flight action',async()=>{
    const h=harness();await h.start();
    const a=h.sync.perform({type:'resources',amount:5},'same');
    const b=h.sync.perform({type:'resources',amount:5},'same');await Promise.all([a,b]);
    assert.equal(h.writes,1);
});
test('concurrent queued actions preserve both deltas',async()=>{
    const h=harness();await h.start();
    await Promise.all([h.sync.perform({type:'resources',amount:5},'a'),h.sync.perform({type:'resources',amount:7},'b')]);
    assert.equal(h.remote.students[0].tokens,32);assert.equal(h.local.students[0].tokens,32);
});
test('old polling response cannot overwrite an acknowledged action',async()=>{
    const h=harness();await h.start();let release;
    h.setRead(()=>new Promise(r=>release=r));const reading=h.sync.refresh();await Promise.resolve();
    h.setRead(null);await h.sync.perform({type:'resources',amount:5},'a');
    release(progress(20));await reading;assert.equal(h.local.students[0].tokens,25);
});
test('offline blocks mutations; reconnect reads before unlocking',async()=>{
    const h=harness();await h.start();h.sync.setConnected(false);
    assert.equal(h.sync.canEdit(),false);
    await assert.rejects(h.sync.perform({type:'resources',amount:5},'a'));
    h.remote=progress(70);h.sync.setConnected(true);assert.equal(h.sync.canEdit(),false);
    await h.sync.refresh();assert.equal(h.local.students[0].tokens,70);assert.equal(h.writes,0);
    assert.ok(h.messages.includes('離線中'));
});
test('uncertain network outcome retries same operation id after server read',async()=>{
    const h=harness();await h.start();let first=true,seen=[];
    h.setExecute(job=>{seen.push(job.id);if(first){first=false;throw Object.assign(new Error('network'),{retryable:true});}});
    const pending=h.sync.perform({type:'resources',amount:5},'a');
    await new Promise(r=>setImmediate(r));assert.equal(h.sync.canEdit(),false);assert.equal(h.stored.length,1);
    await h.sync.refresh();await pending;
    assert.equal(seen[0],seen[1]);assert.equal(h.writes,1);assert.equal(h.stored.length,0);
});
test('returning to tab refreshes cloud without uploading cached changes',async()=>{
    const h=harness();await h.start();h.sync.setActive(false);h.remote=progress(81);
    h.sync.setActive(true);await h.sync.refresh();assert.equal(h.local.students[0].tokens,81);assert.equal(h.writes,0);
});
test('empty cloud clears displayed old progress and does not recreate it',async()=>{
    const h=harness();await h.start();h.remote=null;await h.sync.refresh();
    assert.equal(h.local,null);assert.equal(h.sync.canEdit(),false);assert.equal(h.writes,0);assert.equal(h.sync.canManage(),true);
});
test('reload only checks unresolved receipts and never resends them automatically',async()=>{
    const h=harness({pending:[{id:'old-op',key:'a',createdAt:1000,command:{type:'resources',amount:5}}]});
    await h.start();await h.tick();assert.equal(h.writes,0);assert.equal(h.sync.hasPendingSave(),true);
    await h.sync.perform({type:'resources',amount:5},'a');assert.equal(h.writes,1);
});
test('domain rejection leaves confirmed cloud progress intact and permits following actions',async()=>{
    const h=harness();await h.start();h.setExecute(()=>{throw new Error('代幣不足');});
    await assert.rejects(h.sync.perform({type:'resources',amount:5},'a'),/代幣不足/);
    assert.equal(h.local.students[0].tokens,20);assert.equal(h.sync.canEdit(),true);assert.equal(h.stored.length,0);
});
test('failure to clear local pending storage after cloud acknowledgement does not lose success',async()=>{
    let saves=0;
    const sync=createCloudSync({readRemote:async()=>progress(20),execute:async()=>({progress:progress(25),result:{ok:true}}),applyState(){},lock(){},status(){},error(){},newId:()=> 'persist-id',setInterval:()=>1,clearInterval(){},persistPending:()=>{if(++saves>1)throw new Error('storage unavailable');}});
    sync.setConnected(true);await sync.refresh();
    const result=await sync.perform({type:'resources',amount:5},'a');assert.equal(result.ok,true);assert.equal(sync.hasPendingSave(),false);
});
test('different actions with the same control key are both committed in order',async()=>{
    const h=harness();await h.start();await Promise.all([h.sync.perform({type:'resources',amount:5},'same-control'),h.sync.perform({type:'resources',amount:7},'same-control')]);
    assert.equal(h.remote.students[0].tokens,32);assert.equal(h.writes,2);
});
test('a newly confirmed restore never silently replays a different pending backup',async()=>{
    const h=harness({pending:[{id:'pending-restore',key:'restore',createdAt:1000,command:{type:'restore',value:progress(1)}}]});await h.start();
    await assert.rejects(h.sync.perform({type:'restore',value:progress(99)},'restore'),/未確認/);assert.equal(h.writes,0);
});
test('poll ticks during a slow server read coalesce without keeping refresh alive forever',async()=>{
    const h=harness();await h.start();let release,first=true;
    h.setRead(()=>{if(first){first=false;return new Promise(r=>release=r);}return progress(20);});
    const count=h.reads,reading=h.sync.refresh();await Promise.resolve();void h.tick();release(progress(20));await reading;
    assert.equal(h.reads-count,1);
});

const settleBackground = () => new Promise(resolve=>setImmediate(resolve));
function cleanupHarness(t,options={}) {
    let remote=normalizeProgress({students:[{id:1}],drawings:options.drawings||[],pendingArtworkDeletes:options.pending||['drawing_old']}),counter=0;
    const events=[],errors=[];
    let deleteHook=options.deleteArtwork;
    const sync=createCloudSync({
        readRemote:async()=>clone(remote),applyState(){},lock(){},status(){},error:error=>errors.push(error),
        deleteArtwork:async id=>{events.push(`delete:${id}`);if(deleteHook) await deleteHook(id);},
        execute:async job=>{
            events.push(`${job.command.type}:${job.command.drawingId||''}`);
            const outcome=applyOperation(remote,job.command,Date.now());remote=outcome.progress;return outcome;
        },
        newId:()=>`cleanup-${++counter}`,setInterval:()=>1,clearInterval(){}
    });
    t.after(()=>sync.dispose());
    return {sync,events,errors,get remote(){return remote;},set remote(value){remote=normalizeProgress(value);},
        setDelete:fn=>deleteHook=fn,async start(){sync.setConnected(true);await sync.refresh();await settleBackground();}};
}
test('accepted progress automatically deletes evicted artwork before confirming its queue entry',async t=>{
    const h=cleanupHarness(t);await h.start();
    assert.deepEqual(h.events,['delete:drawing_old','confirmArtworkDeletion:drawing_old']);
    assert.deepEqual(h.remote.pendingArtworkDeletes,[]);
    await h.sync.refresh();await settleBackground();assert.equal(h.events.length,2);
});
test('failed artwork deletion leaves its queue entry and retries on the next snapshot without locking gameplay',async t=>{
    let first=true;
    const h=cleanupHarness(t,{deleteArtwork:()=>{if(first){first=false;throw new TypeError('offline artwork request');}}});
    await h.start();assert.deepEqual(h.remote.pendingArtworkDeletes,['drawing_old']);
    assert.deepEqual(h.events,['delete:drawing_old']);assert.equal(h.sync.canEdit(),true);
    await h.sync.refresh();await settleBackground();
    assert.deepEqual(h.events,['delete:drawing_old','delete:drawing_old','confirmArtworkDeletion:drawing_old']);
    assert.deepEqual(h.remote.pendingArtworkDeletes,[]);
});
test('concurrent snapshots serialize deletion and newly accepted pending IDs are also cleaned',async t=>{
    let release;
    const h=cleanupHarness(t,{deleteArtwork:()=>new Promise(resolve=>release=resolve)});await h.start();
    h.remote={...h.remote,pendingArtworkDeletes:['drawing_old','drawing_next']};
    await Promise.all([h.sync.refresh(),h.sync.refresh()]);await settleBackground();
    assert.deepEqual(h.events,['delete:drawing_old']);
    h.setDelete(null);release();await settleBackground();
    assert.deepEqual(h.events,['delete:drawing_old','confirmArtworkDeletion:drawing_old','delete:drawing_next','confirmArtworkDeletion:drawing_next']);
    assert.deepEqual(h.remote.pendingArtworkDeletes,[]);
});
test('reconnecting retries queued artwork deletion but currently retained drawing IDs are untouched',async t=>{
    const h=cleanupHarness(t,{pending:['drawing_kept','drawing_old'],drawings:[{id:'drawing_kept',savedAt:'2026-09-16T00:00:00.000Z'}],deleteArtwork:()=>{throw new TypeError('offline');}});
    await h.start();assert.deepEqual(h.events,['delete:drawing_old']);
    h.sync.setConnected(false);h.setDelete(null);await h.sync.refresh();assert.equal(h.events.length,1);
    h.sync.setConnected(true);await h.sync.refresh();await settleBackground();
    assert.deepEqual(h.events,['delete:drawing_old','delete:drawing_old','confirmArtworkDeletion:drawing_old']);
    assert.deepEqual(h.remote.pendingArtworkDeletes,['drawing_kept']);
});
test('an artwork restored during a pending delete is not confirmed out of the queue',async t=>{
    let finish;
    const h=cleanupHarness(t,{deleteArtwork:()=>new Promise(resolve=>finish=resolve)});await h.start();
    h.remote={...h.remote,drawings:[{id:'drawing_old',savedAt:'2026-09-16T00:00:00.000Z'}]};
    await h.sync.refresh();finish();await settleBackground();
    assert.deepEqual(h.events,['delete:drawing_old']);
    assert.deepEqual(h.remote.pendingArtworkDeletes,['drawing_old']);
});
