import test from 'node:test';
import assert from 'node:assert/strict';
import {accountForEmail,credentialsForLogin} from '../public/auth-accounts.mjs';

test('student credentials use the approved local domain and a Firebase-valid derived password',()=>{
    assert.deepEqual(credentialsForLogin('student-26','6759'),{
        role:'student',studentId:26,email:'student-26@classroom-115.local',password:'c115-6759'
    });
});

test('teacher has a dedicated address',()=>{
    assert.deepEqual(credentialsForLogin('teacher','1127'),{
        role:'teacher',studentId:null,email:'teacher@classroom-115.local',password:'c115-1127'
    });
});

test('student accounts 27 through 30 use numbered addresses',()=>{
    assert.deepEqual(credentialsForLogin('student-27','2048'),{
        role:'student',studentId:27,email:'student-27@classroom-115.local',password:'c115-2048'
    });
    assert.deepEqual(credentialsForLogin('student-28','9316'),{
        role:'student',studentId:28,email:'student-28@classroom-115.local',password:'c115-9316'
    });
    assert.deepEqual(credentialsForLogin('student-29','5487'),{
        role:'student',studentId:29,email:'student-29@classroom-115.local',password:'c115-5487'
    });
    assert.deepEqual(accountForEmail('student-30@classroom-115.local'),{role:'student',studentId:30});
});

test('invalid accounts and non-PIN passwords cannot produce Firebase credentials',()=>{
    assert.equal(credentialsForLogin('student-0','1234'),null);
    assert.equal(credentialsForLogin('student-31','1234'),null);
    assert.equal(credentialsForLogin('teacher','12345'),null);
    assert.equal(accountForEmail('nobody@classroom-115.local'),null);
});
