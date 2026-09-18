import test from 'node:test';
import assert from 'node:assert/strict';
import {createFirebaseStore,createProgressSubscriber} from '../public/firebase-store.mjs';
const initial=()=>({progress:{students:[{id:1,tokens:100,lotteryTickets:1}],clothesM:[{id:'shirt',name:'服裝',level:'R',price:50,active:true}],revision:9,syncVersion:3,commitId:'legacy'},operations:{}});
const resolveServerValues=(value,clock=100000)=>{
    if(value && typeof value==='object'){
        if(value['.sv']==='timestamp') return clock;
        return Array.isArray(value)?value.map(item=>resolveServerValues(item,clock)):Object.fromEntries(Object.entries(value).map(([key,item])=>[key,resolveServerValues(item,clock)]));
    }
    return value;
};
function server(){
    let room=initial(),artworks={},etag=1,writes=0,drop=false,conflict=false,conflictMutation,dropDelete=false;const calls=[];
    const fetch=async(url,options)=>{
        calls.push({url,options});await Promise.resolve();const path=new URL(url).pathname;
        if(path.startsWith('/artworks/classroom-115/')){
            const id=decodeURIComponent(path.split('/').pop().replace('.json',''));
            if(options.method==='PUT'){artworks[id]=JSON.parse(options.body);return Response.json(artworks[id]);}
            if(options.method==='DELETE'){if(dropDelete){dropDelete=false;throw new TypeError('network lost during delete');}delete artworks[id];return Response.json(null);}
            return Response.json(artworks[id]||null);
        }
        if(options.method==='PUT'){
            if(conflict){conflict=false;room=conflictMutation?.(room)??room;etag++;return new Response('{}',{status:412});}
            if(options.headers['if-match']!==String(etag))return new Response('{}',{status:412});
            room=resolveServerValues(JSON.parse(options.body));writes++;etag++;
            if(drop){drop=false;throw new TypeError('network lost after commit');}
            if(new URL(url).searchParams.get('print')==='silent') return new Response(null,{status:204});
            return Response.json(room);
        }
        let value=path.endsWith('/progress.json')?room.progress:path.includes('/operations/')?room.operations[path.split('/').pop().replace('.json','')]||null:room;
        return Response.json(value,{headers:{etag:String(etag)}});
    };
    const store=createFirebaseStore({databaseURL:'https://fake.test',getToken:async()=>'fake-token',getUid:()=> 'test-user',now:()=>100000,fetch});
    return {store,get room(){return room;},set room(v){room=v;etag++;},get artworks(){return artworks;},get writes(){return writes;},get calls(){return calls;},dropNext:()=>drop=true,dropNextDelete:()=>dropDelete=true,conflictNext:mutation=>{conflict=true;conflictMutation=mutation;}};
}
function sdkServer(options={}) {
    let room=initial(),transactions=0;const fetchCalls=[];
    const transactRoom=options.transactRoom|| (async update=>{
        transactions++;
        const next=update(clone(room));
        if(next===undefined) return {committed:false,value:clone(room)};
        room=resolveServerValues(next,options.now?.()??100000);
        return {committed:true,value:clone(room)};
    });
    const store=createFirebaseStore({databaseURL:'https://fake.test',getToken:async()=>'fake-token',getUid:()=> 'test-user',
        now:options.now||(()=>100000),fetch:async(...args)=>{fetchCalls.push(args);throw new Error('unexpected REST request');},transactRoom});
    return {store,get room(){return room;},set room(value){room=clone(value);},get transactions(){return transactions;},fetchCalls};
}
const clone=value=>structuredClone(value);
const job=(id,command)=>({id,createdAt:90000,command});
const progressFields=['students','tasks','clothesM','clothesF','layouts','backgrounds','boss','bosses','coopTasks',
    'coopTaskTemplates','dailyTaskTemplates','weeklyTaskTemplates','deletedTaskIds','deletedCoopTaskIds',
    'drawings','pendingArtworkDeletes','globalBgImage','lastSaved'];
