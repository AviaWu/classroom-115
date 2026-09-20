# 學生個人投影：第二階段 migration

第二階段只會從 `games/classroom-115/progress/students/0..27` 刪除下列六個重複欄位：

- `tokens`
- `lotteryTickets`
- `petAffection`
- `lastPetMoodDate`
- `equippedLayout`
- `bossProgress`

`studentStates/{uid}` 已是這些資料的唯一權威來源。migration 不會把舊 progress 值寫回 `studentStates`，也不會修改學生名冊、寵物、BOSS、題庫、服裝、背景、任務、教師操作紀錄或任何其他欄位。學生 1–28 必須依序對應 progress index 0–27；學生 27、28 都是一般測試學生。帳號 29、30 不得出現在 active roster。

## 執行順序

1. **先部署相容版本。** 這個版本在 migration 前仍會保留六個 legacy 欄位，在 migration 後也能讀取精簡 progress；不可先刪資料再部署。
2. 確認部署成功後，要求所有老師與學生重新整理或關閉再開啟既有分頁，避免舊分頁繼續寫入 legacy progress。
3. 從正式 Realtime Database 匯出完整 root JSON 備份。不要只備份 `progress`，因為 preview 還要驗證 `studentRoster` 與 `studentStates`。
4. 在本機離線建立 plan，逐項檢查後保留原檔；preview 不需要 token，也不會連線。
5. 只有在使用者另行核准正式 migration 後，才可執行線上 apply。
6. apply 後重新匯出完整 root、執行下面的驗證並保留 migration plan。plan 同時是唯一允許的 scoped rollback 依據。

## 完整備份與離線 preview

本機 migration 檔案應放在已被 git 忽略的 `.local-migrations/`。Firebase CLI 指令一律移除 `DEBUG`，避免認證資訊出現在 debug output：

```sh
mkdir -p .local-migrations

env -u DEBUG firebase database:get / \
  --project classroom-115 \
  --instance classroom-115-default-rtdb \
  --output .local-migrations/full-root-before-phase2.json

node scripts/progress-phase2.mjs \
  --input .local-migrations/full-root-before-phase2.json \
  --output ".local-migrations/progress-phase2-plan-$(date -u +%Y%m%dT%H%M%SZ).json"
```

每次 preview 都要使用全新的 output 檔名；工具以 exclusive create 建檔，不會覆寫完整 root 備份、既有 plan 或任何其他檔案。記下實際產生的 plan 路徑，後續 apply 與 rollback 都只使用同一份已核准檔案。

preview 會拒絕下列任一狀況：output 已存在、不是剛好 28 位 active UID、重複或交換 student ID、progress 的 index/id 不一致、缺少或格式錯誤的權威 state、`_teacherOperation`、`_projectionSync`，或仍為 `projecting` 的老師操作。

檢查 plan 時至少確認：

- `roomPath` 僅為 `games/classroom-115`；
- `deletions` 最多 168 筆，而且每筆只有上述六個欄位、index 只在 0–27；
- 每筆 deletion 都包含精確 `before` 值，`deletePatch` 與 `rollbackPatch` 一致；
- `expectedRoster` 剛好是已核對的 28 個 UID；
- `divergences` 只是列出 legacy 與最新 `studentStates` 的差異，不會用 legacy 覆蓋 state；
- count、byte summary 與 `reviewDigest` 合理，且 plan 檔案在核准後沒有再被修改。

## 明確核准後才 apply

下列指令只接受精確的正式 database URL。`FIREBASE_ID_TOKEN` 必須是目前仍有效的老師 Firebase ID token；不要把 token 寫入 plan、文件、終端指令參數或版本庫。

```sh
printf 'Teacher Firebase ID token: '
read -r -s FIREBASE_ID_TOKEN
printf '\n'
export FIREBASE_ID_TOKEN

node scripts/progress-phase2.mjs \
  --plan .local-migrations/progress-phase2-plan-YYYYMMDDTHHMMSSZ.json \
  --database-url https://classroom-115-default-rtdb.asia-southeast1.firebasedatabase.app \
  --apply

unset FIREBASE_ID_TOKEN
```

沒有 `--apply` 時工具必定拒絕線上操作。apply 會先讀取 live room、roster 與 states，再以 Firebase server ETag transaction 寫入 room；transaction 內會重新驗證 room identity、同步狀態及每個已核准的原值。任何舊值變更、意外新增的六類欄位、部分套用或 mapping 變更都會停止操作。重複執行同一 plan 是安全的 no-op。

## apply 後驗證

1. 再次匯出完整 root，確認 `progress.students/0..27` 已沒有六個欄位，其他 progress 資料未變。
2. 確認 `studentRoster`、`studentStates`、`studentPets`、`publicBosses`、`publicQuestionPapers` 未被 migration 修改。
3. 重新整理後實測老師頁，以及學生 1、27、28；確認資源、寵物心情與 BOSS 進度顯示最新 `studentStates` 值。
4. 執行一筆正常老師操作與一筆學生操作，再下載備份；備份畫面必須包含 hydration 後的完整學生資料，而資料庫 progress 仍保持精簡。
5. 確認沒有 `_projectionSync`、`projecting` receipt 或 `_teacherOperation` marker 殘留。

## Scoped rollback

rollback 只會把原 plan 中實際刪除的 progress 個人欄位恢復成 plan 的 `before` 值。它不會回復或覆蓋 `studentStates`，因此不是學生遊戲進度的時間回復。apply 後產生的新資源、寵物或 BOSS 狀態仍以最新 `studentStates` 為準；其他 progress 欄位也會保留目前值。

只有在 operations verification 判定需要回復 legacy 相容資料，且使用者另外核准後，才可執行：

```sh
printf 'Teacher Firebase ID token: '
read -r -s FIREBASE_ID_TOKEN
printf '\n'
export FIREBASE_ID_TOKEN

node scripts/progress-phase2.mjs \
  --plan .local-migrations/progress-phase2-plan-YYYYMMDDTHHMMSSZ.json \
  --database-url https://classroom-115-default-rtdb.asia-southeast1.firebasedatabase.app \
  --rollback \
  --apply

unset FIREBASE_ID_TOKEN
```

rollback 同樣使用 room ETag transaction。若任一受控欄位已有衝突值、plan 不符、mapping 改變或老師同步尚未完成，工具會 fail closed。重複 rollback 是安全的 no-op。rollback 後仍要重新匯出 root，並重做老師與學生操作驗證。
