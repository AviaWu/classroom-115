import {applyOperation,normalizeProgress} from './game-operations.mjs';

// Firebase REST conditional requests implement a transaction without the SDK's
// offline write queue. ETags stay inside this transport; no progress versions exist.
export function createFirebaseStore({databaseURL,path='games/classroom-115',getToken,getUid,now=Date.now,fetch:request=globalThis.fetch}) {
    async function call(suffix='',options={}){
        const controller=new AbortController();
        let timeout;
        const deadline=new Promise((_,reject)=>{
            timeout=setTimeout(()=>{controller.abort();reject(Object.assign(new Error('雲端連線逾時'),{name:'AbortError',retryable:true}));},15000);
        });
        const operation=(async()=>{
            const token=await getToken();
            const response=await request(`${databaseURL}/${path}${suffix}.json?auth=${encodeURIComponent(token)}`,{
                ...options,cache:'no-store',signal:controller.signal,
            });
            if(!response.ok && response.status!==412){
                const error=new Error(`雲端存取失敗 (${response.status})`);
                error.retryable=response.status>=500 || response.status===408 || response.status===429;
                throw error;
            }
            try{
                return {status:response.status,headers:response.headers,value:response.status===412?null:await response.json()};
            }catch(error){
                if(options.method==='PUT') error.retryable=true; // The server may already have committed.
                throw error;
            }
        })();
        try{return await Promise.race([operation,deadline]);}
        finally{clearTimeout(timeout);}
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
        return receipt ? {...receipt,result:JSON.parse(receipt.result.json)} : null;
    }
    async function execute(job){
        // Same command, ID and lottery samples survive every retry.
        for(let attempt=0;attempt<20;attempt++){
            const response=await call('',{headers:{'X-Firebase-ETag':'true'}});
            const room=response.value || {};
            const receipt=room.operations?.[job.id];
            if(receipt) return {progress:normalizeProgress(room.progress??null),result:JSON.parse(receipt.result.json)};
            const clock=now();
            if(clock-job.createdAt>24*60*60*1000) throw new Error('這筆未確認操作已超過一天，請先確認最新進度再重新操作。');
            if(room.restoredAt && job.createdAt<=room.restoredAt && !['restore','initialize'].includes(job.command.type)){
                throw new Error('老師已還原資料；這筆較早的操作已取消，請依最新進度重新操作。');
            }
            const outcome=applyOperation(room.progress??null,job.command,clock);
            if(!outcome.changed) return {progress:outcome.progress,result:outcome.result||{ok:true}};
            const result={ok:true,...outcome.result};
            const next={...room,
                progress:{...outcome.progress,lastSaved:new Date(clock).toISOString()},
                operations:{...room.operations,[job.id]:{
                    id:job.id,uid:getUid(),type:job.command.type,createdAt:job.createdAt,
                    committedAt:{'.sv':'timestamp'},result:{json:JSON.stringify(result)},
                }},
                lastOperationId:job.id,
            };
            if(['restore','initialize'].includes(job.command.type)) next.restoredAt={'.sv':'timestamp'};
            const etag=response.headers.get('etag');
            if(!etag) throw new Error('雲端未提供交易鎖定資訊，已停止寫入。');
            const written=await call('',{method:'PUT',headers:{'Content-Type':'application/json','if-match':etag},body:JSON.stringify(next)});
            if(written.status===412) continue;
            try{
                const saved=written.value;
                if(!saved?.progress || !saved.operations?.[job.id]?.result?.json) throw new Error('雲端回應不完整，將查證操作結果。');
                return {progress:normalizeProgress(saved.progress),result:JSON.parse(saved.operations[job.id].result.json)};
            }catch(error){error.retryable=true;throw error;}
        }
        throw Object.assign(new Error('雲端正在接收其他裝置的操作，稍後會重試。'),{retryable:true});
    }
    return {readRemote,readReceipt,execute};
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
