// Shared-save protocol. Time is display metadata, never a concurrency token.
export const SYNC_PROTOCOL = 3;

export function canonical(value) {
    if (Array.isArray(value)) return JSON.stringify(value.map(item => JSON.parse(canonical(item))));
    if (value && typeof value === "object") {
        return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])));
    }
    return JSON.stringify(value);
}

export function validState(value) {
    return Boolean(value && Array.isArray(value.students) && value.students.length);
}

export function validVersion(value) {
    if (!validState(value)) return false;
    if (value.revision === undefined) return value.syncVersion === undefined || value.syncVersion <= 2;
    return value.syncVersion === SYNC_PROTOCOL && Number.isSafeInteger(value.revision) && value.revision > 0 &&
        typeof value.commitId === "string" && value.commitId.length > 0;
}

export function sameBase(current, base) {
    if (base === null) return current === null;
    if (!current || !base) return false;
    if (base.revision === undefined) return canonical(current) === canonical(base);
    return validVersion(current) && current.revision === base.revision && current.commitId === base.commitId;
}

export function makeWrite(value, base, commitId, timestamp) {
    return {
        ...structuredClone(value),
        lastSaved: new Date().toISOString(),
        syncVersion: SYNC_PROTOCOL,
        revision: (base?.revision || 0) + 1,
        baseCommitId: base === null ? "initial" : (base.commitId || "legacy"),
        commitId,
        updatedAt: timestamp
    };
}

// All I/O is injected so race conditions can be tested without a live database.
export function createCloudSync(io) {
    let base; // The last server-confirmed state; undefined means not initialized.
    let pending = null;
    let connected = false;
    let active = true;
    let verified = false;
    let running = null;
    let requested = false;
    let epoch = 0;
    let conflictNotice = false;

    const editable = () => connected && active && verified && !running && !pending;
    const updateLock = () => io.lock(!editable());
    const copy = value => structuredClone(value);

    function captureDirty() {
        if (base !== undefined && !pending && io.isDirty()) {
            pending = { base: copy(base), value: copy(io.getState()), user: true };
        }
    }

    async function discardConflict(remote) {
        // A failed backup must stop synchronization, not silently discard local work.
        await io.backup({ reason: "version-conflict", base: pending.base, local: pending.value, remote });
        pending = null;
        conflictNotice = true;
    }

    async function cycle() {
        let abortedTransactions = 0;
        while (connected && active) {
            requested = false;
            const ticket = epoch;
            const remote = await io.readRemote(); // Must be a server read, never an SDK cache fallback.
            if (ticket !== epoch || !connected || !active) continue;
            if (remote !== null && !validVersion(remote)) throw new Error("雲端資料或版本異常，已停止寫入。請更新網頁或檢查備份。");
            if (remote === null && (base !== undefined && base !== null || io.getState().revision > 0)) {
                throw new Error("雲端存檔已不存在；為避免舊進度復活，已停止自動建立。");
            }
            if (pending && !sameBase(remote, pending.base)) await discardConflict(remote);
            if (ticket !== epoch || !connected || !active) continue;

            if (pending) {
                const job = pending;
                const payload = makeWrite(job.value, job.base, io.newId(), io.serverTimestamp());
                const result = await io.transact(current => sameBase(current, job.base) ? payload : undefined);
                if (!result.committed) {
                    // An SDK transaction can first see an empty/stale local cache.
                    // Only a new server read may establish a conflict, never this snapshot.
                    if (++abortedTransactions >= 3) throw new Error("交易未完成，已保留待同步進度，請重試。");
                    continue;
                }
                abortedTransactions = 0;
                base = copy(result.value);
                pending = null;
                io.acknowledge(base);
                // Always read again: a newer remote event may have arrived during the write.
                continue;
            }

            if (base === undefined || !sameBase(remote, base)) {
                if (base === undefined && io.shouldBackupInitial(remote)) {
                    await io.backup({ reason: "before-cloud-load", local: copy(io.getState()), remote });
                }
                if (ticket !== epoch || !connected || !active) continue;
                if (remote !== null) io.applyState(copy(remote));
                base = copy(remote);
                const catalogChanged = io.reconcile();
                if (remote === null || remote.revision === undefined || catalogChanged) {
                    pending = { base: copy(base), value: copy(io.getState()), user: false };
                    continue;
                }
            } else {
                io.acknowledge(remote);
            }
            if (requested || ticket !== epoch) continue;
            verified = true;
            io.status(conflictNotice
                ? "⚠️ 其他裝置已更新；已載入雲端進度，本機衝突備份可下載。請重新確認未同步操作。"
                : "☁️ 已確認最新雲端進度");
            return !conflictNotice;
        }
        return false;
    }

    function refresh() {
        captureDirty();
        verified = false;
        requested = true;
        updateLock();
        if (running) return running;
        if (!connected || !active) return Promise.resolve(false);
        io.status("☁️ 正在確認並同步雲端進度…");
        running = Promise.resolve().then(cycle).catch(error => {
            verified = false;
            io.error(error);
            return false; // No tight retry loop on permission/network/storage errors.
        }).finally(() => {
            running = null;
            updateLock();
        });
        updateLock();
        return running;
    }

    return {
        available: true,
        canEdit: editable,
        editToken: () => epoch,
        queueSave(value) {
            if (!editable()) return false;
            conflictNotice = false;
            pending = { base: copy(base), value: copy(value), user: true };
            void refresh();
            return true;
        },
        flush: refresh,
        refresh,
        hasPendingSave: () => Boolean(pending || io.isDirty()),
        setConnected(value) {
            if (connected === value) return;
            captureDirty();
            connected = value;
            verified = false;
            epoch++;
            updateLock();
            if (value) void refresh();
            else io.status("⚠️ 連線中斷，已暫停操作；重新連線後先確認雲端進度。");
        },
        setActive(value) {
            captureDirty();
            active = value;
            verified = false;
            epoch++;
            updateLock();
            if (value) void refresh();
        },
        remoteChanged(remote) {
            if (base !== undefined && sameBase(remote, base)) return;
            // Never discard an event just because a write is in flight.
            void refresh();
        }
    };
}

let backupDatabase;
function openBackupDatabase() {
    if (!backupDatabase) backupDatabase = new Promise((resolve, reject) => {
        const request = indexedDB.open("classroom-115-sync-backups", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("backups", { keyPath: "id" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("備份資料庫被其他分頁阻擋"));
    }).catch(error => { backupDatabase = null; throw error; });
    return backupDatabase;
}

export async function saveConflictBackup(record) {
    const database = await openBackupDatabase();
    const entry = { ...record, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    await new Promise((resolve, reject) => {
        const transaction = database.transaction("backups", "readwrite");
        transaction.objectStore("backups").put(entry);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error("本機備份未完成"));
    });
    return entry;
}

export async function readConflictBackups() {
    const database = await openBackupDatabase();
    return new Promise((resolve, reject) => {
        const request = database.transaction("backups", "readonly").objectStore("backups").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
