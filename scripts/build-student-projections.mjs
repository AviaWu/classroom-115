import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createStudentProjections} from '../public/student-projections.mjs';

const args=process.argv.slice(2);
const valueFor=flag=>{
    const index=args.indexOf(flag);
    return index>=0 ? args[index+1] : null;
};
const progressPath=valueFor('--progress'),rosterPath=valueFor('--roster'),outputPath=valueFor('--output');
if(!progressPath || !rosterPath || !outputPath || args.length!==6) {
    console.error('Usage: node scripts/build-student-projections.mjs --progress <progress.json> --roster <student-id-to-uid.json> --output <payload.json>');
    process.exitCode=1;
} else {
    const [progressText,rosterText]=await Promise.all([readFile(resolve(progressPath),'utf8'),readFile(resolve(rosterPath),'utf8')]);
    const progress=JSON.parse(progressText),roster=JSON.parse(rosterText);
    const payload=createStudentProjections(progress,roster);
    await writeFile(resolve(outputPath),`${JSON.stringify(payload,null,2)}\n`);
    console.log(`dry-run: wrote ${Object.keys(payload.studentStates).length} student projections to ${resolve(outputPath)}`);
}
