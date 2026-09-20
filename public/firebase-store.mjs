import {applyOperation,normalizeProgress} from './game-operations.mjs';
import {createStudentProjections} from './student-projections.mjs';
import {mergeStudentStatesIntoProgress} from './teacher-projections.mjs';
import {applyTeacherStudentPlan,createTeacherSyncPlan,stripTeacherOperationMarker} from './teacher-sync-plan.mjs';

const PROGRESS_FIELDS=['students','tasks','clothesM','clothesF','layouts','backgrounds','boss','bosses','coopTasks',
    'coopTaskTemplates','dailyTaskTemplates','weeklyTaskTemplates','deletedTaskIds','deletedCoopTaskIds',
    'drawings','pendingArtworkDeletes','globalBgImage','lastSaved'];

export function createProgressSubscriber({database,getToken,ref,onValue,path='games/classroom-115/progress'}) {
    return (onProgress,onError)=>{
        let stopped=false,unsubscribers=[];
        const report=error=>{if(!stopped) onError(error);};
        void Promise.resolve().then(getToken).then(()=>{
            if(stopped) return;
            const values={},loaded=new Set();
            const publish=()=>{
                if(stopped || loaded.size!==PROGRESS_FIELDS.length) return;
                const entries=Object.entries(values).filter(([,value])=>value!==null);
                if(!entries.length){onProgress(null);return;}
                const progress=normalizeProgress(Object.fromEntries(entries));
                if(!progress?.students.length) throw new Error('雲端資料格式不正確：缺少成員，已停止操作。');
                onProgress(progress);
            };
            unsubscribers=PROGRESS_FIELDS.map(field=>onValue(ref(database,`${path}/${field}`),snapshot=>{
                if(stopped) return;
                values[field]=snapshot.val();loaded.add(field);
                try{publish();}catch(error){report(error);}
            },report));
        }).catch(report);
        return ()=>{stopped=true;for(const unsubscribe of unsubscribers)unsubscribe();unsubscribers=[];};
    };
}

export function createStudentProjectionSubscriber({database,uid,ref,onValue}){
    if(typeof uid!=='string' || !uid) throw new Error('學生 UID 不正確');
    return (onProjection,onError)=>{
        let stopped=false;
        const values={},loaded=new Set();
        const paths={
            studentState:`studentStates/${uid}`,
            studentPets:`studentPets/${uid}`,
            publicBosses:'publicBosses',
            publicQuestionPapers:'publicQuestionPapers',
        };
        const publish=()=>{
            if(stopped || loaded.size!==Object.keys(paths).length) return;
            onProjection({...values});
        };
        const unsubscribers=Object.entries(paths).map(([key,path])=>onValue(ref(database,path),snapshot=>{
            if(stopped) return;
            values[key]=snapshot.val()||{};loaded.add(key);publish();
        },error=>{if(!stopped) onError(error);}));
        return ()=>{stopped=true;for(const unsubscribe of unsubscribers) unsubscribe();};
    };
}

export function createTeacherStudentStatesSubscriber({database,ref,onValue}){
    return (onStates,onError)=>onValue(ref(database,'studentStates'),snapshot=>onStates(snapshot.val()||{}),onError);
}

