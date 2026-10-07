import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {JSDOM} from 'jsdom';
import * as operations from '../public/game-operations.mjs';
import {createCloudSync} from '../public/cloud-sync.mjs';
import {createFirebaseStore,createTeacherProgressSubscriber} from '../public/firebase-store.mjs';
import {createFirebaseRestClient} from '../public/firebase-rest-client.mjs';
import {mergeStudentStatesIntoProgress} from '../public/teacher-projections.mjs';

const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
const moduleSource=scripts.find(([,attrs])=>attrs.includes('module'))[2].replace(/^\s*import .*;$/gm,'');
const clone=structuredClone,tick=()=>new Promise(resolve=>setImmediate(resolve));
const room='games/classroom-115',studentPath=`${room}/progress/students/0`;
async function page(t,{hooks={},pending=[]}={}){
    const progress=operations.normalizeProgress({
        students:[{id:1,gender:'M',ownedClothes:['a','b'],ownedBg:['sky','sea'],equippedClothes:'a',equippedBg:'sky'}],
        clothesM:[{id:'a',name:'上衣',image:'/a.png'},{id:'b',name:'外套',image:'/b.png'}],
        backgrounds:[{id:'sky',name:'天空',image:'/sky.png'},{id:'sea',name:'海洋',image:'/sea.png'}]
    });
    const root={games:{'classroom-115':{progress}}},requests=[],jobs=[],subscriptions=[],timers=[],callbacks=new Map();
    const dom=new JSDOM(html,{url:'https://classroom.test',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
    let sync,authCallback,id=0;
    const get=path=>path.split('/').reduce((v,k)=>v?.[k],root)??null;
    const set=(path,value)=>{const parts=path.split('/'),key=parts.pop();let parent=root;for(const p of parts)parent=parent[p]??={};if(value===null)delete parent[key];else parent[key]=clone(value);};
    const etag=path=>'"'+createHash('sha256').update(JSON.stringify(get(path))).digest('hex')+'"';
    const request=async(url,options)=>{
        const path=decodeURIComponent(new URL(url).pathname.slice(1,-5)),method=options.method||'GET';
        assert.equal(options.cache,'no-store');
        const entry={path,method};requests.push(entry);await hooks.before?.({path,method,get,set});
        let status=200;
        if(method==='PUT'){
            assert.ok(options.headers['if-match']);
            if(options.headers['if-match']!==etag(path))status=412;else set(path,JSON.parse(options.body));
        }
        entry.status=status;
        const response=Response.json(get(path),{status,headers:{ETag:etag(path)}});
        return await hooks.response?.({path,method,get,set,response})||response;
    };
    w.structuredClone=clone;w.alert=()=>{};w.confirm=()=>true;
    w.setInterval=(fn,delay)=>{timers.push(delay);return timers.length;};w.clearInterval=()=>{};
    w.fetch=()=>assert.fail('unexpected browser fetch');
    vm.runInContext(scripts[0][2]+'\nwindow.uiState=()=>state;window.savedView=()=>lastSavedView;',dom.getInternalVMContext());
    w.sessionStorage.setItem('classroom-pending-operations',JSON.stringify(pending));
    Object.assign(w,{
        initializeApp:()=>({}),getAuth:()=>({currentUser:{uid:'teacher',getIdToken:async()=>'local-token'}}),getDatabase:()=>({}),
        onAuthStateChanged:(_,callback)=>authCallback=callback,accountForEmail:email=>email?{role:'teacher',studentId:null}:null,
        signOut:async()=>{},ref:(_,path)=>path,
        onValue:(path,callback)=>{subscriptions.push(path);callbacks.set(path,callback);return ()=>callbacks.delete(path);},
        update:()=>assert.fail('unexpected root update'),GameOperations:operations,mergeStudentStatesIntoProgress,createTeacherProgressSubscriber,
        createFirebaseRestClient:config=>createFirebaseRestClient({...config,fetch:request}),createFirebaseStore,
        createCloudSync:config=>sync=createCloudSync({...config,
            execute:(job,ids)=>{jobs.push({id:job.id,createdAt:job.createdAt,command:clone(job.command)});return config.execute(job,ids);},
            newId:()=>`transport-${++id}`,setInterval:(fn,delay)=>{timers.push(delay);return timers.length;},clearInterval(){},error(){}})
    });
    vm.runInContext('{\n'+moduleSource+'\n}',dom.getInternalVMContext());
    const broadcast=()=>{for(const [path,callback] of [...callbacks])callback({val:()=>clone(get(path))});};
    authCallback({email:'teacher@classroom.test'});await tick();broadcast();await tick();w.closet(1);
    t.after(()=>{sync.dispose();w.close();});
    return {w,sync,root,requests,jobs,subscriptions,timers,get,set,authCallback,broadcast,async snapshot(){broadcast();await tick();}};
}
const puts=h=>h.requests.filter(r=>r.method==='PUT');
const preview=h=>h.w.document.getElementById('closetPreview');

for(const fields of [['clothes'],['background'],['clothes','background']])test(`actual page + queue + REST: ten trials per ${fields.join('/')} then close uses one transaction per field`,async t=>{
    const h=await page(t),initial=clone(h.w.uiState()),saved=clone(h.w.savedView());
    const subscriptions=[...h.subscriptions],timers=[...h.timers];
    const storage=JSON.stringify({...h.w.localStorage}),session=JSON.stringify({...h.w.sessionStorage});
    for(const kind of fields){
        const action=kind==='clothes'?h.w.equipClothes:h.w.equipBg;
        for(let i=0;i<10;i++)action(1,kind==='clothes'?(i%2?'b':'a'):(i%2?'sea':'sky'));
    }
    assert.deepEqual(h.requests,[]);assert.deepEqual(h.jobs,[]);
    assert.deepEqual(clone(h.w.uiState()),initial);assert.deepEqual(clone(h.w.savedView()),saved);
    assert.equal(JSON.stringify({...h.w.localStorage}),storage);assert.equal(JSON.stringify({...h.w.sessionStorage}),session);
    await h.w.closeVisibleModal();assert.equal(preview(h),null);
    assert.deepEqual(h.jobs.map(job=>job.command.kind),fields);
    assert.deepEqual(h.requests,fields.flatMap(kind=>[
        {path:`${room}/restoredAt`,method:'GET',status:200},{path:studentPath,method:'GET',status:200},
        {path:`${room}/progress/${kind==='clothes'?'clothesM':'backgrounds'}/1/id`,method:'GET',status:200},
        {path:`${room}/restoredAt`,method:'GET',status:200},{path:studentPath,method:'PUT',status:200}
    ]));
    assert.deepEqual(h.subscriptions,subscriptions);assert.deepEqual(h.timers,timers);
    assert.deepEqual(clone(h.w.uiState()),initial);await h.snapshot();
    for(const kind of fields)assert.equal(h.w.uiState().students[0][kind==='clothes'?'equippedClothes':'equippedBg'],kind==='clothes'?'b':'sea');
});
for(const kind of ['clothes','background'])test(`actual REST ${kind} unequip stays at 2 GET + 1 PUT`,async t=>{
    const h=await page(t);if(kind==='clothes')h.w.equipClothes(1,'a');else h.w.equipBg(1,'sky');
    await h.w.closeVisibleModal();assert.equal(h.requests.filter(r=>r.method==='GET').length,2);assert.equal(puts(h).length,1);
});
for(const mode of ['network','json'])test(`actual committed ${mode} unknown response retains original queue ID, no new write or acknowledged-field replay`,async t=>{
    let failed=false;
    const h=await page(t,{hooks:{response:({method})=>{
        if(method==='PUT'&&!failed){failed=true;if(mode==='network')throw new TypeError('lost response');return new Response('broken JSON',{status:200});}
    }}});
    h.w.equipClothes(1,'b');h.w.equipBg(1,'sea');const saving=h.w.closeVisibleModal();await tick();
    const original=h.sync.pendingActions()[0];assert.ok(original);assert.equal(puts(h).length,1);
    await h.w.closeVisibleModal();h.w.equipClothes(1,'a');assert.equal(h.jobs.length,1);
    assert.match(h.w.document.getElementById('closetStatus').textContent,/尚未確認/);
    await h.snapshot();await saving;
    assert.equal(h.jobs.length,3);assert.equal(h.jobs[0].id,h.jobs[1].id);assert.equal(h.jobs[0].createdAt,h.jobs[1].createdAt);
    assert.equal(puts(h).length,2);assert.deepEqual(h.jobs.map(j=>j.command.kind),['clothes','clothes','background']);
    assert.equal(preview(h),null);
});
test('actual restore barrier rejects draft opened before unseen remote restore, without equipment PUT',async t=>{
    const h=await page(t);h.w.equipClothes(1,'b');h.w.equipBg(1,'sea');
    h.set(`${room}/restoredAt`,Date.now()+1);await h.w.closeVisibleModal();
    assert.ok(preview(h));assert.equal(puts(h).length,0);assert.equal(h.jobs.length,1);
    assert.match(h.w.document.getElementById('closetStatus').textContent,/還原/);
    assert.ok(h.jobs[0].createdAt<=h.get(`${room}/restoredAt`));
});
test('actual server ownership invalidation rejects without submitting background',async t=>{
    const h=await page(t);h.w.equipClothes(1,'b');h.w.equipBg(1,'sea');h.set(`${studentPath}/ownedClothes`,['a']);
    await h.w.closeVisibleModal();assert.ok(preview(h));assert.equal(puts(h).length,0);assert.equal(h.jobs.length,1);
});
test('actual auth loss discards draft without invoking equipment transport',async t=>{
    const h=await page(t);h.w.equipClothes(1,'b');h.authCallback(null);assert.equal(preview(h),null);assert.deepEqual(h.requests,[]);
    h.authCallback({email:'teacher@classroom.test'});await tick();await h.snapshot();h.w.closet(1);await h.w.closeVisibleModal();assert.deepEqual(h.jobs,[]);
});
