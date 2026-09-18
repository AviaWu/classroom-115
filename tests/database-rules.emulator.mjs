import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

// Both rule installation and owner seeding are deliberately limited to localhost.
const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('Local database emulator required');
const project = 'demo-classroom-sync';
const origin = `http://${host}`;
const namespace = `${project}-default-rtdb`;
const roomPath = 'games/classroom-115';
const timestamp = {'.sv':'timestamp'};
const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
const token = uid => {
    const now = Math.floor(Date.now()/1000);
    return `${encode({alg:'none',typ:'JWT'})}.${encode({iss:`https://securetoken.google.com/${project}`,aud:project,iat:now,exp:now+3600,auth_time:now,sub:uid,user_id:uid,firebase:{sign_in_provider:'anonymous',identities:{}}})}.`;
};
const endpoint = (path,uid) => `${origin}/${path}.json?ns=${namespace}${uid ? `&auth=${encodeURIComponent(token(uid))}` : ''}`;
const legacy = {students:[{id:1,tokens:20}],lastSaved:'2026-09-15T01:00:00Z',syncVersion:2};
const cleanProgress = {students:[{id:1,tokens:25}],lastSaved:'2026-09-15T02:00:00Z'};

before(async()=>{
    const rules = await readFile(new URL('../database.rules.json',import.meta.url),'utf8');
    const response = await fetch(endpoint('.settings/rules'),{method:'PUT',headers:{Authorization:'Bearer owner'},body:rules});
    assert.equal(response.status,200,await response.text());
});
async function seed(value) {
    const response = await fetch(endpoint(roomPath),{method:'PUT',headers:{Authorization:'Bearer owner'},body:JSON.stringify(value)});
    assert.equal(response.status,200,await response.text());
}
async function read(path = roomPath,uid = 'test-user',headers = {}) {
    return fetch(endpoint(path,uid),{headers});
}
async function room() {
    const response = await read();
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
}
async function write(value,{uid = 'test-user',path = roomPath,method = 'PUT',headers = {}} = {}) {
    return fetch(endpoint(path,uid),{method,headers,body:JSON.stringify(value)});
}
async function allowed(value,options) {
    const response = await write(value,options);
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
}
async function denied(value,options) {
    const response = await write(value,options);
    assert.equal(response.status,401,await response.text());
}
function operation(previous,{id = randomUUID(),uid = 'test-user',type = 'resources',createdAt = Date.now(),progress = cleanProgress,result = null} = {}) {
    const next = {...previous,progress:structuredClone(progress),lastOperationId:id,
        operations:{...previous?.operations,[id]:{id,uid,type,createdAt,committedAt:timestamp,
            result:{json:JSON.stringify({ok:true,...result})}}}};
    if (type === 'initialize' || type === 'restore') next.restoredAt = timestamp;
    return next;
}
async function seedLedger() {
    await seed({progress:legacy});
    await allowed(operation({progress:legacy}));
    await allowed(operation(await room()));
    return room();
}

// Removing the root read grant would prevent the conditional transaction's fresh read.
test('authenticated clients can read the room and unchanged legacy progress',async()=>{
    await seed({progress:legacy});
    const response = await read();
    assert.equal(response.status,200,await response.clone().text());
    assert.deepEqual(await response.json(),{progress:legacy});
    assert.equal((await read(roomPath,null)).status,401);
    assert.equal((await read(`${roomPath}/progress`,null)).status,401);
    assert.equal((await read('games/other-room')).status,401);
});

test('authenticated clients can only read and write validated external artwork',async()=>{
    const drawing={id:'drawing_abc123',savedAt:'2026-09-16T00:00:00.000Z',data:'data:image/jpeg;base64,AA=='};
    const artworkPath=`artworks/classroom-115/${drawing.id}`;
    await allowed(drawing,{path:artworkPath});
    const response=await read(artworkPath);
    assert.equal(response.status,200,await response.clone().text());
    assert.deepEqual(await response.json(),drawing);
    await allowed({...drawing,id:'drawing_no_millis',savedAt:'2026-09-16T00:00:00Z'},{path:'artworks/classroom-115/drawing_no_millis'});
    await denied(drawing,{path:artworkPath,uid:null});
    for(const invalid of [
        {...drawing,id:'drawing_another'},
        {...drawing,savedAt:'not-an-iso-time'},
        {...drawing,savedAt:'2026-09-16 00:00:00Z'},
        {...drawing,data:'data:text/plain;base64,AA=='},
        {...drawing,data:`data:image/jpeg;base64,${'A'.repeat(1_500_000)}`},
        {...drawing,extra:true},
    ]) await denied(invalid,{path:artworkPath});
});

