# Teacher–Student Concurrent Sync Design

## Goal

Eliminate the teacher-side `database/maxretry` failure without allowing concurrent teacher or student actions to overwrite one another, while keeping phase-one data and postponing phase-two migration.

## Constraints

- Never transact at the RTDB database root.
- Students continue to transact only at `studentStates/{uid}`.
- Teachers retain every existing operation, including purchases, equipment, resources, tasks, lottery, pet mood, and BOSS attacks.
- `progress.students[studentId - 1]` remains the phase-one legacy copy.
- No migration script is required and phase-two cleanup does not begin.
- No commit or push is performed by Codex.

## Architecture

Teacher operations use a short coordinator stored in `games/classroom-115`:

1. Read the room and projection branches.
2. Run a transaction only at `games/classroom-115`. It serializes teacher devices, applies the room operation, stores its receipt as `projecting`, and records a bounded projection plan in `_projectionSync`.
3. Apply each affected student plan with a transaction at `studentStates/{uid}`. A temporary `_teacherOperation` marker makes this step idempotent across lost acknowledgements and reload recovery.
4. Apply teacher-only absolute projections (`studentPets`, `publicBosses`, and `publicQuestionPapers`) with one multi-location update.
5. Run a second room-only transaction. It merges the student transaction results into legacy progress, marks the receipt committed, and removes `_projectionSync`.
6. Remove temporary student markers. A failed cleanup is harmless and later transactions prune old markers.

A new teacher operation that encounters an unfinished `_projectionSync` finishes that plan before acquiring its own room transaction. Therefore teacher tabs cannot overwrite one another or discard receipts.

## Student Plan Semantics

- Additive resources use deltas against the latest student transaction value.
- Explicit teacher sets/resets use absolute values.
- Pet mood and BOSS attack commands are recomputed inside the student transaction using the current state and the room's frozen public context. This preserves once-per-day and single-defeat semantics.
- Equipment and BOSS resets update only the fields they intentionally change.
- Resize deletion is idempotent.
- The internal marker stores the result JSON needed to return the original result if projection application is retried.

## Rules

`studentStates/{uid}/_teacherOperation` is optional. Teachers may modify it; student writes must preserve the existing value exactly. The marker is validated and only one can exist because the room coordinator permits one teacher operation at a time. No existing student record must be pre-populated, so no database migration is needed.

## Failure Handling

- Network/disconnect failures remain retryable.
- A room lock and projection plan survive page reloads.
- Reapplying an unfinished plan cannot duplicate resources or BOSS/pet rewards.
- A committed receipt remains the source for retry recovery.
- Temporary markers are ignored by projection-to-progress conversion and do not enter legacy progress.

## Verification

Automated tests cover two concurrent teacher stores, a student token update during a teacher action, concurrent pet mood and final BOSS attacks, lost acknowledgement recovery, student marker preservation, student 28 equipment, all teacher purchases/resources/tasks/lottery, browser SDK wiring, and Emulator Rules acceptance.
