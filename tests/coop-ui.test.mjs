import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import * as operations from '../public/game-operations.mjs';
import {createCloudSync} from '../public/cloud-sync.mjs';
import {createFirebaseStore,createTeacherProgressSubscriber} from '../public/firebase-store.mjs';
import {createFirebaseRestClient} from '../public/firebase-rest-client.mjs';
import {createStudentProjections} from '../public/student-projections.mjs';
import {mergeStudentStatesIntoProgress} from '../public/teacher-projections.mjs';

const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
const moduleSource=scripts.find(([,attrs])=>attrs.includes('module'))[2].replace(/^\s*import .*;$/gm,'');
const clone=structuredClone,roomPath='games/classroom-115',pendingKey='classroom-pending-operations';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(count=3){
    const progress=operations.normalizeProgress({
        students:Array.from({length:count},(_,i)=>i+1).map(id=>({id,gender:'M',tokens:100,lotteryTickets:2,equippedClothes:'shirt',equippedBg:'bg'})),
        clothesM:[{id:'shirt',name:'上衣',image:'/fixture/shirt.png',level:'R'}],
        clothesF:[{id:'shirt',name:'女裝',image:'/fixture/dress.png',level:'SSR'}],
        backgrounds:[{id:'bg',name:'背景',image:'/fixture/bg.png'}],
        tasks:[{id:'task',title:'個人任務',reward:5}],
        coopTasks:['a','b'].map(id=>({id,monsterName:'怪獸 '+id,monsterImage:'/fixture/'+id+'.png',content:'合作',reward:10,rewardType:'token',completedBy:[],claimed:false})),
    });
    const projections=createStudentProjections(progress,Object.fromEntries(progress.students.map(s=>[s.id,`uid-${s.id}`])));
    for(const s of progress.students)for(const key of ['tokens','lotteryTickets','petAffection','lastPetMoodDate','equippedLayout','bossProgress'])delete s[key];
    return {games:{'classroom-115':{progress,operations:{}}},...projections};
}
async function page(t,{root=fixture(),pending=[],hooks={}}={}){
    const dom=new JSDOM(html,{url:'https://classroom.test',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
    const reads=[],puts=[],subscriptions=[],executions=[],alerts=[],errors=[],timers=[],callbacks=new Map();
    let authCallback,sync,store,dependencies,id=0;
    const get=path=>path.split('/').reduce((value,key)=>value?.[key],root)??null;
    const resolve=value=>{
        if(!value||typeof value!=='object')return value;
        if(value['.sv']==='timestamp')return Date.now();
        return Array.isArray(value)?value.map(resolve):Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolve(v)]));
    };
    const set=(path,value)=>{
        const parts=path.split('/'),key=parts.pop();let parent=root;
        for(const p of parts)parent=parent[p]??={};
        if(value===null)delete parent[key];else parent[key]=resolve(clone(value));
    };
    const etag=path=>'"'+createHash('sha256').update(JSON.stringify(get(path))).digest('hex')+'"';
    const request=async(url,options={})=>{
        const parsed=new URL(url),path=decodeURIComponent(parsed.pathname.slice(1,-5));
        assert.equal(parsed.searchParams.has('print'),false);
        assert.equal(options.cache,'no-store');
        if(options.method==='PUT'){
            await hooks.beforePut?.({path,options,get,set});
            if(options.headers['if-match']!==etag(path))return Response.json(null,{status:412});
            const value=JSON.parse(options.body);puts.push({path,value:clone(value)});set(path,value);
        }else{reads.push(path);await hooks.beforeRead?.({path,options,get,set});}
        const response=Response.json(get(path),{headers:{ETag:etag(path)}});
        return await hooks.response?.({path,options,response,get,set})||response;
    };
    w.structuredClone=clone;w.alert=message=>alerts.push(message);w.confirm=()=>true;
    w.setInterval=(fn,delay)=>{timers.push(delay);return timers.length;};w.clearInterval=()=>{};
    w.fetch=()=>{throw new Error('Unexpected browser fetch');};
    vm.runInContext(scripts[0][2]+'\nwindow.uiState=()=>state;window.savedView=()=>lastSavedView;',dom.getInternalVMContext());
    w.sessionStorage.setItem(pendingKey,JSON.stringify(pending));
    Object.assign(w,{
        initializeApp:()=>({}),getAuth:()=>({currentUser:{uid:'teacher',getIdToken:async()=>'fixture-token'}}),getDatabase:()=>({}),
        onAuthStateChanged:(_,callback)=>authCallback=callback,accountForEmail:email=>email?{role:'teacher',studentId:null}:null,
        signOut:async()=>{},ref:(_,path)=>path,
        onValue:(path,callback)=>{subscriptions.push(path);callbacks.set(path,callback);return ()=>callbacks.delete(path);},
        update:async(_,updates)=>{for(const [path,value] of Object.entries(updates))set(path,value);},
        GameOperations:operations,mergeStudentStatesIntoProgress,createTeacherProgressSubscriber,
        createFirebaseRestClient:config=>createFirebaseRestClient({...config,fetch:request}),
        createFirebaseStore:config=>{dependencies={...config,fetch:request};store=createFirebaseStore(dependencies);return store;},
        createCloudSync:config=>sync=createCloudSync({...config,
            execute:(job,ids)=>{executions.push(clone(job.command));return config.execute(job,ids);},
            newId:()=>`ui-${++id}`,setInterval:(fn,delay)=>{timers.push(delay);return timers.length;},clearInterval(){},error:error=>errors.push(error)}),
    });
    vm.runInContext('{\n'+moduleSource+'\n}',dom.getInternalVMContext());
    const emit=path=>callbacks.get(path)?.({val:()=>clone(get(path))});
    const broadcast=()=>{for(const path of [...callbacks.keys()])emit(path);};
    authCallback({email:'teacher@classroom.test'});
    await tick();broadcast();await tick();
    w.openCoopTasks('a');
    t.after(()=>{sync.dispose();w.close();});
    return {w,root,get,set,reads,puts,subscriptions,executions,alerts,errors,timers,sync,store,dependencies,emit,broadcast,authCallback,
        member:id=>w.document.querySelector(`[data-coop-student="${id}"]`),
        get progress(){return root.games['classroom-115'].progress;},
        async snapshot(){broadcast();await tick();},
        async drain(){await tick();assert.equal(await sync.flush(),true);await tick();},
    };
}
function nodes(h){return [...h.w.document.querySelectorAll('.card,.coop-member,.coop-avatar,.coop-avatar .avatar,.coop-avatar .bg-layer,.coop-avatar .character,#coopMonsterVisual,#coopMonsterVisual img,.monster-list,.monster-list button')];}
function assertSameNodes(h,before){assert.deepEqual(nodes(h),before);}
function watchImages(h){
    const records=[];
    const observer=new h.w.MutationObserver(items=>records.push(...items));
    observer.observe(h.w.document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['src','style']});
    const imageIntents=()=>[...records,...observer.takeRecords()].filter(r=>r.type==='attributes'
        ? r.attributeName==='src'||(r.attributeName==='style'&&r.target.matches('.character,.bg-layer,#userBg'))
        : [...r.addedNodes].some(n=>n.nodeType===1&&(n.matches('img,.character,.bg-layer')||n.querySelector('img,.character,.bg-layer'))));
    return {imageIntents,stop:()=>observer.disconnect()};
}

