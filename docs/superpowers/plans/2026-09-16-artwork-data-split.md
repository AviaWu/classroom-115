# Artwork Data Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move drawing image payloads to `/artworks/classroom-115/{drawingId}`, retain only the newest three drawings, and prevent normal five-second progress reads from downloading images.

**Architecture:** Keep `{id, savedAt}` indexes in `progress.drawings` and store Data URLs in a separate RTDB branch outside the classroom transaction root. The Firebase transport uploads image data before committing its index, while pure domain operations cap indexes at three and queue evicted IDs for durable deletion. The drawing modal resolves indexed images on demand and caches unchanged IDs; the removed teacher album has no replacement history UI.

**Tech Stack:** Browser JavaScript ES modules, Firebase Realtime Database REST API and Security Rules, Node.js 22 test runner, jsdom, Firebase Emulator Suite.

**Spec:** `docs/superpowers/specs/2026-09-16-artwork-data-split-design.md`

## Global Constraints

- Artwork payload path is exactly `/artworks/classroom-115/{drawingId}`.
- `progress.drawings` contains at most three `{id, savedAt}` records and never contains image `data` after migration.
- `progress.drawingAlbum` is removed and rejected by new writes.
- Normal five-second progress reads never request artwork payloads.
- The open drawing modal refreshes from the latest three indexes every five seconds and does not redownload an unchanged ID.
- Closed drawing UI performs no artwork reads.
- Artwork IDs match `^drawing_[A-Za-z0-9_-]+$`, are 8–128 characters, and payloads are JPEG or PNG Data URLs no longer than 1,500,000 characters.
- Existing cloud data is not rewritten on page load; migration requires an explicit teacher action.
- Backups and restores include only the newest three complete drawings.

---

### Task 1: Pure progress model and eviction commands

**Files:**
- Modify: `public/game-operations.mjs`
- Modify: `tests/game-operations.test.mjs`

**Interfaces:**
- Consumes: `applyOperation(progress, command, now)` and `normalizeProgress(value)`.
- Produces: metadata-only `progress.drawings`, unique `progress.pendingArtworkDeletes`, `saveDrawing` result `{evictedArtworkIds}`, `confirmArtworkDeletion` command `{drawingId}`, and `migrateArtworks` command `{drawings}`.

- [ ] **Step 1: Replace drawing tests with failing metadata and eviction cases**

```js
const meta = id => ({id:`drawing_${id}`,savedAt:`2026-09-16T00:00:0${id}.000Z`});
let current = state({drawings:[meta('3'),meta('2'),meta('1')]});
const saved = run(current,'saveDrawing',{drawing:meta('4')});
assert.deepEqual(saved.progress.drawings.map(item=>item.id),['drawing_4','drawing_3','drawing_2']);
assert.deepEqual(saved.progress.pendingArtworkDeletes,['drawing_1']);
assert.deepEqual(saved.result,{evictedArtworkIds:['drawing_1']});
assert.equal('data' in saved.progress.drawings[0],false);
const confirmed = run(saved.progress,'confirmArtworkDeletion',{drawingId:'drawing_1'});
assert.deepEqual(confirmed.progress.pendingArtworkDeletes,[]);
const migrated = run(legacy,'migrateArtworks',{drawings:[meta('5'),meta('4'),meta('3')]});
assert.deepEqual(migrated.progress.drawings.map(item=>item.id),['drawing_5','drawing_4','drawing_3']);
assert.equal('drawingAlbum' in migrated.progress,false);
```

- [ ] **Step 2: Run the focused tests and confirm the old album behavior fails**

Run: `node --test --test-name-pattern="drawing|artwork" tests/game-operations.test.mjs`

Expected: FAIL because `drawingAlbum` is still populated and `confirmArtworkDeletion` is unsupported.

- [ ] **Step 3: Normalize indexes and implement both commands**

