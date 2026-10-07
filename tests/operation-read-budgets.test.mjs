import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import * as operations from '../public/game-operations.mjs';
import {createStudentProjections} from '../public/student-projections.mjs';
import {createTeacherSyncPlan,applyTeacherStudentPlan,teacherProjectionScope,createCoopSharedProgress} from '../public/teacher-sync-plan.mjs';
import {mergeStudentStatesIntoProgress} from '../public/teacher-projections.mjs';
import {createFirebaseStore,createTeacherProgressSubscriber} from '../public/firebase-store.mjs';
import {createFirebaseRestClient} from '../public/firebase-rest-client.mjs';
import {createCloudSync} from '../public/cloud-sync.mjs';

const clone=structuredClone,bytes=value=>Buffer.byteLength(JSON.stringify(value));
const roomPath='games/classroom-115';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const moduleSource=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].find(([,attrs])=>attrs.includes('module'))[2];
function fixture(){
    const item=id=>({id,name:id,image:`/fixture/${'x'.repeat(512)}.png`,level:'R',price:10,active:true});
    const progress=operations.normalizeProgress({
        students:Array.from({length:28},(_,i)=>({id:i+1,gender:'M',tokens:100,lotteryTickets:2,ownedLayout:['cat']})),
        layouts:[item('cat'),item('dog')],clothesM:[item('shirt')],backgrounds:[item('bg')],
        tasks:[{id:'task',title:'任務',reward:5}],
        bosses:[{id:'boss',name:'BOSS',image:'b'.repeat(1024),maxHp:5,reward:20,rewardTickets:1,attackPassword:'1234',paperId:'paper',active:true}],
        questionPapers:[{id:'paper',questions:Array.from({length:40},(_,i)=>({id:`q${i}`,text:'題'.repeat(128),options:['對','錯'],answerIndex:0}))}],
    });
    const mapping=Object.fromEntries(progress.students.map(s=>[s.id,`uid-${s.id}`]));
    const projections=createStudentProjections(progress,mapping);
    for(const s of progress.students) for(const key of ['tokens','lotteryTickets','petAffection','lastPetMoodDate','equippedLayout','bossProgress']) delete s[key];
    return {games:{'classroom-115':{progress,operations:{}}},...projections};
}
function harness(root=fixture(),hooks={}){
    const reads=[],puts=[],patches=[],transactions=[],putAttempts=[],responses=[];
    const get=path=>path.split('/').reduce((value,key)=>value?.[key],root)??null;
    const etag=path=>'"'+createHash('sha256').update(JSON.stringify(get(path))).digest('hex')+'"';
    const resolve=value=>{
        if(value&&typeof value==='object'){
            if(value['.sv']==='timestamp')return Date.now();
            return Array.isArray(value)?value.map(resolve):Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolve(v)]));
        }
        return value;
    };
    const set=(path,value)=>{
        const parts=path.split('/'),key=parts.pop();let parent=root;
        for(const part of parts)parent=parent[part]??={};
        if(value===null)delete parent[key];else parent[key]=resolve(clone(value));
    };
    const request=async(url,options)=>{
        const parsed=new URL(url),path=decodeURIComponent(parsed.pathname.slice(1,-5));
        assert.equal(options.cache,'no-store');assert.equal(parsed.searchParams.has('print'),false);
        if(options.method==='PUT'){
            assert.ok(options.headers['if-match']);
            const value=JSON.parse(options.body);
            putAttempts.push({path,value:clone(value)});
            if(await hooks.conflict?.({path,value,root,set})||options.headers['if-match']!==etag(path))return Response.json(null,{status:412});
            puts.push({path,value:clone(value),bytes:Buffer.byteLength(options.body)});set(path,value);
            await hooks.afterPut?.({path,value,root,set});
        }else{
            await hooks.beforeRead?.({path,root,set});
            reads.push({path,bytes:bytes(get(path))});
        }
        const response=Response.json(get(path),{headers:{ETag:etag(path)}});
        responses.push({path,method:options.method||'GET',bytes:Buffer.byteLength(await response.clone().text())});
        return await hooks.response?.({path,options,response,root,set})||response;
    };
    const context=vm.createContext({
        initializeApp:()=>({}),getAuth:()=>({currentUser:{uid:'teacher',getIdToken:async()=>'token'}}),getDatabase:()=>({}),
        onAuthStateChanged(){},ref:(_,path)=>path,onValue:()=>()=>{},
        update:async(_,updates)=>{patches.push(clone(updates));for(const [path,value] of Object.entries(updates))set(path,value);},
        GameOperations:operations,createFirebaseStore:config=>{context.dependencies=config;return createFirebaseStore(config);},createTeacherProgressSubscriber,
        createFirebaseRestClient:config=>{
            const client=createFirebaseRestClient({...config,fetch:request});
            return {...client,transact:(path,updater)=>{transactions.push(path);return client.transact(path,updater);}};
        },
        createCloudSync:()=>({setConnected(){},setActive(){}}),window:{addEventListener(){}},document:{addEventListener(){},hidden:false},navigator:{onLine:false},console,setSyncLocked(){},setSyncStatus(){},currentUser:null,
    });
    vm.runInContext(moduleSource.replace(/^\s*import .*;$/gm,'')+'\nglobalThis.storeUnderTest=store;',context);
    return {root,reads,puts,patches,transactions,putAttempts,responses,set,get,store:context.storeUnderTest,dependencies:context.dependencies};
}
const job=(command,id='budget-operation')=>({id,createdAt:Date.now(),command});
const commands={
    clothes:{type:'purchase',studentId:1,kind:'clothes',itemId:'shirt'},
    background:{type:'purchase',studentId:1,kind:'background',itemId:'bg'},
    task:{type:'completeTask',studentId:1,taskId:'task'},
    pet:{type:'purchase',studentId:1,kind:'layout',itemId:'dog'},
};
for(const [name,command] of Object.entries(commands))test(`browser ${name} read and request byte budgets retain legacy-safe complete plans`,async t=>{
    const h=harness(),initial=clone(h.root);
    const omitted=['studentPets','publicBosses','publicQuestionPapers'];
    const baselineProjectionBytes=omitted.reduce((n,key)=>n+bytes(initial[key]),0);
    await h.store.execute(job(command));
    const projectionReads=h.reads.filter(r=>omitted.some(key=>r.path===key||r.path.startsWith(key+'/')));
    assert.deepEqual(projectionReads.map(r=>r.path),name==='pet'?['studentPets/uid-1']:[]);
    assert.equal(h.reads.length,name==='pet'?10:9); // 3 initial + 2 room CAS + personal CAS/cleanup + 2 refresh + optional pet
    const projectedBytes=projectionReads.reduce((n,r)=>n+r.bytes,0);
    assert.ok(baselineProjectionBytes>30000);
    assert.ok(projectedBytes<700);
    const plan=h.puts.find(p=>p.path===roomPath).value._projectionSync.plan;
    for(const key of omitted)assert.ok(Object.hasOwn(plan,key));
    assert.equal(Object.keys(plan.studentPets).length,28);
    assert.equal(Object.keys(plan.publicQuestionPapers).length,1);
    const requestBytes=h.puts.reduce((n,p)=>n+p.bytes,0)+h.patches.reduce((n,p)=>n+bytes(p),0);
    assert.ok(requestBytes<100000,`request bytes ${requestBytes}`);
    const baseline=harness(clone(initial));
    const broadStore=createFirebaseStore({...baseline.dependencies,readOperationData:undefined,readPublicProjectionData:undefined});
    await broadStore.execute(job(command));
    assert.equal(baseline.reads.length,12);
    const readBytes=h.reads.reduce((n,r)=>n+r.bytes,0),baselineReadBytes=baseline.reads.reduce((n,r)=>n+r.bytes,0);
    assert.equal(baselineReadBytes-readBytes,baselineProjectionBytes-projectedBytes);
    const baselineRequestBytes=baseline.puts.reduce((n,p)=>n+p.bytes,0)+baseline.patches.reduce((n,p)=>n+bytes(p),0);
    assert.equal(requestBytes,baselineRequestBytes);
    // No claim of request savings: persisted plan remains the legacy payload.
    assert.ok(bytes(plan)>baselineProjectionBytes);
    assert.deepEqual(h.root.publicBosses,initial.publicBosses);
    assert.deepEqual(h.root.publicQuestionPapers,initial.publicQuestionPapers);
    assert.deepEqual(h.root.studentPets['uid-2'],initial.studentPets['uid-2']);
    assert.equal(h.root.studentStates['uid-1'].tokens,name==='task'?105:90);
    assert.equal(h.root.games['classroom-115'].progress.students[0].tokens,undefined);
    const putCount=h.puts.length;
    await h.store.execute(job(command));
    assert.equal(h.puts.length,putCount); // receipt replay, no repeated charge/reward
    t.diagnostic(JSON.stringify({operation:name,projectionReadBytes:projectedBytes,avoidedFixtureProjectionBytes:baselineProjectionBytes-projectedBytes,readBytes,baselineReadBytes,requestBytes,planBytes:bytes(plan)}));
});