test('real page + sync delayed server: synchronous pending, independent queue, exact REST and zero image intents',async t=>{
    const gate=deferred();let first=true;
    const h=await page(t,{hooks:{beforePut:async()=>{if(first){first=false;await gate.promise;}}}});
    const before=nodes(h),confirmed=clone(h.w.uiState()),saved=clone(h.w.savedView()),watch=watchImages(h);
    const subscriptions=h.subscriptions.length,timers=[...h.timers];
    const a=h.w.completeCoopMember('a',1);
    assert.match(h.member(1).textContent,/待確認/);assert.equal(h.member(1).getAttribute('aria-busy'),'true');
    assert.equal(h.member(1).disabled,true);assert.equal(h.member(2).disabled,false);
    assert.equal(h.member(1).classList.contains('done'),false);assert.equal(h.member(1).classList.contains('coop-pressed'),true);
    assert.match(h.w.document.getElementById('coopHpText').textContent,/HP 3 \/ 3/);
    assert.deepEqual(clone(h.w.uiState()),confirmed);assert.deepEqual(clone(h.w.savedView()),saved);
    await h.w.completeCoopMember('a',1);
    const b=h.w.completeCoopMember('a',2);
    assert.match(h.member(2).textContent,/待確認/);assert.equal(h.sync.pendingActions().length,2);
    assert.equal(h.executions.length,1);assertSameNodes(h,before);
    gate.resolve();await Promise.all([a,b]);await h.drain();
    assert.equal(h.executions.length,2);assert.deepEqual(h.executions.map(c=>c.studentId),[1,2]);
    assert.equal(h.puts.length,2);assert.deepEqual(h.reads,[roomPath,'studentRoster','studentStates',roomPath,roomPath,'studentRoster','studentStates',roomPath]);
    assert.match(h.member(1).textContent,/✓/);assert.match(h.member(2).textContent,/✓/);
    assert.match(h.w.document.getElementById('coopHpText').textContent,/HP 1 \/ 3/);
    assertSameNodes(h,before);assert.equal(h.subscriptions.length,subscriptions);assert.deepEqual(h.timers,timers);
    assert.deepEqual(watch.imageIntents(),[]);watch.stop();
    assert.equal(h.root.studentStates['uid-1'].tokens,100);assert.equal(h.alerts.length,0);
});

