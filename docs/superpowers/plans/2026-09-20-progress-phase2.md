# Progress phase-two implementation plan

**Goal:** Remove the six duplicated personal fields only after explicit migration approval, while keeping teacher actions, student actions and complete backups working.

**Approved scope:** `tokens`, `lotteryTickets`, `petAffection`, `lastPetMoodDate`, `equippedLayout`, `bossProgress` become authoritative in `studentStates/{uid}`. Preserve all other progress data and the student 1–28 / index 0–27 mapping. Accounts 29–30 stay unassigned.

**Constraints:** Work directly on `classroom-115-avia/main`. No commit, push, deployment or live migration. Firebase Spark; retain ETag transactions and existing Rules. Do not add a new database mode flag. Do not automatically delete old fields on deployment.

## 1. Stored and hydrated progress

- [x] Add `normalizeStoredProgress(value)` and `progressForStorage(view, previous, uidByStudentId)` in `public/teacher-projections.mjs`. Normalize nonpersonal fields without manufacturing absent personal data. For mapped students preserve only the previous stored six fields; once deleted, never reintroduce them. Preserve full records for members without projection mappings.
- [x] Keep `mergeStudentStatesIntoProgress` for runtime hydration; reject compact students without a valid personal state instead of silently using zero resources.
- [x] Add tests for complete/compact records, phase-one preservation, missing state, student 28 index and other fields.
- [x] Update `public/firebase-store.mjs` coordinator prepare/finalize and receipt recovery to serialize stored progress separately from returned full view. Keep wardrobe child transactions scoped to one student.
- [x] Test resources, tasks, purchases, lottery, pets, BOSS, clothing/background and replay against compact progress. Existing six-field copies must remain unchanged before migration.

## 2. Teacher subscriptions and backup/restore

- [x] Ensure teacher view waits for the first personal-state snapshot. Preserve missing fields through progress subscriptions so a missing projection remains detectable.
- [x] Add `readCompleteProgress()` to read current server progress and personal states, validate the UID/student mapping, and hydrate backup data. Refuse a backup while a teacher projection plan is unfinished.
- [x] Wire `window.readLatestProgress` to this complete read. Restore full backup personal fields into student states, preserving the compact storage shape.
- [x] Test projection-first/progress-first startup, latest backup after a student action, restore, and missing-state failure.

## 3. Migration preview, apply and rollback

- [x] Add a pure migration module under `scripts/lib/` with `buildPhase2Plan(root)` and a room-only apply/rollback transform. Validate exactly 28 students, unique active UID mappings, complete matching personal states and no in-progress teacher sync.
- [x] Produce a plan listing each exact deletion path and previous value (up to 168), a review-only delete patch and rollback patch, plus byte/count summaries. Differences between legacy copies and authoritative state are reported, not copied over the latter.
- [x] CLI defaults to offline preview from an exported full backup. Online apply/rollback requires explicit `--apply`, the reviewed plan, a teacher ID token and the exact database URL. Validate live mapping and stored values before a room ETag transaction; refuse stale plans, unexpected extra fields or active sync.
- [x] Rollback restores only deleted progress fields and never overwrites current student states or unrelated data. Make repeat apply/rollback safe.
- [x] Add tests for invalid mappings, stale plans, active sync, idempotence, allowed paths, unchanged personal states and CLI write gates. Ignore local migration artifacts in git.

## 4. Verification and handoff

- [x] Run Node/DOM suites and full Firebase Emulator suites, including apply → teacher/student actions → backup/restore → rollback.
- [x] Document deployment first, teacher-tab reload, full backup, dry-run review, explicit apply and limited rollback. Include commands and what remains pending.
- [x] Review diff and leave all changes uncommitted. Do not test live mutations beyond the previously authorized wardrobe scope.

## Completion evidence

- `npm test`: 235 passed, 0 failed.
- Full Firebase Emulator suite: 50 passed, 0 failed, including compact migration → teacher/student operations → full backup/restore → scoped rollback and restoration of a removed equipped pet.
- Independent review and one scoped fix review: all three findings addressed (backup overwrite, restored-pet ordering, complete personal restore).
- Additional safeguards: incomplete compact exports are rejected as backups; teacher question papers remain subscribed; preview output is exclusive and mode 0600.
- All work remains uncommitted on `classroom-115-avia/main`. No deployment, live read or live migration performed. Database Rules unchanged.
- Next: user commit/push and compatible deployment; refresh old tabs; export full root and review an offline plan; separately authorize live deletion.