function subscriptionServer() {
    const listeners=new Map(),unsubscribed=[];let tokenReads=0;
    const subscribe=createProgressSubscriber({database:{},getToken:async()=>{tokenReads++;return 'token';},
        ref:(_database,path)=>path,onValue:(path,next,error)=>{
            listeners.set(path,{next,error});return ()=>unsubscribed.push(path);
        }});
    const emit=(field,value)=>listeners.get(`games/classroom-115/progress/${field}`).next({val:()=>clone(value)});
    return {subscribe,listeners,unsubscribed,emit,get tokenReads(){return tokenReads;}};
}
const settleSubscription=()=>new Promise(resolve=>setImmediate(resolve));
test('progress subscription waits for every child once then publishes merged child updates',async()=>{
    const boss={id:'dragon',name:'巨龍',maxHp:20,questions:[]};
    const s=subscriptionServer(),values={students:[{id:1,tokens:10}],tasks:[{id:'task',reward:5}],bosses:[boss],drawings:[{id:'drawing_test1',savedAt:'2026-09-16T00:00:00Z'}]},published=[],errors=[];
    const stop=s.subscribe(value=>published.push(value),error=>errors.push(error));await settleSubscription();
    assert.equal(s.tokenReads,1);assert.deepEqual([...s.listeners.keys()],progressFields.map(field=>`games/classroom-115/progress/${field}`));
    for(const field of progressFields.slice(0,-1)) s.emit(field,values[field]??null);
    assert.deepEqual(published,[]);
    s.emit('lastSaved','2026-09-16T00:00:00Z');
    assert.equal(published.length,1);assert.equal(published[0].students[0].tokens,10);assert.deepEqual(published[0].tasks,values.tasks);assert.deepEqual(published[0].bosses,[{...boss,name:'巨龍',image:'',maxHp:20,attackPassword:'',reward:0,questions:[],active:true,publishedAt:0}]);
    s.emit('students',[{id:1,tokens:25}]);
    assert.equal(published.length,2);assert.equal(published[1].students[0].tokens,25);assert.deepEqual(published[1].tasks,values.tasks);assert.deepEqual(published[1].bosses,published[0].bosses);
    assert.deepEqual(errors,[]);stop();assert.deepEqual(s.unsubscribed,[...s.listeners.keys()]);
});
test('progress subscription converts a legacy single boss into the current bosses array',async()=>{
    const legacyBoss={id:'legacy-dragon',name:'舊巨龍',hp:12,questions:[]};
    const s=subscriptionServer(),published=[],errors=[];
    s.subscribe(value=>published.push(value),error=>errors.push(error));await settleSubscription();
    for(const field of progressFields) s.emit(field,field==='students'?[{id:1}]:field==='boss'?legacyBoss:field==='lastSaved'?'2026-09-16T00:00:00Z':null);
    assert.equal(published.length,1);assert.equal(published[0].boss,undefined);assert.equal(published[0].bosses.length,1);assert.equal(published[0].bosses[0].id,legacyBoss.id);assert.equal(published[0].bosses[0].maxHp,12);assert.deepEqual(errors,[]);
});
test('progress subscription reports malformed merged data and ignores callbacks after unsubscribe',async()=>{
    const s=subscriptionServer(),published=[],errors=[];
    const stop=s.subscribe(value=>published.push(value),error=>errors.push(error));await settleSubscription();
    for(const field of progressFields) s.emit(field,field==='lastSaved'?'2026-09-16T00:00:00Z':null);
    assert.equal(published.length,0);assert.match(errors[0].message,/成員/);
    stop();s.emit('students',[{id:1,tokens:99}]);assert.equal(published.length,0);
});
test('artwork REST methods keep drawing payloads outside the room transaction',async()=>{
    const s=server(),drawing={id:'drawing_1abc',savedAt:'2026-09-16T00:00:00.000Z',data:'data:image/jpeg;base64,AA=='};
    assert.deepEqual(await s.store.writeArtwork(drawing),{id:drawing.id,savedAt:drawing.savedAt});
    assert.match(s.calls[0].url,/\/artworks\/classroom-115\/drawing_1abc\.json/);
    assert.equal(s.calls[0].options.method,'PUT');
    assert.deepEqual(await s.store.readArtwork(drawing.id),drawing);
    await s.store.deleteArtwork(drawing.id);
    assert.equal(s.calls.at(-1).options.method,'DELETE');
});
test('artwork timestamps accept ISO Z without milliseconds and reject spaces',async()=>{
    const s=server(),drawing={id:'drawing_timestamp1',savedAt:'2026-09-16T00:00:00Z',data:'data:image/jpeg;base64,AA=='};
    await s.store.writeArtwork(drawing);
    await assert.rejects(s.store.writeArtwork({...drawing,savedAt:'2026-09-16 00:00:00Z'}),/畫作/);
});
test('saveDrawing uploads validated payload before committing metadata only',async()=>{
    const s=server(),drawing={id:'drawing_2abc',savedAt:'2026-09-16T00:00:00.000Z',data:'data:image/jpeg;base64,AA=='};
    await s.store.execute(job('save-drawing',{type:'saveDrawing',drawing}));
    const upload=s.calls.find(call=>call.url.includes('/artworks/classroom-115/drawing_2abc.json'));
    assert.equal(upload.options.method,'PUT');
    assert.deepEqual(s.room.progress.drawings,[{id:drawing.id,savedAt:drawing.savedAt}]);
    assert.equal(JSON.stringify(s.room).includes(drawing.data),false);
    const calls=s.calls.length;
    await assert.rejects(s.store.execute(job('bad-id',{type:'saveDrawing',drawing:{...drawing,id:'bad'}})),/畫作/);
    await assert.rejects(s.store.writeArtwork({...drawing,data:'not-a-data-url'}),/畫作/);
    await assert.rejects(s.store.execute(job('bad-restore',{type:'restore',value:{students:[{id:1}],drawings:[{...drawing,data:'not-a-data-url'}]}})),/畫作/);
    assert.equal(s.calls.length,calls);
});
test('restore uploads only the newest three artwork payloads',async()=>{
    const drawings=Array.from({length:4},(_,index)=>({id:`drawing_restore${index}`,savedAt:`2026-09-16T00:00:00.00${index}Z`,data:'data:image/png;base64,AA=='}));
    const s=server();
    await s.store.execute(job('restore-artwork',{type:'restore',value:{students:[{id:1,tokens:0}],drawings}}));
    assert.deepEqual(Object.keys(s.artworks).sort(),drawings.slice(1).map(item=>item.id).sort());
    assert.deepEqual(s.room.progress.drawings.map(item=>item.id),drawings.slice(1).reverse().map(item=>item.id));
});
test('a retried drawing save reuses its operation receipt after a lost acknowledgement',async()=>{
    const s=server(),drawing={id:'drawing_retry1',savedAt:'2026-09-16T00:00:00.000Z',data:'data:image/jpeg;base64,AA=='},request=job('save-retry',{type:'saveDrawing',drawing});
    s.dropNext();
    await assert.rejects(s.store.execute(request));
    await s.store.execute(request);
    assert.equal(s.writes,1);
    assert.deepEqual(s.room.progress.drawings,[{id:drawing.id,savedAt:drawing.savedAt}]);
    assert.ok(s.room.operations[request.id]);
});
test('completed drawing receipts skip preprocessing and ETag retries upload once',async()=>{
    const drawing={id:'drawing_receipt1',savedAt:'2026-09-16T00:00:00Z',data:'data:image/jpeg;base64,AA=='},request=job('saved-drawing',{type:'saveDrawing',drawing});
    const done=server();
    done.room={...done.room,operations:{[request.id]:{result:{json:'{"ok":true}'}}}};
    await done.store.execute(request);
    assert.equal(done.calls.filter(call=>call.options.method==='PUT' && call.url.includes('/artworks/')).length,0);
    const retry=server();retry.conflictNext();
    await retry.store.execute(job('conflict-drawing',{type:'saveDrawing',drawing}));
    assert.equal(retry.calls.filter(call=>call.options.method==='PUT' && call.url.includes('/artworks/')).length,1);
});
test('drawing commands rejected by a restored room do not upload artwork',async()=>{
    const drawing={id:'drawing_rejected1',savedAt:'2026-09-16T00:00:00Z',data:'data:image/jpeg;base64,AA=='};
    const restored=server();restored.room={...restored.room,restoredAt:100000};
    await assert.rejects(restored.store.execute(job('stale-drawing',{type:'saveDrawing',drawing})),/還原/);
    assert.equal(restored.calls.filter(call=>call.options.method==='PUT' && call.url.includes('/artworks/')).length,0);
});
test('a drawing uploaded before a restore conflict is deleted before the stale command is cancelled',async()=>{
    const s=server(),drawing={id:'drawing_orphan1',savedAt:'2026-09-16T00:00:00Z',data:'data:image/jpeg;base64,AA=='};
    s.conflictNext(room=>({...room,restoredAt:100000}));
    await assert.rejects(s.store.execute(job('restore-race',{type:'saveDrawing',drawing})),/還原/);
    assert.equal(s.artworks[drawing.id],undefined);
    assert.equal(s.calls.filter(call=>call.options.method==='PUT' && call.url.includes('/artworks/')).length,1);
    assert.equal(s.calls.filter(call=>call.options.method==='DELETE' && call.url.includes('/artworks/')).length,1);
});
test('a transient orphan cleanup failure stays retryable',async()=>{
    const s=server(),drawing={id:'drawing_orphan2',savedAt:'2026-09-16T00:00:00Z',data:'data:image/jpeg;base64,AA=='};
    s.conflictNext(room=>({...room,restoredAt:100000}));s.dropNextDelete();
    await assert.rejects(s.store.execute(job('restore-race-offline',{type:'saveDrawing',drawing})),error=>error instanceof TypeError && error.retryable===true);
    assert.deepEqual(s.artworks[drawing.id],drawing);
});
test('an expired drawing command removes a possibly uploaded orphan before cancellation',async()=>{
    const s=server(),drawing={id:'drawing_expired1',savedAt:'2026-09-16T00:00:00Z',data:'data:image/jpeg;base64,AA=='};
    await s.store.writeArtwork(drawing);
    await assert.rejects(s.store.execute({id:'expired-drawing',createdAt:-100_000_000,command:{type:'saveDrawing',drawing}}),/超過一天/);
    assert.equal(s.artworks[drawing.id],undefined);
});
test('server read does not upgrade or upload legacy progress',async()=>{
    const s=server(),value=await s.store.readRemote();assert.equal(value.students[0].tokens,100);assert.equal(s.writes,0);assert.equal(s.room.progress.revision,9);
});
test('two transactions retry against latest server snapshot preserving both deltas',async()=>{
    const s=server();await Promise.all([s.store.execute(job('a',{type:'resources',studentId:1,field:'tokens',mode:'add',amount:5})),s.store.execute(job('b',{type:'resources',studentId:1,field:'tokens',mode:'add',amount:7}))]);
    assert.equal(s.room.progress.students[0].tokens,112);assert.equal(s.writes,2);assert.equal(s.room.progress.revision,undefined);
});
test('room PUT suppresses the full response body and returns the locally computed outcome',async()=>{
    const s=server();
    const outcome=await s.store.execute(job('silent-put',{type:'resources',studentId:1,field:'tokens',mode:'add',amount:5}));
    const write=s.calls.find(call=>call.options.method==='PUT' && call.url.includes('/games/classroom-115.json'));
    assert.equal(new URL(write.url).searchParams.get('print'),'silent');
    assert.equal(outcome.progress.students[0].tokens,105);
    assert.equal(outcome.result.ok,true);
});
test('response lost after lottery commit is recovered with identical prize and no second ticket charge',async()=>{
    const s=server(),request=job('lottery',{type:'lottery',studentId:1,roll:.2,indexRoll:.1});s.dropNext();
    await assert.rejects(s.store.execute(request));const retry=await s.store.execute(request);
    assert.equal(retry.result.item.id,'shirt');assert.equal(s.writes,1);assert.equal(s.room.progress.students[0].lotteryTickets,0);
    assert.equal((await s.store.readReceipt('lottery')).result.item.id,'shirt');
});
test('a restore prevents older unresolved actions modifying restored progress',async()=>{
    const s=server();s.room={...s.room,restoredAt:95000};
    await assert.rejects(s.store.execute(job('old',{type:'resources',all:true,field:'tokens',mode:'add',amount:100})),/還原/);assert.equal(s.writes,0);
});
test('same task from two devices pays once and unrelated prior receipts survive',async()=>{
    const s=server();s.room={...s.room,progress:{...s.room.progress,tasks:[{id:'task',reward:20}]}};
    await Promise.all(['a','b'].map(id=>s.store.execute(job(id,{type:'completeTask',studentId:1,taskId:'task'}))));
    assert.equal(s.room.progress.students[0].tokens,120);assert.equal(s.writes,1);
});
test('SDK transactions commit progress and receipts without using the REST room PUT path',async()=>{
    const s=sdkServer();
    const outcome=await s.store.execute(job('sdk-operation-id',{type:'resources',studentId:1,field:'tokens',mode:'add',amount:5}));
    assert.equal(outcome.progress.students[0].tokens,105);assert.equal(outcome.result.ok,true);
    assert.equal(s.room.progress.students[0].tokens,105);assert.equal(s.room.progress.lastSaved,'1970-01-01T00:01:40.000Z');
    assert.equal(s.room.progress.revision,undefined);assert.equal(s.room.operations['sdk-operation-id'].committedAt,100000);
    assert.equal(s.transactions,1);assert.deepEqual(s.fetchCalls,[]);
});
test('SDK transaction retries recalculate an operation from the newest room value',async()=>{
    let room=initial(),updates=0;
    const s=sdkServer({transactRoom:async update=>{
        update(clone(room));updates++;
        room={...room,progress:{...room.progress,students:[{...room.progress.students[0],tokens:130}]}};
        const next=update(clone(room));updates++;
        room=resolveServerValues(next);
        return {committed:true,value:clone(room)};
    }});
    const result=await s.store.execute(job('sdk-retry-operation',{type:'resources',studentId:1,field:'tokens',mode:'add',amount:5}));
    assert.equal(updates,2);assert.equal(result.progress.students[0].tokens,135);
});
test('SDK transaction returns an existing receipt without applying the command again',async()=>{
    const s=sdkServer();
    s.room={...s.room,operations:{duplicate_operation:{id:'duplicate_operation',uid:'test-user',type:'resources',createdAt:90000,committedAt:95000,result:{json:'{"ok":true,"tokens":123}'}}}};
    const outcome=await s.store.execute(job('duplicate_operation',{type:'resources',studentId:1,field:'tokens',mode:'add',amount:5}));
    assert.equal(outcome.progress.students[0].tokens,100);assert.deepEqual(outcome.result,{ok:true,tokens:123});assert.equal(s.transactions,1);
});
test('SDK transaction pruning keeps local pending receipts and the newest receipts within one hour',async()=>{
    const s=sdkServer(),operations={};
    for(let index=0;index<105;index++){
        const id=`sdk-recent-${String(index).padStart(3,'0')}`;
        operations[id]={id,uid:'test-user',type:'resources',createdAt:100000-index,committedAt:100000-index,result:{json:'{"ok":true}'}};
    }
    operations.sdk_old_pending={id:'sdk_old_pending',uid:'test-user',type:'resources',createdAt:1,committedAt:1,result:{json:'{"ok":true}'}};
    operations.sdk_expired={id:'sdk_expired',uid:'test-user',type:'resources',createdAt:2,committedAt:2,result:{json:'{"ok":true}'}};
    s.room={...s.room,operations,lastOperationId:'sdk-recent-104'};
    await s.store.execute(job('sdk-new-operation',{type:'resources',studentId:1,field:'tokens',mode:'add',amount:1}),['sdk_old_pending']);
    assert.equal(Object.keys(s.room.operations).length,100);assert.ok(s.room.operations.sdk_old_pending);
    assert.equal(s.room.operations.sdk_expired,undefined);assert.ok(s.room.operations['sdk-recent-000']);assert.equal(s.room.operations['sdk-recent-104'],undefined);
});
test('SDK transactions enforce the restore barrier and mark database network errors retryable',async()=>{
    const restored=sdkServer();restored.room={...restored.room,restoredAt:95000};
    await assert.rejects(restored.store.execute(job('sdk-stale-operation',{type:'resources',studentId:1,field:'tokens',mode:'add',amount:5})),/還原/);
    assert.equal(restored.room.progress.students[0].tokens,100);
    const failure=Object.assign(new Error('disconnected'),{code:'database/disconnected'});
    const offline=sdkServer({transactRoom:async()=>{throw failure;}});
    await assert.rejects(offline.store.execute(job('sdk-offline-operation',{type:'resources',studentId:1,field:'tokens',mode:'add',amount:5})),error=>error===failure&&error.retryable===true);
});
test('transactions retain at most one hour and 100 receipts while protecting pending ids',async()=>{
    const s=server(),recent={},clock=100000;
    for(let index=0;index<105;index++){
        const id=`recent-operation-${String(index).padStart(3,'0')}`;
        recent[id]={id,uid:'test-user',type:'resources',createdAt:clock-index,committedAt:clock-index,result:{json:'{"ok":true}'}};
    }
    const oldId='old-pending-operation';
    const expiredId='expired-operation-id';
    s.room={...s.room,operations:{...recent,
        [oldId]:{id:oldId,uid:'test-user',type:'resources',createdAt:1,committedAt:1,result:{json:'{"ok":true}'}},
        [expiredId]:{id:expiredId,uid:'test-user',type:'resources',createdAt:2,committedAt:2,result:{json:'{"ok":true}'}}
    },lastOperationId:'recent-operation-104'};
    await s.store.execute(job('new-operation-id',{type:'resources',studentId:1,field:'tokens',mode:'add',amount:1}),[oldId]);
    assert.equal(Object.keys(s.room.operations).length,100);
    assert.ok(s.room.operations[oldId]);
    assert.equal(s.room.operations[expiredId],undefined);
    assert.ok(s.room.operations['recent-operation-000']);
    assert.equal(s.room.operations['recent-operation-104'],undefined);
});
test('malformed nonempty cloud does not become an editable empty classroom',async()=>{
    const s=server();s.room={...s.room,progress:{students:[]}};
    await assert.rejects(s.store.readRemote(),/格式|成員/);
});
test('a broken successful acknowledgement remains retryable for receipt recovery',async()=>{
    let written=false;
    const store=createFirebaseStore({databaseURL:'https://fake.test',getToken:async()=>'token',getUid:()=> 'user',now:()=>100000,
        fetch:async(url,options)=>{if(options.method==='PUT'){written=true;return new Response('{broken');}return Response.json(initial(),{headers:{etag:'1'}});}});
    await assert.rejects(store.execute(job('receipt',{type:'resources',studentId:1,field:'tokens',mode:'add',amount:5})),error=>error.retryable===true);
    assert.equal(written,true);
});
test('server read timeout covers a stalled response body',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const store=createFirebaseStore({databaseURL:'https://fake.test',getToken:async()=>'token',getUid:()=> 'user',fetch:async()=>({ok:true,status:200,headers:new Headers(),json:()=>new Promise(()=>{})})});
    let failure;
    const reading=store.readRemote().catch(error=>{failure=error;});
    for(let i=0;i<5;i++)await Promise.resolve();
    t.mock.timers.tick(15000);
    for(let i=0;i<10;i++)await Promise.resolve();
    assert.equal(failure?.name,'AbortError');await reading;
});
test('anonymous login recovers after an initial network failure without reloading the page',async()=>{
    const {createTokenProvider}=await import('../public/firebase-store.mjs');assert.equal(typeof createTokenProvider,'function');
    const auth={currentUser:null};let calls=0;
    const getToken=createTokenProvider(auth,async()=>{if(++calls===1)throw Object.assign(new Error('network'),{code:'auth/network-request-failed'});auth.currentUser={getIdToken:async()=> 'token'};});
    await assert.rejects(getToken(),e=>e.retryable===true);
    assert.deepEqual(await Promise.all([getToken(),getToken()]),['token','token']);assert.equal(calls,2);
});