// REST handles direct reads and artwork payloads. The teacher page serializes commands
// in a room transaction and projects personal changes through per-student transactions.
export function createFirebaseStore({databaseURL,path='games/classroom-115',getToken,getUid,now=Date.now,fetch:request=globalThis.fetch,transactRoom,transactRoot,readRoot,writeRoot,transactStudentState}) {
    function assertArtworkId(id) {
        if(typeof id !== 'string' || id.length < 8 || id.length > 128 || !/^drawing_[A-Za-z0-9_-]+$/.test(id)) throw new Error('畫作編號格式不正確');
        return id;
    }
    function validArtworkTimestamp(value) {
        if(typeof value !== 'string' || value.length < 20 || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,19})?Z$/.test(value)) return false;
        const timestamp=Date.parse(value);
        return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0,19)===value.slice(0,19);
    }
    function validateArtwork(drawing) {
        if(!drawing || typeof drawing !== 'object' || Array.isArray(drawing) ||
            Object.keys(drawing).length !== 3 || !Object.hasOwn(drawing,'id') || !Object.hasOwn(drawing,'savedAt') || !Object.hasOwn(drawing,'data') ||
            !validArtworkTimestamp(drawing.savedAt) ||
            typeof drawing.data !== 'string' || drawing.data.length > 1_500_000 || !/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]*={0,2}$/.test(drawing.data)) throw new Error('畫作資料格式不正確');
        assertArtworkId(drawing.id);
        return drawing;
    }
    const artworkPath=id=>`artworks/classroom-115/${encodeURIComponent(assertArtworkId(id))}`;
    async function callPath(targetPath,options={}){
        const controller=new AbortController();
        let timeout;
        const deadline=new Promise((_,reject)=>{
            timeout=setTimeout(()=>{controller.abort();reject(Object.assign(new Error('雲端連線逾時'),{name:'AbortError',retryable:true}));},15000);
        });
        const operation=(async()=>{
            const token=await getToken();
            // Firebase rejects print=silent when a conditional ETag header is
            // present. Keep silent responses for unconditional artwork writes;
            // room transactions must retain If-Match for conflict safety.
            const silent=options.method==='PUT' && !options.headers?.['if-match'];
            const response=await request(`${databaseURL}/${targetPath}.json?auth=${encodeURIComponent(token)}${silent?'&print=silent':''}`,{
                ...options,cache:'no-store',signal:controller.signal,
            });
            if(!response.ok && response.status!==412){
                const detail=(await response.text()).trim();
                const error=new Error(`雲端存取失敗 (${response.status})${detail?`: ${detail}`:''}`);
                error.retryable=response.status>=500 || response.status===408 || response.status===429;
                throw error;
            }
            try{
                return {status:response.status,headers:response.headers,value:response.status===412 || response.status===204?null:await response.json()};
            }catch(error){
                if(options.method==='PUT') error.retryable=true; // The server may already have committed.
                throw error;
            }
        })();
        try{return await Promise.race([operation,deadline]);}
        finally{clearTimeout(timeout);}
    }
    const call=(suffix='',options={})=>callPath(`${path}${suffix}`,options);
    async function readArtwork(id){
        const {value}=await callPath(artworkPath(id));
        return value;
    }
    async function writeArtwork(drawing){
        validateArtwork(drawing);
        await callPath(artworkPath(drawing.id),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(drawing)});
        return {id:drawing.id,savedAt:drawing.savedAt};
    }
    async function deleteArtwork(id){
        await callPath(artworkPath(id),{method:'DELETE'});
    }
    function newestArtworks(drawings){
        if(!Array.isArray(drawings)) throw new Error('畫作資料格式不正確');
        const seen=new Set(),indexed=[];
        for(const drawing of drawings){
            validateArtwork(drawing);
            if(!seen.has(drawing.id)){seen.add(drawing.id);indexed.push(drawing);}
        }
        indexed.sort((a,b)=>Date.parse(b.savedAt)-Date.parse(a.savedAt));
        return indexed.slice(0,3);
    }
    function preflightArtwork(command){
        if(!command || typeof command !== 'object') return command;
        if(command.type==='saveDrawing') return {type:'saveDrawing',drawings:[validateArtwork(command.drawing)]};
        if(command.type==='restore'){
            const value=command.value;
            if(!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('畫作資料格式不正確');
            return {type:'restore',drawings:newestArtworks(Array.isArray(value.drawings)?value.drawings:[])};
        }
        return null;
    }
    function indexCommand(command,artwork){
        if(!artwork) return command;
        const drawings=artwork.drawings.map(({id,savedAt})=>({id,savedAt}));
        if(artwork.type==='saveDrawing') return {...command,drawing:drawings[0]};
        if(artwork.type==='restore'){
            return {...command,value:{...command.value,drawings}};
        }
        return command;
    }
    async function prepareCommand(command,artwork){
        if(!artwork) return command;
        if(artwork.type==='saveDrawing') return {...command,drawing:await writeArtwork(artwork.drawings[0])};
        if(artwork.type==='restore'){
            const drawings=await Promise.all(artwork.drawings.map(writeArtwork));
            return {...command,value:{...command.value,drawings}};
        }
        return command;
    }
    async function cleanupRejectedArtwork(artwork){
        if(artwork?.type!=='saveDrawing') return;
        try{await deleteArtwork(artwork.drawings[0].id);}
        catch(error){
            if(error.retryable || error.name==='AbortError' || error instanceof TypeError){error.retryable=true;throw error;}
        }
    }
    async function readRemote(){
        const {value}=await call('/progress');
        const normalized=normalizeProgress(value);
        if(value!==null && !normalized?.students.length) throw new Error("雲端資料格式不正確：缺少成員，已停止操作。");
        return normalized;
    }
    async function readReceipt(id){
        if(!/^[\w-]+$/.test(id)) throw new Error('操作識別碼無效');
        const {value:receipt}=await call(`/operations/${id}`);
        return receipt && receipt.phase!=='projecting' ? {...receipt,result:JSON.parse(receipt.result.json)} : null;
    }
    function retainedOperations(operations,pendingIds,clock){
        const pending=new Set(Array.isArray(pendingIds)?pendingIds:[]);
        const entries=Object.entries(operations||{});
        const protectedEntries=entries.filter(([id])=>pending.has(id));
        const protectedSet=new Set(protectedEntries.map(([id])=>id));
        const recent=entries.filter(([id,receipt])=>!protectedSet.has(id) && Number.isFinite(receipt?.committedAt) && receipt.committedAt>=clock-3_600_000)
            .sort(([idA,a],[idB,b])=>b.committedAt-a.committedAt || (b.createdAt||0)-(a.createdAt||0) || idA.localeCompare(idB));
        const slots=Math.max(0,99-protectedEntries.length);
        return Object.fromEntries([...protectedEntries,...recent.slice(0,slots)]);
    }
    async function executeSdkTransaction(job,pendingIds,artwork){
        if(now()-job.createdAt>24*60*60*1000){
            await cleanupRejectedArtwork(artwork);
            throw new Error('這筆未確認操作已超過一天，請先確認最新進度再重新操作。');
        }
        let command=await prepareCommand(job.command,artwork),settled;
        try{
            const rootTransaction=typeof transactRoot==='function';
            const transaction=await (transactRoot||transactRoom)(current=>{
                if(rootTransaction && current===null && !['initialize','restore'].includes(command.type)) return null;
                const root=rootTransaction?(current||{}):null;
                const room=rootTransaction?(root.games?.['classroom-115']||{}):(current||{});
                const receipt=room.operations?.[job.id];
                if(receipt){
                    settled={progress:normalizeProgress(room.progress??null),result:JSON.parse(receipt.result.json)};
                    return;
                }
                const clock=now();
                if(clock-job.createdAt>24*60*60*1000){
                    settled={error:new Error('這筆未確認操作已超過一天，請先確認最新進度再重新操作。')};
                    return;
                }
                if(room.restoredAt && job.createdAt<=room.restoredAt && !['restore','initialize'].includes(command.type)){
                    settled={error:new Error('老師已還原資料；這筆較早的操作已取消，請依最新進度重新操作。')};
                    return;
                }
                const progress=rootTransaction?mergeStudentStatesIntoProgress(room.progress??null,root.studentStates||{}):room.progress??null;
                const outcome=applyOperation(progress,command,clock);
                if(!outcome.changed){
                    settled={progress:outcome.progress,result:outcome.result||{ok:true}};
                    return;
                }
                const result={ok:true,...outcome.result};
                const next={...room,
                    progress:{...outcome.progress,lastSaved:new Date(clock).toISOString()},
                    operations:{...retainedOperations(room.operations,pendingIds,clock),[job.id]:{
                        id:job.id,uid:getUid(),type:command.type,createdAt:job.createdAt,
                        committedAt:{'.sv':'timestamp'},result:{json:JSON.stringify(result)},
                    }},
                    lastOperationId:job.id,
                };
                if(['restore','initialize'].includes(command.type)) next.restoredAt={'.sv':'timestamp'};
                settled={progress:normalizeProgress(next.progress),result};
                if(!rootTransaction) return next;
                const uidByStudentId=Object.fromEntries(Object.entries(root.studentRoster||{}).filter(([,entry])=>entry?.active===true&&Number.isInteger(entry.studentId)).map(([uid,entry])=>[entry.studentId,uid]));
                const projections=createStudentProjections(next.progress,uidByStudentId);
                return {...root,games:{...(root.games||{}),'classroom-115':next},...projections,studentRoster:root.studentRoster||projections.studentRoster};
            });
            if(settled?.error){await cleanupRejectedArtwork(artwork);throw settled.error;}
            if(!transaction.committed){
                if(settled) return settled;
                throw Object.assign(new Error('雲端交易未完成，稍後會重試。'),{retryable:true});
            }
            const saved=rootTransaction?transaction.value?.games?.['classroom-115']:transaction.value;
            const receipt=saved?.operations?.[job.id];
            if(saved?.progress && receipt?.result?.json){
                return {progress:normalizeProgress(saved.progress),result:JSON.parse(receipt.result.json),
                    ...(rootTransaction?{studentStates:transaction.value?.studentStates||{}}:{})};
            }
            if(settled) return settled;
            throw Object.assign(new Error('雲端交易回應不完整，稍後會重試。'),{retryable:true});
        }catch(error){
            if(error?.code?.includes('network') || error?.code==='database/disconnected') error.retryable=true;
            throw error;
        }
    }
    const markRetryable=error=>{
        if(error?.code?.includes('network') || error?.code==='database/disconnected') error.retryable=true;
        return error;
    };
    const uidMap=root=>Object.fromEntries(Object.entries(root.studentRoster||{})
        .filter(([,entry])=>entry?.active===true&&Number.isInteger(entry.studentId))
        .map(([uid,entry])=>[entry.studentId,uid]));
    function projectionUpdates(root,plan,mapping){
        const updates={};
        for(const uid of Object.values(mapping)){
            const desired=plan.studentPets?.[uid]||{},current=root.studentPets?.[uid]||{};
            if(JSON.stringify(current)!==JSON.stringify(desired)) updates[`studentPets/${uid}`]=Object.keys(desired).length?desired:null;
        }
        for(const key of ['publicBosses','publicQuestionPapers']){
            const desired=plan[key]||{};
            if(JSON.stringify(root[key]||{})!==JSON.stringify(desired)) updates[key]=desired;
        }
        return updates;
    }
    async function applyStudentProjection(operationId,studentPlan){
        let applied;
        try{
            const transaction=await transactStudentState(studentPlan.uid,current=>{
                applied=applyTeacherStudentPlan(current,studentPlan,operationId);
                return applied.state;
            });
            if(!transaction?.committed && !studentPlan.delete) throw new Error('學生資料同步交易未完成');
            return {uid:studentPlan.uid,state:transaction?.value??null,result:applied?.result??studentPlan.result??{ok:true}};
        }catch(error){throw markRetryable(error);}
    }
    async function cleanupStudentMarkers(operationId,uids){
        await Promise.allSettled((uids||[]).map(uid=>transactStudentState(uid,current=>stripTeacherOperationMarker(current,operationId))));
    }
    async function resumeProjection(root){
        const room=root.games?.['classroom-115']||{},syncPlan=room._projectionSync;
        if(!syncPlan?.operationId||!syncPlan.plan) return null;
        const operationId=syncPlan.operationId,plan=syncPlan.plan;
        const applied=await Promise.all(Object.values(plan.studentPlans||{}).map(studentPlan=>applyStudentProjection(operationId,studentPlan)));
        const states=Object.fromEntries(applied.map(entry=>[entry.uid,entry.state]).filter(([,state])=>state));
        const updates=projectionUpdates(root,plan,syncPlan.uidByStudentId||{});
        try{if(Object.keys(updates).length) await writeRoot(updates);}catch(error){throw markRetryable(error);}
        const latestRoot=(await readRoot())||{};
        const latestStates=latestRoot.studentStates||states;
        const fallbackRoom=latestRoot.games?.['classroom-115']||room;
        const conditionalResult=syncPlan.resultUid?applied.find(entry=>entry.uid===syncPlan.resultUid)?.result:null;
        const finalResult=conditionalResult||JSON.parse(room.operations?.[operationId]?.result?.json||'{"ok":true}');
        let settled;
        try{
            const transaction=await transactRoom(current=>{
                current=current??fallbackRoom;
                if(current?._projectionSync?.operationId!==operationId) return;
                const receipt=current.operations?.[operationId];
                let progress=mergeStudentStatesIntoProgress(current.progress??null,latestStates);
                const {_projectionSync,...withoutLock}=current;
                const committed={...receipt,phase:null,committedAt:{'.sv':'timestamp'},result:{json:JSON.stringify(finalResult)},
                    projectionUids:Object.keys(plan.studentPlans||{})};
                settled={progress:normalizeProgress(progress),result:finalResult};
                return {...withoutLock,progress:{...progress,lastSaved:new Date(now()).toISOString()},
                    operations:{...(current.operations||{}),[operationId]:committed},lastOperationId:operationId};
            });
            if(!transaction?.committed){
                const current=transaction?.value||{};
                const receipt=current.operations?.[operationId];
                if(receipt&&receipt.phase!=='projecting') settled={progress:normalizeProgress(current.progress),result:JSON.parse(receipt.result.json)};
                else throw Object.assign(new Error('老師同步鎖已變更，稍後會重試。'),{retryable:true});
            }
        }catch(error){throw markRetryable(error);}
        await cleanupStudentMarkers(operationId,Object.keys(plan.studentPlans||{}));
        return {...settled,studentStates:latestStates};
    }
    async function executeCoordinated(job,pendingIds,artwork){
        if(now()-job.createdAt>24*60*60*1000){
            await cleanupRejectedArtwork(artwork);
            throw new Error('這筆未確認操作已超過一天，請先確認最新進度再重新操作。');
        }
        let command;
        for(let attempt=0;attempt<20;attempt++){
            let root=(await readRoot())||{},room=root.games?.['classroom-115']||{};
            const existing=room.operations?.[job.id];
            if(existing&&existing.phase!=='projecting'){
                await cleanupStudentMarkers(job.id,existing.projectionUids||[]);
                return {progress:normalizeProgress(room.progress??null),result:JSON.parse(existing.result.json),studentStates:root.studentStates||{}};
            }
            if(room._projectionSync){
                await resumeProjection(root);
                continue;
            }
            command??=await prepareCommand(job.command,artwork);
            const mapping=uidMap(root),clock=now();let settled,blocked=false;
            try{
                const transaction=await transactRoom(current=>{
                    current=current??room;
                    if(current._projectionSync){blocked=true;return;}
                    const receipt=current.operations?.[job.id];
                    if(receipt&&receipt.phase!=='projecting'){
                        settled={progress:normalizeProgress(current.progress??null),result:JSON.parse(receipt.result.json)};return;
                    }
                    if(current.restoredAt&&job.createdAt<=current.restoredAt&&!['restore','initialize'].includes(command.type)){
                        settled={error:new Error('老師已還原資料；這筆較早的操作已取消，請依最新進度重新操作。')};return;
                    }
                    const before=mergeStudentStatesIntoProgress(current.progress??null,root.studentStates||{});
                    const outcome=applyOperation(before,command,clock);
                    if(!outcome.changed){settled={progress:outcome.progress,result:outcome.result||{ok:true}};return;}
                    const result={ok:true,...outcome.result};
                    const plan=createTeacherSyncPlan({beforeProgress:before,afterProgress:outcome.progress,command,result,
                        uidByStudentId:mapping,clock});
                    const receiptValue={id:job.id,uid:getUid(),type:command.type,createdAt:job.createdAt,phase:'projecting',result:{json:JSON.stringify(result)}};
                    const next={...current,progress:{...outcome.progress,lastSaved:new Date(clock).toISOString()},
                        operations:{...retainedOperations(current.operations,pendingIds,clock),[job.id]:receiptValue},lastOperationId:job.id,
                        _projectionSync:{operationId:job.id,createdAt:clock,uidByStudentId:mapping,
                            resultUid:['petMood','bossAttack'].includes(command.type)?mapping[command.studentId]||null:null,plan}};
                    if(['restore','initialize'].includes(command.type)) next.restoredAt={'.sv':'timestamp'};
                    return next;
                });
                if(settled?.error){await cleanupRejectedArtwork(artwork);throw settled.error;}
                if(settled) return settled;
                if(!transaction?.committed){if(blocked) continue;throw Object.assign(new Error('老師操作交易未完成，稍後會重試。'),{retryable:true});}
                root=(await readRoot())||{};
                return await resumeProjection(root);
            }catch(error){throw markRetryable(error);}
        }
        throw Object.assign(new Error('另一筆老師操作仍在同步，稍後會重試。'),{retryable:true});
    }
    async function execute(job,pendingIds=[]){
        const artwork=preflightArtwork(job.command);
        if(readRoot&&writeRoot&&transactRoom&&transactStudentState) return executeCoordinated(job,pendingIds,artwork);
        if(transactRoot||transactRoom) return executeSdkTransaction(job,pendingIds,artwork);
        let command;
        // Same command, ID and lottery samples survive every retry.
        for(let attempt=0;attempt<20;attempt++){
            const response=await call('',{headers:{'X-Firebase-ETag':'true'}});
            const room=response.value || {};
            const receipt=room.operations?.[job.id];
            if(receipt) return {progress:normalizeProgress(room.progress??null),result:JSON.parse(receipt.result.json)};
            const clock=now();
            if(clock-job.createdAt>24*60*60*1000){
                await cleanupRejectedArtwork(artwork);
                throw new Error('這筆未確認操作已超過一天，請先確認最新進度再重新操作。');
            }
            const candidate=command ?? indexCommand(job.command,artwork);
            if(room.restoredAt && job.createdAt<=room.restoredAt && !['restore','initialize'].includes(candidate.type)){
                await cleanupRejectedArtwork(artwork);
                throw new Error('老師已還原資料；這筆較早的操作已取消，請依最新進度重新操作。');
            }
            const outcome=applyOperation(room.progress??null,candidate,clock);
            if(!outcome.changed) return {progress:outcome.progress,result:outcome.result||{ok:true}};
            command ??= await prepareCommand(job.command,artwork);
            const result={ok:true,...outcome.result};
            const next={...room,
                progress:{...outcome.progress,lastSaved:new Date(clock).toISOString()},
                operations:{...retainedOperations(room.operations,pendingIds,clock),[job.id]:{
                    id:job.id,uid:getUid(),type:command.type,createdAt:job.createdAt,
                    committedAt:{'.sv':'timestamp'},result:{json:JSON.stringify(result)},
                }},
                lastOperationId:job.id,
            };
            if(['restore','initialize'].includes(command.type)) next.restoredAt={'.sv':'timestamp'};
            const etag=response.headers.get('etag');
            if(!etag) throw new Error('雲端未提供交易鎖定資訊，已停止寫入。');
            const written=await call('',{method:'PUT',headers:{'Content-Type':'application/json','if-match':etag},body:JSON.stringify(next)});
            if(written.status===412) continue;
            return {progress:normalizeProgress(next.progress),result};
        }
        throw Object.assign(new Error('雲端正在接收其他裝置的操作，稍後會重試。'),{retryable:true});
    }
    return {readRemote,readReceipt,readArtwork,writeArtwork,deleteArtwork,execute};
}

// Authentication may fail before the first server read. Retry lazily on the next
// read/reconnect, sharing one login attempt across simultaneous operations.
export function createTokenProvider(auth,signIn){
    let signingIn;
    return async()=>{
        try{
            if(!auth.currentUser){
                signingIn ??= Promise.resolve().then(()=>signIn(auth)).finally(()=>{signingIn=null;});
                await signingIn;
            }
            return await auth.currentUser.getIdToken();
        }catch(error){
            if(error.code==='auth/network-request-failed') error.retryable=true;
            throw error;
        }
    };
}