test('duplicate final handlers show reward alert once, preserve next selected tab, and reward once',async t=>{
    const root=fixture();root.games['classroom-115'].progress.coopTasks[0].completedBy=[1,2];
    const gate=deferred();let first=true;
    const h=await page(t,{root,hooks:{beforePut:async()=>{if(first){first=false;await gate.promise;}}}});
    const pending=h.w.completeCoopMember('a',3);await h.w.completeCoopMember('a',3);
    gate.resolve();await pending;await h.drain();
    assert.equal(h.alerts.length,1);assert.match(h.alerts[0],/恭喜/);
    assert.equal(h.root.studentStates['uid-1'].tokens,110);
    assert.match(h.w.document.querySelector('.monster-list .active').textContent,/b/);
    const count=h.executions.length;await h.w.completeCoopMember('a',3);assert.equal(h.executions.length,count);
    await h.snapshot();assert.equal(h.alerts.length,1);
});

for(const outcome of ['rejected','unknown','offline'])test(`pending UI handles ${outcome} without speculative completion or a new ID`,async t=>{
    const gate=deferred();let once=true;
    const h=await page(t,{hooks:{beforePut:async()=>{if(!once)return;once=false;await gate.promise;if(outcome==='rejected')throw new Error('明確拒絕');if(outcome==='unknown')throw new TypeError('unknown');}}});
    const operation=h.w.completeCoopMember('a',1),id=h.sync.pendingActions()[0].id;
    if(outcome==='offline')h.sync.setConnected(false);
    gate.resolve();await tick();
    if(outcome==='rejected'){
        await operation;assert.equal(h.member(1).disabled,false);assert.equal(h.member(1).getAttribute('aria-busy'),'false');assert.equal(h.alerts.length,1);
        assert.equal(h.sync.pendingActions().length,0);assert.equal(h.puts.length,0);
    }else if(outcome==='unknown'){
        assert.equal(h.member(1).disabled,true);assert.match(h.member(1).textContent,/待確認/);assert.equal(h.alerts.length,0);
        await h.w.completeCoopMember('a',1);assert.equal(h.sync.pendingActions()[0].id,id);
        h.w.closeModal();h.w.openCoopTasks('b');h.w.openCoopTasks('a');assert.match(h.member(1).textContent,/待確認/);
        await h.snapshot();await operation;await h.drain();assert.equal(h.puts.length,1);
        assert.equal(Object.keys(h.get(roomPath).operations)[0],id);
    }else{
        await operation;assert.equal(h.member(1).disabled,true); // offline lock even though acknowledgement settled
        h.sync.setConnected(true);await tick();await h.snapshot();assert.equal(h.member(1).disabled,true);assert.match(h.member(1).textContent,/✓/);
    }
});

