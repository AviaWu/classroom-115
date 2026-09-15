import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudSync, makeWrite, sameBase, validVersion} from '../public/cloud-sync.mjs';

const clone = value => structuredClone(value);
const progress = (revision = 10, tokens = 20) => ({students:[{id:1,tokens}],lastSaved:'2026-09-15T01:00:00Z',revision,commitId:`commit-${revision}-abcdefghijkl`,syncVersion:3});
function harness(initial = progress(), options = {}) {
    let remote = clone(initial), local = clone(initial), dirty = false, writes = 0, counter = 0;
    const backups = [], errors = [], locks = [], messages = [];
    let readHook, transactionHook;
    const sync = createCloudSync({
        getState:()=>local, isDirty:()=>dirty, lock:value=>locks.push(value), status:value=>messages.push(value), error:value=>errors.push(value),
        readRemote:async()=>readHook ? readHook() : clone(remote),
        newId:()=>`new-commit-abcdefghijkl-${++counter}`, serverTimestamp:()=>123,
        transact:async update=>{
            if(options.emptyCacheOnce){options.emptyCacheOnce=false;return {committed:false,value:null};}
            if(options.alwaysAbort) return {committed:false,value:null};
            if(transactionHook) await transactionHook();
            const next = update(clone(remote));
            if(next !== undefined){ remote = clone(next); writes++; }
            return {committed:next !== undefined,value:clone(remote)};
        },
        backup:async record=>{ if(options.backupFails) throw new Error('quota'); backups.push(clone(record)); },
        shouldBackupInitial:()=>false,
        applyState:value=>{local=clone(value);dirty=false;},
        acknowledge:value=>{ if(value) for(const k of ['revision','commitId','syncVersion','lastSaved','updatedAt']) local[k]=value[k]; dirty=false; },
        reconcile:()=>false
    });
    return {sync,backups,errors,locks,messages,
        get remote(){return remote;}, set remote(v){remote=clone(v);},
        get local(){return local;}, get writes(){return writes;},
        edit(tokens){local.students[0].tokens=tokens;dirty=true;},
        queue(tokens){local.students[0].tokens=tokens;dirty=false;return sync.queueSave(local);},
        setRead(fn){readHook=fn;},setTransaction(fn){transactionHook=fn;},
        async start(){sync.setConnected(true);await sync.refresh();}
    };
}

