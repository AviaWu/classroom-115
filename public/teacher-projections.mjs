import {normalizeProgress} from './game-operations.mjs';

const clone=value=>structuredClone(value);
export const PERSONAL_FIELDS=['tokens','lotteryTickets','petAffection','lastPetMoodDate','equippedLayout','bossProgress'];
const compact=student=>PERSONAL_FIELDS.every(field=>!Object.hasOwn(student,field));

// Preserve transport omissions: a compact stored record is not a zero-balance
// student. Personal defaults belong in the hydrated runtime view only.
export function normalizeStoredProgress(value){
  const normalized=normalizeProgress(value);
  if(!normalized) return normalized;
  const original=new Map((value.students||[]).filter(Boolean).map((student,index)=>[Number(student.id??index+1),student]));
  for(const student of normalized.students){
    const previous=original.get(student.id)||{};
    for(const field of PERSONAL_FIELDS) if(!Object.hasOwn(previous,field)) delete student[field];
  }
  return normalized;
}

// During rollout leave existing legacy copies untouched. After the explicit
// migration removes them, teacher operations can never manufacture them again.
export function progressForStorage(view,previous,uidByStudentId){
  if(!view) return view;
  const stored=clone(view),before=new Map((previous?.students||[]).map(student=>[student.id,student]));
  for(const student of stored.students||[]){
    if(!uidByStudentId[student.id]) continue;
    const original=before.get(student.id)||{};
    for(const field of PERSONAL_FIELDS){
      delete student[field];
      if(Object.hasOwn(original,field)) student[field]=clone(original[field]);
    }
  }
  return stored;
}

export function mergeStudentStatesIntoProgress(progress,states={},uidByStudentId){
  if(!progress) return progress;
  const byStudentId=new Map();
  for(const state of Object.values(states||{})){
    if(!Number.isInteger(state?.studentId)) continue;
    if(byStudentId.has(state.studentId)) throw new Error(`第 ${state.studentId} 號學生個人資料重複，已停止操作。`);
    byStudentId.set(state.studentId,state);
  }
  return {...clone(progress),students:(progress.students||[]).map(student=>{
    const uid=uidByStudentId?.[student.id];
    const personal=uid?states[uid]:byStudentId.get(student.id);
    if((uid&&personal?.studentId!==student.id)||(uidByStudentId&&!uid&&personal)||(compact(student)&&(!personal||(uidByStudentId&&!uid)))) throw new Error(`第 ${student.id} 號學生個人資料缺少或編號不符，已停止操作。`);
    if(!personal) return clone(student);
    if((compact(student)||uid)&&(!Number.isFinite(personal.tokens)||!Number.isInteger(personal.lotteryTickets)||personal.lotteryTickets<0||!Number.isFinite(personal.petAffection)||personal.petAffection<0||typeof personal.lastPetMoodDate!=='string'||
      ['equippedLayout','bossProgress'].some(field=>personal[field]!=null&&!Array.isArray(personal[field])))) throw new Error(`第 ${student.id} 號學生個人資料不完整，已停止操作。`);
    const normalized={...personal,
      equippedLayout:Array.isArray(personal.equippedLayout)?personal.equippedLayout:[],
      bossProgress:Array.isArray(personal.bossProgress)?personal.bossProgress:[],
    };
    return {...clone(student),...Object.fromEntries(PERSONAL_FIELDS.filter(field=>Object.hasOwn(normalized,field)).map(field=>[field,clone(normalized[field])]))};
  })};
}
