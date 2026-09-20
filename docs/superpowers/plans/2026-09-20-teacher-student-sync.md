# Teacher–Student Concurrent Sync Implementation Plan

> **For agentic workers:** Execute inline with `superpowers:executing-plans`; use test-driven development for every behavior.

**Goal:** Replace the contended database-root transaction with a recoverable room coordinator and per-student transactions.

**Architecture:** A room-only transaction serializes teacher commands and stores a resumable projection plan. Per-student transactions apply personal changes with temporary idempotency markers, followed by a room-only finalize transaction.

**Tech Stack:** Browser JavaScript modules, Firebase Realtime Database SDK, Node test runner, Firebase Emulator Suite.

**Spec:** `docs/superpowers/specs/2026-09-20-teacher-student-sync-design.md`

## Global Constraints

- Do not commit or push.
- Do not run a database migration or phase-two cleanup.
- Keep students 1–28 mapped by `progress.students[studentId - 1]`.
- Students 29–30 remain login-only.

---

### Task 1: Projection plan and idempotent student application

**Files:**
- Create: `public/teacher-sync-plan.mjs`
- Create: `tests/teacher-sync-plan.test.mjs`
- Modify: `public/student-projections.mjs`

**Interfaces:**
- `createTeacherSyncPlan({beforeProgress, afterProgress, command, result, uidByStudentId, clock})`
- `applyTeacherStudentPlan(currentState, studentPlan, operationId)`
- `stripTeacherOperationMarker(state, operationId)`

- [x] Write failing tests for additive resource preservation, absolute resets, conditional pet/BOSS recomputation, marker replay, marker cleanup, and resize deletion.
- [x] Run the focused test and verify behavior failures.
- [x] Implement the pure planning and application functions.
- [x] Run the focused test and all projection/student-operation tests.

### Task 2: Recoverable room coordinator

**Files:**
- Modify: `public/firebase-store.mjs`
- Modify: `tests/firebase-store.test.mjs`

**Interfaces:**
- Store dependencies add `transactRoom`, `transactStudentState`, `readRoot`, and `writeRoot`.
- `_projectionSync` contains the operation ID, plan, provisional result, and creation time.

- [x] Write failing tests for two teacher devices, concurrent student token changes, pet/BOSS races, and replay after a lost acknowledgement.
- [x] Run the focused tests and verify the race assertions fail.
- [x] Implement lock acquisition, unfinished-plan recovery, projection application, finalize, and cleanup.
- [x] Preserve existing REST and legacy transaction transports.
- [x] Run `tests/firebase-store.test.mjs` and related cloud-sync tests.

### Task 3: Browser transport and Firebase Rules

**Files:**
- Modify: `public/index.html`
- Modify: `database.rules.phase1.json`
- Modify: `tests/page-integration.test.mjs`
- Modify: `tests/database-rules.phase1.emulator.mjs`

- [x] Write failing integration assertions for room/student transactions and marker permissions.
- [x] Update the browser SDK wiring to transact the room and individual student states.
- [x] Permit teacher markers while requiring students to preserve them.
- [x] Run page integration tests and the Emulator suite.

### Task 4: Documentation and complete verification

**Files:**
- Modify: `docs/student-projection-phase1.md`

- [x] Document room coordination, scoped student transactions, recovery, and the Rules deployment requirement.
- [x] Run `npm test`.
- [x] Run the Firebase Emulator suite with Java 21 or newer.
- [x] Run `git diff --check` and inspect the final diff/status.
- [x] Do not commit; hand the tested files to the user.
