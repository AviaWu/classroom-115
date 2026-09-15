import test from 'node:test';
import assert from 'node:assert/strict';
import {createFirebaseStore} from '../public/firebase-store.mjs';
const initial=()=>({progress:{students:[{id:1,tokens:100,lotteryTickets:1}],clothesM:[{id:'shirt',name:'服裝',level:'R',price:50,active:true}],revision:9,syncVersion:3,commitId:'legacy'},operations:{}});
function server(){
    let room=initial(),etag=1,writes=0,drop=false;
    const resolve=v=>{if(v && typeof v==='object'){if(v['.sv']==='timestamp')return 100000;return Array.isArray(v)?v.map(resolve):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,resolve(x)]));}return v;};
    const fetch=async(url,options)=>{
        await Promise.resolve();const path=new URL(url).pathname;
        if(options.method==='PUT'){
            if(options.headers['if-match']!==String(etag))return new Response('{}',{status:412});
            room=resolve(JSON.parse(options.body));writes++;etag++;
            if(drop){drop=false;throw new TypeError('network lost after commit');}
            return Response.json(room);
        }
        let value=path.endsWith('/progress.json')?room.progress:path.includes('/operations/')?room.operations[path.split('/').pop().replace('.json','')]||null:room;
        return Response.json(value,{headers:{etag:String(etag)}});
    };
    const store=createFirebaseStore({databaseURL:'https://fake.test',getToken:async()=>'fake-token',getUid:()=> 'test-user',now:()=>100000,fetch});
    return {store,get room(){return room;},set room(v){room=v;etag++;},get writes(){return writes;},dropNext:()=>drop=true};
}
const job=(id,command)=>({id,createdAt:90000,command});
test('server read does not upgrade or upload legacy progress',async()=>{
    const s=server(),value=await s.store.readRemote();assert.equal(value.students[0].tokens,100);assert.equal(s.writes,0);assert.equal(s.room.progress.revision,9);
});
test('two transactions retry against latest server snapshot preserving both deltas',async()=>{
    const s=server();await Promise.all([s.store.execute(job('a',{type:'resources',studentId:1,field:'tokens',mode:'add',amount:5})),s.store.execute(job('b',{type:'resources',studentId:1,field:'tokens',mode:'add',amount:7}))]);
    assert.equal(s.room.progress.students[0].tokens,112);assert.equal(s.writes,2);assert.equal(s.room.progress.revision,undefined);
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
