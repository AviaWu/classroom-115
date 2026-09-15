// Isolated browser fixture. Never connects to Firebase or production data.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyOperation,normalizeProgress} from '../public/game-operations.mjs';
const root=fileURLToPath(new URL('../public/',import.meta.url));
let progress=normalizeProgress({students:[{id:1,gender:'M',tokens:200,lotteryTickets:2},{id:2,gender:'F',tokens:100}],tasks:[{id:'task',title:'測試任務',reward:20}],clothesM:[{id:'shirt',name:'測試上衣',level:'R',price:50,active:true,image:'/images/boy/b%20(1).png'}],layouts:[{id:'pet',name:'測試寵物',price:50,level:'R',active:true,image:'/images/Dec2/1000095494-removebg-preview.png'}],backgrounds:[{id:'bg',name:'天空背景',price:50,level:'R',active:true,image:'/images/bgm/bg%20(1).jpg'}],coopTasks:[{id:'coop',monsterName:'合作怪獸',content:'一起完成',reward:10,rewardType:'token',completedBy:[],claimed:false}]});
const receipts=new Map();let offline=false;
const bootstrap=`<script type="module">
import * as ops from '/game-operations.mjs';import {createCloudSync} from '/cloud-sync.mjs';
window.GameOperations=ops;
async function read(){const r=await fetch('/__state');if(!r.ok)throw Object.assign(new Error('offline'),{retryable:true});return r.json();}
window.readLatestProgress=read;
const sync=createCloudSync({readRemote:read,execute:async job=>{const r=await fetch('/__action',{method:'POST',body:JSON.stringify(job)});const value=await r.json();if(!r.ok)throw Object.assign(new Error(value.error),{retryable:r.status===503});return value;},applyState:applyCloudState,lock:setSyncLocked,status:setSyncStatus,newId:()=>crypto.randomUUID(),error:console.error});
window.firebaseGameStore=sync;sync.setConnected(true);
document.addEventListener('visibilitychange',()=>sync.setActive(!document.hidden));
window.addEventListener('focus',()=>sync.setActive(true));
</script>`;
http.createServer(async(req,res)=>{
    try{
        const url=new URL(req.url,'http://localhost');
        if(url.pathname==='/__state'){res.writeHead(offline?503:200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(progress));return;}
        if(url.pathname==='/__action'){
            if(offline){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'offline'}));return;}
            let body='';for await(const chunk of req)body+=chunk;
            const job=JSON.parse(body);let outcome=receipts.get(job.id);
            if(!outcome){outcome=applyOperation(progress,job.command);progress=outcome.progress;outcome={progress,result:{ok:true,...outcome.result}};receipts.set(job.id,outcome);}
            res.setHeader('Content-Type','application/json');res.end(JSON.stringify(outcome));return;
        }
        if(url.pathname==='/__control'){
            if(url.searchParams.has('tokens'))progress.students[0].tokens=Number(url.searchParams.get('tokens'));
            if(url.searchParams.has('name'))progress.clothesM[0].name=url.searchParams.get('name');
            if(url.searchParams.has('offline'))offline=url.searchParams.get('offline')==='true';
            res.end('ok');return;
        }
        const pathname=url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname);
        const target=path.resolve(root,'.'+pathname);
        if(!target.startsWith(root)){res.writeHead(403);res.end();return;}
        let body=await fs.readFile(target);
        if(pathname==='/index.html')body=body.toString().replace(/<script type="module">[\s\S]*?<\/script>/,bootstrap);
        const ext=path.extname(target);res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.mjs':'text/javascript','.png':'image/png','.jpg':'image/jpeg'})[ext]||'application/octet-stream');
        res.setHeader('Cache-Control','no-store');res.end(body);
    }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
}).listen(8087,'127.0.0.1',()=>console.log('Isolated preview: http://127.0.0.1:8087'));
