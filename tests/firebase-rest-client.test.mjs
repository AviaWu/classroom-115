import test from 'node:test';
import assert from 'node:assert/strict';
import {createFirebaseRestClient} from '../public/firebase-rest-client.mjs';

const makeClient=fetch=>createFirebaseRestClient({databaseURL:'https://classroom.test',getToken:async()=>'test-token',fetch});
test('a transaction retries a real conflict with the newest server value and its ETag',async()=>{
    let value={tokens:10},version=1,puts=0;
    const client=makeClient(async(url,options)=>{
        assert.equal(new URL(url).pathname,'/studentStates/one.json');
        if(options.method==='PUT'){
            puts++;
            if(puts===1){value={tokens:15};version++;return Response.json(value,{status:412});}
            assert.equal(options.headers['if-match'],'"2"');
            assert.equal(new URL(url).searchParams.has('print'),false);
            value=JSON.parse(options.body);
        }
        return Response.json(value,{headers:{ETag:`"${version}"`}});
    });
    const outcome=await client.transact('studentStates/one',current=>({...current,tokens:current.tokens+3}));
    assert.equal(outcome.committed,true);
    assert.equal(value.tokens,18);
    assert.equal(outcome.value.tokens,18);
});
test('missing ETag or an aborted updater cannot cause an unconditional write',async()=>{
    for(const etag of [undefined,'"1"']){
        const client=makeClient(async(url,options)=>{
            assert.notEqual(options.method,'PUT');
            return Response.json({tokens:10},{headers:etag?{ETag:etag}:{}});
        });
        if(!etag) await assert.rejects(client.transact('studentStates/one',()=>({tokens:11})),/ETag/);
        else assert.deepEqual(await client.transact('studentStates/one',()=>undefined),{committed:false,value:{tokens:10}});
    }
});
test('permission denial is a terminal error and never retries the write',async()=>{
    const client=makeClient(async()=>Response.json({error:'Permission denied'},{status:401}));
    await assert.rejects(client.transact('studentStates/one',()=>({tokens:1})),error=>error.retryable===false&&/401/.test(error.message));
});
test('a lost successful write acknowledgement stays retryable',async()=>{
    const client=makeClient(async(url,options)=> options.method==='PUT'
        ? new Response('invalid JSON',{status:200})
        : Response.json({tokens:10},{headers:{ETag:'"1"'}}));
    await assert.rejects(client.transact('studentStates/one',current=>({...current,tokens:11})),error=>error.retryable===true);
});
test('a stalled response body times out instead of hanging a transaction',async()=>{
    const client=createFirebaseRestClient({databaseURL:'https://classroom.test',getToken:async()=>'token',timeoutMs:10,
        fetch:async()=>({ok:true,status:200,headers:new Headers({ETag:'"1"'}),json:()=>new Promise(()=>{})})});
    await assert.rejects(client.transact('studentStates/one',()=>({tokens:1})),error=>error.retryable===true&&error.name==='AbortError');
});
