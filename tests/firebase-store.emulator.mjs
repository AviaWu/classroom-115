import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createFirebaseStore} from '../public/firebase-store.mjs';

// Real REST requests only. Run emulator test files serially because they share this room.
const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('Local database emulator required');
const origin = `http://${host}`;
const project = 'demo-classroom-sync';
const namespace = `${project}-default-rtdb`;
const path = 'games/classroom-115';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(uid) {
    const now = Math.floor(Date.now()/1000);
    return `${encode({alg:'none',typ:'JWT'})}.${encode({iss:`https://securetoken.google.com/${project}`,aud:project,iat:now,exp:now+3600,auth_time:now,sub:uid,user_id:uid,firebase:{sign_in_provider:'anonymous',identities:{}}})}.`;
}
function endpoint(route = path) {
    return `${origin}/${route}.json?ns=${namespace}`;
}
before(async()=>{
    const response = await fetch(endpoint('.settings/rules'),{method:'PUT',headers:{Authorization:'Bearer owner'},
        body:await readFile(new URL('../database.rules.json',import.meta.url),'utf8')});
    assert.equal(response.status,200,await response.text());
});
async function seed(progress) {
    const response = await fetch(endpoint(),{method:'PUT',headers:{Authorization:'Bearer owner'},
        body:JSON.stringify(progress === null ? null : {progress})});
    assert.equal(response.status,200,await response.text());
}
async function seedRoom(value) {
    const response = await fetch(endpoint(),{method:'PUT',headers:{Authorization:'Bearer owner'},body:JSON.stringify(value)});
    assert.equal(response.status,200,await response.text());
}
async function rawRoom() {
    const response = await fetch(`${endpoint()}&auth=${encodeURIComponent(token('reader'))}`);
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
}
function fixture() {
    return {students:[{id:1,gender:'M',tokens:100,lotteryTickets:2,petAffection:9},
        {id:2,gender:'F',tokens:100,lotteryTickets:2}],
    tasks:[{id:'a',title:'作業',reward:20},{id:'b',title:'數學',reward:30}],
    clothesM:[{id:'shirt',name:'星星「上衣」\n第二行',image:null,level:'R',price:50,active:true}],
    clothesF:[],layouts:[{id:'cat',name:'小貓',level:'SR',price:60,active:true}],backgrounds:[],
    coopTasks:[{id:'boss',monsterName:'怪獸',content:'一起完成',reward:10,rewardType:'token',completedBy:[],claimed:false}],
    drawings:[],globalBgImage:'',lastSaved:'2026-09-15T00:00:00Z',
    syncVersion:3,revision:99,baseCommitId:'old-base',commitId:'old-commit',updatedAt:1};
}
const job = (command,createdAt = Date.now()) => ({id:randomUUID(),createdAt,command});

// Delay the first two *real* room responses until both have the same ETag. The
// server still decides every write, conflict, timestamp and permission result.
function transport({concurrentReads = false,restoreFirst = false} = {}) {
    let reads = 0,conflicts = 0,releaseReads,releaseRestore;
    const bothRead = new Promise(resolve=>releaseReads=resolve);
    const restored = new Promise(resolve=>releaseRestore=resolve);
    const request = async(input,options = {})=>{
        const url = new URL(input);
        assert.equal(url.origin,origin);
        url.searchParams.set('ns',namespace);
        const value = options.method === 'PUT' ? JSON.parse(options.body) : null;
        const type = value?.operations?.[value.lastOperationId]?.type;
        if (restoreFirst && type && type !== 'restore') await restored;
        const response = await fetch(url,options);
        if (response.status === 412) conflicts++;
        if (restoreFirst && type === 'restore' && response.ok) releaseRestore();
        if (concurrentReads && !options.method && url.pathname === `/${path}.json` && reads < 2) {
            reads++;
            if (reads === 2) releaseReads();
            await bothRead;
        }
        return response;
    };
    return {request,get conflicts(){return conflicts;}};
}
function store(uid = 'device-one',network = transport()) {
    return createFirebaseStore({databaseURL:origin,getToken:async()=>token(uid),getUid:()=>uid,fetch:network.request});
}
function assertReceipt(receipt,id,type) {
    assert.deepEqual(Object.keys(receipt).sort(),['committedAt','createdAt','id','result','type','uid']);
    assert.equal(receipt.id,id);
    assert.equal(receipt.type,type);
    assert.equal(typeof receipt.committedAt,'number');
    assert.deepEqual(Object.keys(receipt.result),['json']);
    assert.equal(JSON.parse(receipt.result.json).ok,true);
}

