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
        execute:async (job,pendingIds)=>{
            if(executeHook) await executeHook(job,pendingIds);
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
test('fallback polling reads changed cloud data once per minute and emits no processing message',async()=>{
    const h=harness();await h.start();assert.equal(h.interval,60000);
    h.remote=progress(50);await h.tick();assert.equal(h.local.students[0].tokens,50);
    assert.ok(h.messages.every(x=>x==='' || x==='離線中'));
});

function subscriptionHarness(options={}) {
    let remote=progress(20),local=progress(999),reads=0,subscribes=0,unsubscribes=0,tick,interval;
    let onProgress,onSubscriptionError;
    const messages=[],locks=[],errors=[],callbacks=[];
    const sync=createCloudSync({
        readRemote:async()=>{reads++;return clone(remote);},
        subscribeRemote:(next,error)=>{
            subscribes++;onProgress=next;onSubscriptionError=error;
            callbacks.push({next,error});
            let active=true;
            return ()=>{if(active){active=false;unsubscribes++;}};
        },
        execute:async job=>{
            remote.students[0].tokens+=job.command.amount;
            return {progress:clone(remote),result:{tokens:remote.students[0].tokens}};
        },
        applyState:value=>{local=clone(value);},lock:value=>locks.push(value),status:value=>messages.push(value),error:error=>errors.push(error),
        newId:()=> 'subscription-operation',now:()=>1000,
        setInterval:(fn,ms)=>{tick=fn;interval=ms;return 1;},clearInterval:()=>{},
        loadPending:()=>options.pending||[],persistPending:()=>{},readReceipt:async()=>null,
    });
    return {sync,messages,locks,errors,callbacks,
        get local(){return local;},get reads(){return reads;},get subscribes(){return subscribes;},get unsubscribes(){return unsubscribes;},get interval(){return interval;},
        emit:value=>onProgress(clone(value)),fail:error=>onSubscriptionError(error),tick:async()=>{tick();await Promise.resolve();}
    };
}
for(const eventOrder of ['before-ack','after-ack','newer-before-ack','lifecycle-change']) test(`equipment acknowledgement leaves display ordering to realtime events (${eventOrder})`,async t=>{
    let emit,release,local,reads=0,applies=0;
    const snapshot=(clothes,tokens=20)=>({students:[{id:1,equippedClothes:clothes,tokens},{id:2,tokens:77}],tasks:[]});
    const sync=createCloudSync({
        subscribeRemote:next=>{emit=next;return ()=>{};},
        readRemote:async()=>{reads++;throw new Error('unexpected full read');},
        execute:()=>new Promise(resolve=>release=()=>resolve({equipment:{studentId:1,field:'equippedClothes',value:'shirt'},result:{ok:true}})),
        applyState:value=>{local=clone(value);applies++;},lock(){},status(){},error:assert.fail,
        newId:()=> 'equipment',setInterval:()=>0,clearInterval(){},
    });
    t.after(()=>sync.dispose());sync.setConnected(true);emit(snapshot(null));
    const pending=sync.perform({type:'equip',studentId:1,kind:'clothes',itemId:'shirt'});
    if(eventOrder==='before-ack') emit(snapshot('shirt',89));
    if(eventOrder==='newer-before-ack'){
        emit(snapshot('shirt',89));emit(snapshot('newer-dress',95));
    }
    if(eventOrder==='lifecycle-change'){
        sync.setActive(false);sync.setActive(true);emit(snapshot('new-session-dress',100));
    }
    const before=clone(local),appliesBefore=applies;
    release();assert.deepEqual(await pending,{ok:true});
    assert.deepEqual(local,before);assert.equal(applies,appliesBefore);
    if(eventOrder==='after-ack'){emit(snapshot('shirt',89));assert.equal(local.students[0].equippedClothes,'shirt');}
    assert.equal(local.students[1].tokens,77);assert.equal(reads,0);assert.equal(sync.hasPendingSave(),false);
});
test('equipment acknowledgement refreshes server state for integrations without realtime subscriptions',async t=>{
    let local,reads=0;
    const sync=createCloudSync({readRemote:async()=>{reads++;return progress(reads===1?20:89);},
        execute:async()=>({equipment:{studentId:1,field:'equippedClothes',value:null},result:{ok:true}}),
        applyState:value=>local=value,lock(){},status(){},newId:()=> 'no-stream',setInterval:()=>0,clearInterval(){}});
    t.after(()=>sync.dispose());sync.setConnected(true);await sync.refresh();
    await sync.perform({type:'equip',studentId:1,kind:'clothes',itemId:null});
    assert.equal(local.students[0].tokens,89);assert.equal(reads,2);
});
test('a subscription snapshot verifies the connection and every later snapshot updates the page',async t=>{
    const h=subscriptionHarness();t.after(()=>h.sync.dispose());
    h.sync.setConnected(true);
    assert.equal(h.sync.canEdit(),false);assert.equal(h.subscribes,1);assert.equal(h.reads,0);
    h.emit(progress(42));await Promise.resolve();
    assert.equal(h.local.students[0].tokens,42);assert.equal(h.sync.canEdit(),true);
    h.emit(progress(57));await Promise.resolve();
    assert.equal(h.local.students[0].tokens,57);assert.ok(h.messages.every(value=>value===''||value==='離線中'));
});
test('subscriptions stop while hidden or offline and restart when the page becomes usable',async t=>{
    const h=subscriptionHarness();t.after(()=>h.sync.dispose());
    h.sync.setConnected(true);h.emit(progress(20));await Promise.resolve();
    h.sync.setActive(false);assert.equal(h.unsubscribes,1);assert.equal(h.sync.canEdit(),false);
    h.sync.setActive(true);assert.equal(h.subscribes,2);h.emit(progress(30));await Promise.resolve();
    h.sync.setConnected(false);assert.equal(h.unsubscribes,2);assert.equal(h.sync.canEdit(),false);
    h.sync.setConnected(true);assert.equal(h.subscribes,3);h.emit(progress(40));await Promise.resolve();
    assert.equal(h.local.students[0].tokens,40);assert.equal(h.sync.canEdit(),true);
});
test('the one-minute fallback timer does not download progress while a live subscription exists',async t=>{
    const h=subscriptionHarness();t.after(()=>h.sync.dispose());
    h.sync.setConnected(true);h.emit(progress(20));await Promise.resolve();
    assert.equal(h.interval,60000);await h.tick();assert.equal(h.reads,0);
});
test('a subscription failure locks mutations and reports offline without applying stale callbacks',async t=>{
    const h=subscriptionHarness();t.after(()=>h.sync.dispose());
    h.sync.setConnected(true);h.emit(progress(20));await Promise.resolve();
    const stale=h.callbacks[0].next;h.fail(Object.assign(new TypeError('network lost'),{retryable:true}));
    assert.equal(h.sync.canEdit(),false);assert.equal(h.messages.at(-1),'離線中');assert.deepEqual(h.errors,[]);
    h.sync.setActive(false);stale(progress(99));assert.equal(h.local.students[0].tokens,20);
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
test('each transaction receives every locally pending operation id',async()=>{
    const h=harness({pending:[{id:'unresolved-operation',key:'old',createdAt:500,command:{type:'resources',amount:3}}]});
    await h.start();let protectedIds;
    h.setExecute((job,pendingIds)=>{protectedIds=pendingIds;});
    await h.sync.perform({type:'resources',amount:5},'new');
    assert.deepEqual(new Set(protectedIds),new Set(['unresolved-operation','operation-1']));
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
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function receiptHarness(t,{pending=true}={}){
    let clock=1000,reads=0,local,receiptHook=()=>null,executeHook=()=>({progress:progress(25),result:{ok:true}}),readHook=()=>progress(20);
    const callbacks=[],queries=[],executions=[],recovered=[],stored=[],errors=[];
    const command={type:'resources',amount:5},old={id:'old',key:'old-control',createdAt:500,command};
    const sync=createCloudSync({
        subscribeRemote:(next,error)=>{callbacks.push({next,error});return ()=>{};},
        readRemote:async()=>{reads++;return readHook();},
        readReceipt:async id=>{queries.push(id);return receiptHook(id);},
        execute:async job=>{executions.push(clone(job.command));return executeHook(job);},
        loadPending:()=>pending?[old]:[],persistPending:jobs=>stored.push(clone(jobs)),
        recovered:(command,result)=>recovered.push({command,result}),applyState:value=>local=clone(value),
        lock(){},status(){},error:error=>errors.push(error),now:()=>clock,newId:()=> 'new',setInterval:()=>0,clearInterval(){},
    });
    t.after(()=>sync.dispose());sync.setConnected(true);
    return {sync,queries,executions,recovered,stored,errors,command,callbacks,
        get reads(){return reads;},get local(){return local;},advance:ms=>clock+=ms,
        emit:(value=progress(20))=>callbacks.at(-1).next(value),
        receipt:fn=>receiptHook=fn,execute:fn=>executeHook=fn,read:fn=>readHook=fn};
}
test('receipt budget shares in-flight queries across snapshot bursts, refresh and flush',async t=>{
    const h=receiptHarness(t),gate=deferred();h.receipt(()=>gate.promise);
    for(let i=0;i<30;i++) h.emit();
    const refresh=h.sync.refresh(),flush=h.sync.flush();await settleBackground();
    assert.deepEqual(h.queries,['old']);assert.equal(h.reads,1);
    gate.resolve({result:{ok:true}});assert.equal(await refresh,true);assert.equal(await flush,true);
    assert.equal(h.recovered.length,1);assert.equal(h.stored.length,1);assert.equal(h.sync.hasPendingSave(),false);
    assert.equal(h.executions.length,0);
});
test('negative receipt budget cools down snapshots only and never cancels an unresolved operation',async t=>{
    const h=receiptHarness(t);h.emit();await settleBackground();
    for(let i=0;i<30;i++){h.emit();await settleBackground();}
    assert.equal(h.queries.length,1);assert.equal(h.sync.hasPendingSave(),true);assert.equal(h.sync.canManage(),true);
    h.advance(4999);h.emit();await settleBackground();assert.equal(h.queries.length,1);
    h.advance(1);h.emit();await settleBackground();assert.equal(h.queries.length,2);
    await h.sync.refresh();assert.equal(h.queries.length,3);
    assert.equal(await h.sync.flush(),false);assert.equal(h.queries.length,4);assert.equal(h.reads,1);
    assert.equal(h.stored.length,0);assert.equal(h.executions.length,0);assert.deepEqual(h.errors,[]);
    h.sync.setConnected(false);h.sync.setConnected(true);h.emit();await settleBackground();assert.equal(h.queries.length,5);
    h.sync.setActive(false);h.sync.setActive(true);h.receipt(()=>({result:{ok:true}}));h.emit();await settleBackground();
    assert.equal(h.queries.length,6);assert.equal(h.recovered.length,1);assert.equal(h.sync.hasPendingSave(),false);
});
for(const transition of ['reconnect','reactivate','dispose']) for(const response of ['success','failure']) test(`stale receipt ${response} cannot affect ${transition}`,async t=>{
    const h=receiptHarness(t),old=deferred(),fresh=deferred();h.receipt(()=>old.promise);h.emit();await settleBackground();
    if(transition==='reconnect'){h.sync.setConnected(false);h.sync.setConnected(true);}
    if(transition==='reactivate'){h.sync.setActive(false);h.sync.setActive(true);}
    if(transition==='dispose') h.sync.dispose();
    else {h.receipt(()=>fresh.promise);h.emit(progress(70));await settleBackground();}
    if(response==='success') old.resolve({result:{old:true}});else old.reject(new TypeError('old request'));
    await settleBackground();
    assert.equal(h.recovered.length,0);assert.equal(h.stored.length,0);assert.equal(h.sync.hasPendingSave(),true);assert.deepEqual(h.errors,[]);
    if(transition==='dispose'){
        h.sync.setActive(true);h.sync.setConnected(true);h.emit(progress(999));
        assert.equal(h.sync.canManage(),false);assert.equal(h.local.students[0].tokens,20);assert.equal(h.queries.length,1);
    }else{
        assert.equal(h.sync.canManage(),true);h.emit();await settleBackground();assert.equal(h.queries.length,2);
        fresh.resolve({result:{fresh:true}});await settleBackground();assert.equal(h.recovered.length,1);
        assert.deepEqual(h.recovered[0].result,{fresh:true});
    }
});
for(const response of ['success','failure']) test(`explicit retry owns settlement instead of its older receipt ${response}`,async t=>{
    const h=receiptHarness(t),receipt=deferred(),execute=deferred();h.receipt(()=>receipt.promise);h.execute(()=>execute.promise);
    h.emit();await settleBackground();const pending=h.sync.perform(h.command,'old-control');
    if(response==='success') receipt.resolve({result:{stale:true}});else receipt.reject(new TypeError('stale failure'));
    await settleBackground();assert.equal(h.sync.hasPendingSave(),true);assert.equal(h.recovered.length,0);assert.equal(h.sync.canManage(),true);
    execute.resolve({progress:progress(25),result:{ok:true}});assert.deepEqual(await pending,{ok:true});
    assert.equal(h.executions.length,1);assert.equal(h.sync.hasPendingSave(),false);assert.deepEqual(h.errors,[]);
});
test('receipt request failure can be explicitly refreshed without negative caching',async t=>{
    const h=receiptHarness(t);h.receipt(()=>{throw new TypeError('offline');});h.emit();await settleBackground();
    assert.equal(h.sync.canManage(),false);assert.equal(h.sync.hasPendingSave(),true);
    h.receipt(()=>({result:{ok:true}}));assert.equal(await h.sync.refresh(),true);
    assert.equal(h.queries.length,2);assert.equal(h.recovered.length,1);
});
test('verified realtime queue drain has zero full reads and still waits for every queued command',async t=>{
    const h=receiptHarness(t,{pending:false}),gate=deferred();h.emit();await settleBackground();
    assert.equal(await h.sync.flush(),true);assert.equal(h.reads,0);
    h.execute(async()=>{await gate.promise;return {progress:progress(30),result:{ok:true}};});
    const a=h.sync.perform(h.command,'a'),b=h.sync.perform({...h.command,amount:7},'b');
    let drained=false;const flush=h.sync.flush().then(value=>{drained=true;return value;});await settleBackground();
    assert.equal(drained,false);assert.equal(h.reads,0);gate.resolve();
    assert.equal(await flush,true);await Promise.all([a,b]);assert.equal(h.executions.length,2);assert.equal(h.reads,0);
});
for(const transition of ['disconnect','hide','dispose']) test(`queue drain cannot report success after ${transition}`,async t=>{
    const h=receiptHarness(t,{pending:false}),gate=deferred();h.emit();await settleBackground();h.execute(()=>gate.promise);
    const pending=h.sync.perform(h.command),flush=h.sync.flush();await settleBackground();
    if(transition==='disconnect') h.sync.setConnected(false);
    if(transition==='hide') h.sync.setActive(false);
    if(transition==='dispose') h.sync.dispose();
    gate.resolve({progress:progress(99),result:{ok:true}});await pending;
    assert.equal(await flush,false);assert.equal(h.local.students[0].tokens,20);assert.equal(await h.sync.flush(),false);assert.equal(h.reads,0);
});
test('flush refreshes unverified connections and returns false on uncertain writes without waiting forever',async t=>{
    const h=receiptHarness(t,{pending:false});assert.equal(await h.sync.flush(),true);assert.equal(h.reads,1);
    h.execute(()=>{throw new TypeError('ack lost');});const pending=h.sync.perform(h.command);
    assert.equal(await h.sync.flush(),false);assert.equal(h.sync.hasPendingSave(),true);assert.equal(h.sync.canManage(),false);
    h.execute(()=>({progress:progress(25),result:{ok:true}}));assert.equal(await h.sync.flush(),true);await pending;
    assert.equal(h.reads,2);assert.equal(h.sync.hasPendingSave(),false);
});
test('a command queued immediately after an acknowledgement cannot be stranded behind a finishing worker',async t=>{
    const h=receiptHarness(t,{pending:false});h.emit();await settleBackground();
    await h.sync.perform(h.command,'first');
    const second=h.sync.perform({...h.command,amount:7},'second');
    await settleBackground();assert.equal(h.executions.length,2);await second;
    assert.equal(await h.sync.flush(),true);
});
test('flush reports a domain rejection during drain rather than an empty-queue success',async t=>{
    const h=receiptHarness(t,{pending:false}),gate=deferred();h.emit();await settleBackground();h.execute(()=>gate.promise);
    const pending=h.sync.perform(h.command),rejected=assert.rejects(pending,/denied/),flush=h.sync.flush();await settleBackground();
    gate.reject(new Error('denied'));await rejected;
    assert.equal(await flush,false);assert.equal(h.sync.hasPendingSave(),false);
});
test('polling-only flush retains a fresh server read even with an empty verified queue',async()=>{
    const h=harness();await h.start();const before=h.reads;h.remote=progress(88);
    assert.equal(await h.sync.flush(),true);assert.equal(h.reads,before+1);assert.equal(h.local.students[0].tokens,88);
});
for(const response of ['success','failure']) test(`refresh ignores old lifecycle ${response} and reads the new server state`,async t=>{
    const h=receiptHarness(t,{pending:false}),gate=deferred();h.read(()=>gate.promise);
    const reading=h.sync.refresh();h.sync.setActive(false);h.sync.setActive(true);h.read(()=>progress(77));
    if(response==='success') gate.resolve(progress(999));else gate.reject(new TypeError('old read'));
    assert.equal(await reading,true);assert.equal(h.local.students[0].tokens,77);assert.equal(h.reads,2);assert.deepEqual(h.errors,[]);
});
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
