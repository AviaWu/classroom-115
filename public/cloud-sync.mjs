// The browser never uploads a local snapshot. Only explicit commands may write.
export function createCloudSync(io) {
    let connected=false,active=true,verified=false,remote,reading=null,working=false,workPromise=null,rejections=0;
    let epoch=0,writeEpoch=0,readAgain=false,artworkCleanup=null,unsubscribeRemote=null,disposed=false;
    const receiptReads=new Map(),receiptMisses=new Map();
    const receiptClock=io.now||Date.now,receiptMissDelay=5_000;
    const resetReceipts=()=>{receiptReads.clear();receiptMisses.clear();};
    const jobs=(io.loadPending?.()||[]).map(job=>({...job,restored:true}));
    const canManage=()=>connected && active && verified;
    const canEdit=()=>canManage() && remote!==null;
    const persist=()=>io.persistPending?.(jobs.map(({id,key,command,createdAt})=>({id,key,command,createdAt})));
    const lock=()=>io.lock(!canEdit());
    const apply=(value,studentStates)=>{remote=structuredClone(value);io.applyState(structuredClone(value),studentStates&&structuredClone(studentStates));void cleanupEvictedArtworks();};
    const notify=()=>{lock();io.status(connected && verified ? '' : '離線中');};
    const transient=e=>e.retryable===true || e.name==='AbortError' || e instanceof TypeError;
    const stopSubscription=()=>{unsubscribeRemote?.();unsubscribeRemote=null;};
    function startSubscription(){
        if(!io.subscribeRemote || unsubscribeRemote || !connected || !active) return;
        const ticket=epoch;
        unsubscribeRemote=io.subscribeRemote((value,studentStates)=>{
            if(ticket!==epoch || !connected || !active) return;
            apply(value,studentStates);verified=true;notify();void checkReceipts().then(()=>{
                if(ticket===epoch) return work();
            }).catch(error=>{
                if(ticket!==epoch || !connected || !active) return;
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
        const index=jobs.indexOf(job);if(index<0) return;
        jobs.splice(index,1);receiptMisses.delete(job);
        try{persist();}catch(storageError){io.error?.(storageError);}
        if(error){rejections++;job.reject?.(error);}else job.resolve?.(result);
    }
    function work(){
        if(working) return workPromise;
        if(!canManage() || !jobs.some(job=>!job.restored)) return Promise.resolve();
        working=true;
        workPromise=(async()=>{
            try{
                while(canManage()){
                    const job=jobs.find(item=>!item.restored);
                    if(!job) break;
                    const ticket=epoch;
                    writeEpoch++;
                    try{
                        const outcome=await io.execute(job,jobs.map(item=>item.id));
                        writeEpoch++;
                        if(outcome.equipment){
                            // REST acknowledgements and SDK events have no shared revision.
                            // Never replace an ordered stream with an equipment response:
                            // it may arrive after another device changed the same field.
                            if(!io.subscribeRemote && ticket===epoch && connected && active){
                                const value=await io.readRemote();
                                if(ticket===epoch && connected && active) apply(value);
                            }
                        }else if(ticket===epoch && connected && active) apply(outcome.progress,outcome.studentStates);
                        settle(job,null,outcome.result);
                    }catch(error){
                        writeEpoch++;
                        if(transient(error)){
                            if(ticket===epoch){verified=false;notify();}
                            break; // Retain original ID. A successful server read precedes retry.
                        }
                        settle(job,error);
                        io.error?.(error);
                        void refresh();
                    }
                }
            }finally{working=false;lock();}
        })();
        return workPromise;
    }
    function checkReceipts(force=false){
        if(!connected || !active || !io.readReceipt) return Promise.resolve();
        const ticket=epoch;
        return Promise.all(jobs.filter(job=>job.restored).map(job=>{
            if(receiptReads.has(job)) return receiptReads.get(job);
            if(!force && receiptMisses.has(job) && receiptClock()<receiptMisses.get(job)) return;
            const current=()=>ticket===epoch && connected && active && job.restored && jobs.includes(job);
            const query=Promise.resolve().then(()=>{
                if(current()) return io.readReceipt(job.id);
            }).then(receipt=>{
                if(!current()) return;
                if(receipt){
                    settle(job,null,receipt.result);
                    io.recovered?.(job.command,receipt.result);
                }else{
                    // Absence also covers a still-projecting receipt, never a
                    // failed command. Only snapshot-driven negative reads cool down.
                    receiptMisses.set(job,receiptClock()+receiptMissDelay);
                }
            }).catch(error=>{if(current()) throw error;}).finally(()=>{
                if(receiptReads.get(job)===query) receiptReads.delete(job);
            });
            receiptReads.set(job,query);
            return query;
        }));
    }
    function refresh(){
        if(!connected || !active) return Promise.resolve(false);
        if(reading) return reading;
        reading=(async()=>{
            do{
                readAgain=false;
                const ticket=epoch,writeTicket=writeEpoch;
                let value;
                try{value=await io.readRemote();}
                catch(error){
                    if(ticket===epoch) throw error;
                    readAgain=connected&&active;continue;
                }
                if(ticket!==epoch || !connected || !active){readAgain=connected&&active;continue;}
                // A read begun before/during a command cannot reverse its acknowledgement.
                if(writeTicket===writeEpoch && !working) apply(value);
                verified=true;notify();void cleanupEvictedArtworks();
                await checkReceipts(true);
                if(ticket!==epoch) readAgain=connected&&active;
            }while(readAgain);
            void work();
            return canManage();
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
        job.restored=false;receiptMisses.delete(job);
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
            const ticket=epoch,rejectionTicket=rejections;
            try{
                // Queue drain is not a fresh snapshot API. Backups still call
                // readCompleteProgress separately; polling integrations refresh.
                if(io.subscribeRemote && canManage()) await checkReceipts(true);
                else if(!await refresh()) return false;
                if(ticket!==epoch || !canManage()) return false;
                await work();
                return ticket===epoch && rejectionTicket===rejections && canManage() && jobs.length===0;
            }catch(error){
                if(ticket===epoch){verified=false;notify();io.error?.(error);}
                return false;
            }
        },
        setConnected(value){
            if(disposed || connected===value) return;
            connected=value;verified=false;epoch++;resetReceipts();lock();stopSubscription();
            if(value){if(io.subscribeRemote)startSubscription();else void refresh();}else io.status('離線中');
        },
        setActive(value){
            if(disposed || active===value) return;
            active=value;verified=false;epoch++;resetReceipts();lock();stopSubscription();
            if(value){if(io.subscribeRemote)startSubscription();else void refresh();}
        },
        dispose(){disposed=true;active=false;verified=false;epoch++;resetReceipts();(io.clearInterval||globalThis.clearInterval)(timer);stopSubscription();lock();},
    };
}
