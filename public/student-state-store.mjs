import {applyStudentOperation} from './student-operations.mjs';

export function createStudentStateStore({uid,transactState,getPublicData,now=Date.now}){
    if(typeof uid!=='string'||!uid) throw new Error('學生 UID 不正確');
    if(typeof transactState!=='function') throw new Error('學生交易函式不正確');
    return {async perform(command){
        let settled;
        const transaction=await transactState(current=>{
            if(!current) throw new Error('尚未建立學生資料');
            settled=applyStudentOperation(current,command,getPublicData(),now());
            return settled.state;
        },`studentStates/${uid}`);
        if(!transaction?.committed) throw new Error('學生狀態交易未完成');
        return settled?.result;
    }};
}
