/** Pure domain operations. Call again with the latest transaction snapshot on every retry. */
const RECORD_COLLECTIONS = ['students','tasks','clothesM','clothesF','layouts','backgrounds',
    'coopTasks','coopTaskTemplates','dailyTaskTemplates','weeklyTaskTemplates'];
const TOMBSTONES = ['deletedTaskIds','deletedCoopTaskIds'];
const ARTWORK_FIELDS = ['drawings','drawingAlbum','pendingArtworkDeletes'];
const STUDENT_ARRAYS = ['doneTasks','ownedClothes','ownedLayout','equippedLayout','ownedBg'];
const LEGACY_METADATA = ['syncVersion','revision','baseCommitId','commitId','updatedAt'];
const IGNORED_DIFF_FIELDS = new Set([...LEGACY_METADATA,'lastSaved']);
const LEVEL_PRICES = {R:50,SR:100,SSR:200,UR:300};
const DAY = 86_400_000;
const TAIWAN_OFFSET = 8 * 3_600_000;
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const array = value => Array.isArray(value) ? value : [];
const unique = value => [...new Set(array(value))];
const numeric = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const safeKey = key => typeof key === 'string' && !['__proto__','prototype','constructor'].includes(key);
const idValid = id => (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
const validDrawingId = id => typeof id === 'string' && id.length >= 8 && id.length <= 128 && /^drawing_[A-Za-z0-9_-]+$/.test(id);

function legacyArtwork(progress) {
    return Object.hasOwn(progress,'drawingAlbum') || array(progress.drawings).some(item=>object(item) && Object.hasOwn(item,'data'));
}
function indexedDrawings(value) {
    const seen = new Set();
    return array(value)
        .filter(item=>object(item) && validDrawingId(item.id) && Number.isFinite(Date.parse(item.savedAt)))
        .map(({id,savedAt})=>({id,savedAt}))
        .sort((a,b)=>Date.parse(b.savedAt)-Date.parse(a.savedAt))
        .filter(item=>!seen.has(item.id) && seen.add(item.id))
        .slice(0,3);
}
function drawingIds(value) {
    return new Set(array(value).filter(item=>object(item) && validDrawingId(item.id)).map(item=>item.id));
}
function addArtworkDeletes(progress, ids) {
    progress.pendingArtworkDeletes = unique([...progress.pendingArtworkDeletes,...ids]).filter(validDrawingId);
}

function equal(left, right) {
    if (left == null && right == null) return true;
    if (Object.is(left,right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((v,i)=>equal(v,right[i]));
    }
    if (!object(left) || !object(right)) return false;
    const keys = new Set([...Object.keys(left),...Object.keys(right)]);
    return [...keys].every(key=>equal(left[key],right[key]));
}

function templateDefaults(item, weekly = false) {
    const normalized = {...item,enabled:item.enabled !== false,
        appearTime:/^([01]\d|2[0-3]):[0-5]\d$/.test(item.appearTime || '') ? item.appearTime : '08:00',
        dueTime:/^([01]\d|2[0-3]):[0-5]\d$/.test(item.dueTime || '') ? item.dueTime : '23:59'};
    if (weekly) {
        for (const [field,fallback] of [['appearWeekday',1],['dueWeekday',5]]) {
            const value = Number(item[field]);
            normalized[field] = Number.isInteger(value) && value >= 0 && value <= 6 ? value : fallback;
        }
    }
    return normalized;
}

/** Normalize transport omissions without repopulating a catalogue the teacher deleted. */
export function normalizeProgress(value) {
    if (value == null) return null;
    if (!object(value)) throw new Error('遊戲進度格式不正確');
    const progress = clone(value);
    for (const field of LEGACY_METADATA) delete progress[field];
    for (const field of RECORD_COLLECTIONS) progress[field] = array(progress[field]).filter(object);
    for (const field of TOMBSTONES) progress[field] = unique(progress[field]).filter(idValid);
    progress.students = progress.students.map((s,index)=>{
        const normalized = {...s,id:numeric(s.id,index+1),gender:s.gender || (numeric(s.id,index+1)<=12 ? 'M' : 'F'),
            tokens:numeric(s.tokens),lotteryTickets:Math.max(0,Math.floor(numeric(s.lotteryTickets))),
            petAffection:Math.max(0,Math.floor(numeric(s.petAffection))),
            lastPetMoodDate:typeof s.lastPetMoodDate === 'string' ? s.lastPetMoodDate : '',
            equippedClothes:s.equippedClothes ?? null,equippedBg:s.equippedBg ?? null};
        for (const field of STUDENT_ARRAYS) normalized[field] = unique(s[field]);
        normalized.equippedLayout = normalized.equippedLayout.slice(-1);
        return normalized;
    });
    for (const field of ['clothesM','clothesF','layouts','backgrounds']) {
        progress[field] = progress[field].map(item=>({...item,level:item.level || 'R',active:item.active !== false,
            price:item.price == null ? (LEVEL_PRICES[item.level] || LEVEL_PRICES.R) : numeric(item.price,NaN)}));
    }
    progress.dailyTaskTemplates = progress.dailyTaskTemplates.map(item=>templateDefaults(item));
    progress.weeklyTaskTemplates = progress.weeklyTaskTemplates.map(item=>templateDefaults(item,true));
    progress.coopTaskTemplates = progress.coopTaskTemplates.map(item=>({...templateDefaults(item,true),scheduleType:item.scheduleType === 'weekly' ? 'weekly' : 'daily'}));
    progress.coopTasks = progress.coopTasks.map(task=>({...task,completedBy:unique(task.completedBy),claimed:task.claimed === true,
        startAt:task.startAt == null ? null : numeric(task.startAt,null),dueAt:task.dueAt == null ? null : numeric(task.dueAt,null)}));
    if (!legacyArtwork(progress)) progress.drawings = indexedDrawings(progress.drawings);
    progress.pendingArtworkDeletes = unique(progress.pendingArtworkDeletes).filter(validDrawingId);
    if (typeof progress.globalBgImage !== 'string') progress.globalBgImage = '';
    return progress;
}

function requireProgress(progress) {
    if (!progress || progress.students.length < 1) throw new Error('遊戲進度至少需要一位學生，請先初始化或還原進度');
    if (new Set(progress.students.map(s=>s.id)).size !== progress.students.length) throw new Error('學生編號不可重複');
    return progress;
}
function member(progress,id) {
    const student = progress.students.find(s=>s.id === id);
    if (!student) throw new Error('這位學生已不存在，請重新整理成員名單');
    return student;
}
function wardrobe(progress,student,kind) {
    if (kind === 'clothes') return {catalogue:student.gender === 'M' ? progress.clothesM : progress.clothesF,owned:'ownedClothes',equipped:'equippedClothes'};
    if (kind === 'layout') return {catalogue:progress.layouts,owned:'ownedLayout',equipped:'equippedLayout'};
    if (kind === 'background') return {catalogue:progress.backgrounds,owned:'ownedBg',equipped:'equippedBg'};
    throw new Error('商品種類不正確');
}
function clearCloset(student) {
    student.ownedClothes = []; student.equippedClothes = null;
    student.ownedLayout = []; student.equippedLayout = [];
    student.ownedBg = []; student.equippedBg = null;
}
function rewardFor(task) {
    const reward = Number(task.reward ?? 0);
    if (!Number.isFinite(reward) || reward < 0) throw new Error('任務獎勵數值不正確');
    return reward;
}
function checkTiming(task,now) {
    if (task.startAt && now < task.startAt) throw new Error('這項任務尚未開始');
    if (task.dueAt && now > task.dueAt) throw new Error('這項任務已截止');
}
function taiwanDate(now) { return new Date(now + TAIWAN_OFFSET).toISOString().slice(0,10); }
function periodStart(now,weekly) {
    const shifted = new Date(now + TAIWAN_OFFSET);
    if (weekly) shifted.setUTCDate(shifted.getUTCDate() - (shifted.getUTCDay()+6)%7);
    return shifted.toISOString().slice(0,10);
}
function scheduledTimes(template,period,weekly) {
    const offset = weekday => weekly ? ((Number(weekday)+6)%7) * DAY : 0;
    const startAt = Date.parse(`${period}T${template.appearTime}:00+08:00`) + offset(template.appearWeekday);
    let dueAt = Date.parse(`${period}T${template.dueTime}:00+08:00`) + offset(template.dueWeekday);
    if (dueAt <= startAt) dueAt += weekly ? 7*DAY : DAY;
    return {startAt,dueAt};
}
function scheduledCandidates(progress,now) {
    const tasks = [], coopTasks = [];
    for (const weekly of [false,true]) {
        const period = periodStart(now,weekly);
        for (const template of progress[weekly ? 'weeklyTaskTemplates' : 'dailyTaskTemplates']) {
            if (!template.enabled || !template.title || !idValid(template.id)) continue;
            const {startAt,dueAt} = scheduledTimes(template,period,weekly);
            if (now < startAt) continue;
            tasks.push({id:`${weekly ? 'weekly' : 'daily'}_${template.id}_${period}`,title:template.title,
                reward:rewardFor(template),dueAt,...(weekly ? {weeklyTemplateId:template.id,weeklyDate:period} : {dailyTemplateId:template.id,dailyDate:period})});
        }
    }
    for (const template of progress.coopTaskTemplates) {
        if (!template.enabled || !template.monsterName || !template.content || !idValid(template.id)) continue;
        const weekly = template.scheduleType === 'weekly', period = periodStart(now,weekly);
        const {startAt,dueAt} = scheduledTimes(template,period,weekly);
        if (now < startAt) continue;
        coopTasks.push({id:`coop_${weekly ? 'weekly' : 'daily'}_${template.id}_${period}`,monsterName:template.monsterName,
            content:template.content,reward:rewardFor(template),rewardType:template.rewardType === 'ticket' ? 'ticket' : 'token',
            monsterImage:template.monsterImage || '',completedBy:[],claimed:false,startAt,dueAt,coopTemplateId:template.id});
    }
    return {tasks,coopTasks};
}
function tombstoneField(collection) { return collection === 'tasks' ? 'deletedTaskIds' : collection === 'coopTasks' ? 'deletedCoopTaskIds' : null; }
function isScheduledRecord(collection,value) {
    return (collection === 'tasks' && (value.dailyTemplateId != null || value.weeklyTemplateId != null)) || (collection === 'coopTasks' && value.coopTemplateId != null);
}
function addRecord(progress,collection,record,now) {
    if (!object(record) || !idValid(record.id)) throw new Error('新增資料缺少有效編號');
    const deleted = tombstoneField(collection);
    if (deleted && progress[deleted].includes(record.id)) return;
    const existing = progress[collection].find(item=>item.id === record.id);
    if (existing) {
        if (isScheduledRecord(collection,record) || equal(existing,record)) return;
        throw new Error('新增資料的編號已存在，請重新整理後重試');
    }
    if (isScheduledRecord(collection,record)) {
        // UI-generated template tasks are reconstructed from the latest template, never copied from a stale screen.
        const candidate = scheduledCandidates(progress,now)[collection].find(item=>item.id === record.id);
        if (!candidate) return;
        record = candidate;
    }
    progress[collection].push(clone(record));
}

function diffFields(changes,collection,id,before,after,path = []) {
    for (const field of new Set([...Object.keys(before),...Object.keys(after)])) {
        if (!safeKey(field) || (path.length === 0 && (field === 'id' || (collection === '$' && IGNORED_DIFF_FIELDS.has(field))))) continue;
        const oldValue = before[field], newValue = after[field];
        if (equal(oldValue,newValue)) continue;
        const nextPath = [...path,field];
        if (object(oldValue) && object(newValue)) diffFields(changes,collection,id,oldValue,newValue,nextPath);
        else changes.push({collection,...(id === undefined ? {} : {id}),action:'set',field:nextPath[0],
            ...(nextPath.length > 1 ? {path:nextPath} : {}),before:clone(oldValue ?? null),value:clone(newValue ?? null)});
    }
}

/** Patches: record add/remove; order with ID list; set with field or nested path and captured before/value.
 * collection '$' denotes a top-level field. Tombstone collections support monotonic add only.
 */
export function createEditChanges(beforeValue,afterValue) {
    const before = requireProgress(normalizeProgress(beforeValue)), after = requireProgress(normalizeProgress(afterValue));
    const changes = [];
    const removedTasks = new Set(before.tasks.filter(task=>!after.tasks.some(item=>item.id === task.id)).map(task=>task.id));
    // Task removals clean the latest completion arrays when applied, so their derived local changes are not field edits.
    for (const progress of [before,after]) for (const student of progress.students) student.doneTasks = student.doneTasks.filter(id=>!removedTasks.has(id));
    for (const collection of RECORD_COLLECTIONS) {
        const previous = before[collection], next = after[collection];
        const oldById = new Map(previous.map(item=>[item.id,item])), newById = new Map(next.map(item=>[item.id,item]));
        for (const item of previous) if (!newById.has(item.id)) changes.push({collection,id:item.id,action:'remove'});
        for (const item of next) {
            if (!oldById.has(item.id)) changes.push({collection,id:item.id,action:'add',value:clone(item)});
            else diffFields(changes,collection,item.id,oldById.get(item.id),item);
        }
        const commonBefore = previous.filter(item=>newById.has(item.id)).map(item=>item.id);
        const commonAfter = next.filter(item=>oldById.has(item.id)).map(item=>item.id);
        const naturallyAppended = [...commonBefore,...next.filter(item=>!oldById.has(item.id)).map(item=>item.id)];
        const desired = next.map(item=>item.id);
        if (!equal(commonBefore,commonAfter) || !equal(naturallyAppended,desired)) changes.push({collection,action:'order',before:previous.map(item=>item.id),value:desired});
    }
    for (const collection of TOMBSTONES) for (const id of after[collection]) {
        if (!before[collection].includes(id)) changes.push({collection,id,action:'add',value:id});
    }
    const globalBefore = {}, globalAfter = {};
    for (const key of new Set([...Object.keys(before),...Object.keys(after)])) {
        if (RECORD_COLLECTIONS.includes(key) || TOMBSTONES.includes(key) || ARTWORK_FIELDS.includes(key) || IGNORED_DIFF_FIELDS.has(key) || !safeKey(key)) continue;
        globalBefore[key] = before[key]; globalAfter[key] = after[key];
    }
    diffFields(changes,'$',undefined,globalBefore,globalAfter);
    return changes;
}

function removeRecord(progress,collection,id) {
    progress[collection] = progress[collection].filter(item=>item.id !== id);
    const deleted = tombstoneField(collection);
    if (deleted && !progress[deleted].includes(id)) progress[deleted].push(id);
    if (collection === 'tasks') for (const student of progress.students) student.doneTasks = student.doneTasks.filter(taskId=>taskId !== id);
}
function setField(progress,patch) {
    let target = patch.collection === '$' ? progress : progress[patch.collection].find(item=>item.id === patch.id);
    if (!target) throw new Error('要修改的資料已刪除，請重新整理後重試');
    const path = patch.path ?? [patch.field];
    if (!Array.isArray(path) || !path.length || !path.every(safeKey) || path[0] === 'id') throw new Error('欄位變更格式不正確');
    if (patch.collection === '$' && (IGNORED_DIFF_FIELDS.has(path[0]) || RECORD_COLLECTIONS.includes(path[0]) || TOMBSTONES.includes(path[0]) || ARTWORK_FIELDS.includes(path[0]))) throw new Error('不允許整批覆蓋此進度欄位');
    for (const key of path.slice(0,-1)) {
        if (!object(target[key])) throw new Error('資料欄位已被修改，請重新整理以解決衝突');
        target = target[key];
    }
    const field = path[path.length-1];
    if (!equal(target[field],patch.before)) throw new Error('這個欄位已在其他裝置修改，請重新整理以解決衝突');
    target[field] = clone(patch.value ?? null);
}
function applyChanges(progress,changes,now) {
    if (!Array.isArray(changes)) throw new Error('欄位變更格式不正確');
    for (const patch of changes) {
        if (!object(patch) || !['add','remove','set','order'].includes(patch.action) ||
            ![...RECORD_COLLECTIONS,...TOMBSTONES,'$'].includes(patch.collection)) throw new Error('欄位變更格式不正確');
        if (patch.collection !== '$' && patch.action !== 'order' && !idValid(patch.id)) throw new Error('欄位變更缺少資料編號');
        if (TOMBSTONES.includes(patch.collection) && patch.action !== 'add') throw new Error('刪除紀錄只能透過還原進度重置');
        if (patch.collection === '$' && patch.action !== 'set') throw new Error('全域欄位變更格式不正確');
    }
    for (const patch of changes.filter(p=>p.action === 'remove')) removeRecord(progress,patch.collection,patch.id);
    const scheduledAdds = [], orders = [];
    for (const patch of changes) {
        const {collection,action} = patch;
        if (action === 'remove') continue;
        if (TOMBSTONES.includes(collection)) {
            if (!progress[collection].includes(patch.id)) progress[collection].push(patch.id);
            removeRecord(progress,collection === 'deletedTaskIds' ? 'tasks' : 'coopTasks',patch.id);
        } else if (action === 'set') setField(progress,patch);
        else if (action === 'order') orders.push(patch);
        else if (isScheduledRecord(collection,patch.value || {})) scheduledAdds.push(patch);
        else addRecord(progress,collection,patch.value,now);
    }
    for (const patch of scheduledAdds) addRecord(progress,patch.collection,patch.value,now);
    for (const patch of orders) {
        if (!Array.isArray(patch.before) || !Array.isArray(patch.value) || !patch.value.every(idValid) || new Set(patch.value).size !== patch.value.length) throw new Error('排序資料格式不正確');
        const list = progress[patch.collection], byId = new Map(list.map(item=>[item.id,item]));
        const originalIds = new Set(patch.before), desiredIds = new Set(patch.value);
        const comparable = id=>originalIds.has(id) && desiredIds.has(id) && byId.has(id);
        if (!equal(list.map(item=>item.id).filter(comparable),patch.before.filter(comparable))) throw new Error('商品排序已在其他裝置修改，請重新整理以解決衝突');
        const ordered = patch.value.filter(id=>byId.has(id)).map(id=>byId.get(id));
        const selected = new Set(ordered.map(item=>item.id));
        let index = 0;
        progress[patch.collection] = list.map(item=>selected.has(item.id) ? ordered[index++] : item);
    }
}

/** The command's random samples are captured once by the UI; this function never samples randomness. */
export function applyOperation(value,command,now = Date.now()) {
    if (!object(command) || typeof command.type !== 'string') throw new Error('遊戲操作格式不正確');
    now = Number(now);
    if (!Number.isFinite(now)) throw new Error('操作時間不正確');
    let progress = normalizeProgress(value);
    if (command.type === 'initialize' && progress !== null) return {progress:requireProgress(progress),result:null,changed:false};
    if (command.type === 'initialize' || command.type === 'restore') {
        const previousArtworkIds = command.type === 'restore' && progress !== null && !legacyArtwork(progress) ? drawingIds(progress.drawings) : new Set();
        const previousArtworkDeletes = command.type === 'restore' && progress !== null ? progress.pendingArtworkDeletes : [];
        const restored = requireProgress(normalizeProgress(command.value));
        if (command.type === 'restore') addArtworkDeletes(restored,[...previousArtworkDeletes,...[...previousArtworkIds].filter(id=>!drawingIds(restored.drawings).has(id))]);
        return {progress:restored,result:null,changed:!equal(progress,restored)};
    }
    requireProgress(progress);
    const before = clone(progress);
    let result = null;
    switch (command.type) {
    case 'completeTask': {
        const student = member(progress,command.studentId), task = progress.tasks.find(item=>item.id === command.taskId);
        if (!task) throw new Error('這項任務已不存在');
        if (student.doneTasks.includes(task.id)) break;
        checkTiming(task,now);
        const reward = rewardFor(task);
        student.doneTasks.push(task.id); student.tokens += reward;
        result = {reward};
        break;
    }
    case 'purchase': {
        const student = member(progress,command.studentId), info = wardrobe(progress,student,command.kind);
        const item = info.catalogue.find(item=>item.id === command.itemId);
        if (!item || item.active === false) throw new Error('商品已下架或不存在');
        if (student[info.owned].includes(item.id)) break;
        if (!Number.isFinite(item.price) || item.price < 0) throw new Error('商品價格不正確');
        if (student.tokens < item.price) throw new Error('代幣不足！');
        student.tokens -= item.price; student[info.owned].push(item.id);
        result = {item:clone(item)};
        break;
    }
    case 'lottery': {
        if (![command.roll,command.indexRoll].every(sample=>typeof sample === 'number' && Number.isFinite(sample) && sample >= 0 && sample < 1)) throw new Error('抽獎亂數必須介於 0（含）與 1（不含）之間');
        const student = member(progress,command.studentId);
        if (student.lotteryTickets < 1) throw new Error('樂透券不足！');
        const prizes = ['clothes','layout','background'].flatMap(kind=>wardrobe(progress,student,kind).catalogue.filter(item=>item.active !== false).map(item=>({item,kind})));
        if (!prizes.length) throw new Error('商店目前沒有可抽取的商品！');
        const wantedLevel = command.roll < .8 ? 'R' : command.roll < .95 ? 'SR' : command.roll < .99 ? 'SSR' : 'UR';
        const matching = prizes.filter(prize=>prize.item.level === wantedLevel), pool = matching.length ? matching : prizes;
        const prize = pool[Math.floor(command.indexRoll * pool.length)], owned = wardrobe(progress,student,prize.kind).owned;
        const duplicate = student[owned].includes(prize.item.id);
        student.lotteryTickets -= 1;
        if (duplicate) student.tokens += 20;
        else student[owned].push(prize.item.id);
        result = {item:clone(prize.item),duplicate};
        break;
    }
    case 'equip': {
        const student = member(progress,command.studentId), info = wardrobe(progress,student,command.kind);
        if (command.itemId !== null && (typeof command.itemId !== 'string' || !student[info.owned].includes(command.itemId))) throw new Error('衣櫃尚未擁有這項商品');
        if (command.itemId !== null && !info.catalogue.some(item=>item.id === command.itemId)) throw new Error('這項商品已不存在');
        student[info.equipped] = command.kind === 'layout' ? (command.itemId === null ? [] : [command.itemId]) : command.itemId;
        break;
    }
    case 'petMood': {
        const student = member(progress,command.studentId), today = taiwanDate(now), oldLevel = Math.floor(student.petAffection/10)+1;
        result = {awarded:false,bonus:0,level:oldLevel};
        if (student.lastPetMoodDate === today) break;
        student.petAffection++; student.lastPetMoodDate = today;
        const level = Math.floor(student.petAffection/10)+1, bonus = (level-oldLevel)*10;
        student.tokens += bonus; result = {awarded:true,bonus,level};
        break;
    }
    case 'coopComplete': {
        member(progress,command.studentId);
        const task = progress.coopTasks.find(item=>item.id === command.taskId);
        if (!task) throw new Error('這項協力任務已不存在');
        const reward = rewardFor(task), rewardType = task.rewardType === 'ticket' ? 'ticket' : 'token';
        result = {claimed:false,reward,rewardType,monsterName:task.monsterName || ''};
        if (task.claimed) break;
        checkTiming(task,now);
        if (rewardType === 'ticket' && !Number.isInteger(reward)) throw new Error('樂透券獎勵必須是整數');
        if (!task.completedBy.includes(command.studentId)) task.completedBy.push(command.studentId);
        if (progress.students.every(student=>task.completedBy.includes(student.id))) {
            for (const student of progress.students) student[rewardType === 'ticket' ? 'lotteryTickets' : 'tokens'] += reward;
            task.claimed = true; result.claimed = true;
        }
        break;
    }
    case 'saveDrawing': {
        const drawing = command.drawing;
        if (legacyArtwork(progress)) throw new Error('舊畫作資料尚未遷移');
        if (!object(drawing) || !validDrawingId(drawing.id) || !Number.isFinite(Date.parse(drawing.savedAt)) || Object.hasOwn(drawing,'data')) throw new Error('畫作資料格式不正確');
        result = {evictedArtworkIds:[]};
        if (progress.drawings.some(item=>item.id === drawing.id)) break;
        const candidates = indexedDrawings([drawing,...progress.drawings]);
        const retainedIds = new Set(candidates.map(item=>item.id));
        const evictedArtworkIds = [drawing,...progress.drawings].map(item=>item.id).filter(id=>!retainedIds.has(id));
        progress.drawings = candidates;
        addArtworkDeletes(progress,evictedArtworkIds);
        result = {evictedArtworkIds};
        break;
    }
    case 'confirmArtworkDeletion': {
        if (!validDrawingId(command.drawingId)) throw new Error('畫作編號格式不正確');
        progress.pendingArtworkDeletes = progress.pendingArtworkDeletes.filter(id=>id !== command.drawingId);
        break;
    }
    case 'migrateArtworks': {
        if (!Array.isArray(command.drawings)) throw new Error('畫作資料格式不正確');
        progress.drawings = indexedDrawings(command.drawings);
        delete progress.drawingAlbum;
        break;
    }
    case 'resources': {
        const {field,mode,amount} = command;
        if (!['tokens','lotteryTickets'].includes(field) || !['add','set'].includes(mode)) throw new Error('資源操作格式不正確');
        if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new Error('請輸入有效數值');
        if (field === 'lotteryTickets' && (!Number.isInteger(amount) || (mode === 'set' && amount < 0))) throw new Error('樂透券必須設定為大於或等於 0 的整數');
        if (command.all === true && command.studentId != null) throw new Error('請指定單一學生或全體學生');
        const students = command.all === true ? progress.students : [member(progress,command.studentId)];
        for (const student of students) {
            const next = mode === 'add' ? student[field]+amount : amount;
            if (!Number.isFinite(next)) throw new Error('資源數值超出可使用範圍');
            student[field] = field === 'lotteryTickets' ? Math.max(0,next) : next;
        }
        break;
    }
    case 'resetCloset':
        clearCloset(member(progress,command.studentId));
        break;
    case 'resetResources':
        for (const student of progress.students) {
            student.tokens = 0; student.lotteryTickets = 0; clearCloset(student);
        }
        break;
    case 'resizeStudents': {
        const count = command.count;
        if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('學生人數必須是 1 至 1000 的整數');
        const currentById = new Map(progress.students.map(student=>[student.id,student]));
        progress.students = Array.from({length:count},(_,index)=>currentById.get(index+1) || {id:index+1,gender:index%2 === 0 ? 'M' : 'F'});
        progress = normalizeProgress(progress);
        break;
    }
    case 'gender': {
        if (!['M','F'].includes(command.gender)) throw new Error('性別設定不正確');
        const student = member(progress,command.studentId);
        student.gender = command.gender;
        const catalogue = wardrobe(progress,student,'clothes').catalogue;
        if (student.equippedClothes && !catalogue.some(item=>item.id === student.equippedClothes)) student.equippedClothes = null;
        break;
    }
    case 'edit':
        applyChanges(progress,command.changes,now);
        progress = requireProgress(normalizeProgress(progress));
        break;
    case 'schedule': {
        const candidates = scheduledCandidates(progress,now);
        for (const collection of ['tasks','coopTasks']) for (const task of candidates[collection]) addRecord(progress,collection,task,now);
        break;
    }
    default: throw new Error('不支援的遊戲操作');
    }
    return {progress,result,changed:!equal(before,progress)};
}
