import {applyStudentOperation} from './student-operations.mjs';
import {createStudentProjections} from './student-projections.mjs';

const PERSONAL_FIELDS=['tokens','lotteryTickets','petAffection','lastPetMoodDate','equippedLayout','bossProgress'];
const CONDITIONAL_COMMANDS=new Set(['petMood','bossAttack']);
const ADDITIVE_COMMANDS=new Set(['completeTask','purchase','lottery','coopComplete']);
const clone=value=>value===undefined?undefined:structuredClone(value);
const equal=(left,right)=>JSON.stringify(left??null)===JSON.stringify(right??null);

function personalState(student){
    if(!student) return null;
    return {
        studentId:student.id,
        tokens:Number(student.tokens)||0,
        lotteryTickets:Number(student.lotteryTickets)||0,
        petAffection:Number(student.petAffection)||0,
        lastPetMoodDate:typeof student.lastPetMoodDate==='string'?student.lastPetMoodDate:'',
        equippedLayout:Array.isArray(student.equippedLayout)?clone(student.equippedLayout):[],
        bossProgress:Array.isArray(student.bossProgress)?clone(student.bossProgress):[],
    };
}

function isAdditive(command,field){
    if(command.type==='resources') return command.mode==='add' && command.field===field;
    if(command.type==='petMood'||command.type==='bossAttack') return false;
    return ADDITIVE_COMMANDS.has(command.type) && ['tokens','lotteryTickets','petAffection'].includes(field);
}

function publicDataFor(projections,uid){
    return {
        studentPets:clone(projections.studentPets[uid]||{}),
        publicBosses:clone(projections.publicBosses||{}),
        publicQuestionPapers:clone(projections.publicQuestionPapers||{}),
    };
}

export function createTeacherSyncPlan({beforeProgress,afterProgress,command,result,uidByStudentId,clock}){
    const beforeById=new Map((beforeProgress?.students||[]).map(item=>[item.id,item]));
    const afterById=new Map((afterProgress?.students||[]).map(item=>[item.id,item]));
    const projections=createStudentProjections(afterProgress,uidByStudentId);
    const studentPlans={};
    for(const [key,uid] of Object.entries(uidByStudentId||{})){
        const studentId=Number(key),before=personalState(beforeById.get(studentId)),after=personalState(afterById.get(studentId));
        if(!after){
            if(before) studentPlans[uid]={uid,studentId,delete:true,clock};
            continue;
        }
        if(CONDITIONAL_COMMANDS.has(command.type)&&command.studentId===studentId){
            studentPlans[uid]={uid,studentId,strategy:'studentCommand',command:clone(command),
                publicData:publicDataFor(projections,uid),clock,result:clone(result)};
            continue;
        }
        const changes={};
        for(const field of PERSONAL_FIELDS){
            const previous=before?.[field],next=after[field];
            if(command.type!=='restore'&&equal(previous,next)) continue;
            if(command.type==='resetBossProgress'&&field==='bossProgress'){
                changes[field]={mode:'removeBoss',bossId:command.bossId};
            }else if(before&&isAdditive(command,field)&&typeof previous==='number'&&typeof next==='number'){
                changes[field]={mode:command.type==='resources'&&field==='lotteryTickets'?'addClamped':'add',amount:next-previous};
            }else changes[field]={mode:'set',value:clone(next)};
        }
        if(!before||Object.keys(changes).length) studentPlans[uid]={uid,studentId,strategy:'changes',
            baseState:after,changes,clock,result:clone(result)};
    }
    return {studentPlans,studentPets:projections.studentPets,publicBosses:projections.publicBosses,
        publicQuestionPapers:projections.publicQuestionPapers};
}

function defeatedBossResult(state,command){
    const progress=(state.bossProgress||[]).find(item=>item.bossId===command.bossId);
    if(!progress?.defeated&&progress?.hp>0) return null;
    return {correct:false,damage:0,hp:Math.max(0,progress?.hp||0),defeated:true,reward:0,rewardTickets:0,passwordVerified:progress?.passwordVerified===true};
}

export function applyTeacherStudentPlan(currentState,plan,operationId){
    if(plan.delete) return {state:null,result:clone(plan.result)||{ok:true},alreadyApplied:currentState===null};
    const marker=currentState?._teacherOperation;
    if(marker?.id===operationId&&marker.resultJson) return {state:clone(currentState),result:JSON.parse(marker.resultJson),alreadyApplied:true};
    let next=currentState?clone(currentState):clone(plan.baseState);
    if(!next||!Number.isInteger(next.studentId)) throw new Error('尚未建立學生資料');
    let result=clone(plan.result)||{ok:true};
    if(plan.strategy==='studentCommand'){
        try{
            const applied=applyStudentOperation(next,plan.command,plan.publicData,plan.clock);
            next=applied.state;result=applied.result;
        }catch(error){
            const defeated=plan.command.type==='bossAttack'&&/已擊敗/.test(error.message)?defeatedBossResult(next,plan.command):null;
            if(!defeated) throw error;
            result=defeated;
        }
    }else{
        for(const [field,change] of Object.entries(plan.changes||{})){
            if(change.mode==='add') next[field]=(Number(next[field])||0)+change.amount;
            else if(change.mode==='addClamped') next[field]=Math.max(0,(Number(next[field])||0)+change.amount);
            else if(change.mode==='removeBoss') next[field]=(Array.isArray(next[field])?next[field]:[]).filter(item=>item?.bossId!==change.bossId);
            else next[field]=clone(change.value);
        }
    }
    next._teacherOperation={id:operationId,createdAt:plan.clock,resultJson:JSON.stringify(result)};
    return {state:next,result,alreadyApplied:false};
}

export function stripTeacherOperationMarker(currentState,operationId){
    if(currentState?._teacherOperation?.id!==operationId) return clone(currentState);
    const next=clone(currentState);
    delete next._teacherOperation;
    return next;
}