test('unknown committed response uses original receipt; live completion can replace pending before retry',async t=>{
    let lose=true;
    const h=await page(t,{hooks:{response:({options})=>{if(lose&&options.method==='PUT'){lose=false;throw new TypeError('lost ack');}}}});
    const operation=h.w.completeCoopMember('a',1);await tick();
    const id=h.sync.pendingActions()[0].id;assert.match(h.member(1).textContent,/待確認/);
    h.emit(roomPath+'/progress/coopTasks');
    assert.match(h.member(1).textContent,/✓/);assert.equal(h.member(1).getAttribute('aria-busy'),'false');
    await operation;await h.drain();
    assert.equal(h.puts.length,1);assert.equal(Object.keys(h.get(roomPath).operations)[0],id);assert.equal(h.root.studentStates['uid-1'].tokens,100);
});

for(const phase of ['before-ack','after-ack'])test(`live completion ${phase} retains DOM and only one hit effect`,async t=>{
    const gate=deferred();let once=true;
    const h=await page(t,{hooks:{response:async({options})=>{if(once&&options.method==='PUT'){once=false;await gate.promise;}}}});
    const before=nodes(h),visual=h.w.document.getElementById('coopMonsterVisual');let hits=0;
    const add=visual.classList.add.bind(visual.classList);visual.classList.add=(...names)=>{if(names.includes('coop-hit'))hits++;add(...names);};
    const operation=h.w.completeCoopMember('a',1);await tick();
    if(phase==='before-ack'){await h.snapshot();assert.match(h.member(1).textContent,/✓/);assert.equal(hits,0);}
    gate.resolve();await operation;
    if(phase==='after-ack')await h.snapshot();
    await h.w.completeCoopMember('a',1);assert.equal(hits,1);assertSameNodes(h,before);assert.equal(h.puts.length,1);
});

for(const move of ['switch','close-reopen','login','remove-restore','appearance'])test(`old async response cannot animate a new UI after ${move}`,async t=>{
    const gate=deferred();let once=true;
    const h=await page(t,{hooks:{response:async({options})=>{if(once&&options.method==='PUT'){once=false;await gate.promise;}}}});
    const operation=h.w.completeCoopMember('a',1);await tick();
    if(move==='switch'){h.w.openCoopTasks('b');h.w.openCoopTasks('a');}
    if(move==='close-reopen'){h.w.closeModal();h.w.openCoopTasks('a');}
    if(move==='login'){h.w.logout();h.w.applyAuthenticatedSession({role:'teacher',studentId:null});h.w.openCoopTasks('a');}
    if(move==='remove-restore'){
        const tasks=clone(h.progress.coopTasks);h.progress.coopTasks=[];await h.snapshot();assert.equal(h.member(1),null);
        h.progress.coopTasks=tasks;await h.snapshot();
    }
    if(move==='appearance'){h.progress.clothesM[0].image='/fixture/changed.png';await h.snapshot();}
    gate.resolve();await operation;await tick();
    assert.equal(h.w.document.querySelector('.coop-hit'),null);assert.equal(h.alerts.length,0);
});

test('restored persisted jobs reconstruct pending on switch/reopen; missing receipt never enables retry button',async t=>{
    const command={type:'coopComplete',taskId:'a',studentId:1},pending=[{id:'restored',key:'coop:a:1',command,createdAt:Date.now()}];
    const h=await page(t,{pending});
    assert.match(h.member(1).textContent,/待確認/);assert.equal(h.member(2).disabled,false);
    await h.w.completeCoopMember('a',1);assert.equal(h.executions.length,0);
    h.w.openCoopTasks('b');assert.doesNotMatch(h.member(1).textContent,/待確認/);
    h.w.openCoopTasks('a');assert.match(h.member(1).textContent,/待確認/);
    h.w.closeModal();h.w.openCoopTasks('a');assert.match(h.member(1).textContent,/待確認/);
    h.w.updateCloudControls();assert.equal(h.member(1).disabled,true);
    assert.equal(h.sync.pendingActions()[0].id,'restored');
    assert.ok(h.reads.includes(roomPath+'/operations/restored'));
    h.set(roomPath+'/operations/restored',{committedAt:Date.now(),result:{json:'{"claimed":false}'}});
    await h.sync.flush();assert.equal(h.sync.pendingActions().length,0);
    assert.equal(h.member(1).getAttribute('aria-busy'),'false');assert.equal(h.member(1).disabled,false);
});

