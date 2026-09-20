const clone=value=>structuredClone(value);
const PERSONAL_FIELDS=['tokens','lotteryTickets','petAffection','lastPetMoodDate','equippedLayout','bossProgress'];

export function mergeStudentStatesIntoProgress(progress,states={}){
  if(!progress) return progress;
  const byStudentId=new Map(Object.values(states||{}).filter(state=>Number.isInteger(state?.studentId)).map(state=>[state.studentId,state]));
  return {...clone(progress),students:(progress.students||[]).map(student=>{
    const personal=byStudentId.get(student.id);
    if(!personal) return clone(student);
    const normalized={...personal,
      equippedLayout:Array.isArray(personal.equippedLayout)?personal.equippedLayout:[],
      bossProgress:Array.isArray(personal.bossProgress)?personal.bossProgress:[],
    };
    return {...clone(student),...Object.fromEntries(PERSONAL_FIELDS.filter(field=>Object.hasOwn(normalized,field)).map(field=>[field,clone(normalized[field])]))};
  })};
}
