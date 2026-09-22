const clone=value=>structuredClone(value);
const taiwanDate=now=>new Date(Number(now)+8*60*60*1000).toISOString().slice(0,10);
const PET_ATTACK={R:5,SR:6,SSR:7,UR:8};

export function applyStudentOperation(previous,command,publicData,now=Date.now()){
    const state=clone(previous);
    if(!state || !Number.isInteger(state.studentId)) throw new Error('學生狀態不正確');
    let result;
    if(command.type==='petMood'){
        const oldLevel=Math.floor((state.petAffection||0)/10)+1;
        if(state.lastPetMoodDate===taiwanDate(now)) return {state,result:{awarded:false,bonus:0,level:oldLevel}};
        state.petAffection=(state.petAffection||0)+1;state.lastPetMoodDate=taiwanDate(now);
        const level=Math.floor(state.petAffection/10)+1,bonus=(level-oldLevel)*10;
        state.tokens=(state.tokens||0)+bonus;
        return {state,result:{awarded:true,bonus,level}};
    }
    if(command.type==='equipPet'){
        if(command.petId!==null && !publicData.studentPets?.[command.petId]) throw new Error('尚未擁有這隻寵物');
        state.equippedLayout=command.petId===null?[]:[command.petId];
        return {state,result:{ok:true}};
    }
    if(command.type==='bossAttack'){
        const boss=publicData.publicBosses?.[command.bossId];
        if(!boss?.active) throw new Error('BOSS 已停用或不存在');
        const questions=publicData.publicQuestionPapers?.[boss.paperId]?.questions||[];
        const question=questions.find(item=>item.id===command.questionId);
        if(!question) throw new Error('這道題目已不存在');
        state.bossProgress??=[];
        let progress=state.bossProgress.find(item=>item.bossId===boss.id);
        if(!progress){progress={bossId:boss.id,hp:boss.maxHp,passwordVerified:false,answeredQuestionIds:[],defeated:false,completedAt:null};state.bossProgress.push(progress);}
        progress.answeredQuestionIds=Array.isArray(progress.answeredQuestionIds)?progress.answeredQuestionIds:[];
        if(progress.defeated||progress.hp<=0) throw new Error('你已擊敗這隻 BOSS');
        if(!progress.passwordVerified){if(command.password!==boss.attackPassword) throw new Error('攻打密碼錯誤');progress.passwordVerified=true;}
        if(!Number.isInteger(command.answerIndex)||command.answerIndex<0||command.answerIndex>=question.options.length) throw new Error('請選擇有效答案');
        const alreadyCorrect=progress.answeredQuestionIds.includes(question.id),allUsed=questions.every(item=>progress.answeredQuestionIds.includes(item.id));
        if(alreadyCorrect&&!allUsed) throw new Error('這道題目已經答對過了');
        if(command.answerIndex!==question.answerIndex){
            progress.hp+=5;
            return {state,result:{correct:false,damage:0,healing:5,hp:progress.hp,defeated:false,reward:0,rewardTickets:0,passwordVerified:true}};
        }
        const pet=publicData.studentPets?.[state.equippedLayout?.[0]],level=Math.floor((state.petAffection||0)/10)+1,damage=(PET_ATTACK[pet?.level]??5)+level-1;
        if(!alreadyCorrect) progress.answeredQuestionIds.push(question.id);
        progress.hp=Math.max(0,progress.hp-damage);let reward=0,rewardTickets=0;
        if(progress.hp===0){progress.defeated=true;progress.completedAt=Number(now);reward=boss.reward||0;rewardTickets=boss.rewardTickets||0;state.tokens=(state.tokens||0)+reward;state.lotteryTickets=(state.lotteryTickets||0)+rewardTickets;}
        result={correct:true,damage,hp:progress.hp,defeated:progress.defeated,reward,rewardTickets,passwordVerified:true};
        return {state,result};
    }
    throw new Error('不支援的學生操作');
}
