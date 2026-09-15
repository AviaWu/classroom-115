import test from 'node:test';
import assert from 'node:assert/strict';
import {makeWrite} from '../public/cloud-sync.mjs';

// Deliberately refuse all production endpoints.
const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('Local database emulator required');
const project = 'demo-classroom-sync';
const url = `http://${host}/games/classroom-115/progress.json?ns=${project}-default-rtdb`;
const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
const now = Math.floor(Date.now()/1000);
const token = `${encode({alg:'none',typ:'JWT'})}.${encode({iss:`https://securetoken.google.com/${project}`,aud:project,iat:now,exp:now+3600,auth_time:now,sub:'test-user',user_id:'test-user',firebase:{sign_in_provider:'anonymous',identities:{}}})}.`;
const legacy = {students:[{id:1,tokens:20}],lastSaved:'2026-09-15T01:00:00Z',syncVersion:2};
const timestamp = {'.sv':'timestamp'};
async function seed(value) {
    const response = await fetch(url,{method:'PUT',headers:{Authorization:'Bearer owner'},body:JSON.stringify(value)});
    assert.equal(response.status,200,await response.text());
}
async function write(value, authorized = true, method = 'PUT') {
    return fetch(url+(authorized ? `&auth=${encodeURIComponent(token)}` : ''),{method,body:JSON.stringify(value)});
}
async function expectAllowed(value) {const r=await write(value);assert.equal(r.status,200,await r.text());}
async function expectDenied(value, authorized = true, method = 'PUT') {const r=await write(value,authorized,method);assert.equal(r.status,401,await r.text());}

test('production rules: migration, version conflicts, old clients, deletion and metadata',async()=>{
    await seed(legacy);
    await expectDenied({...legacy,lastSaved:'2099-01-01T00:00:00Z'});
    const first=makeWrite(legacy,legacy,'commit-first-abcdefghijkl',timestamp);
    await expectAllowed(first);
    await expectDenied({...first,students:[{id:1,tokens:999}],lastSaved:'2099-01-01T00:00:00Z'});
    await expectDenied({...first,revision:2,baseCommitId:'wrong-base',commitId:'other-commit-abcdefghijkl'});
    const second=makeWrite({...legacy,lastSaved:'1900-01-01T00:00:00Z'},first,'commit-second-abcdefghijkl',timestamp);
    await expectAllowed(second); // Correct ancestry wins even with a slow clock.
    await expectDenied(makeWrite(legacy,first,'stale-commit-abcdefghijkl',timestamp));
    await expectDenied({...makeWrite(legacy,second,'commit-third-abcdefghijkl',timestamp),updatedAt:1});
    await expectDenied({...makeWrite(legacy,second,'commit-third-abcdefghijkl',timestamp),revision:3.5});
    await expectDenied(makeWrite(legacy,second,'commit-third-abcdefghijkl',timestamp),false);
    await expectDenied(null);
    await expectDenied({students:[{id:1,tokens:999}]},true,'PATCH');
    await seed(null);
    await expectAllowed(makeWrite(legacy,null,'commit-create-abcdefghijkl',timestamp));
});