test('restored committed member is done before receipt lookup; offline/global unlock never enables done',async t=>{
    const root=fixture();root.games['classroom-115'].progress.coopTasks[0].completedBy=[1];
    const h=await page(t,{root,pending:[{id:'restored',key:'coop:a:1',command:{type:'coopComplete',taskId:'a',studentId:1},createdAt:Date.now()}]});
    assert.match(h.member(1).textContent,/✓/);assert.equal(h.member(1).getAttribute('aria-busy'),'false');
    h.sync.setConnected(false);h.w.updateCloudControls();assert.equal(h.member(1).disabled,true);
    h.sync.setConnected(true);await tick();await h.snapshot();h.w.updateCloudControls();assert.equal(h.member(1).disabled,true);
    assert.equal(h.executions.length,0);assert.equal(h.alerts.length,0);
});

test('unrelated snapshots and other task progress preserve selected header/member/avatar/monster nodes',async t=>{
    const h=await page(t);h.w.openCoopTasks('b');const before=nodes(h),watch=watchImages(h),reads=h.reads.length,subscriptions=h.subscriptions.length;
    h.progress.coopTasks[0].completedBy=[1];h.progress.lastSaved=new Date().toISOString();
    h.progress.bosses=[];h.progress.drawings=[{id:'drawing_unused',savedAt:new Date().toISOString()}];
    h.progress.coopTaskTemplates=[];await h.snapshot();
    assertSameNodes(h,before);assert.match(h.w.document.querySelector('.monster-list .active').textContent,/b/);
    assert.equal(h.reads.length,reads);assert.equal(h.subscriptions.length,subscriptions);assert.deepEqual(watch.imageIntents(),[]);watch.stop();
});

for(const change of ['gender','clothes','background','roster','monster','tabs'])test(`coop structural ${change} changes rebuild correctly without losing selection`,async t=>{
    const h=await page(t);h.w.openCoopTasks('b');const old=h.member(1);
    if(change==='gender')h.progress.students[0].gender='F';
    if(change==='clothes')h.progress.clothesM[0].image='/fixture/new-shirt.png';
    if(change==='background')h.progress.backgrounds[0].image='/fixture/new-bg.png';
    if(change==='roster')h.progress.students=h.progress.students.filter(s=>s.id!==3);
    if(change==='monster')h.progress.coopTasks[1].monsterImage='/fixture/new-monster.png';
    if(change==='tabs')h.progress.coopTasks[0].monsterName='改名';
    await h.snapshot();assert.notEqual(h.member(1),old);assert.match(h.w.document.querySelector('.monster-list .active').textContent,/b/);
    if(change==='gender')assert.match(h.member(1).querySelector('.character').style.backgroundImage,/dress/);
    if(change==='clothes')assert.match(h.member(1).querySelector('.character').style.backgroundImage,/new-shirt/);
    if(change==='background')assert.match(h.member(1).querySelector('.bg-layer').style.backgroundImage,/new-bg/);
    if(change==='roster'){assert.equal(h.member(3),null);assert.match(h.w.document.getElementById('coopHpText').textContent,/2 \/ 2/);}
    if(change==='monster')assert.match(h.w.document.querySelector('#coopMonsterVisual img').src,/new-monster/);
    if(change==='tabs')assert.match(h.w.document.querySelector('.monster-list').textContent,/改名/);
});

