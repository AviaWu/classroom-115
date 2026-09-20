const clone=value=>structuredClone(value);

function personalState(student){
    const {id:studentId,tokens=0,lotteryTickets=0,petAffection=0,lastPetMoodDate='',equippedLayout=[],bossProgress=[]}=student;
    return {studentId,tokens,lotteryTickets,petAffection,lastPetMoodDate,equippedLayout:clone(equippedLayout),bossProgress:clone(bossProgress)};
}

export function createStudentProjections(progress,uidByStudentId){
    const studentStates={},studentPets={},studentRoster={};
    const layouts=new Map((progress.layouts||[]).map(item=>[item.id,item]));
    for(const [key,uid] of Object.entries(uidByStudentId||{})){
        const studentId=Number(key),student=progress.students?.[studentId-1];
        if(!Number.isInteger(studentId) || studentId<1 || studentId>28 || typeof uid!=='string' || !student || student.id!==studentId) continue;
        const state=personalState(student);
        const ownedLayout=Array.isArray(student.ownedLayout)?student.ownedLayout:[];
        const pets=Object.fromEntries(ownedLayout.map(id=>layouts.get(id)).filter(Boolean).map(({id,name,image,level})=>[id,{id,name,image,level}]));
        state.equippedLayout=state.equippedLayout.filter(id=>pets[id]).slice(0,1);
        studentStates[uid]=state;
        studentRoster[uid]={studentId,active:true};
        studentPets[uid]=pets;
    }
    const activeBosses=(progress.bosses||[]).filter(boss=>boss.active!==false);
    const wantedPapers=new Set(activeBosses.map(boss=>boss.paperId).filter(Boolean));
    const publicBosses=Object.fromEntries(activeBosses.map(({id,name,image,maxHp,reward,rewardTickets,attackPassword,paperId,active})=>[id,{id,name,image,maxHp,reward,rewardTickets,attackPassword,paperId,active:true}]));
    const publicQuestionPapers=Object.fromEntries((progress.questionPapers||[]).filter(paper=>wantedPapers.has(paper.id)).map(paper=>[paper.id,{id:paper.id,questions:clone(paper.questions||[])}]));
    return {studentRoster,studentStates,studentPets,publicBosses,publicQuestionPapers};
}

export function studentProjectionToProgress({studentState,studentPets={},publicBosses={},publicQuestionPapers={}}){
    if(!studentState || !Number.isInteger(studentState.studentId)) return null;
    const {_teacherOperation,...visibleState}=studentState;
    return {
        students:[{...clone(visibleState),id:studentState.studentId,ownedLayout:Object.keys(studentPets)}],layouts:Object.values(studentPets).map(clone),bosses:Object.values(publicBosses).map(clone),
        questionPapers:Object.values(publicQuestionPapers).map(clone),tasks:[],clothesM:[],clothesF:[],backgrounds:[],
        coopTasks:[],coopTaskTemplates:[],dailyTaskTemplates:[],weeklyTaskTemplates:[],deletedTaskIds:[],deletedCoopTaskIds:[],
        drawings:[],pendingArtworkDeletes:[],globalBgImage:'',lastSaved:'',
    };
}
