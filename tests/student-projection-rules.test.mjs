import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('phase one rules keep progress teacher-only and scope student projections to the authenticated uid',async()=>{
  const rules=JSON.parse(await readFile(new URL('../database.rules.phase1.json',import.meta.url),'utf8'));
  assert.match(rules.rules['.write'],/teacher@classroom-115\.local/);
  assert.match(rules.rules.games['classroom-115']['.read'],/teacher@classroom-115\.local/);
  assert.match(rules.rules.studentStates.$uid['.read'],/auth\.uid === \$uid/);
  assert.match(rules.rules.studentPets.$uid['.write'],/teacher@classroom-115\.local/);
  assert.equal(rules.rules.studentStates.$uid.$other['.validate'],false);
  assert.match(rules.rules.studentStates.$uid['.validate'],/newData\.child\('_teacherOperation'\)\.child\('resultJson'\)\.val\(\) === data\.child\('_teacherOperation'\)\.child\('resultJson'\)\.val\(\)/);
  assert.match(rules.rules.studentStates.$uid._teacherOperation['.validate'],/resultJson/);
  assert.match(rules.rules.studentStates.$uid['.write'],/child\('active'\)\.val\(\) === true/);
  assert.equal(rules.rules.publicBosses['.read'],'auth != null');
  assert.equal(rules.rules.publicQuestionPapers['.write'],'auth != null && auth.token.email === "teacher@classroom-115.local"');
});