test('home dependencies update resources, task NEW, gender/clothes/background/global background and coop indicator',async t=>{
    const h=await page(t),member=h.member(1);
    h.root.studentStates['uid-1'].tokens=456;h.root.studentStates['uid-1'].lotteryTickets=9;
    await h.snapshot();assert.match(h.w.document.querySelector('.card .tokens').textContent,/456/);assert.match(h.w.document.querySelector('.card .lottery-ticket').textContent,/9/);
    assert.equal(h.member(1),member);
    h.progress.students[0].doneTasks=['task'];await h.snapshot();assert.equal(h.w.document.querySelector('.card').querySelector('.task-new'),null);
    h.progress.students[0].gender='F';await h.snapshot();assert.match(h.w.document.querySelector('.card .character').style.backgroundImage,/dress/);
    h.progress.clothesF[0].image='/fixture/new-dress.png';h.progress.backgrounds[0].image='/fixture/new-bg.png';h.progress.globalBgImage='/fixture/global.png';
    await h.snapshot();assert.match(h.w.document.querySelector('.card .character').style.backgroundImage,/new-dress/);
    assert.match(h.w.document.querySelector('.card .bg-layer').style.backgroundImage,/new-bg/);assert.match(h.w.document.getElementById('userBg').style.backgroundImage,/global/);
    for(const task of h.progress.coopTasks)task.claimed=true;await h.snapshot();assert.equal(h.w.document.getElementById('coopIng').hidden,true);
    assert.match(h.w.document.getElementById('body').textContent,/目前沒有/);
    h.w.applyAuthenticatedSession({role:'student',studentId:1});assert.equal(h.w.document.querySelector('.card'),null);
});

test('two devices completing final members use real ETag serialization and only one reward with live snapshots',async t=>{
    const root=fixture();root.games['classroom-115'].progress.coopTasks[0].completedBy=[1];
    const h=await page(t,{root}),other=createFirebaseStore(h.dependencies);
    const local=h.w.completeCoopMember('a',2);
    const remote=other.execute({id:'remote-final',createdAt:Date.now(),command:{type:'coopComplete',taskId:'a',studentId:3}});
    await Promise.all([local,remote]);await h.snapshot();await h.drain();
    assert.deepEqual(new Set(h.progress.coopTasks[0].completedBy),new Set([1,2,3]));
    assert.equal(h.progress.coopTasks[0].claimed,true);
    for(const s of Object.values(root.studentStates))assert.equal(s.tokens,110);
    assert.ok(h.alerts.length<=1);assert.match(h.w.document.querySelector('.monster-list .active').textContent,/b/);
});

test('restore barrier rejects queued old completion and unlocks the restored task without effects',async t=>{
    const gate=deferred();let once=true;
    const h=await page(t,{hooks:{beforeRead:async({path})=>{if(once&&path===roomPath){once=false;await gate.promise;}}}});
    const operation=h.w.completeCoopMember('a',1);
    h.set(roomPath+'/restoredAt',Date.now()+1000);h.root.studentStates['uid-1'].tokens=700;
    await h.snapshot();gate.resolve();await operation;await tick();
    assert.equal(h.puts.length,0);assert.match(h.alerts[0],/還原/);assert.equal(h.member(1).disabled,false);
    assert.equal(h.member(1).getAttribute('aria-busy'),'false');assert.equal(h.w.document.querySelector('.coop-hit'),null);
    assert.match(h.w.document.querySelector('.card .tokens').textContent,/700/);
});

test('offline direct duplicate invocation reports once, creates no job/read, and releases UI-only pending',async t=>{
    const h=await page(t);h.sync.setConnected(false);
    const reads=h.reads.length;
    await Promise.all([h.w.completeCoopMember('a',1),h.w.completeCoopMember('a',1)]);
    assert.equal(h.alerts.length,1);assert.match(h.alerts[0],/無法連線/);
    assert.equal(h.sync.pendingActions().length,0);assert.equal(h.executions.length,0);assert.equal(h.reads.length,reads);
    assert.equal(h.member(1).getAttribute('aria-busy'),'false');assert.equal(h.member(1).disabled,true);
    h.sync.setConnected(true);await tick();await h.snapshot();assert.equal(h.member(1).disabled,false);
});

