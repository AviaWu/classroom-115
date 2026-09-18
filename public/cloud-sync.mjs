// The browser never uploads a local snapshot. Only explicit commands may write.
export function createCloudSync(io) {
    let connected=false,active=true,verified=false,remote,reading=null,working=false;
    let epoch=0,writeEpoch=0,readAgain=false,artworkCleanup=null,unsubscribeRemote=null;
    const jobs=(io.loadPending?.()||[]).map(job=>({...job,restored:true}));
    const canManage=()=>connected && active && verified;
    const canEdit=()=>canManage() && remote!==null;
    const persist=()=>io.persistPending?.(jobs.map(({id,key,command,createdAt})=>({id,key,command,createdAt})));
    const lock=()=>io.lock(!canEdit());
    const apply=value=>{remote=structuredClone(value);io.applyState(structuredClone(value));void cleanupEvictedArtworks();};
    const notify=()=>{lock();io.status(connected && verified ? '' : '離線中');};
    const transient=e=>e.retryable===true || e.name==='AbortError' || e instanceof TypeError;
    const stopSubscription=()=>{unsubscribeRemote?.();unsubscribeRemote=null;};
    function startSubscription(){
        if(!io.subscribeRemote || unsubscribeRemote || !connected || !active) return;
        const ticket=epoch;
        unsubscribeRemote=io.subscribeRemote(value=>{
            if(ticket!==epoch || !connected || !active) return;
            apply(value);verified=true;notify();void checkReceipts().then(()=>work()).catch(error=>{
                verified=false;notify();io.error?.(error);
            });
        },error=>{
            if(ticket!==epoch) return;
            verified=false;notify();
            if(!transient(error)) io.error?.(error);
        });
    }
    function cleanupEvictedArtworks(){
        if(artworkCleanup) return artworkCleanup;
        if(!canEdit() || typeof io.deleteArtwork!=='function') return Promise.resolve();
        artworkCleanup=Promise.resolve().then(async()=>{
            const attempted=new Set();
            while(canEdit()){
                const retained=new Set((remote?.drawings||[]).map(item=>item.id));
                const id=(remote?.pendingArtworkDeletes||[]).find(id=>!attempted.has(id) && !retained.has(id));
                if(!id) break;
                attempted.add(id);
                try{
                    await io.deleteArtwork(id);
                    if(!canEdit()) break;
                    if((remote.drawings||[]).some(item=>item.id===id)) continue;
                    await perform({type:'confirmArtworkDeletion',drawingId:id},`artwork-delete:${id}`);
                }catch(error){
                    // A failed delete stays in progress for a later snapshot/reconnect.
                    // Do not turn a separate artwork request into a gameplay outage.
                    io.error?.(error);
                }
            }
        }).finally(()=>{artworkCleanup=null;});
        return artworkCleanup;
    }
    function settle(job,error,result){
        const index=jobs.indexOf(job);if(index>=0) jobs.splice(index,1);
        try{persist();}catch(storageError){io.error?.(storageError);}
        if(error) job.reject?.(error);else job.resolve?.(result);
    }
    async function work(){
        if(working || !canManage()) return;
        working=true;
        try{
            while(canManage()){
                const job=jobs.find(item=>!item.restored);
                if(!job) break;
                writeEpoch++;
                try{
                    const outcome=await io.execute(job,jobs.map(item=>item.id));
                    writeEpoch++;
                    apply(outcome.progress);
                    settle(job,null,outcome.result);
                }catch(error){
                    writeEpoch++;
                    if(transient(error)){
                        verified=false;notify();
                        break; // Retain original ID. A successful server read precedes retry.
                    }
                    settle(job,error);
                    io.error?.(error);
                    void refresh();
                }
            }
        }finally{working=false;lock();}
    }
    async function checkReceipts(){
        for(const job of [...jobs]){
            if(!job.restored || !io.readReceipt) continue;
            const receipt=await io.readReceipt(job.id);
            if(receipt){
                settle(job,null,receipt.result);
                io.recovered?.(job.command,receipt.result);
            }
        }
    }
    function refresh(){
        if(!connected || !active) return Promise.resolve(false);
        if(reading) return reading;
        reading=(async()=>{
            do{
                readAgain=false;
                const ticket=epoch,writeTicket=writeEpoch;
                const value=await io.readRemote();
                if(ticket!==epoch || !connected || !active){readAgain=connected&&active;continue;}
                // A read begun before/during a command cannot reverse its acknowledgement.
                if(writeTicket===writeEpoch && !working) apply(value);
                verified=true;notify();void cleanupEvictedArtworks();
                await checkReceipts();
            }while(readAgain);
            void work();
            return true;
        })().catch(error=>{
            verified=false;lock();
            if(transient(error)) io.status('離線中');else io.error?.(error);
            return false;
        }).finally(()=>{reading=null;});
        return reading;
    }
    function equivalent(a,b){
        if(a.type!==b.type) return false;
        if(a.type==='lottery') return a.studentId===b.studentId;
        if(a.type==='saveDrawing') return a.drawing.data===b.drawing.data;
        return JSON.stringify(a)===JSON.stringify(b);
    }
    function perform(command,key=JSON.stringify(command)){
        const sameControl=jobs.filter(job=>job.key===key);
        const existing=sameControl.find(job=>equivalent(job.command,command));
        if(!existing && sameControl.some(job=>job.restored)){
            return Promise.reject(new Error('這個功能還有一筆未確認操作，請先到老師後台的備份頁確認上次操作，再送出新內容。'));
        }
        if(existing?.promise) return existing.promise;
        if(!canManage() || (remote===null && !['initialize','restore'].includes(command.type))) {
            return Promise.reject(new Error(connected && verified ? '雲端尚無資料，請由老師初始化或還原備份。' : '離線中'));
        }
        const job=existing || {id:io.newId(),createdAt:io.now?.()??Date.now(),key,command:structuredClone(command)};
        job.restored=false;
        job.promise=new Promise((resolve,reject)=>{job.resolve=resolve;job.reject=reject;});
        if(!existing) jobs.push(job);
        try{persist();}catch(error){settle(job,error);return job.promise;}
        void work();
        return job.promise;
    }
    const timer=(io.setInterval||globalThis.setInterval)(()=>{if(!io.subscribeRemote)void refresh();},60_000);
    return {
        available:true,canEdit,canManage,perform,refresh,cleanupEvictedArtworks,
        editToken:()=>epoch,
        hasPendingSave:()=>jobs.length>0,
        pendingActions:()=>jobs.map(({id,key,command,createdAt})=>({id,key,command,createdAt})),
        async flush(){
            await refresh();
            if(!canManage()) return false;
            const pending=jobs.filter(job=>job.promise).map(job=>job.promise);
            try{await Promise.all(pending);return jobs.length===0;}catch{return false;}
        },
        setConnected(value){
            if(connected===value) return;
            connected=value;verified=false;epoch++;lock();stopSubscription();
            if(value){if(io.subscribeRemote)startSubscription();else void refresh();}else io.status('離線中');
        },
        setActive(value){
            if(active===value) return;
            active=value;verified=false;epoch++;lock();stopSubscription();
            if(value){if(io.subscribeRemote)startSubscription();else void refresh();}
        },
        dispose(){(io.clearInterval||globalThis.clearInterval)(timer);stopSubscription();active=false;epoch++;},
    };
}