test('omitted scoped transport nodes fail before any personal or public projection writes',async()=>{
    const h=harness();
    const store=createFirebaseStore({...h.dependencies,readPublicProjectionData:async()=>({})});
    await assert.rejects(store.execute(job(commands.pet)),/投影讀取不完整/);
    assert.equal(h.root.studentStates['uid-1'].tokens,100);assert.equal(h.patches.length,0);
    assert.ok(h.root.games['classroom-115']._projectionSync);
    await h.store.execute(job(commands.pet));
    assert.equal(h.root.studentStates['uid-1'].tokens,90);
    assert.deepEqual(h.reads.filter(r=>['studentPets','publicBosses','publicQuestionPapers'].includes(r.path)).map(r=>r.path),['studentPets','publicBosses','publicQuestionPapers']);
});

test('scoped initial reader without companion projection reader is rejected before committing a lock',async()=>{
    const h=harness(),store=createFirebaseStore({...h.dependencies,readPublicProjectionData:undefined});
    await assert.rejects(store.execute(job(commands.task)),/讀取器/);
    assert.equal(h.puts.length,0);
});

// Frozen pre-B projection algorithm: omissions are DESTRUCTIVE in old tabs.
function legacyProjectionUpdates(root,plan,mapping){
    const updates={};
    for(const uid of Object.values(mapping)){
        const desired=plan.studentPets?.[uid]||{},current=root.studentPets?.[uid]||{};
        if(JSON.stringify(current)!==JSON.stringify(desired))updates[`studentPets/${uid}`]=Object.keys(desired).length?desired:null;
    }
    for(const key of ['publicBosses','publicQuestionPapers']){
        const desired=plan[key]||{};
        if(JSON.stringify(root[key]||{})!==JSON.stringify(desired))updates[key]=desired;
    }
    return updates;
}
test('old tab consuming a new pending plan preserves every unrelated projection; compact negative control deletes',async()=>{
    let drop=true;
    const h=harness(fixture(),{afterPut:({path,value})=>{
        if(drop&&path===roomPath&&value._projectionSync){drop=false;throw new TypeError('lost room ack');}
    }});
    const initial=clone(h.root);
    await assert.rejects(h.store.execute(job(commands.task)),/lost room ack/);
    const sync=h.root.games['classroom-115']._projectionSync;
    assert.deepEqual(legacyProjectionUpdates(h.root,sync.plan,sync.uidByStudentId),{});
    const destructive=legacyProjectionUpdates(h.root,{studentPlans:sync.plan.studentPlans},sync.uidByStudentId);
    assert.equal(destructive['studentPets/uid-2'],null);assert.deepEqual(destructive.publicBosses,{});
    // Old consumer may already apply a personal delta before the new tab resumes.
    for(const p of Object.values(sync.plan.studentPlans))h.set(`studentStates/${p.uid}`,applyTeacherStudentPlan(h.get(`studentStates/${p.uid}`),p,sync.operationId).state);
    await h.store.execute(job(commands.task));
    assert.equal(h.root.studentStates['uid-1'].tokens,105);
    for(const key of ['studentPets','publicBosses','publicQuestionPapers'])assert.deepEqual(h.root[key],initial[key]);
});

test('legacy pending full plan recovers complete projections even when next command has empty scope',async()=>{
    const root=fixture(),mapping=Object.fromEntries(Object.entries(root.studentRoster).map(([uid,s])=>[s.studentId,uid]));
    const before=operations.normalizeProgress({...root.games['classroom-115'].progress,students:root.games['classroom-115'].progress.students.map(s=>({...s,...root.studentStates[mapping[s.id]],id:s.id}))});
    const after=operations.applyOperation(before,commands.pet,Date.now());
    const plan=createTeacherSyncPlan({beforeProgress:before,afterProgress:after.progress,command:commands.pet,result:{ok:true},uidByStudentId:mapping,clock:Date.now()});
    root.games['classroom-115']._projectionSync={operationId:'legacy',plan,uidByStudentId:mapping};
    root.games['classroom-115'].operations.legacy={phase:'projecting',result:{json:'{"ok":true}'}};
    const h=harness(root);await h.store.execute(job(commands.task));
    assert.equal(h.root.studentPets['uid-1'].dog.id,'dog');assert.equal(h.root.studentStates['uid-1'].tokens,95);
    assert.equal(h.root.games['classroom-115']._projectionSync,undefined);
    assert.ok(h.reads.some(r=>r.path==='studentPets'));
});