test('artwork deletion cannot remove an image still referenced by progress',async()=>{
    const kept={id:'drawing_kept01',savedAt:'2026-09-16T00:00:00.000Z',data:'data:image/jpeg;base64,AA=='};
    const evicted={id:'drawing_evicted01',savedAt:'2026-09-15T00:00:00.000Z',data:'data:image/jpeg;base64,AQ=='};
    await seed({progress:{...cleanProgress,drawings:[{id:kept.id,savedAt:kept.savedAt}]}});
    await allowed(kept,{path:`artworks/classroom-115/${kept.id}`});
    await allowed(evicted,{path:`artworks/classroom-115/${evicted.id}`});
    await denied(null,{path:`artworks/classroom-115/${kept.id}`,method:'DELETE'});
    await allowed(null,{path:`artworks/classroom-115/${evicted.id}`,method:'DELETE'});
});

test('progress drawing indexes reject a fourth metadata record',async()=>{
    const drawings=Array.from({length:4},(_,index)=>({id:`drawing_index${index}`,savedAt:`2026-09-16T00:00:0${index}.000Z`}));
    await seed({progress:cleanProgress});
    await denied(operation(await room(),{progress:{...cleanProgress,drawings}}));
    await denied(operation(await room(),{progress:{...cleanProgress,drawings:{0:drawings[0],4:drawings[1]}}}));
});

test('progress rejects retired embedded artwork and album fields',async()=>{
    const drawing={id:'drawing_current1',savedAt:'2026-09-16T00:00:00.000Z'};
    await seed({progress:cleanProgress});
    const current=await room();
    await denied(operation(current,{progress:{...cleanProgress,drawings:[{...drawing,data:'data:image/png;base64,AA=='}]}}));
    await denied(operation(current,{progress:{...cleanProgress,drawingAlbum:[]}}));
});

test('operation receipts reject the retired artwork migration type',async()=>{
    await seed({progress:cleanProgress});
    await denied(operation(await room(),{type:'migrateArtworks'}));
});

test('normal operations retain an immutable historical artwork migration receipt',async()=>{
    const id=randomUUID();
    await seed({progress:cleanProgress,lastOperationId:id,operations:{[id]:{
        id,uid:'test-user',type:'migrateArtworks',createdAt:Date.now()-1000,committedAt:Date.now()-500,result:{json:'{"ok":true}'}
    }}});
    await allowed(operation(await room()));
});

test('a conditional root transaction migrates progress and appends an authenticated receipt',async()=>{
    await seed({progress:legacy});
    const response = await read(roomPath,'test-user',{'X-Firebase-ETag':'true'});
    assert.equal(response.status,200,await response.clone().text());
    const next = operation(await response.json());
    await allowed(next,{headers:{'If-Match':response.headers.get('etag')}});
    const saved = await room();
    assert.equal(saved.progress.students[0].tokens,25);
    assert.equal(saved.operations[next.lastOperationId].uid,'test-user');
    assert.equal(typeof saved.operations[next.lastOperationId].committedAt,'number');
    assert.deepEqual(JSON.parse(saved.operations[next.lastOperationId].result.json),{ok:true});
    for (const key of ['syncVersion','revision','baseCommitId','commitId','updatedAt']) assert.equal(key in saved.progress,false);
    const stale = await write(operation({progress:legacy}),{headers:{'If-Match':response.headers.get('etag')}});
    assert.equal(stale.status,412,await stale.text());
});

test('legacy whole-progress and partial clients cannot write without a new receipt',async()=>{
    await seed({progress:legacy});
    await denied({...legacy,lastSaved:'2099-01-01T00:00:00Z'},{path:`${roomPath}/progress`});
    await denied({students:[{id:1,tokens:999}]},{path:`${roomPath}/progress`,method:'PATCH'});
    await denied({progress:cleanProgress});
    const previous = await seedLedger();
    await denied({...previous,progress:{...cleanProgress,students:[{id:1,tokens:999}]}});
    await denied({progress:cleanProgress},{method:'PATCH'});
    await denied({...cleanProgress,syncVersion:3,revision:3,baseCommitId:'old-commit',commitId:randomUUID(),updatedAt:timestamp},{path:`${roomPath}/progress`});
});

test('writes require authentication and the receipt belongs to the current authenticated user',async()=>{
    await seed({progress:legacy});
    await denied(operation({progress:legacy}),{uid:null});
    await denied(operation({progress:legacy},{uid:'another-user'}));
    await allowed(operation({progress:legacy},{uid:'another-user'}),{uid:'another-user'});
});

for (const type of ['resetCloset','resetResources','resizeStudents','gender']) {
    test(`the ${type} operation can commit with a fresh receipt`,async()=>{
        await seed({progress:legacy});
        const next = operation({progress:legacy},{type});
        await allowed(next);
        assert.equal((await room()).operations[next.lastOperationId].type,type);
    });
}

