import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import * as operations from '../public/game-operations.mjs';
import {createFirebaseStore,createTeacherProgressSubscriber} from '../public/firebase-store.mjs';
import {createFirebaseRestClient} from '../public/firebase-rest-client.mjs';

const clone=structuredClone,bytes=value=>Buffer.byteLength(JSON.stringify(value));
const room='games/classroom-115',studentPath=`${room}/progress/students/0`,metadataPath=`${room}/restoredAt`;
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const moduleSource=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].find(([,attrs])=>attrs.includes('module'))[2];
const job=(itemId='item-1',kind='clothes')=>({id:'equipment-stage1',createdAt:1000,command:{type:'equip',studentId:1,kind,itemId}});
function fixture(){
    const catalogue=()=>Array.from({length:80},(_,i)=>({id:`item-${i}`,name:`商品 ${i}`,image:'x'.repeat(1024),price:20}));
    return {games:{'classroom-115':{progress:{students:[{id:1,gender:'M',ownedClothes:['item-1'],ownedBg:['item-1'],equippedClothes:null,equippedBg:null,tokens:42,other:{keep:true}}],clothesM:catalogue(),clothesF:catalogue(),backgrounds:catalogue()}}}};
}
function harness({root=fixture(),local=clone(root.games['classroom-115'].progress),hooks={},legacy=false}={}){
    const requests=[];
    const get=path=>path.split('/').reduce((v,key)=>v?.[key],root)??null;
    const set=(path,value)=>{
        const keys=path.split('/'),key=keys.pop();let parent=root;
        for(const part of keys)parent=parent[part]??={};
        if(value===null)delete parent[key];else parent[key]=clone(value);
    };
    const etag=path=>'"'+createHash('sha256').update(JSON.stringify(get(path))).digest('hex')+'"';
    const request=async(url,options)=>{
        const parsed=new URL(url),path=decodeURIComponent(parsed.pathname.slice(1,-5)),method=options.method||'GET';
        assert.equal(options.cache,'no-store');assert.equal(parsed.searchParams.has('print'),false);
        const entry={path,method,headers:options.headers,requestBytes:options.body?Buffer.byteLength(options.body):0};requests.push(entry);
        await hooks.before?.({path,method,get,set,requests});
        let status=200;
        if(method==='PUT'){
            assert.ok(options.headers['if-match']);
            if(options.headers['if-match']!==etag(path))status=412;
            else set(path,JSON.parse(options.body));
        }
        const value=clone(get(path));
        entry.status=status;entry.responseBytes=bytes(value);
        const response=Response.json(value,{status,headers:hooks.noEtag?{}:{ETag:etag(path)}});
        return await hooks.response?.({path,method,status,response,get,set,requests})||response;
    };
    const context=vm.createContext({
        initializeApp:()=>({}),getAuth:()=>({currentUser:{uid:'teacher',getIdToken:async()=>'token'}}),getDatabase:()=>({}),
        onAuthStateChanged(){},ref:(_,path)=>path,onValue:()=>()=>{},update(){assert.fail('unexpected multi-path update');},
        GameOperations:operations,createTeacherProgressSubscriber,
        createFirebaseStore:config=>{context.dependencies={...config,now:()=>2000};return createFirebaseStore(context.dependencies);},
        createFirebaseRestClient:config=>{const client=createFirebaseRestClient({...config,fetch:request});if(legacy)delete client.transactPrepared;return client;},
        createCloudSync:()=>({setConnected(){},setActive(){}}),window:{addEventListener(){}},document:{addEventListener(){},hidden:false},navigator:{onLine:false},console,setSyncLocked(){},setSyncStatus(){},currentUser:null,state:local,
    });
    vm.runInContext(moduleSource.replace(/^\s*import .*;$/gm,'')+'\nglobalThis.storeUnderTest=store;',context);
    return {root,local,requests,get,set,store:context.storeUnderTest,dependencies:context.dependencies};
}
const gets=h=>h.requests.filter(r=>r.method==='GET'),puts=h=>h.requests.filter(r=>r.method==='PUT');
const run=(h,dependencies={},command=job())=>createFirebaseStore({...h.dependencies,...dependencies}).execute(command);
for(const [kind,category,field] of [['clothes','clothesM','equippedClothes'],['background','backgrounds','equippedBg']])test(`hinted ${kind}: exact page-wired REST paths, 4 GET + 1 PUT and full response byte budget`,async t=>{
    const h=harness(),initial=clone(h.root),old=harness({root:clone(initial),legacy:true});
    const outcome=await h.store.execute(job('item-1',kind));await old.store.execute(job('item-1',kind));
    assert.deepEqual(gets(h).map(r=>r.path),[metadataPath,studentPath,`${room}/progress/${category}/1/id`,metadataPath]);
    assert.equal(gets(h)[1].headers['X-Firebase-ETag'],'true');
    assert.equal(puts(h).length,1);assert.equal(puts(h)[0].path,studentPath);
    assert.equal(gets(old).length,5);assert.equal(puts(old).length,1);
    const responseBytes=h.requests.reduce((n,r)=>n+r.responseBytes,0),oldBytes=old.requests.reduce((n,r)=>n+r.responseBytes,0);
    const saved=bytes(initial.games['classroom-115'].progress[category])-bytes('item-1')+bytes(initial.games['classroom-115'].progress.students[0]);
    assert.equal(oldBytes-responseBytes,saved);assert.ok(responseBytes<500);assert.ok(oldBytes>85000);
    assert.equal(puts(h)[0].requestBytes,puts(old)[0].requestBytes);
    assert.deepEqual(h.root,old.root);assert.deepEqual(outcome.equipment,{studentId:1,field,value:'item-1'});assert.equal(outcome.progress,undefined);
    t.diagnostic(JSON.stringify({kind,responseBytes,oldBytes,saved,requestBytes:puts(h)[0].requestBytes}));
});
for(const hint of [undefined,null,-1,1.5,'1','../clothesF/1',Infinity,{},Number.MAX_SAFE_INTEGER+1])test(`invalid hint ${JSON.stringify(hint)} falls back without a scalar request`,async()=>{
    const h=harness();await run(h,{getEquipmentCatalogueHint:()=>hint});
    assert.deepEqual(gets(h).map(r=>r.path),[metadataPath,studentPath,`${room}/progress/clothesM`,metadataPath]);
    assert.equal(puts(h).length,1);
});
for(const change of ['reorder','delete','missing-index','wrong-identity'])test(`server catalogue ${change} verifies hint then reads fresh category`,async()=>{
    const h=harness(),category=clone(h.get(`${room}/progress/clothesM`));
    if(change==='reorder')[category[0],category[1]]=[category[1],category[0]];
    if(change==='delete')category.splice(1,1);
    if(change==='missing-index'){category[0]=category[1];category.length=1;}
    if(change==='wrong-identity')category[1].id='other';
    h.set(`${room}/progress/clothesM`,category);
    if(['delete','wrong-identity'].includes(change))await assert.rejects(h.store.execute(job()),/商品已不存在/);
    else await h.store.execute(job());
    assert.deepEqual(gets(h).slice(2,4).map(r=>r.path),[`${room}/progress/clothesM/1/id`,`${room}/progress/clothesM`]);
    assert.equal(puts(h).length,['delete','wrong-identity'].includes(change)?0:1);
});
test('local gender and catalogue contents never authorize an item in a different server category',async()=>{
    const h=harness();h.set(`${studentPath}/gender`,'F');h.set(`${room}/progress/clothesF`,[]);
    await assert.rejects(h.store.execute(job()),/商品已不存在/);
    assert.ok(gets(h).some(r=>r.path===`${room}/progress/clothesF/1/id`));
    assert.ok(!gets(h).some(r=>r.path.includes('clothesM')));assert.equal(puts(h).length,0);
});
for(const change of ['ownership','gender-valid','gender-invalid','disappearance','identity','unrelated','catalogue-deletion','catalogue-reorder'])test(`real student ETag conflict revalidates ${change}`,async()=>{
    let changed=false;
    const h=harness({hooks:{before:({method,path,get,set})=>{
        if(method!=='PUT'||path!==studentPath||changed)return;changed=true;
        const student=clone(get(studentPath));student.concurrent=99;
        if(change==='ownership')student.ownedClothes=[];
        if(change.startsWith('gender'))student.gender='F';
        if(change==='gender-invalid')set(`${room}/progress/clothesF`,[]);
        if(change==='identity')student.id=2;
        set(studentPath,change==='disappearance'?null:student);
        if(change==='catalogue-deletion')set(`${room}/progress/clothesM`,[]);
        if(change==='catalogue-reorder'){
            const items=clone(get(`${room}/progress/clothesM`));[items[0],items[1]]=[items[1],items[0]];set(`${room}/progress/clothesM`,items);
        }
    }}});
    const rejected=['ownership','gender-invalid','disappearance','identity','catalogue-deletion'].includes(change);
    if(rejected)await assert.rejects(h.store.execute(job()),/尚未擁有|已不存在/);else await h.store.execute(job());
    assert.equal(puts(h)[0].status,412);assert.equal(gets(h).filter(r=>r.path===studentPath).length,2);
    assert.equal(puts(h).filter(r=>r.status===200).length,rejected?0:1);
    if(!rejected){assert.equal(h.get(`${studentPath}/concurrent`),99);assert.equal(h.get(`${studentPath}/equippedClothes`),'item-1');}
    if(change==='gender-valid')assert.ok(gets(h).some(r=>r.path===`${room}/progress/clothesF/1/id`));
    if(change==='disappearance')assert.equal(h.get(studentPath),null);
});
for(const phase of ['initial','after-catalogue','conflict'])test(`restore barrier rejects at ${phase}`,async()=>{
    let changed=false;
    const h=harness({hooks:{before:({path,method,set,get})=>{
        if(changed)return;
        if((phase==='initial'&&path===metadataPath)||(phase==='after-catalogue'&&path.endsWith('/1/id'))||(phase==='conflict'&&method==='PUT')){
            changed=true;set(metadataPath,1000);
            if(phase==='conflict')set(studentPath,{...get(studentPath),restored:true});
        }
    }}});
    await assert.rejects(h.store.execute(job()),/老師已還原資料/);
    assert.equal(puts(h).filter(r=>r.status===200).length,0);
    assert.equal(puts(h).length,phase==='conflict'?1:0);
});
for(const failure of ['network','json'])test(`unknown committed ${failure} response is not acknowledged or automatically rewritten`,async()=>{
    let fail=true;
    const h=harness({hooks:{response:({method})=>{
        if(method==='PUT'&&fail){fail=false;if(failure==='network')throw new TypeError('lost acknowledgement');return new Response('invalid json',{status:200});}
    }}});
    await assert.rejects(h.store.execute(job()),error=>failure==='network'?error instanceof TypeError:error.retryable===true);
    assert.equal(h.get(`${studentPath}/equippedClothes`),'item-1');assert.equal(puts(h).length,1);
    // Explicit retry still validates metadata, server identity and ownership;
    // already-equipped is a no-op, not a blind re-PUT or a persisted receipt.
    await h.store.execute(job());assert.equal(puts(h).length,1);
    assert.equal(gets(h).filter(r=>r.path===metadataPath).length,4);
});
test('unknown committed result followed by restore is rejected on explicit retry',async()=>{
    let fail=true;
    const h=harness({hooks:{response:({method})=>{if(method==='PUT'&&fail){fail=false;throw new TypeError('lost acknowledgement');}}}});
    await assert.rejects(h.store.execute(job()),TypeError);h.set(metadataPath,1500);
    await assert.rejects(h.store.execute(job()),/老師已還原資料/);assert.equal(puts(h).length,1);
});
test('already equipped still validates ownership and catalogue with both metadata checks',async()=>{
    const h=harness();h.set(`${studentPath}/equippedClothes`,'item-1');
    await h.store.execute(job());assert.equal(gets(h).length,4);assert.equal(puts(h).length,0);
    h.set(`${studentPath}/ownedClothes`,[]);await assert.rejects(h.store.execute(job()),/尚未擁有/);
});
test('unequip retains 2 GET + 1 PUT and never invokes hint or async prepare',async()=>{
    const h=harness();h.set(`${studentPath}/equippedClothes`,'item-1');
    await run(h,{getEquipmentCatalogueHint:assert.fail,transactPreparedProgressStudent:assert.fail},job(null));
    assert.deepEqual(gets(h).map(r=>r.path),[metadataPath,studentPath]);assert.equal(puts(h).length,1);
});
for(const missing of ['getEquipmentCatalogueHint','readEquipmentItemId','transactPreparedProgressStudent'])test(`adapter missing ${missing} safely falls back`,async()=>{
    const h=harness();await run(h,{[missing]:undefined});
    assert.equal(puts(h).length,1);assert.ok(gets(h).some(r=>r.path===`${room}/progress/clothesM`));
    assert.equal(gets(h).length,missing==='transactPreparedProgressStudent'?5:4);
});
test('scalar transport failure is not interpreted as a missing item or a successful write',async()=>{
    const h=harness();await assert.rejects(run(h,{readEquipmentItemId:async()=>{throw new TypeError('offline');}}),/offline/);
    assert.equal(puts(h).length,0);assert.ok(!gets(h).some(r=>r.path===`${room}/progress/clothesM`));
});
test('prepared transaction requires a server ETag before async validation',async()=>{
    const h=harness({hooks:{noEtag:true}});await assert.rejects(h.store.execute(job()),/ETag/);
    assert.equal(gets(h).length,2);assert.equal(puts(h).length,0);
});
test('hint provider reads the current local catalogue at execution, not its initial array',async()=>{
    const h=harness();
    h.local.clothesM=[h.local.clothesM[1]];
    h.set(`${room}/progress/clothesM`,clone(h.local.clothesM));
    await h.store.execute(job());
    assert.equal(gets(h)[2].path,`${room}/progress/clothesM/0/id`);
    assert.equal(gets(h).length,4);
});
for(const race of ['catalogue-after-validation','restore-after-barrier'])test(`cross-node ${race} retains the existing non-atomic limitation`,async()=>{
    const outcomes=[];
    for(const legacy of [true,false]){
        let changed=false;
        const h=harness({legacy,hooks:{before:({method,set})=>{
            if(method!=='PUT'||changed)return;changed=true;
            // Neither change touches the student ETag. Both old and new paths
            // have a cross-node window; this test must not imply global CAS.
            if(race==='catalogue-after-validation')set(`${room}/progress/clothesM`,[]);
            else set(metadataPath,1500);
        }}});
        await h.store.execute(job());outcomes.push(clone(h.root));
        assert.equal(puts(h)[0].status,200);
    }
    assert.deepEqual(outcomes[0],outcomes[1]);
});
test('prepared transaction refuses exhausted conflicts instead of acknowledging success',async()=>{
    let version=0;
    const h=harness({hooks:{before:({method,get,set})=>{if(method==='PUT')set(studentPath,{...get(studentPath),version:++version});}}});
    await assert.rejects(h.store.execute(job()),error=>error.retryable===true);
    assert.equal(puts(h).length,20);assert.ok(puts(h).every(r=>r.status===412));
    assert.equal(gets(h).filter(r=>r.path.endsWith('/1/id')).length,20);
    assert.equal(gets(h).filter(r=>r.path===metadataPath).length,21);
});