test('room ETag retry recomputes pet scope against changed ownership and price',async()=>{
    let conflict=true;
    const h=harness(fixture(),{conflict:({path,root})=>{
        if(!conflict||path!==roomPath)return false;conflict=false;
        root.games['classroom-115'].progress.students[0].ownedLayout.push('dog');
        root.games['classroom-115'].progress.layouts[1].price=25;
        return true;
    }});
    await h.store.execute(job(commands.pet));
    assert.equal(h.puts.length,0);assert.equal(h.root.studentStates['uid-1'].tokens,100);
    assert.equal(h.reads.filter(r=>r.path.startsWith('studentPets')).length,0);
});

test('personal ETag retry retains concurrent reward while applying purchase delta once',async()=>{
    let conflict=true;
    const h=harness(fixture(),{conflict:({path,root})=>{
        if(!conflict||path!=='studentStates/uid-1')return false;conflict=false;
        root.studentStates['uid-1'].tokens+=7;root.studentStates['uid-1'].petAffection=8;return true;
    }});
    await h.store.execute(job(commands.clothes));
    assert.equal(h.root.studentStates['uid-1'].tokens,97);assert.equal(h.root.studentStates['uid-1'].petAffection,8);
    assert.equal(h.reads.filter(r=>r.path==='studentStates/uid-1').length,3);
});

test('retry after lost room acknowledgement uses persisted mapping, not current target mapping',async()=>{
    let drop=true;
    const h=harness(fixture(),{afterPut:({path,value})=>{if(drop&&path===roomPath&&value._projectionSync){drop=false;throw new TypeError('lost ack');}}});
    await assert.rejects(h.store.execute(job(commands.pet)),/lost ack/);
    h.root.studentRoster['uid-1'].active=false;
    h.root.studentRoster.replacement={studentId:1,active:true};
    // Mapping/state disagreement must fail closed rather than silently retarget a reward.
    h.root.studentStates.replacement=clone(h.root.studentStates['uid-1']);
    await assert.rejects(h.store.execute(job(commands.pet)),/重複/);
    assert.equal(h.root.studentStates.replacement.tokens,100);
    assert.equal(h.root.studentStates['uid-1'].tokens,90);
    assert.ok(h.root.games['classroom-115']._projectionSync);
    delete h.root.studentRoster.replacement;delete h.root.studentStates.replacement;h.root.studentRoster['uid-1'].active=true;
    await h.store.execute(job(commands.pet));assert.equal(h.root.studentStates['uid-1'].tokens,90);
});

for(const collection of ['bosses','questionPapers','layouts'])test(`${collection} edits retain full related projection repair`,async()=>{
    const h=harness(),value=h.root.games['classroom-115'].progress[collection][0];
    const command={type:'edit',changes:[{collection,id:value.id,action:'remove'}]};
    await h.store.execute(job(command));
    assert.deepEqual(h.reads.filter(r=>['studentPets','publicBosses','publicQuestionPapers'].includes(r.path)).map(r=>r.path),['studentPets','publicBosses','publicQuestionPapers']);
    if(collection==='bosses'){assert.deepEqual(h.root.publicBosses,{});assert.deepEqual(h.root.publicQuestionPapers,{});}
    if(collection==='questionPapers')assert.deepEqual(h.root.publicQuestionPapers,{});
    if(collection==='layouts')assert.equal(h.root.studentPets['uid-28'],undefined);
});

test('restore forces full projection repair and a restoredAt barrier even for equal backup',async()=>{
    const h=harness(),backup=await h.store.readCompleteProgress();
    await h.store.execute(job({type:'restore',value:backup}));
    assert.ok(h.root.games['classroom-115'].restoredAt);
    assert.ok(h.reads.some(r=>r.path==='studentPets'));
    const plan=h.puts.find(p=>p.value?._projectionSync).value._projectionSync.plan;
    assert.equal(Object.keys(plan.studentPlans).length,28);
    await assert.rejects(h.store.execute({id:'old',createdAt:h.root.games['classroom-115'].restoredAt-1,command:commands.task}),/老師已還原/);
});

for(const petFirst of [true,false])test(`lottery ETag retry discards stale scope (${petFirst?'pet to clothes':'clothes to pet'})`,async()=>{
    const root=fixture();
    if(petFirst)root.games['classroom-115'].progress.clothesM=[];
    // Pick dog (index 1) with pet-only catalogues, shirt (index 0) otherwise.
    root.games['classroom-115'].progress.layouts=[root.games['classroom-115'].progress.layouts[1]];
    let conflict=true;
    const h=harness(root,{conflict:({path,root})=>{
        if(!conflict||path!==roomPath)return false;conflict=false;
        root.games['classroom-115'].progress.clothesM=petFirst?fixture().games['classroom-115'].progress.clothesM:[];
        return true;
    }});
    await h.store.execute(job({type:'lottery',studentId:1,roll:0,indexRoll:0}));
    const petReads=h.reads.filter(r=>r.path.startsWith('studentPets')).map(r=>r.path);
    assert.deepEqual(petReads,petFirst?[]:['studentPets/uid-1']);
    assert.equal(h.root.studentStates['uid-1'].lotteryTickets,1);
    assert.ok(h.root.games['classroom-115'].progress.students[0][petFirst?'ownedClothes':'ownedLayout'].includes(petFirst?'shirt':'dog'));
});

for(const type of ['petMood','bossAttack'])test(`scoped ${type} recomputes conditional result on latest personal state`,async()=>{
    const root=fixture(),now=Date.now();
    root.studentStates['uid-1'].petAffection=9;
    const bossProgress={bossId:'boss',hp:5,passwordVerified:true,answeredQuestionIds:[],defeated:false,completedAt:null};
    root.studentStates['uid-1'].bossProgress=[bossProgress];
    const command=type==='petMood'?{type,studentId:1}:{type,studentId:1,bossId:'boss',questionId:'q0',answerIndex:0,password:'1234'};
    let conflict=true;
    const h=harness(root,{conflict:({path,root})=>{
        if(!conflict||path!=='studentStates/uid-1')return false;conflict=false;
        if(type==='petMood'){
            const today=new Date(now+8*60*60*1000).toISOString().slice(0,10);
            Object.assign(root.studentStates['uid-1'],{tokens:110,petAffection:10,lastPetMoodDate:today});
        }else Object.assign(root.studentStates['uid-1'],{tokens:120,lotteryTickets:3,bossProgress:[{...bossProgress,hp:0,defeated:true,answeredQuestionIds:['q0'],completedAt:now}]});
        return true;
    }});
    const outcome=await h.store.execute(job(command));
    assert.equal(h.root.studentStates['uid-1'].tokens,type==='petMood'?110:120);
    assert.equal(type==='petMood'?outcome.result.awarded:outcome.result.reward,type==='petMood'?false:0);
    assert.equal(h.reads.filter(r=>/^(studentPets|publicBosses|publicQuestionPapers)/.test(r.path)).length,0);
});