test('deleted task rejects an already queued command; restoring the ID does not keep a phantom pending lock',async t=>{
    const gate=deferred();let once=true;
    const h=await page(t,{hooks:{beforeRead:async({path})=>{if(once&&path===roomPath){once=false;await gate.promise;}}}});
    const original=clone(h.progress.coopTasks[0]),operation=h.w.completeCoopMember('a',1);
    h.progress.coopTasks=h.progress.coopTasks.filter(task=>task.id!=='a');await h.snapshot();
    gate.resolve();await operation;await tick();assert.equal(h.puts.length,0);assert.equal(h.sync.pendingActions().length,0);
    assert.equal(h.alerts.length,0); // old view rejection is not shown in the replacement task
    h.progress.coopTasks.unshift(original);await h.snapshot();h.w.openCoopTasks('a');
    assert.equal(h.member(1).disabled,false);assert.equal(h.member(1).getAttribute('aria-busy'),'false');
});

test('persisted job remains pending after task deletion/restoration until explicit backend retry settles it',async t=>{
    const command={type:'coopComplete',taskId:'a',studentId:1};
    const h=await page(t,{pending:[{id:'restored-deleted',key:'coop:a:1',command,createdAt:Date.now()}]});
    const task=clone(h.progress.coopTasks[0]);h.progress.coopTasks=h.progress.coopTasks.slice(1);await h.snapshot();
    h.progress.coopTasks.unshift(task);await h.snapshot();h.w.openCoopTasks('a');
    assert.match(h.member(1).textContent,/待確認/);
    await h.sync.perform(command,'coop:a:1');await h.drain();
    assert.match(h.member(1).textContent,/✓/);assert.equal(h.puts.length,1);
    assert.ok(h.get(roomPath).operations['restored-deleted']);assert.equal(h.get(roomPath).operations['ui-1'],undefined);
    assert.equal(h.alerts.length,0);
});

test('homepage task expiry and newly added tasks recompute NEW on the next existing snapshot',async t=>{
    const h=await page(t);h.progress.tasks[0].dueAt=Date.now()-1000;await h.snapshot();
    assert.equal(h.w.document.querySelector('.task-new'),null);
    h.progress.tasks.push({id:'new-task',title:'新任務',reward:1});await h.snapshot();
    assert.ok(h.w.document.querySelector('.card .task-new'));
    assert.deepEqual(h.reads,[]);
});

test('unknown invalid-JSON committed response retains pending ID and recovers without repeat write',async t=>{
    let lose=true;
    const h=await page(t,{hooks:{response:({options})=>{
        if(lose&&options.method==='PUT'){lose=false;return new Response('{broken',{status:200});}
    }}});
    const operation=h.w.completeCoopMember('a',1);await tick();
    const id=h.sync.pendingActions()[0].id;assert.match(h.member(1).textContent,/待確認/);
    assert.equal(h.alerts.length,0);await h.snapshot();await operation;await h.drain();
    assert.equal(h.puts.length,1);assert.ok(h.get(roomPath).operations[id]);assert.match(h.member(1).textContent,/✓/);
});

