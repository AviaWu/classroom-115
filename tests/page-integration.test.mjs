import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {JSDOM} from 'jsdom';
import * as operations from '../public/game-operations.mjs';
import {createCloudSync} from '../public/cloud-sync.mjs';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
const clone=structuredClone;
const fixture=()=>operations.normalizeProgress({students:[{id:1,gender:'M',tokens:200,lotteryTickets:2},{id:2,gender:'F',tokens:100}],tasks:[{id:'task',title:'測試任務',reward:20}],clothesM:[{id:'shirt',name:'藍色上衣',level:'R',price:50,active:true,image:'/images/boy/b0.png'}],layouts:[{id:'pet',name:'測試寵物',price:50,level:'R',active:true,image:'/images/Dec2/1000095494-removebg-preview.png'}],backgrounds:[{id:'bg',name:'天空背景',price:50,level:'R',active:true,image:'/images/bgm/bg%20(1).jpg'}],coopTasks:[{id:'coop',monsterName:'合作怪獸',content:'一起完成',reward:10,rewardType:'token',completedBy:[],claimed:false}]});
function page(t){
    const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,url:'https://classroom.test'}),w=dom.window;
    let cloud=fixture(),writes=0,id=0,promptValue=null;
    const alerts=[],artworkReads=[],artworkPayloads=new Map();
    let artworkReadHook;
    w.structuredClone=clone;w.alert=m=>alerts.push(m);w.confirm=()=>true;w.prompt=()=>promptValue;
    w.HTMLCanvasElement.prototype.getContext=function(){return {fillRect(){},clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},closePath(){},drawImage(){},getImageData(){return {data:new Uint8ClampedArray(16)};},putImageData(){}};};
    w.HTMLCanvasElement.prototype.toDataURL=()=> 'data:image/jpeg;base64,test';
    w.eval(scripts[0][2]);
    w.GameOperations=operations;
    w.artworkStore={readArtwork:async id=>{artworkReads.push(id);return artworkReadHook ? artworkReadHook(id) : clone(artworkPayloads.get(id)||null);}};
    const sync=createCloudSync({readRemote:async()=>clone(cloud),execute:async job=>{
        const command=clone(job.command);
        if(command.type==='saveDrawing'){
            artworkPayloads.set(command.drawing.id,clone(command.drawing));
            const {id,savedAt}=command.drawing;command.drawing={id,savedAt};
        }
        if(command.type==='restore'){
            const source=command.value;
            source.drawings=source.drawings.map(drawing=>{
                artworkPayloads.set(drawing.id,clone(drawing));
                return {id:drawing.id,savedAt:drawing.savedAt};
            });
        }
        const out=operations.applyOperation(cloud,command,Date.now());cloud=out.progress;if(out.changed)writes++;return {...out,result:{ok:true,...out.result}};
    },applyState:w.applyCloudState,lock:w.setSyncLocked,status:w.setSyncStatus,newId:()=>`test-${++id}`,setInterval:()=>1,clearInterval(){},error(){}});
    w.firebaseGameStore=sync;
    t.after(()=>{sync.dispose();w.close();});
    const signIn=(account,password)=>{w.document.getElementById('loginAccount').value=account;w.document.getElementById('loginPassword').value=password;w.login(new w.Event('submit'));};
    return {w,sync,alerts,artworkReads,artworkPayloads,setArtworkRead:fn=>artworkReadHook=fn,setPrompt:value=>promptValue=value,get writes(){return writes;},get cloud(){return cloud;},set cloud(v){cloud=operations.normalizeProgress(v);},async start(){sync.setConnected(true);await sync.refresh();signIn('teacher','1127');},signIn,async login(){w.openBackend();w.document.getElementById("backendPw").value="5905606";await w.checkBackendPw();},async run(code){const result=w.eval(code);await result;await sync.flush();return result;}};
}
test('inline scripts and modules parse',()=>{
    for(const [,attributes,source] of scripts){
        if(attributes.includes('module')){const r=spawnSync(process.execPath,['--input-type=module','--check'],{input:source,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
        else new vm.Script(source);
    }
});
test('browser module wires child subscriptions and SDK transactions into cloud sync',()=>{
    const moduleSource=scripts.find(([_,attributes])=>attributes.includes('module'))[2];
    assert.match(moduleSource,/createProgressSubscriber\(\{database,getToken,ref,onValue\}\)/);
    assert.match(moduleSource,/subscribeRemote:subscribeProgress/);
    assert.match(moduleSource,/transactRoom:async update/);
    assert.match(moduleSource,/runTransaction\(roomRef,update,\{applyLocally:false\}\)/);
});
test('login screen accepts configured teacher and student credentials and rejects incorrect passwords',async t=>{
    const h=page(t);h.sync.setConnected(true);await h.sync.refresh();
    assert.equal(h.w.document.getElementById('loginAccount').options.length,31);
    h.signIn('student-1','0000');assert.equal(h.w.document.getElementById('loginScreen').hidden,false);assert.match(h.w.document.getElementById('loginMessage').textContent,/錯誤/);
    h.signIn('student-1','3847');assert.equal(h.w.document.getElementById('loginScreen').hidden,true);assert.equal(h.w.document.getElementById('sessionBadge').textContent,'學生 1 號');
    h.w.logout();h.signIn('teacher','5905606');assert.equal(h.w.document.getElementById('loginScreen').hidden,false);
    const loginPassword=h.w.document.getElementById('loginPassword');loginPassword.value='1127';
    loginPassword.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    assert.equal(h.w.document.getElementById('sessionBadge').textContent,'老師');assert.equal(h.w.document.getElementById('backendButton').hidden,false);
});
test('student can use own features and drawing but is blocked from every other student',async t=>{
    const h=page(t);await h.start();h.w.logout();h.signIn('student-1','3847');
    for(const action of ['tasks(1)','shop(1)','closet(1)','openPetMood(1)','openDrawingBoard()','openCoopTasks()']) await h.run(action);
    assert.ok(h.w.document.getElementById('modal').classList.contains('open'));
    for(const action of ['tasks(2)','shop(2)','closet(2)','openPetMood(2)',"completeCoopMember('coop',2)"]) await h.run(action);
    assert.equal(h.alerts.filter(message=>message==='點錯啦!這不是你的人物喔!').length,5);assert.equal(h.writes,0);
    h.w.openBackend();assert.equal(h.w.document.getElementById('backendPw'),null);
});
test('teacher has all student access but must enter the password again for backend',async t=>{
    const h=page(t);await h.start();await h.run('tasks(2)');assert.deepEqual(h.alerts,[]);
    h.w.openBackend();assert.ok(h.w.document.getElementById('backendPw'));assert.match(h.w.document.getElementById('body').textContent,/登入後台/);
    h.w.document.getElementById('backendPw').value='0000';await h.w.checkBackendPw();assert.equal(h.w.document.getElementById('modal').classList.contains('open'),false);assert.ok(h.alerts.includes('密碼錯誤！'));
    h.w.openBackend();const backendPassword=h.w.document.getElementById('backendPw');backendPassword.value='5905606';
    backendPassword.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    await new Promise(resolve=>setTimeout(resolve,0));assert.match(h.w.document.getElementById('body').textContent,/老師後台/);
});
test('event gifts remain free and omit the level wording in shop and closet',async t=>{
    const h=page(t);h.cloud={...h.cloud,clothesM:[...h.cloud.clothesM,{id:'event',name:'活動服裝',level:'活動贈送',price:0,active:true,image:'/images/boy/ba1.png'}]};
    await h.start();await h.run('shop(1)');
    const shop=h.w.document.getElementById('shopTabContent').textContent;
    assert.match(shop,/活動贈送/);assert.doesNotMatch(shop,/活動贈送\s*等級/);assert.match(shop,/R\s*等級/);
    const eventSection=h.w.document.querySelector('.shop-level.level-gift');
    assert.ok(eventSection);assert.match(h.w.document.querySelector('style').textContent,/\.shop-level \.product\{border:3px solid var\(--level-color\)\}/);
    assert.equal(h.w.getComputedStyle(eventSection.querySelector('.level-badge')).boxShadow,'none');
    await h.run("buyCloth(1,'event')");assert.equal(h.cloud.students[0].tokens,200);
    await h.run('closet(1)');const closet=h.w.document.getElementById('closetTabContent').textContent;
    assert.match(closet,/活動贈送/);assert.doesNotMatch(closet,/活動贈送\s*等級/);
    await h.run("equipClothes(1,'event')");h.w.closeModal();
    const memberCard=h.w.document.querySelector('.card');
    assert.equal(memberCard.dataset.clothingLevel,'活動贈送');
    assert.equal(memberCard.style.getPropertyValue('--member-level-color'),'#d05c78');
});
test('member card border follows every equipped clothing level',async t=>{
    const h=page(t);h.cloud={...h.cloud,clothesM:['R','SR','SSR','UR'].map(level=>({id:`cloth-${level}`,name:level,level,price:0,active:true,image:`/${level}.png`})),students:[{...h.cloud.students[0],ownedClothes:['cloth-R','cloth-SR','cloth-SSR','cloth-UR']},h.cloud.students[1]]};
    await h.start();
    for(const [level,color] of Object.entries({R:'#687386',SR:'#27868c',SSR:'#8960b5',UR:'#c18418'})){
        await h.run(`equipClothes(1,'cloth-${level}')`);
        const card=h.w.document.querySelector('.card');
        assert.equal(card.dataset.clothingLevel,level);assert.equal(card.style.getPropertyValue('--member-level-color'),color);
    }
});
test('teacher edits daily and weekly task templates through conflict-safe commands',async t=>{
    const h=page(t);h.cloud={...h.cloud,
        dailyTaskTemplates:[{id:'daily',title:'每日舊名稱',reward:10,appearTime:'08:00',dueTime:'23:59',enabled:true}],
        weeklyTaskTemplates:[{id:'weekly',title:'每週舊名稱',reward:20,appearWeekday:1,appearTime:'08:00',dueWeekday:5,dueTime:'23:59',enabled:true}]};
    await h.start();await h.login();
    assert.ok(h.w.document.querySelector('[data-field="dailyTaskTemplates:daily:title"]'));
    assert.ok(h.w.document.querySelector('[data-field="weeklyTaskTemplates:weekly:appearWeekday"]'));
    await h.run("updateTaskTemplate('dailyTaskTemplates','daily','title','每日新名稱')");
    await h.run("updateTaskTemplate('weeklyTaskTemplates','weekly','reward','42')");
    await h.run("updateTaskTemplate('weeklyTaskTemplates','weekly','dueWeekday','6')");
    assert.equal(h.cloud.dailyTaskTemplates[0].title,'每日新名稱');
    assert.equal(h.cloud.weeklyTaskTemplates[0].reward,42);assert.equal(h.cloud.weeklyTaskTemplates[0].dueWeekday,6);
});
test('teacher edits daily and weekly coop templates through conflict-safe commands',async t=>{
    const h=page(t);h.cloud={...h.cloud,coopTaskTemplates:[
        {id:'coop-daily',monsterName:'每日怪獸',content:'每日內容',reward:5,rewardType:'token',scheduleType:'daily',appearTime:'08:00',dueTime:'23:59',enabled:true},
        {id:'coop-weekly',monsterName:'每週怪獸',content:'每週內容',reward:1,rewardType:'ticket',scheduleType:'weekly',appearWeekday:1,appearTime:'08:00',dueWeekday:5,dueTime:'23:59',enabled:true}
    ]};
    await h.start();await h.login();
    assert.ok(h.w.document.querySelector('[data-field="coopTaskTemplates:coop-daily:content"]'));
    assert.ok(h.w.document.querySelector('[data-field="coopTaskTemplates:coop-weekly:appearWeekday"]'));
    await h.run("updateCoopTaskTemplate('coop-daily','content','更新每日內容')");
    await h.run("updateCoopTaskTemplate('coop-weekly','dueTime','21:30')");
    await h.run("updateCoopTaskTemplate('coop-weekly','reward','3')");
    assert.equal(h.cloud.coopTaskTemplates.find(item=>item.id==='coop-daily').content,'更新每日內容');
    const weekly=h.cloud.coopTaskTemplates.find(item=>item.id==='coop-weekly');assert.equal(weekly.dueTime,'21:30');assert.equal(weekly.reward,3);
});
test('startup and opening all student views never writes; task button commits live reward',async t=>{
    const h=page(t);await h.start();
    for(const action of ['tasks(1)','shop(1)','closet(1)','openPetMood(1)','openCoopTasks()']) await h.run(action);
    assert.equal(h.writes,0);await h.run("finishTask(1,'task')");
    assert.equal(h.cloud.students[0].tokens,220);assert.deepEqual(h.cloud.students[0].doneTasks,['task']);
});
test('NEW disappears when every unfinished task has expired',async t=>{
    const h=page(t);h.cloud={...h.cloud,tasks:[{id:'expired',title:'過期任務',reward:20,dueAt:Date.now()-1000}]};
    await h.start();
    assert.equal(h.w.document.querySelector('.task-new'),null);
    await h.run('tasks(1)');
    assert.match(h.w.document.getElementById('modal').textContent,/全部任務已完成/);
});
test('purchase, wardrobe and pet controls commit immediately without processing UI',async t=>{
    const h=page(t);await h.start();await h.run('shop(1)');await h.run("buyCloth(1,'shirt')");
    await h.run("buyLayout(1,'pet')");await h.run("buyBg(1,'bg')");await h.run('closet(1)');
    await h.run("equipClothes(1,'shirt')");await h.run("toggleEquipLayout(1,'pet')");await h.run("equipBg(1,'bg')");
    assert.equal(h.cloud.students[0].tokens,50);assert.equal(h.cloud.students[0].equippedClothes,'shirt');
    assert.deepEqual(h.cloud.students[0].equippedLayout,['pet']);assert.equal(h.cloud.students[0].equippedBg,'bg');
    await h.run('equipDefaultPet(1)');assert.deepEqual(h.cloud.students[0].equippedLayout,[]);
    assert.equal(h.w.document.getElementById('saveStatus').textContent,'');assert.deepEqual(h.alerts,[]);
});
test('cloud polling preserves current shop tab and scroll position',async t=>{
    const h=page(t);await h.start();await h.run("shop(1);switchShopTab(1,'lottery')");
    const panel=h.w.document.querySelector('#modal .panel');panel.scrollTop=90;
    h.cloud={...h.cloud,students:h.cloud.students.map(s=>({...s,lotteryTickets:7}))};await h.sync.refresh();
    assert.match(h.w.document.querySelector('.lottery-page h3').textContent,/7/);assert.equal(panel.scrollTop,90);
    assert.ok(h.w.document.getElementById('modal').classList.contains('open'));
});
test('polling keeps teacher draft DOM, value, focus and selected backend page',async t=>{
    const h=page(t);await h.start();await h.login();await h.run("activateBackendPage('backend-tasks')");
    const input=h.w.document.getElementById('newTaskTitle');input.value='尚未送出的任務';input.focus();
    h.cloud={...h.cloud,tasks:[...h.cloud.tasks,{id:'remote',title:'另一台新增',reward:30}]};await h.sync.refresh();
    assert.equal(h.w.document.getElementById('newTaskTitle'),input);assert.equal(input.value,'尚未送出的任務');
    assert.equal(h.w.document.activeElement,input);assert.ok(h.w.document.getElementById('backend-tasks').classList.contains('active'));
    assert.match(h.w.document.getElementById('backend-tasks').textContent,/另一台新增/);
});
test('polling never replaces the canvas or its drawing tools',async t=>{
    const h=page(t);await h.start();await h.run('openDrawingBoard()');const canvas=h.w.document.getElementById('drawingCanvas');
    h.cloud.students[0].tokens=70;await h.sync.refresh();assert.equal(h.w.document.getElementById('drawingCanvas'),canvas);
    await h.run('saveDrawingBoard()');assert.equal(h.cloud.drawings.length,1);assert.match(h.w.document.getElementById('drawingStatus').textContent,/已儲存/);
});
test('teacher name draft reports same-field conflict without overwriting newer cloud',async t=>{
    const h=page(t);await h.start();await h.login();await h.run("activateBackendPage('backend-clothes-m')");
    const input=h.w.document.querySelector('[data-field="clothesM:shirt:name"]');input.focus();input.value='本機草稿';input.dispatchEvent(new h.w.Event('input',{bubbles:true}));
    h.cloud.clothesM[0].name='其他老師修改';await h.sync.refresh();
    await h.run("updateItemName('clothesM','shirt','本機草稿')");
    assert.equal(h.cloud.clothesM[0].name,'其他老師修改');assert.ok(h.alerts.some(x=>/衝突|修改/.test(x)));
    assert.equal(h.w.document.querySelector('[data-field="clothesM:shirt:name"]').value,'本機草稿');
});
test('teacher additions, deltas and deletes persist without a five-second debounce',async t=>{
    const h=page(t);await h.start();await h.login();
    h.w.document.getElementById('newTaskTitle').value='新增任務';h.w.document.getElementById('newTaskReward').value='12';await h.run('addTask()');
    assert.ok(h.cloud.tasks.some(x=>x.title==='新增任務'));
    h.w.document.getElementById('targetStuId').value='1';h.w.document.getElementById('deltaToken').value='7';await h.run('addTokenOne()');
    assert.equal(h.cloud.students[0].tokens,207);await h.run("deleteTask('task')");assert.ok(!h.cloud.tasks.some(x=>x.id==='task'));
});
test('offline permits viewing but blocks cloud mutations',async t=>{
    const h=page(t);await h.start();h.sync.setConnected(false);await h.w.tasks(1);await h.w.finishTask(1,'task');
    assert.equal(h.writes,0);assert.equal(h.w.document.getElementById('saveStatus').textContent,'離線中');
});
test('backup is absent from header and export reads the server instead of local UI',async t=>{
    const h=page(t);await h.start();assert.doesNotMatch(h.w.document.querySelector('header').textContent,/備份/);
    await h.login();let read=0,downloaded;
    h.w.readLatestProgress=async()=>{read++;return {...h.cloud,globalBgImage:'new-server-background'};};
    h.w.URL.createObjectURL=blob=>{downloaded=blob;return 'blob:test';};h.w.URL.revokeObjectURL=()=>{};h.w.HTMLAnchorElement.prototype.click=()=>{};
    await h.w.exportData();assert.equal(read,1);assert.ok(downloaded.size>0);assert.equal(h.writes,0);
});
test('a deleted catalogue record does not discard an unsaved teacher input',async t=>{
    const h=page(t);await h.start();await h.login();await h.run("activateBackendPage('backend-clothes-m')");
    const input=h.w.document.querySelector('[data-field="clothesM:shirt:name"]');input.focus();input.value='保留草稿';input.dispatchEvent(new h.w.Event('input',{bubbles:true}));
    h.cloud.clothesM=[];await h.sync.refresh();
    assert.equal(h.w.document.querySelector('[data-field="clothesM:shirt:name"]')?.value,'保留草稿');
    assert.match(h.w.document.querySelector('#backend-clothes-m').textContent,/刪除/);
});
test('untouched teacher field focus does not cause a false conflict after a remote update',async t=>{
    const h=page(t);await h.start();await h.login();
    const input=h.w.document.querySelector('[data-field="clothesM:shirt:name"]');input.focus();input.blur();
    h.cloud.clothesM[0].name='新名稱';await h.sync.refresh();
    const fresh=h.w.document.querySelector('[data-field="clothesM:shirt:name"]');fresh.focus();fresh.value='再修改';fresh.dispatchEvent(new h.w.Event('input',{bubbles:true}));
    await h.run("updateItemName('clothesM','shirt','再修改')");assert.equal(h.cloud.clothesM[0].name,'再修改');
});
test('preserved coop schedule selector keeps its corresponding form visible after polling',async t=>{
    const h=page(t);await h.start();await h.login();
    h.w.document.getElementById('coopScheduleType').value='daily';h.w.updateCoopScheduleFields();
    h.cloud.students[0].tokens=300;await h.sync.refresh();
    assert.equal(h.w.document.getElementById('coopDailySchedule').style.display,'block');assert.equal(h.w.document.getElementById('coopOnceSchedule').style.display,'none');
});
test('single-image uploads finishing after disconnect do not mutate the catalogue',async t=>{
    const h=page(t);await h.start();await h.login();
    h.w.document.getElementById('mName').value='未上傳圖片';
    Object.defineProperty(h.w.document.getElementById('mImg'),'files',{value:[{}]});
    let resolve;h.w.compressImage=()=>new Promise(r=>resolve=r);
    const upload=h.w.addClothM();h.sync.setConnected(false);resolve('data:image/png;base64,test');await upload;
    assert.equal(h.cloud.clothesM.length,1);assert.doesNotMatch(h.w.document.getElementById('body').textContent,/未上傳圖片/);
    assert.equal(h.writes,0);
});

const drawingMeta = number=>({id:`drawing_${number}`,savedAt:`2026-09-16T00:00:0${number}.000Z`});
const settleArtwork = () => new Promise(resolve=>setImmediate(resolve));
function addArtworkFixture(h,numbers=[3,2,1]) {
    for(const number of numbers){const metadata=drawingMeta(number);h.artworkPayloads.set(metadata.id,{...metadata,data:`data:image/png;base64,image${number}`});}
    h.cloud={...h.cloud,drawings:numbers.map(drawingMeta)};
}
test('closed drawing UI never downloads artworks and opening reads only the latest three IDs once',async t=>{
    const h=page(t);addArtworkFixture(h);await h.start();await h.sync.refresh();await settleArtwork();
    assert.deepEqual(h.artworkReads,[]);
    await h.run('openDrawingBoard()');await settleArtwork();
    assert.deepEqual(h.artworkReads,['drawing_3','drawing_2','drawing_1']);
    assert.equal(h.w.document.querySelectorAll('#drawingHistory img').length,3);
    await h.sync.refresh();await settleArtwork();
    h.w.closeModal();await h.run('openDrawingBoard()');await settleArtwork();
    assert.deepEqual(h.artworkReads,['drawing_3','drawing_2','drawing_1']);
    assert.equal(h.writes,0);
});
test('open drawing polling loads only new IDs and preserves the exact canvas and tools',async t=>{
    const h=page(t);addArtworkFixture(h);await h.start();await h.run('openDrawingBoard()');await settleArtwork();
    const canvas=h.w.document.getElementById('drawingCanvas'),eraser=h.w.document.getElementById('drawingEraser');h.w.toggleDrawingEraser();
    addArtworkFixture(h,[4,3,2]);await h.sync.refresh();await settleArtwork();
    assert.deepEqual(h.artworkReads,['drawing_3','drawing_2','drawing_1','drawing_4']);
    assert.equal(h.w.document.getElementById('drawingCanvas'),canvas);assert.equal(h.w.document.getElementById('drawingEraser'),eraser);assert.equal(eraser.classList.contains('active'),true);
    assert.deepEqual([...h.w.document.querySelectorAll('#drawingHistory img')].map(img=>img.getAttribute('src')),['data:image/png;base64,image4','data:image/png;base64,image3','data:image/png;base64,image2']);
    h.w.closeModal();addArtworkFixture(h,[5,4,3]);await h.sync.refresh();await settleArtwork();
    assert.equal(h.artworkReads.includes('drawing_5'),false);
});
test('in-flight drawing reads are shared and finishing after close does not recreate the modal',async t=>{
    const h=page(t);addArtworkFixture(h,[1]);let finish;
    h.setArtworkRead(()=>new Promise(resolve=>finish=resolve));await h.start();
    const opening=h.w.openDrawingBoard();await settleArtwork();
    assert.deepEqual(h.artworkReads,['drawing_1']);
    assert.equal(h.w.document.querySelector('#drawingHistory img'),null);
    assert.doesNotMatch(h.w.document.getElementById('drawingHistory').innerHTML,/src="undefined"/);
    h.cloud={...h.cloud,globalBgImage:'different'};await h.sync.refresh();await settleArtwork();assert.equal(h.artworkReads.length,1);
    h.w.closeModal();finish(h.artworkPayloads.get('drawing_1'));await opening;await settleArtwork();
    assert.equal(h.w.document.getElementById('modal').classList.contains('open'),false);
    assert.equal(h.w.document.getElementById('drawingHistory'),null);
});
test('a failed image does not block other thumbnails and retries on an unchanged progress snapshot',async t=>{
    const h=page(t);addArtworkFixture(h,[2,1]);let fail=true;
    h.setArtworkRead(id=>{if(id==='drawing_1'&&fail){fail=false;throw new TypeError('image unavailable');}return h.artworkPayloads.get(id);});
    await h.start();await h.w.openDrawingBoard();await settleArtwork();
    assert.equal(h.w.document.querySelectorAll('#drawingHistory img').length,1);
    assert.match(h.w.document.getElementById('drawingHistory').textContent,/失敗|無法載入/);
    assert.equal(h.sync.canEdit(),true);
    await h.sync.refresh();await settleArtwork();
    assert.deepEqual(h.artworkReads,['drawing_2','drawing_1','drawing_1']);
    assert.equal(h.w.document.querySelectorAll('#drawingHistory img').length,2);
});
test('closing a board before its queued loader starts sends no artwork request',async t=>{
    const h=page(t);addArtworkFixture(h,[1]);await h.start();
    const opening=h.w.openDrawingBoard();h.w.closeModal();await opening;await settleArtwork();
    assert.deepEqual(h.artworkReads,[]);
});

function deferDrawingDecodes(h){
    const images=[],painted=[];
    h.w.Image=class {constructor(){images.push(this);}};
    const getContext=h.w.HTMLCanvasElement.prototype.getContext;
    h.w.HTMLCanvasElement.prototype.getContext=function(...args){
        const context=getContext.apply(this,args);
        context.drawImage=image=>painted.push(image.src);
        return context;
    };
    return {images,painted};
}
function drawingPointer(h,type){
    const canvas=h.w.document.getElementById('drawingCanvas');
    canvas.setPointerCapture=()=>{};
    canvas.getBoundingClientRect=()=>({left:0,top:0,width:800,height:600});
    canvas.dispatchEvent(new h.w.MouseEvent(type,{clientX:1,clientY:1,bubbles:true,cancelable:true}));
}
for(const order of [[0,1],[1,0]]) test(`only the latest selected drawing paints when decodes complete in order ${order.join(',')}`,async t=>{
    const h=page(t),decoder=deferDrawingDecodes(h);addArtworkFixture(h,[2,1]);await h.start();await h.w.openDrawingBoard();
    h.w.loadDrawing('drawing_1');h.w.loadDrawing('drawing_2');
    decoder.images[order[0]].onload();
    assert.deepEqual(decoder.painted,order[0]===0 ? [] : ['data:image/png;base64,image2']);
    decoder.images[order[1]].onload();
    assert.deepEqual(decoder.painted,['data:image/png;base64,image2']);
    assert.match(h.w.document.getElementById('drawingUndo').textContent,/1\/5/);
});
for(const action of [
    {name:'pointerdown',edit:h=>drawingPointer(h,'pointerdown')},
    {name:'continuing a stroke',prepare:h=>drawingPointer(h,'pointerdown'),edit:h=>drawingPointer(h,'pointermove')},
    {name:'clearing the board',edit:h=>h.w.clearDrawingBoard()},
    {name:'undoing a change',prepare:h=>h.w.clearDrawingBoard(),edit:h=>h.w.undoDrawing()},
    {name:'filling an area',edit:h=>h.w.floodFillDrawing(0,0)}
]) test(`a pending drawing decode cannot overwrite ${action.name}`,async t=>{
    const h=page(t),decoder=deferDrawingDecodes(h);addArtworkFixture(h,[1]);await h.start();await h.w.openDrawingBoard();
    action.prepare?.(h);h.w.loadDrawing('drawing_1');action.edit(h);
    const status=h.w.document.getElementById('drawingStatus').textContent,undo=h.w.document.getElementById('drawingUndo').textContent;
    decoder.images[0].onload();
    assert.deepEqual(decoder.painted,[]);
    assert.equal(h.w.document.getElementById('drawingStatus').textContent,status);
    assert.equal(h.w.document.getElementById('drawingUndo').textContent,undo);
    h.w.loadDrawing('drawing_1');decoder.images[1].onload();
    assert.deepEqual(decoder.painted,['data:image/png;base64,image1']);
});
test('an image decoded after the drawing board reopens cannot paint the replacement canvas',async t=>{
    const h=page(t),decoder=deferDrawingDecodes(h);addArtworkFixture(h,[1]);await h.start();await h.w.openDrawingBoard();
    h.w.loadDrawing('drawing_1');h.w.closeModal();await h.w.openDrawingBoard();
    decoder.images[0].onload();assert.deepEqual(decoder.painted,[]);
    h.w.loadDrawing('drawing_1');decoder.images[1].onload();
    assert.deepEqual(decoder.painted,['data:image/png;base64,image1']);
});

const completeDrawing = number=>({...drawingMeta(number),data:`data:image/png;base64,image${number}`});
function captureBackupDownloads(h){
    const blobs=[];
    h.w.URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:test';};
    h.w.URL.revokeObjectURL=()=>{};h.w.HTMLAnchorElement.prototype.click=()=>{};
    return {blobs,async read(){
        const text=await new Promise((resolve,reject)=>{
            const reader=new h.w.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsText(blobs.at(-1));
        });
        return JSON.parse(text);
    }};
}
const backupInput = value=>({files:[{text:async()=>JSON.stringify(value)}],value:'backup.json'});
test('new progress and teacher backend contain no album or legacy cleanup action',async t=>{
    const h=page(t);await h.start();await h.login();
    assert.equal('drawingAlbum' in h.w.initialProgress(),false);
    assert.equal(h.w.document.getElementById('backend-album'),null);
    assert.doesNotMatch(h.w.document.getElementById('body').textContent,/畫冊/);
    assert.equal(h.w.document.getElementById('clearLegacyArtworks'),null);
    assert.equal(typeof h.w.clearLegacyArtworks,'undefined');
    assert.equal(h.writes,0);assert.deepEqual(h.artworkReads,[]);
});
test('backup downloads hydrate only the newest three server drawing indexes',async t=>{
    const h=page(t);addArtworkFixture(h,[1,2,3,4]);await h.start();await h.login();const download=captureBackupDownloads(h);
    h.w.readLatestProgress=async()=>({...h.cloud,drawings:[1,4,2,3].map(drawingMeta),pendingArtworkDeletes:['drawing_orphan'],globalBgImage:'server-backup'});
    await h.w.exportData();const backup=await download.read();
    assert.deepEqual(h.artworkReads,['drawing_4','drawing_3','drawing_2']);
    assert.deepEqual(backup.drawings,[4,3,2].map(completeDrawing));
    assert.equal(backup.globalBgImage,'server-backup');assert.equal('drawingAlbum' in backup,false);assert.equal('pendingArtworkDeletes' in backup,false);assert.equal(h.writes,0);
});
test('backup download fails instead of producing an incomplete drawing when an artwork is missing',async t=>{
    const h=page(t);h.cloud={...h.cloud,drawings:[drawingMeta(1)]};await h.start();await h.login();const download=captureBackupDownloads(h);
    h.w.readLatestProgress=async()=>clone(h.cloud);await h.w.exportData();
    assert.equal(download.blobs.length,0);assert.ok(h.alerts.some(message=>/備份下載失敗/.test(message)));assert.equal(h.writes,0);
});
test('restore imports only three complete drawings and assigns fresh IDs every time',async t=>{
    const h=page(t);await h.start();await h.login();
    const backup={...h.cloud,students:[{...h.cloud.students[0],tokens:777}],drawings:[2,5,1,4,3].map(completeDrawing),pendingArtworkDeletes:['drawing_injected']};
    backup.drawings.push(drawingMeta(8),{...completeDrawing(7),data:'data:image/svg+xml;base64,AA=='},
        {...completeDrawing(6),data:'data:image/png;base64,'},
        {...completeDrawing(6),data:'data:image/png;base64,'+'A'.repeat(1500000)},
        {...completeDrawing(6),savedAt:'2026-09-31T00:00:00.000Z'});
    const before=clone(backup),input=backupInput(backup);await h.w.importData(input);
    assert.deepEqual(h.cloud.drawings.map(item=>item.savedAt),[5,4,3].map(number=>drawingMeta(number).savedAt));
    const firstIds=h.cloud.drawings.map(item=>item.id),oldIds=new Set(backup.drawings.map(item=>item.id));
    assert.equal(new Set(firstIds).size,3);assert.ok(firstIds.every(id=>/^drawing_[0-9a-f-]{36}$/.test(id) && !oldIds.has(id)));
    assert.deepEqual(firstIds.map(id=>h.artworkPayloads.get(id).data),[5,4,3].map(number=>completeDrawing(number).data));
    assert.ok(h.cloud.drawings.every(item=>!('data' in item)));assert.ok(!h.cloud.pendingArtworkDeletes.includes('drawing_injected'));
    assert.equal(h.cloud.students[0].tokens,777);assert.equal(input.value,'');assert.deepEqual(h.artworkReads,[]);assert.deepEqual(backup,before);
    await h.w.importData(backupInput(backup));assert.ok(h.cloud.drawings.every(item=>!firstIds.includes(item.id)));
});
test('restore skips drawing metadata without image data',async t=>{
    const h=page(t);await h.start();await h.login();
    await h.w.importData(backupInput({...h.cloud,drawings:[drawingMeta(2)]}));
    assert.deepEqual(h.cloud.drawings,[]);assert.equal(h.artworkPayloads.size,0);assert.deepEqual(h.artworkReads,[]);
});
test('pet view shows multiple bosses with independent HP and asks password only once',async t=>{
    const h=page(t);await h.start();await h.run('openPetMood(1)');assert.match(h.w.document.getElementById('modal').textContent,/目前世界一片和平/);
    const boss={id:'dragon',name:'巨龍',image:'/images/boss/boss%20(1).png',maxHp:8,attackPassword:'1234',reward:30,active:true,questions:[{id:'q1',text:'1 加 1 是多少？',options:['1','2','3','4'],answerIndex:1},{id:'q2',text:'天空是藍色',options:['是','否'],answerIndex:0}]};
    h.cloud={...h.cloud,bosses:[boss,{...boss,id:'dragon2',name:'第二隻龍'}],students:[{...h.cloud.students[0],equippedLayout:['pet'],petAffection:20},h.cloud.students[1]]};await h.sync.refresh();await h.run('openPetMood(1)');
    assert.equal(h.w.document.querySelectorAll('.boss-card').length,2);assert.equal(h.w.document.querySelector('[aria-label="巨龍血量"]').getAttribute('aria-valuenow'),'8');
    h.w.Math.random=()=>0;h.setPrompt('1234');await h.run("startBossBattle(1,'dragon')");assert.equal(h.w.document.querySelectorAll('#bossBattleArea .boss-options button').length,4);assert.equal(h.w.document.querySelector('.pet-interaction'),null);
    await h.run("answerBossQuestion(1,'dragon','q1',1,'1234')");assert.equal(h.cloud.students[0].bossProgress[0].hp,1);assert.match(h.w.document.getElementById('bossBattleResult').textContent,/答對了/);assert.ok(h.w.document.querySelector('#bossBattleResult button.primary'));
    h.setPrompt(null);await h.run("continueBossBattle(1,'dragon')");assert.equal(h.w.document.querySelectorAll('#bossBattleArea .boss-options button').length,2);
    await h.run("answerBossQuestion(1,'dragon','q2',0,'')");assert.equal(h.cloud.students[0].bossProgress[0].hp,0);assert.equal(h.cloud.students[1].bossProgress.length,0);assert.equal(h.w.document.querySelector('#bossBattleResult button.primary'),null);
    await h.run('leaveBossBattle(1)');assert.ok(h.w.document.querySelector('.pet-interaction'));assert.match(h.w.document.getElementById('modal').textContent,/你已完成攻打/);
});
test('teacher publishes multiple bosses and manages separate choice and true-false banks',async t=>{
    const h=page(t);await h.start();await h.login();await h.run("activateBackendPage('backend-boss')");
    for(const name of ['黑龍','白龍']){h.w.document.getElementById('bossName').value=name;h.w.document.getElementById('bossHp').value='20';h.w.document.getElementById('bossPassword').value='2468';h.w.document.getElementById('bossReward').value='50';h.w.document.getElementById('bossImage').value='/images/boss/boss%20(1).png';await h.run('saveBoss()');}
    assert.equal(h.cloud.bosses.length,2);const firstId=h.cloud.bosses[0].id;
    h.w.document.getElementById(`bossQuestionText-${firstId}`).value='地球是圓的';h.w.document.getElementById(`bossQuestionType-${firstId}`).value='boolean';h.w.document.getElementById(`bossBooleanAnswer-${firstId}`).value='0';await h.run(`addBossQuestion('${firstId}')`);
    assert.deepEqual(h.cloud.bosses[0].questions[0].options,['是','否']);assert.equal(h.cloud.bosses[1].questions.length,0);
    await h.run(`toggleBossActive('${firstId}')`);assert.equal(h.cloud.bosses[0].active,false);
    const questionId=h.cloud.bosses[0].questions[0].id;await h.run(`deleteBossQuestion('${firstId}','${questionId}')`);assert.equal(h.cloud.bosses[0].questions.length,0);
    await h.run(`deleteBoss('${firstId}')`);assert.equal(h.cloud.bosses.length,1);
});
