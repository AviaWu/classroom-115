// One transport operation/receipt, with immutable original click identities.
export const isCoopCommand=command=>['coopComplete','coopCompleteBatch'].includes(command?.type);
const operationId=id=>typeof id==='string'&&id.length>0&&id.length<=128&&/^[\w-]+$/.test(id)&&!['__proto__','constructor','prototype'].includes(id);
const taskId=id=>(typeof id==='string'&&id.length>0)||(typeof id==='number'&&Number.isFinite(id));
export function validateCoopBatch(command){
    if(command?.type!=='coopCompleteBatch') return;
    if(!taskId(command.taskId)||!Array.isArray(command.members)||command.members.length<2||command.members.length>1000||
        Object.keys(command).some(key=>!['type','taskId','members'].includes(key))) throw new Error('協力批次格式不正確');
    const ids=new Set(),students=new Set();
    for(const member of command.members){
        if(!member||typeof member!=='object'||Object.keys(member).sort().join(',')!=='createdAt,id,studentId'||
            !operationId(member.id)||!Number.isInteger(member.studentId)||member.studentId<1||
            !Number.isFinite(member.createdAt)||member.createdAt<0||ids.has(member.id)||students.has(member.studentId)){
            throw new Error('協力批次成員或識別碼不正確／重複');
        }
        ids.add(member.id);students.add(member.studentId);
    }
}
export function validateBatchJob(job){
    validateCoopBatch(job.command);
    if(job.command?.type!=='coopCompleteBatch') return;
    if(job.id!==job.command.members[0].id||job.createdAt!==Math.min(...job.command.members.map(member=>member.createdAt))){
        throw new Error('協力批次識別碼或原始時間不正確');
    }
}
export const operationTimes=job=>job.command?.type==='coopCompleteBatch'?job.command.members.map(member=>member.createdAt):[job.createdAt];
export const pendingMembers=job=>job.members||[job];
export const storedJob=({id,key,command,createdAt,started,members})=>({id,key,command,createdAt,...(started?{started:true}:{}),...(members?{members:members.map(storedJob)}:{})});
export function batchResultFor(job,member,result){
    if(!job.members) return result;
    const entries=result?.members;
    if(!Array.isArray(entries)||entries.length!==job.members.length||
        new Set(entries.map(entry=>entry?.id)).size!==entries.length||
        entries.some(entry=>!entry?.result||typeof entry.result.claimed!=='boolean')||
        entries.filter(entry=>entry.result.claimed).length>1){
        throw Object.assign(new Error('協力批次回應格式不完整，保留原批次待確認。'),{retryable:true});
    }
    const entry=entries.find(entry=>entry.id===member.id);
    if(!entry) throw Object.assign(new Error('協力批次回應缺少成員結果，保留原批次待確認。'),{retryable:true});
    return entry.result;
}
export function queuedCoopBatch(jobs,job){
    if(job.started||job.restored||job.command.type!=='coopComplete') return [job];
    const selected=[],students=new Set();
    for(const next of jobs.slice(jobs.indexOf(job))){
        if(next.started||next.restored||next.command.type!=='coopComplete'||next.command.taskId!==job.command.taskId||students.has(next.command.studentId)) break;
        selected.push(next);students.add(next.command.studentId);
        if(selected.length===1000) break;
    }
    return selected;
}
export function freezeCoopBatch(members){
    const first=members[0];
    return {id:first.id,key:first.key,createdAt:Math.min(...members.map(member=>member.createdAt)),started:true,members,
        command:{type:'coopCompleteBatch',taskId:first.command.taskId,members:members.map(({id,createdAt,command})=>({id,createdAt,studentId:command.studentId}))}};
}
