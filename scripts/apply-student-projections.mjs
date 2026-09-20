import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const args=process.argv.slice(2);
const valueFor=flag=>{
  const index=args.indexOf(flag);
  return index>=0?args[index+1]:null;
};
const usage='Usage: FIREBASE_ID_TOKEN=<teacher-id-token> node scripts/apply-student-projections.mjs --payload <payload.json> --database-url <https://...> --apply';
const payloadPath=valueFor('--payload'),databaseURL=valueFor('--database-url');
const expectedKeys=['studentRoster','studentStates','studentPets','publicBosses','publicQuestionPapers'];

function fail(message){
  console.error(message);
  process.exitCode=1;
}
function validDatabaseURL(value){
  try {
    const url=new URL(value);
    return url.protocol==='https:' && (url.hostname.endsWith('.firebasedatabase.app')||url.hostname.endsWith('.firebaseio.com'));
  } catch { return false; }
}
function validPayload(value){
  return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===expectedKeys.slice().sort().join(',')&&expectedKeys.every(key=>value[key]&&typeof value[key]==='object'&&!Array.isArray(value[key]));
}

if(!args.includes('--apply')) fail(`Refusing to write without --apply.\n${usage}`);
else if(!payloadPath||!databaseURL) fail(usage);
else if(!validDatabaseURL(databaseURL)) fail('Database URL must be an HTTPS Firebase Realtime Database URL.');
else if(!process.env.FIREBASE_ID_TOKEN) fail('FIREBASE_ID_TOKEN must contain a current teacher Firebase ID token.');
else {
  let payload;
  try { payload=JSON.parse(await readFile(resolve(payloadPath),'utf8')); }
  catch(error){ fail(`Cannot read projection payload: ${error.message}`); }
  if(process.exitCode!==1&&!validPayload(payload)) fail(`Projection payload must contain exactly: ${expectedKeys.join(', ')}.`);
  if(process.exitCode!==1){
    const url=`${databaseURL.replace(/\/$/,'')}/.json?auth=${encodeURIComponent(process.env.FIREBASE_ID_TOKEN)}`;
    try {
      const response=await fetch(url,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
      if(!response.ok) throw new Error(`Firebase returned ${response.status}: ${await response.text()}`);
      console.log(`applied ${Object.keys(payload.studentStates).length} student projections; existing games/classroom-115/progress was not touched`);
    } catch(error) { fail(`Projection apply failed: ${error.message}`); }
  }
}