```js
progress.drawings = array(progress.drawings)
  .filter(item=>object(item) && validDrawingId(item.id) && Number.isFinite(Date.parse(item.savedAt)))
  .map(({id,savedAt})=>({id,savedAt}))
  .sort((a,b)=>Date.parse(b.savedAt)-Date.parse(a.savedAt))
  .slice(0,3);
delete progress.drawingAlbum;
progress.pendingArtworkDeletes = unique(progress.pendingArtworkDeletes).filter(validDrawingId);
```

Implement `saveDrawing` with metadata validation, deduplication, three-item slicing, and evicted-ID queuing. Implement `confirmArtworkDeletion` so it removes only `command.drawingId` from the queue. Implement `migrateArtworks` so an explicit operation replaces legacy embedded drawings with at most three metadata records and deletes `drawingAlbum`. Remove `drawings` and `drawingAlbum` from generic teacher-edit collections so teacher bulk edits cannot forge artwork state.

When `restore` replaces progress, compare the old and restored drawing IDs, add displaced IDs to the restored `pendingArtworkDeletes`, and preserve already-pending cleanup IDs. This prevents a restore from leaking artwork payloads that are no longer among its newest three.

- [ ] **Step 4: Run domain tests**

Run: `node --test tests/game-operations.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Commit the domain change**

```bash
git add public/game-operations.mjs tests/game-operations.test.mjs
git commit -m "feat: retain only three drawing indexes"
```

### Task 2: Artwork REST transport and security rules

**Files:**
- Modify: `public/firebase-store.mjs`
- Modify: `database.rules.json`
- Modify: `tests/firebase-store.test.mjs`
- Modify: `tests/firebase-store.emulator.mjs`
- Modify: `tests/database-rules.emulator.mjs`

**Interfaces:**
- Consumes: Firebase token provider and existing timed REST request behavior.
- Produces: `readArtwork(id)`, `writeArtwork(drawing)`, `deleteArtwork(id)`, and transaction preprocessing for `saveDrawing`, `restore`, and `migrateArtworks`.

- [ ] **Step 1: Add failing transport tests**

```js
await store.writeArtwork({id:'drawing_1',savedAt:'2026-09-16T00:00:00.000Z',data:'data:image/jpeg;base64,AA=='});
assert.match(fetch.calls[0].url,/\/artworks\/classroom-115\/drawing_1\.json/);
assert.equal(fetch.calls[0].options.method,'PUT');
assert.deepEqual(await store.readArtwork('drawing_1'),drawing);
await store.deleteArtwork('drawing_1');
assert.equal(fetch.calls.at(-1).options.method,'DELETE');
```

Also assert that `execute(saveDrawing)` uploads the payload first but passes metadata only into the room transaction, and that invalid IDs/Data URLs fail before fetch.

- [ ] **Step 2: Run store tests and confirm the interface is missing**

Run: `node --test tests/firebase-store.test.mjs`

Expected: FAIL because artwork methods do not exist.

- [ ] **Step 3: Generalize the timed request helper and add artwork methods**

```js
const artworkPath = id => `artworks/classroom-115/${encodeURIComponent(assertArtworkId(id))}`;
async function writeArtwork(drawing) {
  validateArtwork(drawing);
  await callPath(artworkPath(drawing.id),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(drawing)});
  return {id:drawing.id,savedAt:drawing.savedAt};
}
```

Keep authentication, `cache:'no-store'`, timeout coverage, and retryable error classification identical to current room calls. `execute` uploads `saveDrawing.command.drawing.data` before the room ETag transaction and gives `applyOperation` only `{id,savedAt}`. Restore/migration helpers upload only the newest three before committing sanitized progress.

- [ ] **Step 4: Add restrictive artwork and progress rules**

Add `/artworks/classroom-115/$drawingId` read/write validation for authenticated users, key/id equality, prefix and length, ISO timestamp length, allowed Data URL prefix, exact children, and 1,500,000-character limit. Add `drawings`, `drawingAlbum`, and `pendingArtworkDeletes` validations under progress; add `confirmArtworkDeletion` and `migrateArtworks` to receipt types.

- [ ] **Step 5: Run store unit tests and emulator suites**

Run: `npm test`

Run: `firebase emulators:exec --config firebase.emulator.json --project demo-classroom-sync --only database "npm run test:emulator"`

Expected: unit tests and emulator tests pass; invalid payloads and embedded progress images are rejected.

- [ ] **Step 6: Commit transport and rules**

```bash
git add public/firebase-store.mjs database.rules.json tests/firebase-store.test.mjs tests/firebase-store.emulator.mjs tests/database-rules.emulator.mjs
git commit -m "feat: store artwork outside classroom progress"
```

### Task 3: Lazy drawing UI and durable cleanup

**Files:**
- Modify: `public/index.html`
- Modify: `public/cloud-sync.mjs`
- Modify: `tests/cloud-sync.test.mjs`
- Modify: `tests/page-integration.test.mjs`

**Interfaces:**
- Consumes: `store.readArtwork`, `store.deleteArtwork`, `state.drawings`, and `state.pendingArtworkDeletes`.
- Produces: an in-memory `artworkCache`, `refreshDrawingImages()`, and `cleanupEvictedArtworks()`.

- [ ] **Step 1: Add failing DOM and synchronization tests**

```js
await page.run('openDrawingBoard()');
assert.deepEqual(page.artworkReads,['drawing_3','drawing_2','drawing_1']);
await page.tick(5000);
assert.deepEqual(page.artworkReads,['drawing_3','drawing_2','drawing_1']);
page.apply({...progress,drawings:[meta('4'),meta('3'),meta('2')]});
await page.tick(5000);
assert.deepEqual(page.artworkReads,['drawing_3','drawing_2','drawing_1','drawing_4']);
```

Add a cleanup test where `pendingArtworkDeletes:['drawing_1']` causes one delete followed by `confirmArtworkDeletion`, and a failed delete leaves the ID queued for retry.

- [ ] **Step 2: Run focused UI/sync tests and confirm eager `item.data` rendering fails**

Run: `node --test tests/cloud-sync.test.mjs tests/page-integration.test.mjs`

Expected: FAIL because drawing thumbnails currently read embedded `data` and no cleanup hook exists.

- [ ] **Step 3: Implement ID-based lazy image loading**

```js
const artworkCache = new Map();
async function refreshDrawingImages() {
  if (currentView?.type !== 'drawing') return;
  const missing = state.drawings.filter(item=>!artworkCache.has(item.id));
  await Promise.all(missing.map(async item=>artworkCache.set(item.id,await store.readArtwork(item.id))));
  if (currentView?.type === 'drawing') document.getElementById('drawingHistory').innerHTML=drawingHistoryHtml();
}
```

Render loading/error placeholders without inserting an undefined image URL. Call refresh immediately when opening the board and after a progress refresh only while `currentView.type === 'drawing'`. Preserve the current canvas and tools when thumbnail indexes change.

- [ ] **Step 4: Implement automatic deletion retries**

Serialize cleanup so one client loop handles IDs. For each queued ID call `store.deleteArtwork(id)`, then `sync.perform({type:'confirmArtworkDeletion',drawingId:id},\`artwork-delete:${id}\`)`. Trigger after every accepted progress snapshot and after reconnect; leave failed IDs in cloud progress.

- [ ] **Step 5: Run focused and complete Node tests**

Run: `node --test tests/cloud-sync.test.mjs tests/page-integration.test.mjs`

Run: `npm test`

Expected: all tests pass with no repeated artwork read for unchanged IDs.

- [ ] **Step 6: Commit UI and cleanup**

```bash
git add public/index.html public/cloud-sync.mjs tests/cloud-sync.test.mjs tests/page-integration.test.mjs
git commit -m "feat: load latest drawings only when board is open"
```

### Task 4: Remove album and preserve backup/restore migration

**Files:**
- Modify: `public/index.html`
- Modify: `tests/page-integration.test.mjs`
- Modify: `tests/firebase-store.test.mjs`

**Interfaces:**
- Consumes: artwork store methods and metadata-only progress.
- Produces: `buildCompleteBackup(progress)`, `prepareArtworkRestore(candidate)`, and explicit `migrateLegacyArtworks()` teacher backup action.

- [ ] **Step 1: Add failing tests for removed album and three-image backups**

```js
assert.doesNotMatch(await page.backendHtml(),/backend-album|畫冊/);
const backup = await page.downloadBackup();
assert.equal(backup.drawings.length,3);
assert.ok(backup.drawings.every(item=>item.data.startsWith('data:image/')));
assert.equal('drawingAlbum' in backup,false);
```

Add restore coverage proving a legacy backup with five drawings restores only the three greatest valid `savedAt` values. Add migration coverage proving page load performs no writes and explicit migration removes embedded `data` and `drawingAlbum` only after three artwork uploads succeed.

- [ ] **Step 2: Run integration tests and confirm album/backup behavior fails**

Run: `node --test tests/page-integration.test.mjs tests/firebase-store.test.mjs`

Expected: FAIL because the backend still renders the album and backup exports embedded progress directly.

- [ ] **Step 3: Remove album UI and functions**

Remove the backend navigation button, `backend-album` section, album CSS, `downloadAlbumDrawing`, `deleteAlbumDrawing`, and any `refreshBackendPage('backend-album')` calls. Remove `drawingAlbum` from default and browser normalization state.

- [ ] **Step 4: Assemble complete backups and sanitize restores**

```js
async function buildCompleteBackup(progress) {
  const copy=structuredClone(progress);
  copy.drawings=await Promise.all(copy.drawings.slice(0,3).map(async meta=>({...meta,data:(await store.readArtwork(meta.id)).data})));
  delete copy.drawingAlbum;
  delete copy.pendingArtworkDeletes;
  return copy;
}
```

Restore and migration select the newest three valid records from legacy `drawings` plus `drawingAlbum`, upload their payloads, then submit sanitized `restore` or `migrateArtworks` commands. Keep migration behind a teacher confirmation that states historical drawings are permanently removed.

- [ ] **Step 5: Run complete Node and emulator tests**

Run: `npm test`

Run: `firebase emulators:exec --config firebase.emulator.json --project demo-classroom-sync --only database "npm run test:emulator"`

Expected: all tests pass.

- [ ] **Step 6: Commit album removal and migration**

```bash
git add public/index.html public/firebase-store.mjs tests/page-integration.test.mjs tests/firebase-store.test.mjs tests/firebase-store.emulator.mjs
git commit -m "feat: remove historical drawing album"
```

### Task 5: Documentation and final verification

**Files:**
- Modify: `docs/database-structure.md`
- Modify: `docs/cloud-sync-deployment.md`

**Interfaces:**
- Consumes: final schema and verified behavior from Tasks 1–4.
- Produces: deployable schema, migration instructions, and operator verification checklist.

- [ ] **Step 1: Update database documentation**

Document `/artworks/classroom-115/{drawingId}`, three metadata-only indexes, the deletion queue, absence of `drawingAlbum`, lazy reads, save/eviction flow, and backup migration behavior. Update the Mermaid relation from `drawings -> drawingAlbum` to `drawings -> artwork payload`.

- [ ] **Step 2: Update deployment instructions**

Specify rules-first deployment, explicit teacher migration, the permanent deletion of historical album images, verification that `/progress` contains no Data URLs, and verification that normal polling makes no `/artworks` request.

- [ ] **Step 3: Run all automated checks**

Run: `npm test`

Run: `firebase emulators:exec --config firebase.emulator.json --project demo-classroom-sync --only database "npm run test:emulator"`

Run: `git diff --check`

Expected: all Node/DOM tests and Firebase emulator tests pass; diff check emits no output.

- [ ] **Step 4: Review repository changes**

Run: `git status --short`

Run: `git diff --stat HEAD`

Expected: only the implementation, tests, rules, and documentation listed in this plan are changed.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/database-structure.md docs/cloud-sync-deployment.md
git commit -m "docs: document artwork retention and migration"
```