test('scope detects normalization changes rather than trusting a command-only allowlist',()=>{
    const root=fixture(),before=root.games['classroom-115'].progress,after=clone(before);
    after.layouts[0].image='changed';
    assert.equal(teacherProjectionScope({beforeProgress:before,afterProgress:after,command:commands.task,uidByStudentId:{1:'uid-1',2:'uid-2'}}).pets.length,2);
});

const coopCommand=studentId=>({type:'coopComplete',studentId,taskId:'coop'});
function coopFixture(completedBy=[]){
    const root=fixture();
    root.games['classroom-115'].progress.coopTasks=[{id:'coop',monsterName:'怪獸',reward:10,rewardType:'token',completedBy,claimed:false}];
    return root;
}
const projectionPaths=/^(studentPets|publicBosses|publicQuestionPapers)(\/|$)/;
function assertNoProjection(h){
    assert.equal(h.reads.filter(r=>projectionPaths.test(r.path)||r.path.startsWith('studentStates/')).length,0);
    assert.equal(h.puts.filter(p=>p.path!==roomPath).length,0);
    assert.deepEqual(h.patches,[]);
    assert.equal(h.puts.some(p=>p.value._projectionSync),false);
}
// Compatibility control: run the otherwise identical pre-C coordinator path
// with ONLY the new shared-only branch disabled. Its full wire plan, recovery,
// receipts and personal transactions are unchanged by C.
let preCFactory;
async function preCStore(dependencies){
    if(!preCFactory){
        const source=fs.readFileSync(new URL('../public/firebase-store.mjs',import.meta.url),'utf8');
        assert.equal(source.split('if(sharedProgress){').length,2);
        const legacy=source.replace('if(sharedProgress){','if(false){').replace(/from '(\.\/[^']+)'/g,(_,path)=>`from '${new URL('../public/'+path.slice(2),import.meta.url).href}'`);
        preCFactory=(await import('data:text/javascript;base64,'+Buffer.from(legacy).toString('base64'))).createFirebaseStore;
    }
    return preCFactory(dependencies);
}

test('browser nonfinal coop commits shared progress and final receipt in one room transaction with exact budgets',async t=>{
    const h=harness(coopFixture()),initial=clone(h.root),request=job(coopCommand(1),'coop-budget');
    const outcome=await h.store.execute(request);
    assert.equal(outcome.result.claimed,false);
    assert.deepEqual(h.transactions,[roomPath]);assert.equal(h.puts.length,1);
    assert.deepEqual(h.reads.map(r=>r.path),[roomPath,'studentRoster','studentStates',roomPath]);
    assertNoProjection(h);
    const room=h.root.games['classroom-115'],receipt=room.operations[request.id];
    assert.equal(receipt.phase,undefined);assert.equal(typeof receipt.committedAt,'number');
    assert.equal(receipt.projectionUids,undefined);assert.equal(room.lastOperationId,request.id);
    assert.equal(room.progress.lastSaved.length,24);
    assert.deepEqual(room.progress.coopTasks[0].completedBy,[1]);assert.equal(room.progress.coopTasks[0].claimed,false);
    for(const key of ['studentStates','studentPets','publicBosses','publicQuestionPapers'])assert.deepEqual(h.root[key],initial[key]);
    assert.deepEqual(room.progress.students,initial.games['classroom-115'].progress.students);
    const baseline=harness(clone(initial));await (await preCStore(baseline.dependencies)).execute(request);
    assert.equal(baseline.reads.length,7);assert.deepEqual(baseline.transactions,[roomPath,roomPath]);
    assert.equal(baseline.puts.length,2);assert.ok(baseline.puts[0].value._projectionSync.plan.publicQuestionPapers.paper);
    const readBytes=h.reads.reduce((n,r)=>n+r.bytes,0),requestBytes=h.puts.reduce((n,p)=>n+p.bytes,0);
    const baselineReadBytes=baseline.reads.reduce((n,r)=>n+r.bytes,0),baselineRequestBytes=baseline.puts.reduce((n,p)=>n+p.bytes,0);
    assert.ok(readBytes<60000);assert.ok(requestBytes<30000);
    assert.ok(baselineReadBytes-readBytes>60000);assert.ok(baselineRequestBytes-requestBytes>60000);
    t.diagnostic(JSON.stringify({operation:'coop-nonfinal',gets:h.reads.length,roomTransactions:h.transactions.length,projectionReadBytes:0,readBytes,baselineReadBytes,requestBytes,baselineRequestBytes}));
});

test('coop receipt replay, duplicate clicks and receipt pruning never repeat progress or rewards',async()=>{
    const h=harness(coopFixture()),request=job(coopCommand(1));
    await h.store.execute(request);
    h.root.studentStates['uid-1'].tokens=777;
    const replay=await h.store.execute(request);
    assert.equal(replay.progress.students[0].tokens,777);assert.equal(replay.studentStates['uid-1'].tokens,777);
    assert.equal(h.reads.length,7);assert.equal(h.puts.length,1);assert.deepEqual(h.transactions,[roomPath]);
    await h.store.execute(job(coopCommand(1),'duplicate-click'));
    delete h.root.games['classroom-115'].operations[request.id];
    await h.store.execute(request);
    assert.equal(h.puts.length,1);assertNoProjection(h);
    assert.deepEqual(h.root.games['classroom-115'].progress.coopTasks[0].completedBy,[1]);
    assert.equal(h.root.studentStates['uid-1'].tokens,777);
});

for(const loss of ['network','invalid-json'])test(`nonfinal coop unknown committed PUT (${loss}) recovers via receipt with no second transaction`,async()=>{
    let drop=true;
    const h=harness(coopFixture(),{response:({path,options})=>{
        if(!drop||path!==roomPath||options.method!=='PUT')return;drop=false;
        if(loss==='network')throw new TypeError('lost ack');
        return new Response('{broken',{status:200});
    }});
    const request=job(coopCommand(1));
    await assert.rejects(h.store.execute(request),error=>loss==='network'?error instanceof TypeError:error.retryable===true);
    const recovered=await createFirebaseStore(h.dependencies).execute(request);
    assert.equal(recovered.result.claimed,false);assert.equal(h.puts.length,1);assert.deepEqual(h.transactions,[roomPath]);
    assertNoProjection(h);assert.equal(h.root.studentStates['uid-1'].tokens,100);
});

