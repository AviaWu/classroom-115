import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';

const html = fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
function body(start,end){return scripts[0][2].slice(scripts[0][2].indexOf(start),scripts[0][2].indexOf(end));}

test('all inline scripts and cloud module parse',()=>{
    for(const [,attributes,source] of scripts){
        if(attributes.includes('module')){
            const result=spawnSync(process.execPath,['--input-type=module','--check'],{input:source,encoding:'utf8'});
            assert.equal(result.status,0,result.stderr);
        }else new vm.Script(source);
    }
});
test('save clears delayed timer, does not upload unchanged or locked state',()=>{
    let editable=true, queues=0, clears=0;
    const context=vm.createContext({window:{firebaseGameStore:{canEdit:()=>editable,queueSave:()=>{queues++;return true;}}},clearTimeout:()=>clears++,localStorage:{setItem(){}},alert(){},console});
    vm.runInContext('let autoSaveTimer=123;let unsavedChange=false;let state={};const STORAGE_KEY="test";'+body('function save(){','async function flushSavedState(){'),context);
    assert.equal(vm.runInContext('save()',context),true);assert.equal(queues,0);assert.equal(clears,1);
    vm.runInContext('unsavedChange=true;save()',context);assert.equal(queues,1);
    editable=false;vm.runInContext('unsavedChange=true;save()',context);assert.equal(queues,1);
});
test('scheduled tasks never mutate state while sync is locked',()=>{
    let generated=0;
    const context=vm.createContext({window:{firebaseGameStore:{canEdit:()=>false}},generateDailyTasks:()=>generated++,generateWeeklyTasks:()=>generated++,generateScheduledCoopTasks:()=>generated++});
    vm.runInContext(body('function syncScheduledTasks(){','function syncDailyTasks(){'),context);
    assert.equal(vm.runInContext('syncScheduledTasks()',context),false);assert.equal(generated,0);
});
test('initial empty state save has valid migration metadata',async()=>{
    const {makeWrite}=await import('../public/cloud-sync.mjs');
    const next=makeWrite({students:[{id:1}],lastSaved:null},null,'initial-commit-abcdefghijkl',{'.sv':'timestamp'});
    assert.equal(typeof next.lastSaved,'string');assert.equal(next.revision,1);assert.equal(next.baseCommitId,'initial');
});