test('new receipts validate identity, timestamp, type and the stored result shape',async()=>{
    await seed({progress:legacy});
    const malformed = [
        ['id','different-operation-id'],['uid',null],['type',''],['createdAt','now'],
        ['createdAt',Date.now()-86_400_001],['createdAt',Date.now()+120_000],
        ['committedAt',1],
        ['result',{json:123}],['result',{json:'null',extra:'not-allowed'}],['extra',true],
    ];
    for (const [field,value] of malformed) {
        const next = operation({progress:legacy});
        next.operations[next.lastOperationId][field] = value;
        await denied(next);
    }
    for (const field of ['id','uid','type','createdAt','committedAt','result']) {
        const next = operation({progress:legacy});
        delete next.operations[next.lastOperationId][field];
        await denied(next);
    }
    const next = operation({progress:legacy});
    const extraId = randomUUID();
    next.operations[extraId] = {...next.operations[next.lastOperationId],id:extraId};
    await denied(next);
    await allowed(operation({progress:legacy},{createdAt:Date.now()-86_390_000}));
});

test('a new receipt cannot carry legacy progress metadata or malformed progress',async()=>{
    await seed({progress:legacy});
    for (const [key,value] of Object.entries({syncVersion:3,revision:1,baseCommitId:'legacy',commitId:randomUUID(),updatedAt:timestamp})) {
        await denied(operation({progress:legacy},{progress:{...cleanProgress,[key]:value}}));
    }
    for (const progress of [null,{},'invalid',{lastSaved:'today'},{students:[],lastSaved:'today'},{students:'invalid',lastSaved:'today'},
        {students:[{id:1}],lastSaved:123},{students:[{id:1}],lastSaved:'today',globalBgImage:123}]) {
        await denied(operation({progress:legacy},{progress}));
    }
});

test('retained receipts are immutable and the latest receipt cannot be removed',async()=>{
    const previous = await seedLedger();
    const firstId = Object.keys(previous.operations).find(id=>id !== previous.lastOperationId);
    await denied(operation(previous,{id:firstId}));
    await denied(operation(previous,{id:previous.lastOperationId}));
    for (const field of ['id','uid','type','createdAt','committedAt','result']) {
        const next = operation(previous);
        next.operations = structuredClone(next.operations);
        delete next.operations[firstId][field];
        await denied(next);
    }
    for (const [field,value] of Object.entries({id:randomUUID(),uid:'another-user',type:'restore',createdAt:Date.now()+1,
        committedAt:timestamp,result:{json:'{"reward":999}'},extra:true})) {
        const next = operation(previous);
        next.operations = structuredClone(next.operations);
        next.operations[firstId][field] = value;
        await denied(next);
    }
    for (const removedIds of [[previous.lastOperationId],Object.keys(previous.operations)]) {
        const next = operation(previous);
        for (const id of removedIds) delete next.operations[id];
        await denied(next);
    }
    await denied(null,{path:`${roomPath}/operations/${firstId}`});
    await denied({[firstId]:null},{path:`${roomPath}/operations`,method:'PATCH'});
    await allowed(operation(previous,{result:{item:{id:'hat',name:'帽子',price:12},duplicate:false}}));
});

test('deleting progress, receipts or the whole room is denied at every write depth',async()=>{
    const previous = await seedLedger();
    await denied(null);
    await denied(null,{path:`${roomPath}/progress`});
    await denied(null,{path:`${roomPath}/operations`});
    await denied({progress:null},{method:'PATCH'});
    const next = operation(previous);
    delete next.progress;
    await denied(next);
    await denied({progress:cleanProgress,operations:null,lastOperationId:randomUUID()});
});

test('version-three metadata is readable and removed only by an actual operation',async()=>{
    const oldProgress = {...legacy,syncVersion:3,revision:25,baseCommitId:'old-base',commitId:'old-commit',updatedAt:1};
    await seed({progress:oldProgress});
    assert.deepEqual((await room()).progress,oldProgress);
    await allowed(operation({progress:oldProgress}));
    assert.deepEqual((await room()).progress,cleanProgress);
});

test('only explicit initialize or restore can create progress from null',async()=>{
    await seed(null);
    await denied(operation(null));
    await allowed(operation(null,{type:'initialize'}));
    assert.equal(typeof (await room()).restoredAt,'number');
    await denied(operation(await room(),{type:'initialize'}));
    await seed(null);
    await allowed(operation(null,{type:'restore'}));
});

test('restoration sets a server-time barrier and other operations must preserve it',async()=>{
    const previous = await seedLedger();
    const staleCreatedAt = Date.now()-1_000;
    const restored = operation(previous,{type:'restore'});
    await allowed(restored);
    const current = await room();
    assert.equal(typeof current.restoredAt,'number');
    const missing = operation(current);
    delete missing.restoredAt;
    await denied(missing);
    await denied({...operation(current),restoredAt:current.restoredAt+1});
    await denied({...operation(current,{type:'restore'}),restoredAt:1});
    await denied(operation(current,{createdAt:staleCreatedAt}));
    await denied(operation(current,{createdAt:current.restoredAt}));
    await allowed(operation(current));
    assert.equal((await room()).restoredAt,current.restoredAt);
    await allowed(operation(await room(),{type:'restore',createdAt:staleCreatedAt}));
});