test('five real page clicks retain every pending DOM node and send only singleton plus four-member batch',async t=>{
    const firstGate=deferred(),batchGate=deferred();let count=0;
    const h=await page(t,{root:fixture(6),hooks:{beforePut:async({path})=>{if(path===roomPath){count++;await (count===1?firstGate:batchGate).promise;}}}});
    const before=nodes(h),watch=watchImages(h),timers=[...h.timers],subscriptions=[...h.subscriptions];
    const first=h.w.completeCoopMember('a',1);assert.equal(h.executions.length,1);
    const rest=[2,3,4,5].map(id=>h.w.completeCoopMember('a',id));
    for(let id=1;id<=5;id++){assert.match(h.member(id).textContent,/待確認/);assert.equal(h.member(id).disabled,true);}
    assertSameNodes(h,before);firstGate.resolve();await first;await tick();
    assert.equal(h.executions.length,2);assert.equal(h.executions[1].type,'coopCompleteBatch');
    for(let id=2;id<=5;id++)assert.match(h.member(id).textContent,/待確認/);
    h.w.updateCloudControls();assertSameNodes(h,before);assert.equal(h.member(6).disabled,false);
    batchGate.resolve();await Promise.all(rest);await h.drain();
    assertSameNodes(h,before);assert.equal(h.reads.length,8);assert.equal(h.puts.length,2);assert.equal(h.alerts.length,0);
    assert.deepEqual(h.timers,timers);assert.deepEqual(h.subscriptions,subscriptions);assert.deepEqual(watch.imageIntents(),[]);watch.stop();
});
test('final batch resolves per student and displays a single reward alert',async t=>{
    const gate=deferred();let once=true;const h=await page(t,{root:fixture(5),hooks:{beforePut:async()=>{if(once){once=false;await gate.promise;}}}});
    const actions=[1,2,3,4,5].map(id=>h.w.completeCoopMember('a',id));gate.resolve();await Promise.all(actions);await h.drain();
    assert.equal(h.executions.length,2);assert.equal(h.executions[1].members.length,4);assert.equal(h.alerts.length,1);
    assert.match(h.alerts[0],/恭喜/);for(const s of Object.values(h.root.studentStates))assert.equal(s.tokens,110);
    await h.snapshot();assert.equal(h.alerts.length,1);
});
function savedBatch(){
    const createdAt=Date.now(),members=[2,3].map(studentId=>({id:`saved-${studentId}`,key:`coop:a:${studentId}`,createdAt,command:{type:'coopComplete',taskId:'a',studentId}}));
    return {id:members[0].id,key:members[0].key,createdAt,started:true,members,command:{type:'coopCompleteBatch',taskId:'a',members:members.map(m=>({id:m.id,createdAt:m.createdAt,studentId:m.command.studentId}))}};
}
test('reload frozen batch only queries transport receipt, keeps per-student pending, and recovers one alert',async t=>{
    const saved=savedBatch(),root=fixture();root.games['classroom-115'].progress.coopTasks[0].completedBy=[1];
    const h=await page(t,{root,pending:[saved]});assert.equal(h.executions.length,0);
    assert.deepEqual(h.reads,[roomPath+'/operations/saved-2']);
    for(const id of [2,3])assert.match(h.member(id).textContent,/待確認/);
    h.w.openCoopTasks('b');h.w.openCoopTasks('a');for(const id of [2,3])assert.match(h.member(id).textContent,/待確認/);
    await h.store.execute(saved);await h.sync.flush();await tick();
    assert.equal(h.alerts.length,1);assert.equal(h.sync.pendingActions().length,0);assert.equal(h.executions.length,0);
    assert.equal(h.reads.filter(path=>path.includes('/operations/')).length,2);
    await h.sync.flush();assert.equal(h.alerts.length,1);
});
for(const memberId of [2,3])test(`backend retry through frozen batch member ${memberId} retries whole batch and alerts once`,async t=>{
    const saved=savedBatch(),root=fixture();root.games['classroom-115'].progress.coopTasks[0].completedBy=[1];
    const h=await page(t,{root,pending:[saved]});h.w.eval('backendAuthenticated=true');
    await Promise.all([h.w.retryPendingAction(`saved-${memberId}`),h.w.retryPendingAction(`saved-${memberId}`)]);await h.drain();
    assert.equal(h.executions.length,1);assert.deepEqual(h.executions[0],saved.command);assert.equal(h.alerts.length,1);
    assert.equal(h.sync.pendingActions().length,0);for(const s of Object.values(h.root.studentStates))assert.equal(s.tokens,110);
});
test('live coop and backend handlers sharing a member result cannot display reward twice',async t=>{
    const gate=deferred();let once=true;const root=fixture();root.games['classroom-115'].progress.coopTasks[0].completedBy=[1,2];
    const h=await page(t,{root,hooks:{beforePut:async()=>{if(once){once=false;await gate.promise;}}}});h.w.eval('backendAuthenticated=true');
    const live=h.w.completeCoopMember('a',3),retry=h.w.retryPendingAction(h.sync.pendingActions()[0].id);
    gate.resolve();await Promise.all([live,retry]);await h.drain();assert.equal(h.alerts.length,1);
});