test('real initialization and reads round-trip Firebase omissions without writing on load',async()=>{
    await seed(null);
    const client = store();
    assert.equal(await client.readRemote(),null);
    assert.equal(await rawRoom(),null);
    const request = job({type:'initialize',value:{students:[{id:1,tokens:0,equippedClothes:null}],drawings:[],clothesM:[]}});
    const outcome = await client.execute(request);
    assert.deepEqual(outcome.result,{ok:true});
    const raw = await rawRoom();
    assert.equal(raw.progress.students[0].equippedClothes,undefined);
    assert.equal(raw.progress.drawings,undefined);
    assert.equal(raw.progress.clothesM,undefined);
    assertReceipt(raw.operations[request.id],request.id,'initialize');
    const normalized = await client.readRemote();
    assert.equal(normalized.students[0].equippedClothes,null);
    assert.deepEqual(normalized.students[0].ownedClothes,[]);
    assert.deepEqual(normalized.drawings,[]);
    assert.deepEqual(normalized.clothesM,[]);
    assert.deepEqual(await rawRoom(),raw);
});

test('real artwork REST upload commits save metadata without embedding its Data URL',async()=>{
    const initial=fixture();
    await seed(initial);
    const client=store(),drawing={id:`drawing_${randomUUID()}`,savedAt:'2026-09-16T00:00:00.000Z',data:'data:image/jpeg;base64,AA=='};
    await client.execute(job({type:'saveDrawing',drawing}));
    const raw=await rawRoom();
    assert.deepEqual(raw.progress.drawings,[{id:drawing.id,savedAt:drawing.savedAt}]);
    assert.equal(JSON.stringify(raw).includes(drawing.data),false);
    assert.deepEqual(await client.readArtwork(drawing.id),drawing);
    await assert.rejects(client.deleteArtwork(drawing.id),/401/);
    await seed(initial);
    await client.deleteArtwork(drawing.id);
    assert.equal(await client.readArtwork(drawing.id),null);
});

test('real ETag conflicts reapply different task rewards against the latest progress',async()=>{
    const legacy = fixture();
    await seed(legacy);
    const network = transport({concurrentReads:true});
    const clients = [store('device-one',network),store('device-two',network)];
    await clients[0].readRemote();
    assert.equal((await rawRoom()).progress.revision,99);
    const requests = ['a','b'].map(taskId=>job({type:'completeTask',studentId:1,taskId}));
    await Promise.all(requests.map((request,index)=>clients[index].execute(request)));
    assert.ok(network.conflicts >= 1);
    const raw = await rawRoom();
    assert.equal(raw.progress.students[0].tokens,150);
    assert.deepEqual([...raw.progress.students[0].doneTasks].sort(),['a','b']);
    assert.equal(Object.keys(raw.operations).length,2);
    for (const request of requests) assertReceipt(raw.operations[request.id],request.id,'completeTask');
    for (const key of ['syncVersion','revision','baseCommitId','commitId','updatedAt']) assert.equal(key in raw.progress,false);
    await clients[0].execute(requests[0]);
    assert.equal((await rawRoom()).progress.students[0].tokens,150);
    assert.deepEqual((await clients[0].readReceipt(requests[0].id)).result,{ok:true,reward:20});
});

test('parallel purchases preserve both ownership changes and replay the stored nested result',async()=>{
    const initial = fixture();
    initial.students[0].tokens = 120;
    await seed(initial);
    const network = transport({concurrentReads:true});
    const clients = [store('device-one',network),store('device-two',network)];
    const requests = [job({type:'purchase',studentId:1,kind:'clothes',itemId:'shirt'}),
        job({type:'purchase',studentId:1,kind:'layout',itemId:'cat'})];
    const outcomes = await Promise.all(requests.map((request,index)=>clients[index].execute(request)));
    assert.ok(network.conflicts >= 1);
    const raw = await rawRoom();
    assert.equal(raw.progress.students[0].tokens,10);
    assert.deepEqual(raw.progress.students[0].ownedClothes,['shirt']);
    assert.deepEqual(raw.progress.students[0].ownedLayout,['cat']);
    assert.equal(outcomes[0].result.item.name,'星星「上衣」\n第二行');
    assert.equal(outcomes[0].result.item.image,undefined);
    assert.deepEqual((await clients[0].execute(requests[0])).result,outcomes[0].result);
    assert.deepEqual((await clients[1].readReceipt(requests[0].id)).result,outcomes[0].result);
    await clients[1].execute(job({type:'purchase',studentId:1,kind:'clothes',itemId:'shirt'}));
    assert.equal((await rawRoom()).progress.students[0].tokens,10);
    assert.equal(Object.keys((await rawRoom()).operations).length,2);
});

test('parallel pet moods award one affection point and one level bonus',async()=>{
    await seed(fixture());
    const network = transport({concurrentReads:true});
    const outcomes = await Promise.all(['device-one','device-two'].map(uid=>
        store(uid,network).execute(job({type:'petMood',studentId:1}))));
    assert.ok(network.conflicts >= 1);
    const raw = await rawRoom();
    assert.equal(raw.progress.students[0].petAffection,10);
    assert.equal(raw.progress.students[0].tokens,110);
    assert.equal(Object.keys(raw.operations).length,1);
    assert.equal(outcomes.filter(outcome=>outcome.result.awarded).length,1);
});