for(const legacy of [false,true])test(`coop shared-only ETag retry preserves latest non-coop fields and ${legacy?'legacy':'compact'} students`,async()=>{
    const root=coopFixture();
    if(legacy)for(const s of root.games['classroom-115'].progress.students)Object.assign(s,clone(root.studentStates[`uid-${s.id}`]));
    let conflict=true,expected;
    const h=harness(root,{conflict:({path,root})=>{
        if(!conflict||path!==roomPath)return false;conflict=false;
        const progress=root.games['classroom-115'].progress;
        Object.assign(progress.students[0],{gender:'F',ownedBg:['bg'],equippedBg:'bg',customLegacy:'keep'});
        if(legacy)Object.assign(progress.students[0],{tokens:333,lotteryTickets:8,petAffection:21,equippedLayout:['cat']});
        root.studentStates['uid-1'].tokens=900;root.studentStates['uid-1'].petAffection=40;
        progress.tasks.push({id:'concurrent',reward:9});progress.globalBgImage='latest';
        progress.drawings=[{id:'drawing_race',savedAt:'2026-10-07T00:00:00Z'}];
        expected=clone(progress);return true;
    }});
    await h.store.execute(job(coopCommand(1)));
    const saved=h.root.games['classroom-115'].progress;
    for(const key of Object.keys(expected).filter(k=>!['coopTasks','lastSaved'].includes(k)))assert.deepEqual(saved[key],expected[key],key);
    assert.equal(h.root.studentStates['uid-1'].tokens,900);assert.equal(h.root.studentStates['uid-1'].petAffection,40);
    assert.equal(h.reads.length,5);assert.equal(h.putAttempts.length,2);assert.equal(h.puts.length,1);
    assert.deepEqual(h.transactions,[roomPath]);assertNoProjection(h);
});

for(const direction of ['nonfinal-final','final-nonfinal'])test(`coop ETag retry recomputes eligibility ${direction}`,async()=>{
    const completed=Array.from({length:26},(_,i)=>i+1),root=coopFixture(direction==='final-nonfinal'?[...completed,27]:completed);
    let conflict=true;
    const h=harness(root,{conflict:({path,value,root})=>{
        if(!conflict||path!==roomPath)return false;conflict=false;
        assert.equal(Boolean(value._projectionSync),direction==='final-nonfinal');
        root.games['classroom-115'].progress.coopTasks[0].completedBy=direction==='nonfinal-final'?[...completed,27]:completed;
        root.studentStates['uid-1'].tokens=500;
        return true;
    }});
    const outcome=await h.store.execute(job(coopCommand(28)));
    const final=direction==='nonfinal-final';
    assert.equal(outcome.result.claimed,final);assert.equal(h.root.studentStates['uid-1'].tokens,final?510:500);
    assert.equal(h.transactions.filter(p=>p===roomPath).length,final?2:1);
    assert.equal(h.puts.filter(p=>p.path===roomPath).length,final?2:1);
    assert.equal(h.root.games['classroom-115']._projectionSync,undefined);
    if(final){
        assert.equal(Object.keys(h.puts[0].value._projectionSync.plan.studentPlans).length,28);
        assert.equal(h.transactions.filter(p=>p.startsWith('studentStates/')).length,56);
        assert.equal(outcome.progress.students[0].tokens,510);
    }else assertNoProjection(h);
});

for(const rewardType of ['token','ticket'])test(`two simultaneous last coop members serialize real ETags and award ${rewardType} once`,async()=>{
    const root=coopFixture(Array.from({length:26},(_,i)=>i+1));root.games['classroom-115'].progress.coopTasks[0].rewardType=rewardType;
    const h=harness(root),a=job(coopCommand(27),'member-27'),b=job(coopCommand(28),'member-28');
    const outcomes=await Promise.all([h.store.execute(a),createFirebaseStore(h.dependencies).execute(b)]);
    assert.equal(outcomes.filter(o=>o.result.claimed).length,1);
    assert.ok(h.putAttempts.length>h.puts.length,'overlapping ETags must actually conflict');
    assert.equal(h.puts.filter(p=>p.path===roomPath).length,3);
    assert.equal(h.puts.filter(p=>p.value._projectionSync).length,1);
    for(const s of Object.values(h.root.studentStates)){
        assert.equal(s.tokens,rewardType==='token'?110:100);assert.equal(s.lotteryTickets,rewardType==='ticket'?12:2);
        assert.equal(s._teacherOperation,undefined);
    }
    await h.store.execute(a);await h.store.execute(b);await h.store.execute(job(coopCommand(28),'new-click'));
    assert.equal(h.puts.filter(p=>p.path===roomPath).length,3);
    assert.equal(h.root.games['classroom-115'].progress.coopTasks[0].claimed,true);
});

for(const when of ['initial','etag-conflict'])test(`coop ${when} restore barrier rejects stale completion without writes`,async()=>{
    const request=job(coopCommand(1)),root=coopFixture();
    if(when==='initial')root.games['classroom-115'].restoredAt=request.createdAt;
    let conflict=true;
    const h=harness(root,{conflict:({path,root})=>{
        if(when!=='etag-conflict'||!conflict||path!==roomPath)return false;conflict=false;
        root.games['classroom-115'].restoredAt=request.createdAt;root.studentStates['uid-1'].tokens=700;return true;
    }});
    await assert.rejects(h.store.execute(request),/老師已還原/);
    assert.equal(h.puts.length,0);assertNoProjection(h);
    assert.deepEqual(h.root.games['classroom-115'].progress.coopTasks[0].completedBy,[]);
});

for(const when of ['initial','etag-conflict'])test(`coop ${when} orphan projecting receipt fails closed`,async()=>{
    const root=coopFixture(),pending={phase:'projecting',result:{json:'{"ok":true}'}};
    if(when==='initial')root.games['classroom-115'].operations.orphan=pending;
    let conflict=true;
    const h=harness(root,{conflict:({path,root})=>{
        if(when!=='etag-conflict'||!conflict||path!==roomPath)return false;conflict=false;
        root.games['classroom-115'].operations.orphan=pending;return true;
    }});
    await assert.rejects(h.store.execute(job(coopCommand(1))),/缺少同步計畫/);
    assert.equal(h.puts.length,0);assertNoProjection(h);
});

for(const oldClient of [false,true])test(`${oldClient?'pre-C':'current'} pending plan preempts coop fast path after ETag conflict and recovers fully`,async()=>{
    let drop=true;
    const producer=harness(coopFixture(),{afterPut:({path,value})=>{
        if(drop&&path===roomPath&&value._projectionSync){drop=false;throw new TypeError('lost plan ack');}
    }});
    const producerStore=oldClient?await preCStore(producer.dependencies):producer.store;
    await assert.rejects(producerStore.execute(job(commands.pet,'pending-pet')),/lost plan ack/);
    const pending=clone(producer.root.games['classroom-115']);let conflict=true;
    const h=harness(coopFixture(),{conflict:({path,set})=>{
        if(!conflict||path!==roomPath)return false;conflict=false;set(roomPath,pending);return true;
    }});
    await h.store.execute(job(coopCommand(1),'coop-after-plan'));
    assert.deepEqual(h.reads.filter(r=>projectionPaths.test(r.path)).map(r=>r.path),['studentPets','publicBosses','publicQuestionPapers']);
    assert.equal(h.root.studentPets['uid-1'].dog.id,'dog');assert.equal(h.root.studentStates['uid-1'].tokens,90);
    const room=h.root.games['classroom-115'];assert.equal(room._projectionSync,undefined);
    assert.deepEqual(room.progress.coopTasks[0].completedBy,[1]);assert.equal(room.operations['pending-pet'].phase,null);
    assert.equal(room.operations['coop-after-plan'].phase,undefined);
    assert.equal(h.puts.filter(p=>p.path===roomPath).length,2); // recovered finalize + short commit
    assert.equal(h.puts.at(-1).value.lastOperationId,'coop-after-plan');
});

