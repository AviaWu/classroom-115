import {createHash} from 'node:crypto';

export const PHASE2_ROOM_PATH='games/classroom-115';
export const PHASE2_PRODUCTION_DATABASE_URL='https://classroom-115-default-rtdb.asia-southeast1.firebasedatabase.app';

const KIND='classroom-115-progress-phase2';
const SCHEMA_VERSION=1;
const PERSONAL_FIELDS=['tokens','lotteryTickets','petAffection','lastPetMoodDate','equippedLayout','bossProgress'];
const REQUIRED_STATE_FIELDS=['studentId','tokens','lotteryTickets','petAffection','lastPetMoodDate'];
const OPTIONAL_STATE_FIELDS=['equippedLayout','bossProgress'];
const has=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>structuredClone(value);
const byteLength=value=>Buffer.byteLength(JSON.stringify(value),'utf8');

function fail(message){throw new Error(`Phase-two migration refused: ${message}`);}

function stableJson(value){
  if(Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if(isObject(value)) return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest=value=>createHash('sha256').update(stableJson(value)).digest('hex');

function validateRoomIdentity(room){
  if(!isObject(room)) fail('games/classroom-115 room is missing or malformed.');
  if(has(room,'_projectionSync')) fail('room has an active _projectionSync marker.');
  const projecting=Object.entries(room.operations||{}).find(([,receipt])=>receipt?.phase==='projecting');
  if(projecting) fail(`teacher receipt ${projecting[0]} is still projecting.`);
  const students=room.progress?.students;
  if(!Array.isArray(students)||students.length!==28) fail('progress.students must contain exactly indices 0 through 27.');
  for(let index=0;index<28;index++){
    if(!has(students,index)||!isObject(students[index])||students[index].id!==index+1){
      fail(`progress student at index ${index} must have id ${index+1}.`);
    }
  }
  return students;
}

function validateBossProgress(value,uid){
  if(!Array.isArray(value)) fail(`studentStates/${uid}/bossProgress must be an array when present.`);
  value.forEach((entry,index)=>{
    const label=`studentStates/${uid}/bossProgress/${index}`;
    if(!isObject(entry)) fail(`${label} must be an object.`);
    const allowed=['bossId','hp','passwordVerified','answeredQuestionIds','defeated','completedAt'];
    if(Object.keys(entry).some(key=>!allowed.includes(key))) fail(`${label} contains a field Rules do not allow.`);
    if(typeof entry.bossId!=='string'||!Number.isFinite(entry.hp)||entry.hp<0||
      typeof entry.passwordVerified!=='boolean'||typeof entry.defeated!=='boolean') fail(`${label} is malformed.`);
    if(has(entry,'answeredQuestionIds')&&(!Array.isArray(entry.answeredQuestionIds)||entry.answeredQuestionIds.some(id=>typeof id!=='string'))){
      fail(`${label}/answeredQuestionIds is malformed.`);
    }
    if(has(entry,'completedAt')&&!Number.isFinite(entry.completedAt)) fail(`${label}/completedAt is malformed.`);
  });
}

function validateState(uid,state,studentId){
  if(!isObject(state)) fail(`studentStates/${uid} is missing or malformed.`);
  if(has(state,'_teacherOperation')) fail(`studentStates/${uid} has an active _teacherOperation marker.`);
  const allowed=[...REQUIRED_STATE_FIELDS,...OPTIONAL_STATE_FIELDS];
  if(Object.keys(state).some(key=>!allowed.includes(key))) fail(`studentStates/${uid} contains a field Rules do not allow.`);
  for(const field of REQUIRED_STATE_FIELDS) if(!has(state,field)) fail(`studentStates/${uid}/${field} is required.`);
  if(state.studentId!==studentId) fail(`studentStates/${uid}/studentId does not match its roster mapping.`);
  if(!Number.isFinite(state.tokens)) fail(`studentStates/${uid}/tokens must be a finite number.`);
  if(!Number.isInteger(state.lotteryTickets)||state.lotteryTickets<0) fail(`studentStates/${uid}/lotteryTickets is malformed.`);
  if(!Number.isFinite(state.petAffection)||state.petAffection<0) fail(`studentStates/${uid}/petAffection is malformed.`);
  if(typeof state.lastPetMoodDate!=='string') fail(`studentStates/${uid}/lastPetMoodDate must be a string.`);
  if(has(state,'equippedLayout')&&(!Array.isArray(state.equippedLayout)||state.equippedLayout.length>1||state.equippedLayout.some(id=>typeof id!=='string'))){
    fail(`studentStates/${uid}/equippedLayout is malformed.`);
  }
  if(has(state,'bossProgress')) validateBossProgress(state.bossProgress,uid);
}

function validateMappings(studentRoster,studentStates){
  if(!isObject(studentRoster)||Object.keys(studentRoster).length!==28) fail('studentRoster must contain exactly 28 active UID mappings.');
  if(!isObject(studentStates)||Object.keys(studentStates).length!==28) fail('studentStates must match exactly the 28 roster UIDs.');
  const uidByStudentId={};
  for(const [uid,entry] of Object.entries(studentRoster)){
    if(!uid||!isObject(entry)||entry.active!==true||!Number.isInteger(entry.studentId)||entry.studentId<1||entry.studentId>28){
      fail(`studentRoster/${uid||'<empty>'} is not an active student 1 through 28 mapping.`);
    }
    if(Object.keys(entry).sort().join(',')!=='active,studentId') fail(`studentRoster/${uid} contains unexpected roster fields.`);
    if(uidByStudentId[entry.studentId]) fail(`studentRoster has a duplicate mapping for student ${entry.studentId}.`);
    uidByStudentId[entry.studentId]=uid;
  }
  for(let studentId=1;studentId<=28;studentId++){
    const uid=uidByStudentId[studentId];
    if(!uid) fail(`studentRoster is missing student ${studentId}.`);
    validateState(uid,studentStates[uid],studentId);
  }
  for(const uid of Object.keys(studentStates)) if(!has(studentRoster,uid)) fail(`studentStates/${uid} has no active roster mapping.`);
  return uidByStudentId;
}

function authoritativeValue(state,field){
  if(OPTIONAL_STATE_FIELDS.includes(field)&&!has(state,field)) return [];
  return state[field];
}

function removeApprovedFields(room){
  const result=clone(room);
  for(const member of result.progress.students) for(const field of PERSONAL_FIELDS) delete member[field];
  return result;
}

export function buildPhase2Plan(root){
  if(!isObject(root)) fail('full Firebase root JSON must be an object.');
  const room=root.games?.['classroom-115'];
  const students=validateRoomIdentity(room);
  const uidByStudentId=validateMappings(root.studentRoster,root.studentStates);
  const deletions=[],divergences=[],deletePatch={},rollbackPatch={};
  for(let index=0;index<28;index++){
    const member=students[index],studentId=index+1,uid=uidByStudentId[studentId],state=root.studentStates[uid];
    for(const field of PERSONAL_FIELDS){
      if(!has(member,field)) continue;
      const path=`${PHASE2_ROOM_PATH}/progress/students/${index}/${field}`,before=clone(member[field]);
      deletions.push({path,before});deletePatch[path]=null;rollbackPatch[path]=clone(before);
      const current=authoritativeValue(state,field);
      if(stableJson(before)!==stableJson(current)) divergences.push({path,studentId,uid,field,legacyValue:clone(before),authoritativeValue:clone(current)});
    }
  }
  const compactRoom=removeApprovedFields(room);
  const plan={
    kind:KIND,schemaVersion:SCHEMA_VERSION,roomPath:PHASE2_ROOM_PATH,
    expectedRoster:clone(root.studentRoster),
    approvedFields:clone(PERSONAL_FIELDS),deletions,divergences,deletePatch,rollbackPatch,
    summary:{
      students:{expected:28,validated:28},
      fields:{approved:28*PERSONAL_FIELDS.length,present:deletions.length,absent:28*PERSONAL_FIELDS.length-deletions.length,divergent:divergences.length},
      roomBytesBefore:byteLength(room),roomBytesAfter:byteLength(compactRoom),bytesRemoved:byteLength(room)-byteLength(compactRoom),
      deletionValuesBytes:deletions.reduce((sum,entry)=>sum+byteLength(entry.before),0),
    },
  };
  plan.reviewDigest=digest(plan);
  return plan;
}

function validateExpectedRoster(roster){
  if(!isObject(roster)||Object.keys(roster).length!==28) fail('plan expectedRoster must contain exactly 28 mappings.');
  const ids=new Set();
  for(const [uid,entry] of Object.entries(roster)){
    if(!uid||!isObject(entry)||Object.keys(entry).sort().join(',')!=='active,studentId'||entry.active!==true||
      !Number.isInteger(entry.studentId)||entry.studentId<1||entry.studentId>28||ids.has(entry.studentId)){
      fail(`plan expectedRoster/${uid||'<empty>'} is malformed or duplicated.`);
    }
    ids.add(entry.studentId);
  }
}

function parseApprovedPath(path){
  if(typeof path!=='string') fail('plan deletion path must be a string.');
  const match=path.match(/^games\/classroom-115\/progress\/students\/(\d+)\/([A-Za-z]+)$/);
  if(!match) fail(`plan path is outside the approved room: ${path}`);
  const index=Number(match[1]),field=match[2];
  if(index<0||index>27||String(index)!==match[1]||!PERSONAL_FIELDS.includes(field)) fail(`plan path is not an approved personal field: ${path}`);
  return {index,studentId:index+1,field};
}

function validJsonValue(value){
  if(value===null||typeof value==='string'||typeof value==='boolean') return true;
  if(typeof value==='number') return Number.isFinite(value);
  if(Array.isArray(value)) return value.every(validJsonValue);
  return isObject(value)&&Object.entries(value).every(([key,item])=>key&&validJsonValue(item));
}

export function validatePhase2Plan(plan){
  if(!isObject(plan)) fail('reviewed plan must be an object.');
  const expectedKeys=['approvedFields','deletePatch','deletions','divergences','expectedRoster','kind','reviewDigest','rollbackPatch','roomPath','schemaVersion','summary'];
  if(Object.keys(plan).sort().join(',')!==expectedKeys.sort().join(',')) fail('reviewed plan has missing or unexpected top-level fields.');
  if(plan.kind!==KIND||plan.schemaVersion!==SCHEMA_VERSION) fail('reviewed plan kind or schema version is unsupported.');
  if(plan.roomPath!==PHASE2_ROOM_PATH) fail('reviewed plan targets the wrong room.');
  if(stableJson(plan.approvedFields)!==stableJson(PERSONAL_FIELDS)) fail('reviewed plan approvedFields are not exact.');
  validateExpectedRoster(plan.expectedRoster);
  if(!Array.isArray(plan.deletions)||plan.deletions.length>168) fail('reviewed plan deletions are malformed.');
  if(!isObject(plan.deletePatch)||!isObject(plan.rollbackPatch)) fail('reviewed plan patches are malformed.');
  const paths=new Set(),deletionByPath=new Map();
  for(const entry of plan.deletions){
    if(!isObject(entry)||Object.keys(entry).sort().join(',')!=='before,path'||!validJsonValue(entry.before)) fail('reviewed plan deletion entry is malformed.');
    parseApprovedPath(entry.path);
    if(paths.has(entry.path)) fail(`reviewed plan repeats deletion path ${entry.path}.`);
    paths.add(entry.path);deletionByPath.set(entry.path,entry);
    if(plan.deletePatch[entry.path]!==null) fail(`reviewed plan deletePatch does not delete ${entry.path}.`);
    if(!has(plan.rollbackPatch,entry.path)||stableJson(plan.rollbackPatch[entry.path])!==stableJson(entry.before)) fail(`reviewed plan rollbackPatch does not match ${entry.path}.`);
  }
  if(Object.keys(plan.deletePatch).length!==paths.size||Object.keys(plan.rollbackPatch).length!==paths.size||
    Object.keys(plan.deletePatch).some(path=>!paths.has(path))||Object.keys(plan.rollbackPatch).some(path=>!paths.has(path))){
    fail('reviewed plan deletePatch or rollbackPatch contains extra paths.');
  }
  if(!Array.isArray(plan.divergences)) fail('reviewed plan divergences must be an array.');
  for(const entry of plan.divergences){
    const parsed=parseApprovedPath(entry?.path),deletion=deletionByPath.get(entry.path);
    const uid=Object.entries(plan.expectedRoster).find(([,mapping])=>mapping.studentId===parsed.studentId)?.[0];
    if(!deletion||entry.studentId!==parsed.studentId||entry.uid!==uid||entry.field!==parsed.field||
      stableJson(entry.legacyValue)!==stableJson(deletion.before)||!validJsonValue(entry.authoritativeValue)){
      fail(`reviewed plan divergence is malformed for ${entry?.path||'<missing path>'}.`);
    }
  }
  const fields=plan.summary?.fields,students=plan.summary?.students;
  if(students?.expected!==28||students?.validated!==28||fields?.approved!==168||fields?.present!==paths.size||
    fields?.absent!==168-paths.size||fields?.divergent!==plan.divergences.length) fail('reviewed plan summary counts are inconsistent.');
  for(const field of ['roomBytesBefore','roomBytesAfter','bytesRemoved','deletionValuesBytes']){
    if(!Number.isInteger(plan.summary?.[field])||plan.summary[field]<0) fail(`reviewed plan summary ${field} is malformed.`);
  }
  if(plan.summary.bytesRemoved!==plan.summary.roomBytesBefore-plan.summary.roomBytesAfter) fail('reviewed plan byte summary is inconsistent.');
  const {reviewDigest,...unsigned}=plan;
  if(typeof reviewDigest!=='string'||reviewDigest!==digest(unsigned)) fail('reviewed plan digest does not match its contents.');
  return plan;
}

function inspectRoom(room,plan){
  validatePhase2Plan(plan);
  const students=validateRoomIdentity(room),planned=new Map(plan.deletions.map(entry=>[entry.path,entry.before]));
  let beforeCount=0,absentCount=0;
  for(let index=0;index<28;index++) for(const field of PERSONAL_FIELDS){
    const path=`${PHASE2_ROOM_PATH}/progress/students/${index}/${field}`,member=students[index];
    if(planned.has(path)){
      if(!has(member,field)){absentCount++;continue;}
      if(stableJson(member[field])!==stableJson(planned.get(path))) fail(`${path} changed since preview; the plan is stale.`);
      beforeCount++;
    }else if(has(member,field)) fail(`${path} is an unexpected approved field added after preview.`);
  }
  if(beforeCount&&absentCount) fail('room contains a partially applied phase-two plan.');
  return {status:beforeCount===plan.deletions.length&&beforeCount>0?'ready':'applied'};
}

export function validatePhase2LiveData({room,studentRoster,studentStates},plan){
  validatePhase2Plan(plan);
  validateMappings(studentRoster,studentStates);
  if(stableJson(studentRoster)!==stableJson(plan.expectedRoster)) fail('live studentRoster mapping does not match the reviewed plan.');
  return {...inspectRoom(room,plan),students:28,deletions:plan.deletions.length};
}

export function applyPhase2PlanToRoom(room,plan){
  const inspection=inspectRoom(room,plan),result=clone(room);
  if(inspection.status==='applied') return result;
  for(const entry of plan.deletions){
    const {index,field}=parseApprovedPath(entry.path);
    delete result.progress.students[index][field];
  }
  return result;
}

export function rollbackPhase2PlanToRoom(room,plan){
  const inspection=inspectRoom(room,plan),result=clone(room);
  if(inspection.status==='ready') return result;
  for(const entry of plan.deletions){
    const {index,field}=parseApprovedPath(entry.path);
    result.progress.students[index][field]=clone(entry.before);
  }
  return result;
}
