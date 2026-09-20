// Firebase JS SDK 12.19.0 hashes some large numbers incorrectly, including
// MAX_SAFE_INTEGER in legacy BOSS HP. Server-generated ETags avoid perpetual
// datastale/maxretry while retaining compare-and-set transaction semantics.
export function createFirebaseRestClient({databaseURL,getToken,fetch:request=globalThis.fetch,timeoutMs=15000}){
    async function send(path,options={}){
        const controller=new AbortController();
        let timer;
        const deadline=new Promise((_,reject)=>{
            timer=setTimeout(()=>{
                controller.abort();
                reject(Object.assign(new Error('雲端連線逾時'),{name:'AbortError',retryable:true}));
            },timeoutMs);
        });
        const operation=(async()=>{
            const token=await getToken();
            const route=path.split('/').map(encodeURIComponent).join('/');
            const response=await request(`${databaseURL.replace(/\/$/,'')}/${route}.json?auth=${encodeURIComponent(token)}`,{
                ...options,cache:'no-store',signal:controller.signal,
            });
            if(!response.ok&&response.status!==412){
                throw Object.assign(new Error(`雲端存取失敗 (${response.status})`),{
                    retryable:response.status>=500||response.status===408||response.status===429,
                });
            }
            try{return {status:response.status,value:await response.json(),etag:response.headers.get('etag')};}
            catch(error){if(options.method==='PUT'&&response.ok) error.retryable=true;throw error;}
        })();
        try{return await Promise.race([operation,deadline]);}
        finally{clearTimeout(timer);}
    }
    return {
        // Always read the server: an SDK subscription can still hold the value
        // from before an acknowledged REST write when a coordinator resumes.
        async read(path){return (await send(path)).value;},
        async transact(path,updater){
            for(let attempt=0;attempt<20;attempt++){
                const current=await send(path,{headers:{'X-Firebase-ETag':'true'}});
                if(!current.etag) throw new Error('雲端回應缺少 ETag，已停止寫入。');
                const next=updater(structuredClone(current.value));
                if(next===undefined) return {committed:false,value:current.value};
                const saved=await send(path,{method:'PUT',headers:{'Content-Type':'application/json','if-match':current.etag},body:JSON.stringify(next)});
                if(saved.status===412) continue;
                return {committed:true,value:saved.value};
            }
            throw Object.assign(new Error('資料持續被更新，稍後會重試。'),{retryable:true});
        },
    };
}
