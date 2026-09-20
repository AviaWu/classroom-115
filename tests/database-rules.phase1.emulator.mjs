import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const host=process.env.FIREBASE_DATABASE_EMULATOR_HOST;
if(!host||!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('Local database emulator required');
const project='demo-classroom-sync',origin=`http://${host}`,namespace=`${project}-default-rtdb`;
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
function token(uid,email){
  const now=Math.floor(Date.now()/1000);
  return `${encode({alg:'none',typ:'JWT'})}.${encode({iss:`https://securetoken.google.com/${project}`,aud:project,iat:now,exp:now+3600,auth_time:now,sub:uid,user_id:uid,email,firebase:{sign_in_provider:'password',identities:{email:[email]}}})}.`;
}
const endpoint=(path,uid,email)=>`${origin}/${path}.json?ns=${namespace}${uid?`&auth=${encodeURIComponent(token(uid,email))}`:''}`;
const teacher={uid:'teacher-uid',email:'teacher@classroom-115.local'};
const studentOne={uid:'student-one',email:'student-1@classroom-115.local'};
const studentTwo={uid:'student-two',email:'student-2@classroom-115.local'};
const unassigned={uid:'student-twenty-nine',email:'student-29@classroom-115.local'};
const migrating={uid:'student-three',email:'student-3@classroom-115.local'};
const state=(studentId=1)=>({studentId,tokens:10,lotteryTickets:1,petAffection:2,lastPetMoodDate:'2026-09-20',equippedLayout:['cat'],bossProgress:[]});

before(async()=>{
  const response=await fetch(endpoint('.settings/rules'),{method:'PUT',headers:{Authorization:'Bearer owner'},body:await readFile(new URL('../database.rules.phase1.json',import.meta.url),'utf8')});
  assert.equal(response.status,200,await response.text());
  const cat={cat:{id:'cat',name:'小貓',image:'cat.png',level:'R'}};
  const seed={studentRoster:{[studentOne.uid]:{studentId:1,active:true},[studentTwo.uid]:{studentId:2,active:true}},studentStates:{[studentOne.uid]:state(1),[studentTwo.uid]:state(2)},studentPets:{[studentOne.uid]:cat,[studentTwo.uid]:cat},publicBosses:{boss:{id:'boss',active:true}},publicQuestionPapers:{paper:{id:'paper',questions:[]}},games:{'classroom-115':{progress:{students:[{id:1}]}}}};
  const seeded=await fetch(endpoint('',null,null),{method:'PUT',headers:{Authorization:'Bearer owner'},body:JSON.stringify(seed)});
  assert.equal(seeded.status,200,await seeded.text());
});
async function request(path,identity,{method='GET',body}={}){
  return fetch(endpoint(path,identity?.uid,identity?.email),{method,body:body===undefined?undefined:JSON.stringify(body)});
}
async function allowed(path,identity,options){
  const response=await request(path,identity,options);
  assert.equal(response.status,200,await response.text());
}
async function denied(path,identity,options){
  const response=await request(path,identity,options);
  assert.equal(response.status,401,await response.text());
}

test('teacher retains full room and projection access',async()=>{
  await allowed('games/classroom-115',teacher);
  await allowed(`studentStates/${studentOne.uid}`,teacher,{method:'PUT',body:state(1)});
  await allowed('studentRoster',teacher,{method:'GET'});
  await allowed('publicBosses',teacher,{method:'PUT',body:{boss:{id:'boss',active:true}}});
  const current=await (await request('',teacher)).json();
  current.studentStates[studentOne.uid].tokens=11;
  await allowed('',teacher,{method:'PUT',body:current});
  await allowed(`studentStates/${studentOne.uid}`,teacher,{method:'PUT',body:{...state(1),bossProgress:[{bossId:'boss',hp:8,passwordVerified:true,answeredQuestionIds:['q1'],defeated:false,completedAt:null}]}});
  await allowed(`studentStates/${studentOne.uid}`,teacher,{method:'PUT',body:{...state(1),tokens:-5}});
});

test('teacher can create roster and student state in one phase-one migration patch',async()=>{
  await allowed('',teacher,{method:'PATCH',body:{
    [`studentRoster/${migrating.uid}`]:{studentId:3,active:true},
    [`studentStates/${migrating.uid}`]:state(3),
    [`studentPets/${migrating.uid}`]:{cat:{id:'cat',name:'小貓',image:'cat.png',level:'R'}},
  }});
});

test('teacher can atomically update room data and increment one student projection',async()=>{
  const before=await (await request(`studentStates/${studentOne.uid}/tokens`,teacher)).json();
  await allowed('',teacher,{method:'PATCH',body:{
    'games/classroom-115/progress/students/0/equippedClothes':null,
    [`studentStates/${studentOne.uid}/tokens`]:{'.sv':{increment:5}},
  }});
  const after=await (await request(`studentStates/${studentOne.uid}/tokens`,teacher)).json();
    assert.equal(after,before+5);
});

test('teacher can update one legacy student without touching projections',async()=>{
  const before=await (await request('games/classroom-115/progress/students/1',teacher)).json();
  await allowed('games/classroom-115/progress/students/0',teacher,{method:'PATCH',body:{equippedClothes:'shirt'}});
  const first=await (await request('games/classroom-115/progress/students/0',teacher)).json();
  const second=await (await request('games/classroom-115/progress/students/1',teacher)).json();
  assert.equal(first.equippedClothes,'shirt');
  assert.deepEqual(second,before);
});

test('teacher sync marker is writable by teacher and immutable to the student',async()=>{
  const marker={id:'operation',createdAt:100000,resultJson:'{"ok":true}'};
  await allowed(`studentStates/${studentOne.uid}`,teacher,{method:'PUT',body:{...state(1),_teacherOperation:marker}});
  await allowed(`studentStates/${studentOne.uid}`,studentOne,{method:'PUT',body:{...state(1),tokens:12,_teacherOperation:marker}});
  await denied(`studentStates/${studentOne.uid}`,studentOne,{method:'PUT',body:{...state(1),tokens:13}});
  await denied(`studentStates/${studentOne.uid}`,studentOne,{method:'PUT',body:{...state(1),tokens:13,
    _teacherOperation:{...marker,resultJson:'{"ok":false}'}}});
  await allowed(`studentStates/${studentOne.uid}`,teacher,{method:'PUT',body:state(1)});
});

test('student is limited to their own state and public battle data',async()=>{
  await allowed(`studentStates/${studentOne.uid}`,studentOne);
  await allowed(`studentStates/${studentOne.uid}`,studentOne,{method:'PUT',body:{...state(1),tokens:11}});
  await allowed(`studentPets/${studentOne.uid}`,studentOne);
  await allowed('publicBosses',studentOne);
  await allowed('publicQuestionPapers',studentOne);
  await denied('games/classroom-115',studentOne);
  await denied(`studentStates/${studentTwo.uid}`,studentOne);
  await denied('studentRoster',studentOne);
  await denied('',studentOne,{method:'PUT',body:{studentStates:{[studentOne.uid]:state(1)}}});
  await denied('publicBosses',studentOne,{method:'PUT',body:{boss:{id:'boss',active:false}}});
});

test('an unassigned login cannot create a projection',async()=>{
  await denied(`studentStates/${unassigned.uid}`,unassigned,{method:'PUT',body:state(29)});
  await denied(`studentPets/${unassigned.uid}`,unassigned,{method:'PUT',body:{cat:{id:'cat',level:'UR'}}});
});

test('students cannot forge pet catalogue entries or malformed personal state',async()=>{
  await denied(`studentPets/${studentOne.uid}`,studentOne,{method:'PUT',body:{dragon:{id:'dragon',name:'龍',image:'dragon.png',level:'UR'}}});
  await denied(`studentStates/${studentOne.uid}`,studentOne,{method:'PUT',body:{...state(1),ownedLayout:['dragon']}});
  await denied(`studentStates/${studentOne.uid}`,studentOne,{method:'PUT',body:{...state(1),equippedLayout:['dragon']}});
  await denied(`studentStates/${studentOne.uid}`,studentOne,{method:'PUT',body:{...state(1),admin:true}});
  await denied(`studentStates/${studentOne.uid}`,studentOne,{method:'PUT',body:{...state(1),studentId:2}});
  await denied(`studentStates/${studentOne.uid}`,studentOne,{method:'PUT',body:{...state(1),lotteryTickets:-1}});
});
