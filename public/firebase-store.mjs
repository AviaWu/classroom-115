import {applyOperation,normalizeProgress} from './game-operations.mjs';

// Firebase REST conditional requests implement a transaction without the SDK's
// offline write queue. ETags stay inside this transport; no progress versions exist.
export function createFirebaseStore({databaseURL,path='games/classroom-115',getToken,getUid,now=Date.now,fetch:request=globalThis.fetch}) {
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
            const response=await request(`${databaseURL}/${targetPath}.json?auth=${encodeURIComponent(token)}`,{
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
            return {type:'restore',drawings:newestArtworks([...(Array.isArray(value.drawings)?value.drawings:[]),...(Array.isArray(value.drawingAlbum)?value.drawingAlbum:[])])};
        }
        if(command.type==='migrateArtworks') return {type:'migrateArtworks',drawings:newestArtworks(command.drawings)};
        return null;
    }
    function indexCommand(command,artwork){
        if(!artwork) return command;
        const drawings=artwork.drawings.map(({id,savedAt})=>({id,savedAt}));
        if(artwork.type==='saveDrawing') return {...command,drawing:drawings[0]};
        if(artwork.type==='restore'){
            const {drawingAlbum,...restored}=command.value;
            return {...command,value:{...restored,drawings}};
        }
        if(artwork.type==='migrateArtworks') return {...command,drawings};
        return command;
    }
    async function prepareCommand(command,artwork){
        if(!artwork) return command;
        if(artwork.type==='saveDrawing') return {...command,drawing:await writeArtwork(artwork.drawings[0])};
        if(artwork.type==='restore'){
            const drawings=await Promise.all(artwork.drawings.map(writeArtwork));
            const value=command.value;
            const {drawingAlbum,...restored}=value;
            return {...command,value:{...restored,drawings}};
        }
        if(artwork.type==='migrateArtworks') return {...command,drawings:await Promise.all(artwork.drawings.map(writeArtwork))};
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
        return receipt ? {...receipt,result:JSON.parse(receipt.result.json)} : null;
    }
    async function execute(job){
        const artwork=preflightArtwork(job.command);
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
                operations:{...room.operations,[job.id]:{
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
            try{
                const saved=written.value;
                if(!saved?.progress || !saved.operations?.[job.id]?.result?.json) throw new Error('雲端回應不完整，將查證操作結果。');
                return {progress:normalizeProgress(saved.progress),result:JSON.parse(saved.operations[job.id].result.json)};
            }catch(error){error.retryable=true;throw error;}
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
