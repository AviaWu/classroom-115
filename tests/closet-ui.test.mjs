import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import * as operations from '../public/game-operations.mjs';
import {createCloudSync} from '../public/cloud-sync.mjs';

const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const source=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)][0][2];
const clone=structuredClone;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){
    return operations.normalizeProgress({
        students:[1,2].map(id=>({id,gender:'M',tokens:100,ownedClothes:['a','b'],ownedBg:['sky','sea'],ownedLayout:['pet'],equippedClothes:'a',equippedBg:'sky',equippedLayout:['pet']})),
        clothesM:[{id:'a',name:'上衣',image:'/fixture/a.png',level:'R'},{id:'b',name:'外套',image:'/fixture/b.png',level:'SR'},{id:'new',name:'新衣',image:'/fixture/new.png',level:'SSR'}],
        clothesF:[{id:'a',name:'女裝',image:'/fixture/f.png',level:'R'}],
        backgrounds:[{id:'sky',name:'天空',image:'/fixture/sky.jpg',level:'R'},{id:'sea',name:'海洋',image:'/fixture/sea.jpg',level:'SR'}],
        layouts:[{id:'pet',name:'寵物',image:'/fixture/pet.png',level:'R'}],
        coopTasks:[{id:'coop',monsterName:'怪獸',content:'合作',reward:10,completedBy:[],claimed:false}],
        tasks:[{id:'task',title:'個人任務',reward:5}]
    });
}
async function page(t,{gate=null,execute=null,pending=[],lagReads=false}={}){
    const dom=new JSDOM(html,{url:'https://classroom.test',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
    let cloud=fixture(),snapshotCallback,reads=0,subscriptions=0,id=0;
    const commands=[],jobs=[],alerts=[],timers=[],listeners=[],network=[];
    w.structuredClone=clone;w.alert=message=>alerts.push(message);w.confirm=()=>true;
    w.fetch=(...args)=>{network.push(args);throw new Error('Unexpected fetch');};
    w.XMLHttpRequest.prototype.open=function(...args){network.push(args);throw new Error('Unexpected XHR');};
    w.setInterval=(fn,delay)=>{timers.push(['interval',delay]);return timers.length;};
    w.setTimeout=(fn,delay)=>{timers.push(['timeout',delay]);return timers.length;};
    const add=w.EventTarget.prototype.addEventListener;
    w.EventTarget.prototype.addEventListener=function(type,...rest){listeners.push(type);return add.call(this,type,...rest);};
    w.eval(source+'\nwindow.uiState=()=>state;window.savedView=()=>lastSavedView;');
    w.GameOperations=operations;
    const sync=createCloudSync({
        readRemote:async()=>{reads++;return clone(lagReads?fixture():cloud);},
        subscribeRemote:callback=>{subscriptions++;snapshotCallback=callback;return ()=>{};},
        execute:async job=>{
            commands.push(clone(job.command));jobs.push({id:job.id,createdAt:job.createdAt});
            if(gate)await gate.promise;
            await execute?.(job,cloud,commands.length);
            const out=operations.applyOperation(cloud,clone(job.command),Date.now());cloud=out.progress;
            // As in stage1, an equipment acknowledgement does not replace the SDK stream.
            if(job.command.type==='equip')return {equipment:{studentId:job.command.studentId},result:{ok:true}};
            return out;
        },
        loadPending:()=>clone(pending),pendingChanged:()=>w.updateClosetControls(),
        applyState:w.applyCloudState,lock:w.setSyncLocked,status:w.setSyncStatus,newId:()=>`closet-${++id}`,
        setInterval:(fn,delay)=>{timers.push(['sync',delay]);return timers.length;},clearInterval(){},error(){}
    });
    w.firebaseGameStore=sync;sync.setConnected(true);snapshotCallback(clone(cloud));
    w.applyAuthenticatedSession({role:'teacher',studentId:null});w.closet(1);await tick();
    t.after(()=>{sync.dispose();w.close();});
    return {w,sync,commands,jobs,alerts,timers,listeners,network,
        get cloud(){return cloud;},get reads(){return reads;},get subscriptions(){return subscriptions;},
        async snapshot(){snapshotCallback(clone(cloud));await tick();},
        card:id=>w.document.querySelector(`[data-closet-item="${id}"]`),
        panel:tab=>w.document.querySelector(`[data-closet-tab="${tab}"]`),
        preview:()=>w.document.getElementById('closetPreview'),
        activeTab:()=>w.document.querySelector('#modal .tabs .active')?.textContent,
    };
}
function nodes(h){return [...h.w.document.querySelectorAll('#closetTabContent,#closetTabContent *,#closetPreview,#closetPreview *,#modal .tabs,#modal .tab')];}
function watch(h){
    const records=[],observer=new h.w.MutationObserver(items=>records.push(...items));
    observer.observe(h.w.document.getElementById('body'),{subtree:true,childList:true,attributes:true,attributeFilter:['src','style']});
    return {
        take(){const all=[...records.splice(0),...observer.takeRecords()];return all.filter(r=>r.type==='attributes' || [...r.addedNodes].some(n=>n.nodeType===1&&(n.matches('img,.character,.bg-layer')||n.querySelector('img,.character,.bg-layer'))));},
        stop:()=>observer.disconnect()
    };
}
function budget(h){return {reads:h.reads,subscriptions:h.subscriptions,timers:[...h.timers],listeners:[...h.listeners],network:[...h.network],commands:clone(h.commands)};}

for(const kind of ['clothes','background'])test(`closet ${kind} snapshot keeps all nodes and changes only the corresponding preview layer`,async t=>{
    const h=await page(t);h.w.switchClosetTab(1,'bgs');h.w.switchClosetTab(1,'clothes');
    const before=nodes(h),images=watch(h),cost=budget(h),field=kind==='clothes'?'equippedClothes':'equippedBg',target=kind==='clothes'?'b':'sea';
    const panel=h.w.document.querySelector('#modal .panel');panel.scrollTop=73;h.card('a').querySelector('button').focus();
    const focus=h.w.document.activeElement;
    h.cloud.students[0][field]=target;await h.snapshot();
    assert.deepEqual(nodes(h),before);assert.equal(panel.scrollTop,73);assert.equal(h.w.document.activeElement,focus);
    assert.equal(h.card(target).querySelector('button').getAttribute('aria-pressed'),'true');
    assert.equal(h.card(target).querySelector('button').textContent,kind==='clothes'?'脫下':'移除');
    const changes=images.take();assert.equal(changes.length,1);assert.equal(changes[0].attributeName,'style');
    assert.ok(changes[0].target.matches(kind==='clothes'?'.character':'.bg-layer'));
    assert.deepEqual(budget(h),cost);assert.equal(h.activeTab(),'服裝');images.stop();
});

test('unrelated cloned snapshots and resource changes leave closet nodes and all image sources untouched',async t=>{
    const h=await page(t);h.w.switchClosetTab(1,'bgs');
    const before=nodes(h),images=watch(h),cost=budget(h);
    for(let i=0;i<3;i++){
        h.cloud.students[0].tokens++;h.cloud.students[0].lotteryTickets++;
        h.cloud.students[0].doneTasks=['task'];h.cloud.students[1].equippedClothes='b';
        h.cloud.coopTasks[0].completedBy=[2];h.cloud.lastSaved=String(i);
        h.cloud.drawings=[{id:'drawing',savedAt:String(i)}];h.cloud.globalBgImage='/fixture/global.jpg';
        await h.snapshot();
    }
    h.w.refreshVisibleView();
    assert.deepEqual(nodes(h),before);assert.deepEqual(images.take(),[]);assert.deepEqual(budget(h),cost);
    assert.equal(h.activeTab(),'背景');images.stop();
});

test('tabs mount on first visit, retain grids when toggled, and never rewrite preview sources',async t=>{
    const h=await page(t),clothes=h.panel('clothes'),preview=[...h.preview().querySelectorAll('*')],cost=budget(h);
    assert.equal(h.panel('bgs'),null);
    const images=watch(h);h.w.switchClosetTab(1,'bgs');
    const backgrounds=h.panel('bgs');assert.ok(backgrounds);assert.equal(clothes.hidden,true);
    assert.equal(images.take().length,1); // One new grid, no preview source changes.
    const before=nodes(h);
    for(let i=0;i<4;i++){h.w.switchClosetTab(1,'clothes');h.w.switchClosetTab(1,'bgs');}
    assert.deepEqual(nodes(h),before);assert.equal(h.panel('clothes'),clothes);assert.equal(h.panel('bgs'),backgrounds);
    assert.deepEqual([...h.preview().querySelectorAll('*')],preview);assert.deepEqual(images.take(),[]);
    assert.deepEqual(budget(h),cost);images.stop();
});

for(const change of ['add-owned','remove-owned','name','image','level','remove-product','reorder'])test(`visible catalogue/ownership ${change} rebuilds only that grid and preserves tab and preview`,async t=>{
    const h=await page(t);h.w.switchClosetTab(1,'bgs');const background=h.panel('bgs');h.w.switchClosetTab(1,'clothes');
    const grid=h.panel('clothes'),preview=[...h.preview().querySelectorAll('*')],cost=budget(h);
    if(change==='add-owned')h.cloud.students[0].ownedClothes.push('new');
    if(change==='remove-owned')h.cloud.students[0].ownedClothes=['a'];
    if(change==='name')h.cloud.clothesM[0].name='新名稱';
    if(change==='image')h.cloud.clothesM[0].image='/fixture/revised.png';
    if(change==='level')h.cloud.clothesM[0].level='SSR';
    if(change==='remove-product')h.cloud.clothesM=h.cloud.clothesM.filter(p=>p.id!=='b');
    if(change==='reorder')h.cloud.clothesM.reverse();
    await h.snapshot();
    assert.notEqual(h.panel('clothes'),grid);assert.equal(h.panel('bgs'),background);
    assert.deepEqual([...h.preview().querySelectorAll('*')],preview);assert.equal(h.activeTab(),'服裝');assert.deepEqual(budget(h),cost);
    if(change==='add-owned')assert.ok(h.card('new'));
    if(['remove-owned','remove-product'].includes(change))assert.equal(h.card('b'),null);
    if(change==='name')assert.equal(h.card('a').querySelector('b').textContent,'新名稱');
    if(change==='image'){assert.equal(h.card('a').querySelector('img').getAttribute('src'),'/fixture/revised.png');assert.match(h.preview().querySelector('.character').style.backgroundImage,/revised/);}
    if(change==='level')assert.ok(h.card('a').closest('.level-ssr'));
});

test('hidden grid invalidation is deferred until visited and unrelated catalogue metadata never invalidates cards',async t=>{
    const h=await page(t);h.w.switchClosetTab(1,'bgs');const backgrounds=h.panel('bgs');h.w.switchClosetTab(1,'clothes');
    const clothes=h.panel('clothes'),images=watch(h),cost=budget(h);
    h.cloud.backgrounds[1].image='/fixture/new-sea.jpg';await h.snapshot();
    assert.equal(backgrounds.isConnected,false);assert.equal(h.panel('bgs'),null);assert.equal(h.panel('clothes'),clothes);assert.deepEqual(images.take(),[]);
    h.cloud.clothesM[2].name='尚未持有';h.cloud.clothesM[0].price=999;h.cloud.clothesM[0].active=false;
    h.cloud.clothesF[0].image='/fixture/other-gender.png';h.cloud.students[0].ownedClothes.reverse();await h.snapshot();
    assert.equal(h.panel('clothes'),clothes);assert.deepEqual(images.take(),[]);
    h.w.switchClosetTab(1,'bgs');assert.equal(h.card('sea').querySelector('img').getAttribute('src'),'/fixture/new-sea.jpg');
    assert.deepEqual(budget(h),cost);images.stop();
});

test('same-image equipment and pet name changes do not reassign image sources',async t=>{
    const h=await page(t);h.cloud.clothesM[1].image=h.cloud.clothesM[0].image;await h.snapshot();
    const before=nodes(h),images=watch(h);
    h.cloud.students[0].equippedClothes='b';h.cloud.layouts[0].name='改名寵物';await h.snapshot();
    assert.deepEqual(nodes(h),before);assert.deepEqual(images.take(),[]);
    assert.equal(h.preview().querySelector('img').alt,'改名寵物');assert.equal(h.card('b').querySelector('button').textContent,'脫下');images.stop();
});

test('unequip and pet changes patch only affected preview sources while preserving every layer',async t=>{
    const h=await page(t),before=nodes(h),images=watch(h);
    h.cloud.students[0].equippedBg=null;await h.snapshot();
    assert.equal(images.take().length,1);assert.equal(h.preview().querySelector('.bg-layer').style.backgroundImage,'');
    h.cloud.students[0].equippedClothes=null;await h.snapshot();
    assert.equal(images.take().length,1);assert.match(h.preview().querySelector('.character').style.backgroundImage,/boy\/b0.png/);
    h.cloud.layouts[0].image='/fixture/new-pet.png';await h.snapshot();
    let changes=images.take();assert.equal(changes.length,1);assert.equal(changes[0].attributeName,'src');
    h.cloud.students[0].equippedLayout=[];await h.snapshot();
    changes=images.take();assert.equal(changes.length,1);assert.equal(changes[0].attributeName,'src');
    assert.notEqual(h.preview().querySelector('img').getAttribute('src'),'/fixture/new-pet.png');
    assert.deepEqual(nodes(h),before);images.stop();
});

test('gender and student switches rebuild structure, retain selected tab, and deletion closes the view',async t=>{
    const h=await page(t);h.w.switchClosetTab(1,'bgs');const old=h.preview();
    h.cloud.students[0].gender='F';await h.snapshot();
    assert.notEqual(h.preview(),old);assert.equal(h.activeTab(),'背景');assert.match(h.preview().querySelector('.character').style.backgroundImage,/f.png/);
    const second=h.preview();h.w.closet(2,'bgs');assert.notEqual(h.preview(),second);assert.equal(h.activeTab(),'背景');
    assert.match(h.w.document.querySelector('#modal h2').textContent,/2號/);
    h.cloud.students=h.cloud.students.filter(s=>s.id!==2);await h.snapshot();
    assert.equal(h.preview(),null);assert.equal(h.w.document.getElementById('modal').classList.contains('open'),false);
});

test('reordered roster resolves the selected student by ID, and close/reopen discards old grid cache',async t=>{
    const h=await page(t),before=nodes(h);
    h.cloud.students[1].equippedClothes='b';h.cloud.students.reverse();await h.snapshot();assert.deepEqual(nodes(h),before);
    const grid=h.panel('clothes');h.w.closeModal();h.w.closet(1,'bgs');assert.equal(grid.isConnected,false);assert.equal(h.panel('clothes'),null);
    assert.match(h.preview().querySelector('.character').style.backgroundImage,/a.png/);assert.equal(h.activeTab(),'背景');
});

test('grid images use existing URLs with lazy/async hints and a reserved CSS layout box',async t=>{
    const h=await page(t);h.w.switchClosetTab(1,'bgs');
    for(const image of h.w.document.querySelectorAll('#closetTabContent img')){
        assert.equal(image.getAttribute('loading'),'lazy');assert.equal(image.getAttribute('decoding'),'async');assert.ok(image.alt);
        assert.equal(image.getAttribute('srcset'),null);assert.match(image.getAttribute('src'),/^\/fixture\//);
        assert.equal(h.w.getComputedStyle(image).width,'100%');assert.equal(h.w.getComputedStyle(image).height,'100%');
        assert.equal(h.w.getComputedStyle(image.closest('.pic')).height,'155px');assert.equal(h.w.getComputedStyle(image).objectFit,'contain');
    }
    assert.equal(h.preview().querySelector('img').getAttribute('loading'),null);assert.deepEqual(h.network,[]);
});

for(const kind of ['clothes','background'])test(`ten ${kind} trials are local; explicit CLOSE sends final choice once and waits for acknowledgement`,async t=>{
    const gate=deferred(),h=await page(t,{gate});if(kind==='background')h.w.switchClosetTab(1,'bgs');
    const before=nodes(h),confirmed=clone(h.w.uiState()),saved=clone(h.w.savedView()),cost=budget(h);
    const storage=JSON.stringify({...h.w.localStorage}),session=JSON.stringify({...h.w.sessionStorage});
    const action=kind==='clothes'?h.w.equipClothes:h.w.equipBg,target=kind==='clothes'?'b':'sea',initial=kind==='clothes'?'a':'sky';
    for(let i=0;i<10;i++)action(1,i%2?target:initial);
    assert.deepEqual(budget(h),cost);assert.deepEqual(nodes(h),before);
    assert.equal(h.card(target).querySelector('button').getAttribute('aria-pressed'),'true');
    assert.deepEqual(clone(h.w.uiState()),confirmed);assert.deepEqual(clone(h.w.savedView()),saved);
    assert.equal(JSON.stringify({...h.w.localStorage}),storage);assert.equal(JSON.stringify({...h.w.sessionStorage}),session);
    assert.equal(h.w.document.querySelector('#modal .close').textContent,'關閉衣櫃');
    assert.equal(h.w.document.querySelector('#modal .close').getAttribute('onclick'),'closeVisibleModal()');
    assert.ok(![...h.w.document.querySelectorAll('#modal button')].some(b=>/Apply|套用/.test(b.textContent)));
    const saving=h.w.closeVisibleModal();await h.w.closeVisibleModal();
    assert.deepEqual(h.commands,[{type:'equip',studentId:1,kind,itemId:target}]);
    assert.deepEqual(nodes(h),before);assert.equal(h.w.document.querySelector('#modal .close').disabled,true);
    action(1,initial);assert.equal(h.card(target).querySelector('button').getAttribute('aria-pressed'),'true');
    gate.resolve();await saving;
    assert.equal(h.preview(),null);assert.deepEqual(clone(h.w.uiState()),confirmed);
    assert.equal(h.reads,0);assert.equal(h.subscriptions,1);
});

test('presentation-only override is reusable without changing confirmed state, saved state, cache or networking',async t=>{
    const h=await page(t),before=nodes(h),confirmed=clone(h.w.uiState()),saved=clone(h.w.savedView()),cost=budget(h);
    const storage=JSON.stringify({...h.w.localStorage}),session=JSON.stringify({...h.w.sessionStorage});
    h.w.refreshClosetView({equippedClothes:'b',equippedBg:null});
    assert.deepEqual(nodes(h),before);assert.match(h.preview().querySelector('.character').style.backgroundImage,/b.png/);
    assert.equal(h.preview().querySelector('.bg-layer').style.backgroundImage,'');assert.equal(h.card('b').querySelector('button').textContent,'脫下');
    assert.deepEqual(clone(h.w.uiState()),confirmed);assert.deepEqual(clone(h.w.savedView()),saved);assert.deepEqual(budget(h),cost);
    assert.equal(JSON.stringify({...h.w.localStorage}),storage);assert.equal(JSON.stringify({...h.w.sessionStorage}),session);
    h.w.refreshClosetView();assert.match(h.preview().querySelector('.character').style.backgroundImage,/a.png/);
    assert.equal(h.card('b').querySelector('button').textContent,'穿上');
});

for(const change of ['ownership','catalogue'])test(`background ${change} changes rebuild the background grid without resetting its tab`,async t=>{
    const h=await page(t),clothes=h.panel('clothes');h.w.switchClosetTab(1,'bgs');
    const background=h.panel('bgs'),preview=[...h.preview().querySelectorAll('*')],cost=budget(h);
    if(change==='ownership')h.cloud.students[0].ownedBg=['sky'];
    else h.cloud.backgrounds[1].name='改名海洋';
    await h.snapshot();
    assert.notEqual(h.panel('bgs'),background);assert.equal(h.panel('clothes'),clothes);assert.equal(h.activeTab(),'背景');
    assert.deepEqual([...h.preview().querySelectorAll('*')],preview);assert.deepEqual(budget(h),cost);
    if(change==='ownership')assert.equal(h.card('sea'),null);else assert.equal(h.card('sea').querySelector('b').textContent,'改名海洋');
});

test('offline preview remains local and enabled, close retains draft until verified reconnect',async t=>{
    const h=await page(t),card=h.card('a');h.sync.setConnected(false);
    h.w.refreshVisibleView();h.w.switchClosetTab(1,'bgs');
    for(const button of h.w.document.querySelectorAll('#closetTabContent button'))assert.equal(button.disabled,false);
    h.w.equipClothes(1,'b');h.w.equipBg(1,'sea');await h.w.closeVisibleModal();
    assert.ok(h.preview());assert.match(h.w.document.getElementById('closetStatus').textContent,/离線|離線/);
    assert.equal(h.commands.length,0);assert.equal(h.card('a'),card);
    h.sync.setConnected(true);await h.snapshot();
    assert.equal(h.card('b').querySelector('button').getAttribute('aria-pressed'),'true');
    await h.w.closeVisibleModal();assert.equal(h.commands.length,2);assert.equal(h.reads,0);
});

test('empty closet and legacy pet selector route retain existing behavior without commands',async t=>{
    const h=await page(t);h.cloud.students[0].ownedClothes=[];h.cloud.students[0].ownedBg=[];await h.snapshot();
    assert.match(h.panel('clothes').textContent,/還沒有服裝/);h.w.switchClosetTab(1,'bgs');assert.match(h.panel('bgs').textContent,/還沒有背景/);
    h.w.closet(1,'layouts');assert.equal(h.preview(),null);assert.ok(h.w.document.querySelector('.pet-selector'));assert.equal(h.w.document.querySelector('#modal .tabs'),null);
    assert.match(h.w.document.querySelector('.pet-selector').textContent,/卸下/);await h.snapshot();assert.ok(h.w.document.querySelector('.pet-selector'));
    assert.equal(h.commands.length,0);
});

for(const mode of ['unchanged','change-back','toggle-off-on'])test(`${mode} closes without any commands`,async t=>{
    const h=await page(t);
    if(mode==='change-back'){h.w.equipClothes(1,'b');h.w.equipClothes(1,'a');h.w.equipBg(1,'sea');h.w.equipBg(1,'sky');}
    if(mode==='toggle-off-on'){h.w.equipClothes(1,'a');h.w.equipClothes(1,'a');h.w.equipBg(1,'sky');h.w.equipBg(1,'sky');}
    await h.w.closeVisibleModal();assert.equal(h.commands.length,0);assert.equal(h.preview(),null);
});
for(const kind of ['clothes','background'])test(`${kind} repeated selected-item clicks toggle against draft, not cloud`,async t=>{
    const h=await page(t),action=kind==='clothes'?h.w.equipClothes:h.w.equipBg,target=kind==='clothes'?'b':'sea';
    action(1,target);action(1,target);assert.equal(h.commands.length,0);
    await h.w.closeVisibleModal();assert.deepEqual(h.commands,[{type:'equip',studentId:1,kind,itemId:null}]);
});
test('two changed fields are serial, with no pet command',async t=>{
    const gate=deferred(),h=await page(t,{gate});h.w.equipClothes(1,'b');h.w.equipBg(1,'sea');
    const saving=h.w.closeVisibleModal();assert.equal(h.commands.length,1);gate.resolve();await saving;
    assert.deepEqual(h.commands.map(c=>[c.kind,c.itemId]),[['clothes','b'],['background','sea']]);
});
test('draft survives unrelated snapshots, tab switches and targeted rebuilds; untouched remote field is never overwritten',async t=>{
    const h=await page(t);h.w.equipClothes(1,'b');const preview=h.preview();
    h.cloud.students[0].tokens++;h.cloud.students[0].equippedBg='sea';h.cloud.clothesM[1].name='改名';await h.snapshot();
    h.w.switchClosetTab(1,'bgs');h.w.switchClosetTab(1,'clothes');h.w.refreshVisibleView();
    assert.equal(h.preview(),preview);assert.equal(h.card('b').querySelector('button').getAttribute('aria-pressed'),'true');
    assert.match(preview.querySelector('.bg-layer').style.backgroundImage,/sea/);
    await h.w.closeVisibleModal();assert.deepEqual(h.commands.map(c=>c.kind),['clothes']);assert.equal(h.cloud.students[0].equippedBg,'sea');
});
test('changed-back field follows remote value and does not restore stale baseline',async t=>{
    const h=await page(t);h.w.equipClothes(1,'b');h.cloud.students[0].equippedClothes=null;await h.snapshot();
    h.w.equipClothes(1,'a');assert.match(h.preview().querySelector('.character').style.backgroundImage,/b0/);
    await h.w.closeVisibleModal();assert.equal(h.commands.length,0);
});
test('remote convergence to dirty choice makes close a no-op',async t=>{
    const h=await page(t);h.w.equipClothes(1,'b');h.cloud.students[0].equippedClothes='b';await h.snapshot();
    await h.w.closeVisibleModal();assert.equal(h.commands.length,0);
});
for(const invalid of ['ownership','catalogue','gender'])test(`${invalid} invalidation cancels affected draft only and warns`,async t=>{
    const h=await page(t);h.w.equipClothes(1,'b');h.w.equipBg(1,'sea');
    if(invalid==='ownership')h.cloud.students[0].ownedClothes=['a'];
    if(invalid==='catalogue')h.cloud.clothesM=h.cloud.clothesM.filter(p=>p.id!=='b');
    if(invalid==='gender')h.cloud.students[0].gender='F';
    await h.snapshot();assert.match(h.w.document.getElementById('closetStatus').textContent,/無效.*取消/);
    await h.w.closeVisibleModal();assert.deepEqual(h.commands.map(c=>c.kind),['background']);
});
test('background invalidation never submits removed item',async t=>{
    const h=await page(t);h.w.equipBg(1,'sea');h.cloud.students[0].ownedBg=['sky'];await h.snapshot();
    await h.w.closeVisibleModal();assert.equal(h.commands.length,0);
});
test('student removal discards with notice and reinsertion does not revive draft',async t=>{
    const h=await page(t);h.w.equipClothes(1,'b');const removed=h.cloud.students.shift();await h.snapshot();
    assert.equal(h.preview(),null);assert.match(h.alerts.at(-1),/捨棄/);h.cloud.students.unshift(removed);await h.snapshot();
    h.w.closet(1);await h.w.closeVisibleModal();assert.equal(h.commands.length,0);
});
test('partial rejection retains preview and retry never resends acknowledged clothes with lagging stream',async t=>{
    let fail=true;const h=await page(t,{lagReads:true,execute:job=>{if(job.command.kind==='background'&&fail){fail=false;throw new Error('測試拒絕');}}});
    h.w.equipClothes(1,'b');h.w.equipBg(1,'sea');await h.w.closeVisibleModal();
    await tick();assert.equal(h.w.uiState().students[0].equippedClothes,'a');
    assert.ok(h.preview());assert.match(h.w.document.getElementById('closetStatus').textContent,/未全部儲存.*測試拒絕/);
    assert.equal(h.card('b').querySelector('button').getAttribute('aria-pressed'),'true');
    await h.w.closeVisibleModal();assert.deepEqual(h.commands.map(c=>c.kind),['clothes','background','background']);assert.equal(h.preview(),null);
});
test('first-field rejection stops second submission and retains both selections',async t=>{
    let fail=true;const h=await page(t,{execute:()=>{if(fail){fail=false;throw new Error('拒絕');}}});
    h.w.equipClothes(1,'b');h.w.equipBg(1,'sea');await h.w.closeVisibleModal();assert.equal(h.commands.length,1);
    await h.w.closeVisibleModal();assert.deepEqual(h.commands.map(c=>c.kind),['clothes','clothes','background']);
});
test('unknown result blocks new choices and duplicate close; existing queue resumes same ID',async t=>{
    let fail=true;const h=await page(t,{execute:()=>{if(fail){fail=false;throw new TypeError('unknown');}}});
    h.w.equipClothes(1,'b');h.w.equipBg(1,'sea');const saving=h.w.closeVisibleModal();await tick();
    const pending=h.sync.pendingActions()[0];assert.equal(pending.id,h.jobs[0].id);
    assert.match(h.w.document.getElementById('closetStatus').textContent,/尚未確認/);
    h.w.equipClothes(1,'a');await h.w.closeVisibleModal();assert.equal(h.commands.length,1);
    assert.equal(h.card('b').querySelector('button').getAttribute('aria-pressed'),'true');
    await h.snapshot();await saving;assert.deepEqual(h.jobs.slice(0,2).map(j=>j.id),[pending.id,pending.id]);
    assert.deepEqual(h.commands.map(c=>c.kind),['clothes','clothes','background']);assert.equal(h.preview(),null);
});
test('restored pending command blocks draft, explicit confirmation reuses ID and does not close or resubmit it',async t=>{
    const job={id:'original',createdAt:Date.now(),key:'equip:1:clothes',command:{type:'equip',studentId:1,kind:'clothes',itemId:'b'}};
    const h=await page(t,{pending:[job]});h.w.equipClothes(1,'a');await h.w.closeVisibleModal();
    assert.equal(h.commands.length,0);assert.equal(h.w.document.getElementById('closetRetry').hidden,false);
    await h.w.retryClosetPending();assert.deepEqual(h.jobs.map(j=>j.id),['original']);assert.ok(h.preview());
    assert.equal(h.card('b').querySelector('button').getAttribute('aria-pressed'),'true');
    await h.w.closeVisibleModal();assert.equal(h.commands.length,1);assert.equal(h.preview(),null);
});
for(const route of ['escape','internal','replacement','student','pet'])test(`${route} prompts to discard, never implicitly applies`,async t=>{
    const h=await page(t);h.w.equipClothes(1,'b');const before=nodes(h),prompts=[];h.w.confirm=message=>{prompts.push(message);return false;};
    const leave=()=>route==='escape'?h.w.document.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'Escape'}))
        :route==='internal'?h.w.closeModal():route==='replacement'?h.w.openModal('<p>另一視窗</p>'):route==='student'?h.w.closet(2):h.w.openPetSelector(1);
    leave();assert.deepEqual(nodes(h),before);assert.equal(h.commands.length,0);assert.match(prompts[0],/捨棄.*不會套用/);
    h.w.confirm=()=>true;leave();assert.equal(h.commands.length,0);
    if(route==='student')assert.match(h.w.document.querySelector('#modal h2').textContent,/2號/);else assert.equal(h.preview(),null);
});
for(const route of ['logout','session','replacement'])test(`inflight ${route} invalidates async completion and prevents unsent second field`,async t=>{
    const gate=deferred(),h=await page(t,{gate});h.w.equipClothes(1,'b');h.w.equipBg(1,'sea');const saving=h.w.closeVisibleModal();
    if(route==='logout')h.w.logout();else if(route==='session')h.w.applyAuthenticatedSession({role:'teacher',studentId:null});else h.w.shop(2);
    if(route!=='replacement')h.w.applyAuthenticatedSession({role:'teacher',studentId:null});
    h.w.closet(2);const next=h.preview();gate.resolve();await saving;
    assert.equal(h.commands.length,1);assert.equal(h.preview(),next);assert.match(h.w.document.querySelector('#modal h2').textContent,/2號/);
});
test('gender change during first request cancels continuation and retains unaffected background for explicit next close',async t=>{
    const gate=deferred(),h=await page(t,{gate});h.w.equipClothes(1,'b');h.w.equipBg(1,'sea');const saving=h.w.closeVisibleModal();
    h.cloud.students[0].gender='F';await h.snapshot();gate.resolve();await saving;
    assert.ok(h.preview());assert.equal(h.commands.length,1);assert.match(h.w.document.getElementById('closetStatus').textContent,/取消/);
    await h.w.closeVisibleModal();assert.equal(h.commands.at(-1).kind,'background');
});
test('acknowledged choice changed away and back remains acknowledged despite lagging stream',async t=>{
    let fail=true;const h=await page(t,{lagReads:true,execute:job=>{if(job.command.kind==='background'&&fail){fail=false;throw new Error('拒絕');}}});
    h.w.equipClothes(1,'b');h.w.equipBg(1,'sea');await h.w.closeVisibleModal();await tick();
    h.w.equipClothes(1,'a');h.w.equipClothes(1,'b');
    assert.equal(h.w.uiState().students[0].equippedClothes,'a');assert.match(h.preview().querySelector('.character').style.backgroundImage,/b.png/);
    await h.w.closeVisibleModal();assert.deepEqual(h.commands.map(c=>c.kind),['clothes','background','background']);
});
test('view rebuild while saving retains guard and final draft',async t=>{
    const gate=deferred(),h=await page(t,{gate});h.w.equipClothes(1,'b');h.w.equipBg(1,'sea');
    const saving=h.w.closeVisibleModal();h.w.document.getElementById('closetTabContent').remove();h.w.refreshVisibleView();
    assert.ok(h.preview());assert.equal(h.w.document.querySelector('#modal .close').disabled,true);
    await h.w.closeVisibleModal();gate.resolve();await saving;assert.equal(h.commands.length,2);assert.equal(h.preview(),null);
});
test('replacement decline restores current view so later snapshots preserve draft',async t=>{
    const h=await page(t);h.w.equipClothes(1,'b');const before=nodes(h);h.w.confirm=()=>false;
    h.w.shop(2);h.cloud.students[0].tokens++;await h.snapshot();assert.deepEqual(nodes(h),before);
    assert.equal(h.card('b').querySelector('button').getAttribute('aria-pressed'),'true');assert.equal(h.commands.length,0);
});
test('beforeunload is scoped to dirty draft or existing queue, never submits',async t=>{
    const h=await page(t),unload=()=>{const e=new h.w.Event('beforeunload',{cancelable:true});h.w.dispatchEvent(e);return e.defaultPrevented;};
    assert.equal(unload(),false);h.w.equipClothes(1,'b');assert.equal(unload(),true);
    h.w.equipClothes(1,'a');assert.equal(unload(),false);h.w.equipClothes(1,'b');h.w.logout();assert.equal(unload(),false);
    assert.equal(h.commands.length,0);
});