test('pre-C nonfinal pending coop plan is fully recovered, never mistaken for a final receipt',async()=>{
    let drop=true;
    const h=harness(coopFixture(),{afterPut:({path,value})=>{
        if(drop&&path===roomPath&&value._projectionSync){drop=false;throw new TypeError('lost old plan');}
    }});
    const request=job(coopCommand(1));await assert.rejects((await preCStore(h.dependencies)).execute(request),/lost old plan/);
    assert.deepEqual(h.root.games['classroom-115']._projectionSync.plan.studentPlans,{});
    await h.store.execute(request);
    assert.equal(h.puts.filter(p=>p.path===roomPath).length,2);
    assert.deepEqual(h.reads.filter(r=>projectionPaths.test(r.path)).map(r=>r.path),['studentPets','publicBosses','publicQuestionPapers']);
    assert.equal(h.root.games['classroom-115'].operations[request.id].phase,null);
    assert.equal(h.root.studentStates['uid-1'].tokens,100);
});

test('pre-C client replays new short receipt and finishes the class using its unchanged full plan',async()=>{
    const h=harness(coopFixture(Array.from({length:26},(_,i)=>i+1))),first=job(coopCommand(27),'new-nonfinal');
    await h.store.execute(first);
    const old=await preCStore(h.dependencies);await old.execute(first);
    assert.equal(h.puts.length,1);assertNoProjection(h);
    const final=job(coopCommand(28),'old-final');await old.execute(final);await h.store.execute(final);
    assert.equal(h.puts.filter(p=>p.path===roomPath).length,3);
    for(const s of Object.values(h.root.studentStates))assert.equal(s.tokens,110);
});

test('new final coop full plan can be resumed by pre-C client after a personal commit with unknown acknowledgement',async()=>{
    let drop=true;
    const h=harness(coopFixture(Array.from({length:27},(_,i)=>i+1)),{afterPut:({path,value})=>{
        if(drop&&path==='studentStates/uid-1'&&value._teacherOperation){drop=false;throw new TypeError('lost personal ack');}
    }});
    const request=job(coopCommand(28));await assert.rejects(h.store.execute(request),/lost personal ack/);
    const plan=h.root.games['classroom-115']._projectionSync.plan;
    assert.deepEqual(legacyProjectionUpdates(h.root,plan,h.root.games['classroom-115']._projectionSync.uidByStudentId),{});
    await (await preCStore(h.dependencies)).execute(request);await h.store.execute(request);
    for(const s of Object.values(h.root.studentStates)){assert.equal(s.tokens,110);assert.equal(s._teacherOperation,undefined);}
    assert.equal(h.root.games['classroom-115']._projectionSync,undefined);
});

test('final zero reward still uses full coordinator, not the empty-plan coop shortcut',async()=>{
    const root=coopFixture(Array.from({length:27},(_,i)=>i+1));root.games['classroom-115'].progress.coopTasks[0].reward=0;
    const h=harness(root),outcome=await h.store.execute(job(coopCommand(28)));
    assert.equal(outcome.result.claimed,true);assert.deepEqual(h.transactions,[roomPath,roomPath]);
    assert.ok(h.puts[0].value._projectionSync);assert.equal(h.puts.length,2);
});

test('coop ETag retry never resurrects a deleted room from the initial read',async()=>{
    let conflict=true;
    const h=harness(coopFixture(),{conflict:({path,set})=>{
        if(!conflict||path!==roomPath)return false;conflict=false;set(roomPath,null);return true;
    }});
    await assert.rejects(h.store.execute(job(coopCommand(1))),/房間資料已不存在/);
    assert.equal(h.get(roomPath),null);assert.equal(h.puts.length,0);assertNoProjection(h);
});

for(const change of ['member-removed','task-deleted','deadline'])test(`coop retry validates latest ${change} instead of initial eligibility`,async()=>{
    const root=coopFixture();let conflict=true,clock=Date.now();
    root.games['classroom-115'].progress.coopTasks[0].dueAt=clock+1000;
    const h=harness(root,{conflict:({path,root})=>{
        if(!conflict||path!==roomPath)return false;conflict=false;
        const progress=root.games['classroom-115'].progress;
        if(change==='member-removed')progress.students=progress.students.filter(s=>s.id!==1);
        if(change==='task-deleted')progress.coopTasks=[];
        if(change==='deadline')clock+=2000;
        return true;
    }});
    const store=createFirebaseStore({...h.dependencies,now:()=>clock});
    await assert.rejects(store.execute(job(coopCommand(1))),/不存在|截止/);
    assert.equal(h.puts.length,0);assertNoProjection(h);
});

test('pending restore preempts an uncommitted coop shortcut and cancels it after full restore recovery',async()=>{
    let drop=true;
    const producer=harness(coopFixture(),{afterPut:({path,value})=>{
        if(drop&&path===roomPath&&value._projectionSync){drop=false;throw new TypeError('restore ack lost');}
    }});
    const backup=await producer.store.readCompleteProgress();backup.students[0].tokens=700;
    await assert.rejects(producer.store.execute(job({type:'restore',value:backup},'pending-restore')),/restore ack lost/);
    const pending=clone(producer.root.games['classroom-115']);
    const request={...job(coopCommand(1)),createdAt:pending.restoredAt-1};let conflict=true;
    const h=harness(coopFixture(),{conflict:({path,set})=>{
        if(!conflict||path!==roomPath)return false;conflict=false;set(roomPath,pending);return true;
    }});
    await assert.rejects(h.store.execute(request),/老師已還原/);
    assert.equal(h.root.studentStates['uid-1'].tokens,700);
    assert.equal(h.root.games['classroom-115']._projectionSync,undefined);
    assert.deepEqual(h.root.games['classroom-115'].progress.coopTasks[0].completedBy,[]);
    assert.equal(h.root.games['classroom-115'].operations[request.id],undefined);
    assert.deepEqual(h.reads.filter(r=>projectionPaths.test(r.path)).map(r=>r.path),['studentPets','publicBosses','publicQuestionPapers']);
});

