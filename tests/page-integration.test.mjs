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
    let cloud=fixture(),writes=0,id=0;
    const alerts=[];
    w.structuredClone=clone;w.alert=m=>alerts.push(m);w.confirm=()=>true;
    w.HTMLCanvasElement.prototype.getContext=function(){return {fillRect(){},clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},closePath(){},getImageData(){return {data:new Uint8ClampedArray(16)};},putImageData(){}};};
    w.HTMLCanvasElement.prototype.toDataURL=()=> 'data:image/jpeg;base64,test';
    w.eval(scripts[0][2]);
    w.GameOperations=operations;
    const sync=createCloudSync({readRemote:async()=>clone(cloud),execute:async job=>{const out=operations.applyOperation(cloud,job.command,Date.now());cloud=out.progress;if(out.changed)writes++;return {...out,result:{ok:true,...out.result}};},applyState:w.applyCloudState,lock:w.setSyncLocked,status:w.setSyncStatus,newId:()=>`test-${++id}`,setInterval:()=>1,clearInterval(){},error(){}});
    w.firebaseGameStore=sync;
    t.after(()=>{sync.dispose();w.close();});
    const signIn=(account,password)=>{w.document.getElementById('loginAccount').value=account;w.document.getElementById('loginPassword').value=password;w.login(new w.Event('submit'));};
    return {w,sync,alerts,get writes(){return writes;},get cloud(){return cloud;},set cloud(v){cloud=operations.normalizeProgress(v);},async start(){sync.setConnected(true);await sync.refresh();signIn('teacher','1127');},signIn,async login(){w.openBackend();w.document.getElementById("backendPw").value="1127";await w.checkBackendPw();},async run(code){const result=w.eval(code);await result;await sync.flush();return result;}};
}
test('inline scripts and modules parse',()=>{
    for(const [,attributes,source] of scripts){
        if(attributes.includes('module')){const r=spawnSync(process.execPath,['--input-type=module','--check'],{input:source,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
        else new vm.Script(source);
    }
});
test('login screen accepts configured teacher and student credentials and rejects incorrect passwords',async t=>{
    const h=page(t);h.sync.setConnected(true);await h.sync.refresh();
    assert.equal(h.w.document.getElementById('loginAccount').options.length,31);
    h.signIn('student-1','0000');assert.equal(h.w.document.getElementById('loginScreen').hidden,false);assert.match(h.w.document.getElementById('loginMessage').textContent,/錯誤/);
    h.signIn('student-1','3847');assert.equal(h.w.document.getElementById('loginScreen').hidden,true);assert.equal(h.w.document.getElementById('sessionBadge').textContent,'學生 1 號');
    h.w.logout();h.signIn('teacher','1127');assert.equal(h.w.document.getElementById('sessionBadge').textContent,'老師');assert.equal(h.w.document.getElementById('backendButton').hidden,false);
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
    h.w.openBackend();h.w.document.getElementById('backendPw').value='1127';await h.w.checkBackendPw();assert.match(h.w.document.getElementById('body').textContent,/老師後台/);
});
test('startup and opening all student views never writes; task button commits live reward',async t=>{
    const h=page(t);await h.start();
    for(const action of ['tasks(1)','shop(1)','closet(1)','openPetMood(1)','openCoopTasks()']) await h.run(action);
    assert.equal(h.writes,0);await h.run("finishTask(1,'task')");
    assert.equal(h.cloud.students[0].tokens,220);assert.deepEqual(h.cloud.students[0].doneTasks,['task']);
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
