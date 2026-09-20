import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createFirebaseRestClient} from '../public/firebase-rest-client.mjs';
import {
  PHASE2_PRODUCTION_DATABASE_URL,
  PHASE2_ROOM_PATH,
  applyPhase2PlanToRoom,
  buildPhase2Plan,
  rollbackPhase2PlanToRoom,
  validatePhase2LiveData,
  validatePhase2Plan,
} from './lib/progress-phase2.mjs';

const previewUsage='Preview: node scripts/progress-phase2.mjs --input <full-root.json> --output <review-plan.json>';
const applyUsage=`Apply (with FIREBASE_ID_TOKEN already exported): node scripts/progress-phase2.mjs --plan <review-plan.json> --database-url ${PHASE2_PRODUCTION_DATABASE_URL} --apply`;
const rollbackUsage=`Rollback (with FIREBASE_ID_TOKEN already exported): node scripts/progress-phase2.mjs --plan <review-plan.json> --database-url ${PHASE2_PRODUCTION_DATABASE_URL} --rollback --apply`;

function parseArgs(args){
  const allowed=new Set(['--input','--output','--plan','--database-url','--apply','--rollback']);
  const booleans=new Set(['--apply','--rollback']),values={};
  for(let index=0;index<args.length;index++){
    const flag=args[index];
    if(!allowed.has(flag)) throw new Error(`Unknown option: ${flag}\n${previewUsage}`);
    if(Object.prototype.hasOwnProperty.call(values,flag)) throw new Error(`Option may only be provided once: ${flag}`);
    if(booleans.has(flag)){values[flag]=true;continue;}
    const value=args[++index];
    if(!value||value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    values[flag]=value;
  }
  return values;
}

async function readJson(path,label){
  try{return JSON.parse(await readFile(resolve(path),'utf8'));}
  catch(error){throw new Error(`Cannot read ${label}: ${error.message}`);}
}

async function preview(options){
  const keys=Object.keys(options).sort().join(',');
  if(keys!=='--input,--output') throw new Error(`${previewUsage}\nOffline preview accepts only --input and --output.`);
  const root=await readJson(options['--input'],'full Firebase root export');
  const plan=buildPhase2Plan(root);
  await writeFile(resolve(options['--output']),`${JSON.stringify(plan,null,2)}\n`,{flag:'wx',mode:0o600});
  console.log(`offline preview: wrote ${plan.deletions.length} reviewed deletion paths to ${resolve(options['--output'])}`);
  console.log(`review digest: ${plan.reviewDigest}`);
}

async function online(options){
  if(!options['--apply']) throw new Error(`Refusing online access without explicit --apply.\n${applyUsage}\n${rollbackUsage}`);
  const allowed=options['--rollback']?['--apply','--database-url','--plan','--rollback']:['--apply','--database-url','--plan'];
  if(Object.keys(options).sort().join(',')!==allowed.sort().join(',')) throw new Error(options['--rollback']?rollbackUsage:applyUsage);
  if(options['--database-url']!==PHASE2_PRODUCTION_DATABASE_URL) throw new Error(`Database URL must be the exact production URL: ${PHASE2_PRODUCTION_DATABASE_URL}`);
  const token=process.env.FIREBASE_ID_TOKEN;
  if(!token) throw new Error('FIREBASE_ID_TOKEN must contain a current teacher Firebase ID token.');
  const plan=validatePhase2Plan(await readJson(options['--plan'],'reviewed phase-two plan'));
  const client=createFirebaseRestClient({databaseURL:PHASE2_PRODUCTION_DATABASE_URL,getToken:async()=>token});
  const [room,studentRoster,studentStates]=await Promise.all([
    client.read(PHASE2_ROOM_PATH),client.read('studentRoster'),client.read('studentStates'),
  ]);
  validatePhase2LiveData({room,studentRoster,studentStates},plan);
  const rollback=Boolean(options['--rollback']);
  const transaction=await client.transact(PHASE2_ROOM_PATH,current=>{
    const next=rollback?rollbackPhase2PlanToRoom(current,plan):applyPhase2PlanToRoom(current,plan);
    return JSON.stringify(next)===JSON.stringify(current)?undefined:next;
  });
  const action=rollback?'rollback':'apply';
  console.log(transaction.committed?`${action} committed for ${plan.deletions.length} reviewed fields.`:`${action} already complete; no write was needed.`);
}

async function main(){
  const options=parseArgs(process.argv.slice(2));
  const onlineRequested=['--plan','--database-url','--apply','--rollback'].some(flag=>options[flag]);
  if(onlineRequested) await online(options);
  else await preview(options);
}

try{await main();}
catch(error){console.error(error.message);process.exitCode=1;}