test('coop eligibility rejects personal/projection/other domain changes even with a false claimed result',()=>{
    const root=coopFixture(),currentProgress=root.games['classroom-115'].progress;
    const mapping=Object.fromEntries(Object.entries(root.studentRoster).map(([uid,s])=>[s.studentId,uid]));
    const beforeProgress=mergeStudentStatesIntoProgress(currentProgress,root.studentStates,mapping),command=coopCommand(1);
    const outcome=operations.applyOperation(beforeProgress,command,Date.now());
    const args={currentProgress,beforeProgress,afterProgress:outcome.progress,command,result:outcome.result,
        plan:createTeacherSyncPlan({beforeProgress,afterProgress:outcome.progress,command,result:outcome.result,uidByStudentId:mapping,clock:Date.now()}),
        scope:teacherProjectionScope({beforeProgress,afterProgress:outcome.progress,command,uidByStudentId:mapping})};
    assert.ok(createCoopSharedProgress(args));
    for(const change of [
        {command:commands.task},
        {plan:{...args.plan,studentPlans:{'uid-1':{}}}},
        {scope:{pets:['uid-1'],public:false}},
        {scope:{pets:[],public:true}},
        {scope:{pets:'all',public:false}},
        {afterProgress:{...clone(outcome.progress),globalBgImage:'other-change'}},
    ])assert.equal(createCoopSharedProgress({...args,...change}),null);
    const changed=clone(outcome.progress);changed.students[0].tokens++;
    assert.equal(createCoopSharedProgress({...args,afterProgress:changed}),null,'even an unmapped personal change must not be skipped');
});