test('parallel final coop completions pay the class once and preserve both members',async()=>{
    await seed(fixture());
    const network = transport({concurrentReads:true});
    const outcomes = await Promise.all([1,2].map(studentId=>store(`device-${studentId}`,network)
        .execute(job({type:'coopComplete',studentId,taskId:'boss'}))));
    assert.ok(network.conflicts >= 1);
    const raw = await rawRoom();
    assert.deepEqual(raw.progress.students.map(student=>student.tokens),[110,110]);
    assert.deepEqual([...raw.progress.coopTasks[0].completedBy].sort(),[1,2]);
    assert.equal(raw.progress.coopTasks[0].claimed,true);
    assert.equal(Object.keys(raw.operations).length,2);
    assert.equal(outcomes.filter(outcome=>outcome.result.claimed).length,1);
    await store().execute(job({type:'coopComplete',studentId:2,taskId:'boss'}));
    assert.deepEqual((await rawRoom()).progress.students.map(student=>student.tokens),[110,110]);
});

test('a concurrent restore rejects an older operation after its real ETag conflict',async()=>{
    await seed(fixture());
    const network = transport({concurrentReads:true,restoreFirst:true});
    const stale = job({type:'resources',all:true,field:'tokens',mode:'add',amount:100},Date.now()-1_000);
    const restore = job({type:'restore',value:{students:[{id:1,tokens:7}],clothesM:[],drawings:[],syncVersion:3,revision:9}});
    const outcomes = await Promise.allSettled([store('teacher',network).execute(restore),store('device-two',network).execute(stale)]);
    assert.equal(outcomes[0].status,'fulfilled');
    assert.equal(outcomes[1].status,'rejected');
    assert.match(outcomes[1].reason.message,/還原/);
    assert.ok(network.conflicts >= 1);
    const raw = await rawRoom();
    assert.equal(raw.progress.students[0].tokens,7);
    assert.equal(raw.progress.revision,undefined);
    assert.equal(raw.operations[stale.id],undefined);
    assert.equal(typeof raw.restoredAt,'number');
    assertReceipt(raw.operations[restore.id],restore.id,'restore');
    assert.deepEqual((await store().readRemote()).clothesM,[]);
});

test('a real transaction prunes expired and excess receipts while retaining its pending receipt',async()=>{
    const clock=Date.now(),operations={};
    for(let index=0;index<105;index++){
        const id=`receipt_recent_${String(index).padStart(3,'0')}`;
        operations[id]={id,uid:'device-one',type:'resources',createdAt:clock-index,committedAt:clock-index,result:{json:'{"ok":true}'}};
    }
    const pendingId='receipt_pending_old';
    const expiredId='receipt_expired_old';
    operations[pendingId]={id:pendingId,uid:'device-one',type:'resources',createdAt:1,committedAt:1,result:{json:'{"ok":true}'}};
    operations[expiredId]={id:expiredId,uid:'device-one',type:'resources',createdAt:2,committedAt:2,result:{json:'{"ok":true}'}};
    await seedRoom({progress:fixture(),operations,lastOperationId:'receipt_recent_104'});
    const request=job({type:'resources',studentId:1,field:'tokens',mode:'add',amount:1});
    await store().execute(request,[pendingId]);
    const raw=await rawRoom(),ids=Object.keys(raw.operations);
    assert.equal(ids.length,100);assert.ok(raw.operations[pendingId]);assert.ok(raw.operations[request.id]);
    assert.equal(raw.operations[expiredId],undefined);assert.ok(raw.operations.receipt_recent_000);assert.equal(raw.operations.receipt_recent_104,undefined);
});

for (const [command,verify] of [
    [{type:'resetCloset',studentId:1},progress=>{
        assert.deepEqual(progress.students[0].ownedClothes,[]);
        assert.equal(progress.students[0].equippedClothes,null);
        assert.equal(progress.students[0].tokens,100);
    }],
    [{type:'resetResources'},progress=>{
        assert.deepEqual(progress.students.map(student=>student.tokens),[0,0]);
        assert.deepEqual(progress.students.map(student=>student.lotteryTickets),[0,0]);
        assert.deepEqual(progress.students[0].ownedClothes,[]);
    }],
    [{type:'resizeStudents',count:3},progress=>{
        assert.equal(progress.students.length,3);
        assert.equal(progress.students[0].tokens,100);
        assert.equal(progress.students[2].tokens,0);
        assert.deepEqual(progress.students[2].ownedClothes,[]);
    }],
    [{type:'gender',studentId:1,gender:'F'},progress=>{
        assert.equal(progress.students[0].gender,'F');
        assert.equal(progress.students[0].equippedClothes,null);
    }],
]) {
    test(`the real ${command.type} payload passes rules and survives omitted empty values`,async()=>{
        const initial = fixture();
        Object.assign(initial.students[0],{ownedClothes:['shirt'],equippedClothes:'shirt'});
        await seed(initial);
        const client = store();
        const request = job(command);
        const outcome = await client.execute(request);
        assert.deepEqual(outcome.result,{ok:true});
        verify(outcome.progress);
        verify(await client.readRemote());
        assertReceipt((await rawRoom()).operations[request.id],request.id,command.type);
    });
}
