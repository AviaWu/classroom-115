import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const args=process.argv.slice(2);
const valueFor=flag=>{const index=args.indexOf(flag);return index>=0?args[index+1]:null;};
const input=valueFor('--auth-export'),output=valueFor('--output');
const usage='Usage: node scripts/build-student-uid-map.mjs --auth-export <firebase-auth-export.json> --output <student-id-to-uid.json>';

try{
  if(!input||!output||args.length!==4) throw new Error(usage);
  const exported=JSON.parse(await readFile(resolve(input),'utf8'));
  const roster={};
  for(const user of exported.users||[]){
    const match=String(user.email||'').match(/^student-(\d+)@classroom-115\.local$/);
    if(!match) continue;
    const studentId=Number(match[1]);
    if(studentId<1||studentId>28) continue;
    if(typeof user.localId!=='string'||!user.localId) throw new Error(`student-${studentId} 缺少 UID`);
    if(roster[studentId]) throw new Error(`student-${studentId} 帳號重複`);
    roster[studentId]=user.localId;
  }
  const missing=Array.from({length:28},(_,index)=>index+1).filter(id=>!roster[id]);
  if(missing.length) throw new Error(`缺少學生帳號：${missing.join(', ')}`);
  await writeFile(resolve(output),`${JSON.stringify(roster,null,2)}\n`,{mode:0o600});
  console.log(`wrote UID map for ${Object.keys(roster).length} students to ${resolve(output)}`);
}catch(error){console.error(error.message);process.exitCode=1;}