const batchJob=(ids=[1,2],id='batch',createdAt=Date.now())=>({id,createdAt,command:{type:'coopCompleteBatch',taskId:'coop',members:ids.map((studentId,i)=>({studentId,id:i?`${id}-${i}`:id,createdAt}))}});
const totalTraffic=h=>({download:h.responses.reduce((sum,r)=>sum+r.bytes,0),upload:h.puts.reduce((sum,r)=>sum+r.bytes,0)+h.patches.reduce((sum,r)=>sum+bytes(r),0)});
test('real browser REST queue: immediate first click plus four queued members uses 8 GET + 2 PUT versus 20 GET + 5 PUT, including PUT response bytes',async t=>{
    let release,emit,id=0;const gate=new Promise(resolve=>release=resolve),h=harness(coopFixture()),executions=[];
    const sync=createCloudSync({subscribeRemote:next=>{emit=next;return ()=>{};},execute:(request,ids)=>{
        executions.push(clone(request.command));return (async()=>{if(executions.length===1)await gate;return h.store.execute(request,ids);})();
    },persistPending(){},applyState(){},lock(){},status(){},newId:()=>`click-${++id}`,now:()=>1700000000000,setInterval:()=>0,clearInterval(){}});
    h.store=createFirebaseStore({...h.dependencies,now:()=>1700000000000});
    t.after(()=>sync.dispose());sync.setConnected(true);emit(h.get(roomPath).progress);
    const first=sync.perform(coopCommand(1));assert.equal(executions.length,1);
    const rest=[2,3,4,5].map(i=>sync.perform(coopCommand(i)));release();await Promise.all([first,...rest]);
    assert.deepEqual(executions.map(c=>c.type),['coopComplete','coopCompleteBatch']);
    assert.equal(h.reads.length,8);assert.equal(h.puts.length,2);assert.equal(h.responses.length,10);assertNoProjection(h);
    const baseline=harness(coopFixture()),old=createFirebaseStore({...baseline.dependencies,now:()=>1700000000000});
    for(let i=1;i<=5;i++)await old.execute({id:`click-${i}`,createdAt:1700000000000,command:coopCommand(i)});
    assert.equal(baseline.reads.length,20);assert.equal(baseline.puts.length,5);assert.equal(baseline.responses.length,25);
    const actual=totalTraffic(h),previous=totalTraffic(baseline);
    assert.ok(actual.download<previous.download*0.45);assert.ok(actual.upload<previous.upload*0.45);
    assert.ok(actual.download<170000);assert.ok(actual.upload<55000);
    assert.deepEqual(h.get(roomPath).progress,baseline.get(roomPath).progress);
    const single=harness(coopFixture());await createFirebaseStore({...single.dependencies,now:()=>1700000000000}).execute({id:'click-1',createdAt:1700000000000,command:coopCommand(1)});
    assert.equal(h.responses.slice(0,5).reduce((n,r)=>n+r.bytes,0),totalTraffic(single).download);
    assert.equal(h.puts[0].bytes,totalTraffic(single).upload);
    t.diagnostic(JSON.stringify({batch:actual,sequential:previous,singleton:totalTraffic(single)}));
});
for(const direction of ['nonfinal-final','final-nonfinal'])test(`batch real ETag retry clears closure ${direction}`,async()=>{
    const base=Array.from({length:25},(_,i)=>i+1),final=direction==='nonfinal-final';let once=true;
    const h=harness(coopFixture(final?base:[...base,26]),{conflict:({path,value,root})=>{
        if(path!==roomPath||!once)return false;once=false;assert.equal(Boolean(value._projectionSync),!final);
        root.games['classroom-115'].progress.coopTasks[0].completedBy=final?[...base,26]:base;
        root.studentStates['uid-1'].tokens=700;return true;
    }});
    const outcome=await h.store.execute(batchJob([27,28]));
    assert.equal(outcome.result.claimed,final);assert.equal(outcome.result.members.filter(m=>m.result.claimed).length,final?1:0);
    assert.equal(h.root.studentStates['uid-1'].tokens,final?710:700);
    assert.equal(h.puts.filter(p=>p.path===roomPath).length,final?2:1);if(!final)assertNoProjection(h);
});
for(const change of ['member-removed','task-deleted','deadline','restore','expired'])test(`batch atomically rejects latest ${change} after 412`,async()=>{
    let once=true,clock=Date.now();const request=batchJob([1,2],'invalid',clock);
    const h=harness(coopFixture(),{conflict:({path,root})=>{
        if(path!==roomPath||!once)return false;once=false;const room=root.games['classroom-115'];
        if(change==='member-removed')room.progress.students=room.progress.students.filter(s=>s.id!==2);
        if(change==='task-deleted')room.progress.coopTasks=[];
        if(change==='deadline')room.progress.coopTasks[0].dueAt=clock-1;
        if(change==='restore')room.restoredAt=clock;
        if(change==='expired')clock+=86400001;
        return true;
    }});
    await assert.rejects(createFirebaseStore({...h.dependencies,now:()=>clock}).execute(request),/不存在|截止|還原|超過一天/);
    assert.equal(h.puts.length,0);assert.equal(h.get(roomPath).operations.invalid,undefined);assertNoProjection(h);
});
for(const loss of ['nonfinal','plan','personal','final'])test(`batch unknown ${loss} acknowledgement replays one receipt without duplicate rewards`,async()=>{
    let once=true;const final=loss!=='nonfinal';
    const h=harness(coopFixture(final?Array.from({length:26},(_,i)=>i+1):[]),{response:({path,options,root})=>{
        if(!once||options.method!=='PUT')return;const room=root.games['classroom-115'];
        if((loss==='nonfinal'&&path===roomPath)||(loss==='plan'&&path===roomPath&&room._projectionSync)||
            (loss==='personal'&&path==='studentStates/uid-1')||(loss==='final'&&path===roomPath&&!room._projectionSync)){
            once=false;throw new TypeError('lost batch ack');
        }
    }});
    const request=batchJob(final?[27,28]:[1,2]);await assert.rejects(h.store.execute(request),/lost batch ack/);
    if(h.get(roomPath)._projectionSync){const sync=h.get(roomPath)._projectionSync;assert.deepEqual(legacyProjectionUpdates(h.root,sync.plan,sync.uidByStudentId),{});}
    const recovered=await createFirebaseStore(h.dependencies).execute(request);assert.equal(recovered.result.members.length,2);
    for(const state of Object.values(h.root.studentStates)){assert.equal(state.tokens,final?110:100);assert.equal(state._teacherOperation,undefined);}
    const count=h.puts.length;await h.store.execute(request);assert.equal(h.puts.length,count);
    assert.equal(h.reads.filter(r=>r.path.includes('/operations/')).length,0);
});
test('two devices with overlapping final batches serialize real ETags and claim only once',async()=>{
    const h=harness(coopFixture(Array.from({length:25},(_,i)=>i+1)));
    const outcomes=await Promise.all([h.store.execute(batchJob([26,27],'device-a')),createFirebaseStore(h.dependencies).execute(batchJob([27,28],'device-b'))]);
    assert.equal(outcomes.flatMap(o=>o.result.members).filter(m=>m.result.claimed).length,1);
    assert.ok(h.putAttempts.length>h.puts.length);assert.equal(h.puts.filter(p=>p.value._projectionSync).length,1);
    for(const state of Object.values(h.root.studentStates))assert.equal(state.tokens,110);
});
test('batch zero reward still persists full old-client-compatible plan and final receipt',async()=>{
    const root=coopFixture(Array.from({length:26},(_,i)=>i+1));root.games['classroom-115'].progress.coopTasks[0].reward=0;
    const h=harness(root),outcome=await h.store.execute(batchJob([27,28]));assert.equal(outcome.result.members.filter(m=>m.result.claimed).length,1);
    assert.deepEqual(h.transactions,[roomPath,roomPath]);assert.equal(h.puts.length,2);
    const plan=h.puts[0].value._projectionSync.plan;
    for(const key of ['studentPlans','studentPets','publicBosses','publicQuestionPapers'])assert.ok(Object.hasOwn(plan,key));
});
test('batch validates original member ages and restore cutoff, but old committed receipt remains recoverable',async()=>{
    const clock=Date.now(),request=batchJob([1,2],'age',clock);request.command.members[1].createdAt=clock-86400001;request.createdAt=clock-86400001;
    const h=harness(coopFixture());await assert.rejects(h.store.execute(request),/超過一天/);assert.equal(h.puts.length,0);
    request.command.members[1].createdAt=clock-100;request.createdAt=clock-100;h.get(roomPath).restoredAt=clock-50;
    await assert.rejects(h.store.execute(request),/還原/);assert.equal(h.puts.length,0);
    delete h.get(roomPath).restoredAt;await h.store.execute(request);const count=h.puts.length;
    const result=await createFirebaseStore({...h.dependencies,now:()=>clock+172800000}).execute(request);
    assert.equal(result.result.members.length,2);assert.equal(h.puts.length,count);
});
test('old pending complete plan recovers before a new batch proceeds',async()=>{
    let once=true;const h=harness(coopFixture(),{afterPut:({path,value})=>{if(once&&path===roomPath&&value._projectionSync){once=false;throw new TypeError('lost old plan');}}});
    await assert.rejects((await preCStore(h.dependencies)).execute(job(commands.pet,'old-pet')),/lost old plan/);
    await h.store.execute(batchJob());assert.equal(h.root.studentStates['uid-1'].tokens,90);assert.equal(h.root.studentPets['uid-1'].dog.id,'dog');
    assert.deepEqual(h.get(roomPath).progress.coopTasks[0].completedBy,[1,2]);assert.equal(h.get(roomPath)._projectionSync,undefined);
    assert.ok(h.reads.some(r=>r.path==='publicQuestionPapers'));
});
for(const legacy of [false,true])test(`batch preserves latest raw ${legacy?'legacy':'compact'} non-coop fields after real 412`,async()=>{
    const root=coopFixture();let once=true,expected;
    if(legacy)for(const s of root.games['classroom-115'].progress.students)Object.assign(s,clone(root.studentStates[`uid-${s.id}`]));
    const h=harness(root,{conflict:({path,root})=>{
        if(!once||path!==roomPath)return false;once=false;const p=root.games['classroom-115'].progress;
        p.globalBgImage='new-background';p.tasks.push({id:'new-task',reward:9});p.students[0].customLegacy='preserve';
        if(legacy)p.students[0].tokens=777;root.studentStates['uid-1'].tokens=900;
        expected=clone(p);return true;
    }});
    await h.store.execute(batchJob());const saved=h.get(roomPath).progress;
    for(const key of Object.keys(expected).filter(key=>!['coopTasks','lastSaved'].includes(key)))assert.deepEqual(saved[key],expected[key]);
    assert.equal(h.root.studentStates['uid-1'].tokens,900);assertNoProjection(h);
});
test('pending restore winning ETag race recovers fully and rejects entire older batch',async()=>{
    let once=true;const producer=harness(coopFixture(),{afterPut:({path,value})=>{
        if(once&&path===roomPath&&value._projectionSync){once=false;throw new TypeError('lost restore');}
    }});
    const backup=await producer.store.readCompleteProgress();backup.students[0].tokens=700;
    await assert.rejects(producer.store.execute(job({type:'restore',value:backup},'restore-batch-race')),/lost restore/);
    const pending=clone(producer.get(roomPath)),request=batchJob([1,2],'old-batch',pending.restoredAt-1);let conflict=true;
    const h=harness(coopFixture(),{conflict:({path,set})=>{if(!conflict||path!==roomPath)return false;conflict=false;set(roomPath,pending);return true;}});
    await assert.rejects(h.store.execute(request),/還原/);assert.equal(h.root.studentStates['uid-1'].tokens,700);
    assert.equal(h.get(roomPath)._projectionSync,undefined);assert.deepEqual(h.get(roomPath).progress.coopTasks[0].completedBy,[]);
    assert.equal(h.get(roomPath).operations['old-batch'],undefined);
});
