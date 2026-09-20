import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {initializeApp,deleteApp} from 'firebase/app';
import {connectDatabaseEmulator,getDatabase,ref,runTransaction,get,onValue} from 'firebase/database';
import {createFirebaseStore} from '../public/firebase-store.mjs';
import {createFirebaseRestClient} from '../public/firebase-rest-client.mjs';

const host=process.env.FIREBASE_DATABASE_EMULATOR_HOST;
if(!host||!/^127\.0\.0\.1:\d+$/.test(host)) throw new Error('Local database emulator required');
const project='demo-classroom-sync',namespace=`${project}-default-rtdb`,origin=`http://${host}`;
const teacher={sub:'teacher-uid',user_id:'teacher-uid',email:'teacher@classroom-115.local',
  firebase:{sign_in_provider:'password',identities:{email:['teacher@classroom-115.local']}}};
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const now=Math.floor(Date.now()/1000);
const token=`${encode({alg:'none',typ:'JWT'})}.${encode({...teacher,iss:`https://securetoken.google.com/${project}`,aud:project,iat:now,exp:now+3600,auth_time:now})}.`;
const endpoint=path=>`${origin}/${path}.json?ns=${namespace}`;
const app=initializeApp({projectId:project,databaseURL:`https://${namespace}.firebaseio.com`},'wardrobe-regression');
const database=getDatabase(app);
connectDatabaseEmulator(database,'127.0.0.1',Number(host.split(':')[1]),{mockUserToken:teacher});
after(()=>deleteApp(app));
before(async()=>{
  const response=await fetch(endpoint('.settings/rules'),{method:'PUT',headers:{Authorization:'Bearer owner'},
    body:await readFile(new URL('../database.rules.phase1.json',import.meta.url),'utf8')});
  assert.equal(response.status,200,await response.text());
});
const studentPath='games/classroom-115/progress/students/27';
function fixture(){
  return {students:Array.from({length:28},(_,index)=>({id:index+1,gender:'M',tokens:630,
    ownedClothes:['shirt'],equippedClothes:'shirt',ownedBg:['sky'],equippedBg:'sky',
    // Actual problematic value found on student 28. It must survive wardrobe edits unchanged.
    bossProgress:[{bossId:'retired-boss',hp:9007199254740991,passwordVerified:false,defeated:false}]})),
    clothesM:[{id:'shirt',name:'上衣',active:true,price:0}],backgrounds:[{id:'sky',name:'天空',price:0}]};
}
async function seed(){
  const response=await fetch(endpoint('games/classroom-115'),{method:'PUT',headers:{Authorization:'Bearer owner'},body:JSON.stringify({progress:fixture()})});
  assert.equal(response.status,200,await response.text());
}
async function read(path){
  const response=await fetch(`${endpoint(path)}&auth=${encodeURIComponent(token)}`);
  assert.equal(response.status,200,await response.clone().text());
  return response.json();
}
const restClient=createFirebaseRestClient({databaseURL:origin,getToken:async()=>token,fetch:(input,options)=>{
  const url=new URL(input);url.searchParams.set('ns',namespace);return fetch(url,options);
}});

test('SDK 12.19.0 reproduces maxretry for a MAX_SAFE_INTEGER child without concurrent writers',async()=>{
  await seed();
  await assert.rejects(runTransaction(ref(database,studentPath),value=>({...value,equippedClothes:null}),{applyLocally:false}),/maxretry/);
  assert.equal((await read(studentPath)).equippedClothes,'shirt');
});

test('student 28 can remove and wear clothes even when legacy BOSS HP is MAX_SAFE_INTEGER',async()=>{
  await seed();
  const stop=onValue(ref(database,'games/classroom-115/progress'),()=>{});
  try{
    await get(ref(database,'games/classroom-115/progress'));
    const store=createFirebaseStore({databaseURL:origin,getToken:async()=>token,getUid:()=>teacher.sub,
      readProgress:()=>read('games/classroom-115/progress'),readRoomMetadata:async()=>({}),
      readEquipmentCatalogues:async()=>fixture(),
      transactProgressStudent:(studentId,updater)=>restClient.transact(`games/classroom-115/progress/students/${studentId-1}`,updater)});
    for(const [kind,field,items] of [['clothes','equippedClothes',[null,'shirt']],['background','equippedBg',[null,'sky']]]){
      for(const itemId of items){
        await store.execute({id:`wardrobe-${kind}-${itemId}`,createdAt:Date.now(),command:{type:'equip',studentId:28,kind,itemId}});
        const saved=await read(studentPath);
        assert.equal(saved[field]??null,itemId);
        assert.equal(saved.bossProgress[0].hp,9007199254740991);
        assert.equal(saved.tokens,630);
      }
    }
    assert.deepEqual(await read('games/classroom-115/progress/students/26'),fixture().students[26]);
  }finally{stop();}
});

test('ETag transactions preserve concurrent increments and resolve server timestamps',async()=>{
  await seed();
  const results=await Promise.all([1,2].map(amount=>restClient.transact(studentPath,current=>({...current,tokens:current.tokens+amount,updatedAt:{'.sv':'timestamp'}}))));
  assert.equal((await read(studentPath)).tokens,633);
  for(const result of results){assert.equal(result.committed,true);assert.equal(typeof result.value.updatedAt,'number');}
});

test('teacher coordinated resources also commit when room and personal state contain large BOSS HP',async()=>{
  await seed();
  const personal={studentId:28,tokens:630,lotteryTickets:0,petAffection:0,lastPetMoodDate:'',bossProgress:fixture().students[27].bossProgress};
  for(const [path,value] of [['studentRoster',{'uid-28':{studentId:28,active:true}}],['studentStates',{'uid-28':personal}]]){
    const response=await fetch(endpoint(path),{method:'PUT',headers:{Authorization:'Bearer owner'},body:JSON.stringify(value)});
    assert.equal(response.status,200,await response.text());
  }
  const store=createFirebaseStore({databaseURL:origin,getToken:async()=>token,getUid:()=>teacher.sub,
    readRoot:async()=>({games:{'classroom-115':await restClient.read('games/classroom-115')},studentRoster:await restClient.read('studentRoster'),studentStates:await restClient.read('studentStates')}),
    writeRoot:async updates=>{
      const response=await fetch(`${endpoint('')}&auth=${encodeURIComponent(token)}`,{method:'PATCH',body:JSON.stringify(updates)});
      assert.equal(response.status,200,await response.text());
    },
    transactRoom:updater=>restClient.transact('games/classroom-115',updater),
    transactStudentState:(uid,updater)=>restClient.transact(`studentStates/${uid}`,updater)});
  const job={id:'resources-28',createdAt:Date.now(),command:{type:'resources',studentId:28,field:'tokens',mode:'add',amount:5}};
  for(let repeat=0;repeat<2;repeat++){
    const result=await store.execute(job);
    assert.equal(result.progress.students[27].tokens,635);
    assert.equal((await read('studentStates/uid-28')).tokens,635);
    assert.equal((await read('games/classroom-115'))._projectionSync,undefined);
  }
});