test('save advances version, not timestamp ordering; no-op refresh does not write',async()=>{
    const h=harness();await h.start();assert.equal(h.sync.canEdit(),true);
    assert.equal(h.queue(100),true);assert.equal(h.sync.canEdit(),false);await h.sync.flush();
    assert.equal(h.remote.revision,11);assert.equal(h.remote.students[0].tokens,100);
    assert.equal(h.remote.baseCommitId,'commit-10-abcdefghijkl');
    await h.sync.refresh();assert.equal(h.writes,1);
});
test('A resumes after B updated: read latest before allowing edits',async()=>{
    const h=harness();await h.start();h.sync.setActive(false);
    h.remote=progress(11,100);assert.equal(h.queue(25),false);
    h.sync.setActive(true);await h.sync.refresh();
    assert.equal(h.local.students[0].tokens,100);assert.equal(h.writes,0);assert.equal(h.sync.canEdit(),true);
});
test('dirty A offline versus B update: backup and discard stale write',async()=>{
    const h=harness();await h.start();h.edit(25);h.sync.setConnected(false);
    h.local.lastSaved='2099-01-01T00:00:00Z';h.remote=progress(11,100);
    h.sync.setConnected(true);await h.sync.refresh();
    assert.equal(h.writes,0);assert.equal(h.local.students[0].tokens,100);
    assert.equal(h.backups[0].local.students[0].tokens,25);assert.equal(h.backups[0].base.revision,10);
});
test('B wins between A read and transaction; transaction rejects A original base',async()=>{
    const h=harness();await h.start();let first=true;
    h.setTransaction(()=>{if(first){first=false;h.remote=progress(11,100);}});
    h.queue(25);await h.sync.flush();
    assert.equal(h.writes,0);assert.equal(h.local.students[0].tokens,100);assert.equal(h.backups.length,1);
});
test('remote event during write is not lost',async()=>{
    const h=harness();await h.start();let first=true;
    h.setTransaction(()=>{if(first){first=false;h.remote=progress(11,200);h.sync.remoteChanged(h.remote);}});
    h.queue(25);await h.sync.flush();assert.equal(h.local.students[0].tokens,200);assert.equal(h.writes,0);
});
test('network failure holds pending original base; explicit retry detects conflict',async()=>{
    const h=harness();await h.start();h.setRead(()=>{throw new Error('offline');});
    h.queue(25);await h.sync.flush();assert.equal(h.sync.canEdit(),false);assert.equal(h.errors.length,1);
    h.remote=progress(11,100);h.setRead(null);await h.sync.refresh();
    assert.equal(h.backups.length,1);assert.equal(h.writes,0);assert.equal(h.sync.canEdit(),true);
});
test('backup failure must not replace local data or unlock',async()=>{
    const h=harness(progress(),{backupFails:true});await h.start();h.edit(25);h.sync.setActive(false);
    h.remote=progress(11,100);h.sync.setActive(true);await h.sync.refresh();
    assert.equal(h.local.students[0].tokens,25);assert.equal(h.writes,0);assert.equal(h.sync.canEdit(),false);
});
test('reconnect while same read is in flight cannot unlock using pre-disconnect response',async()=>{
    const h=harness();await h.start();let resolve;let first=true;
    h.setRead(()=>{if(first){first=false;return new Promise(r=>resolve=r);}return clone(h.remote);});
    const run=h.sync.refresh();await Promise.resolve();h.sync.setConnected(false);h.remote=progress(11,100);h.sync.setConnected(true);
    resolve(progress());await run;assert.equal(h.local.students[0].tokens,100);assert.equal(h.sync.canEdit(),true);
});
test('legacy migration compares entire original snapshot',async()=>{
    const legacy={students:[{id:1,tokens:100}],lastSaved:'2026-09-15T07:00:00Z',syncVersion:2};
    const h=harness(legacy);await h.start();assert.equal(h.remote.revision,1);assert.equal(h.remote.syncVersion,3);assert.equal(h.remote.students[0].tokens,100);
    assert.equal(sameBase({...legacy,students:[{id:1,tokens:20}]},legacy),false);
});
test('deleted cloud state cannot be resurrected by previously loaded page',async()=>{
    const h=harness();await h.start();h.remote=null;await h.sync.refresh();assert.equal(h.writes,0);assert.equal(h.sync.canEdit(),false);
});
test('SDK empty cache abort does not discard valid pending work',async()=>{
    const h=harness(progress(),{emptyCacheOnce:true});await h.start();h.queue(55);await h.sync.flush();
    assert.equal(h.remote.students[0].tokens,55);assert.equal(h.writes,1);assert.equal(h.backups.length,0);
});
test('repeated transaction aborts stop retrying and retain pending data',async()=>{
    const h=harness(progress(),{alwaysAbort:true});await h.start();h.queue(55);await h.sync.flush();
    assert.equal(h.sync.canEdit(),false);assert.equal(h.sync.hasPendingSave(),true);assert.equal(h.errors.length,1);assert.equal(h.writes,0);
});
test('conflict flush returns false rather than reporting save success',async()=>{
    const h=harness();await h.start();h.remote=progress(11,100);h.queue(55);
    assert.equal(await h.sync.flush(),false);assert.equal(h.sync.canEdit(),true);assert.equal(h.local.students[0].tokens,100);
});
test('future/invalid protocol does not unlock or write',async()=>{
    const h=harness({...progress(),syncVersion:4});await h.start();assert.equal(h.sync.canEdit(),false);assert.equal(h.writes,0);
});
test('import metadata cannot change write base; clock skew has no effect',()=>{
    const base=progress();const payload=makeWrite({...progress(999,50),lastSaved:'1900-01-01T00:00:00Z'},base,'unique-commit-abcdefghijkl',123);
    assert.equal(payload.revision,11);assert.equal(payload.baseCommitId,base.commitId);assert.equal(validVersion(payload),true);
    assert.equal(sameBase(progress(11),base),false);
});
