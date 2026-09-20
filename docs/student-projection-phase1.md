# 學生個人投影：第一階段 migration

第一階段只新增學生專用投影節點，**不會刪除、搬移或精簡**既有的 `/games/classroom-115/progress`。第二階段必須等第一階段完成實機測試後，另行確認才可進行。

## 新增的節點

```text
studentRoster/{firebaseUid}          # { studentId: 1..28, active: true }
studentStates/{firebaseUid}          # 學生自己的寵物、資源及 BOSS 進度
studentPets/{firebaseUid}            # 該學生擁有的寵物資料
publicBosses/{bossId}                # 已啟用 BOSS
publicQuestionPapers/{paperId}       # 已啟用 BOSS 所需題庫
```

學生 1 對應舊資料 `progress/students/0`，學生 28 對應 `progress/students/27`。學生 29、30 不放入 `studentRoster`，因此可登入但沒有任何投影畫面或可寫資料。

## 正式執行前

1. 從 Firebase Realtime Database 匯出完整 JSON 備份，保留原始檔。
2. 準備只含學生 1–28 的 JSON 對照表：

   ```json
   {
     "1": "Firebase Auth 的 student-1 UID",
     "28": "Firebase Auth 的 student-28 UID"
   }
   ```

3. 從備份擷取 `games/classroom-115/progress` 成獨立 `progress.json`。
4. 先離線產生並檢查 payload：

   ```sh
   node scripts/build-student-projections.mjs \
     --progress progress.json \
     --roster student-id-to-uid.json \
     --output student-projections.json
   ```

5. 檢查 `student-projections.json`：必須剛好有 28 個 `studentRoster`、`studentStates`；確認學生 1 的代幣來自舊 `students/0`，學生 28 來自舊 `students/27`。不應出現學生 29、30。

## 部署與套用順序

下列操作會影響正式環境，請在確認 payload 後才做；本專案目前沒有自動部署或自動套用程式。

1. `firebase.json` 已將 `database.rules.phase1.json` 設為正式 Firebase Rules 部署來源。該檔案讓老師保留完整班級資料存取權，學生只能讀寫自己的投影。
2. 使用具備專案管理權限且已執行 `firebase login` 的 Firebase CLI，確認目標專案與資料庫執行個體均為正式環境。
3. 在舊網頁與舊 Rules 仍運作時，先以管理員 CLI 明確套用已檢查的 payload：

   ```sh
   firebase database:update / student-projections.json \
     --project classroom-115 \
     --instance classroom-115-default-rtdb \
     --force
   ```

   `student-projections.json` 的產生工具只會輸出五個投影根節點，且拒絕混入舊 `games` 資料；`database:update` 會以管理員權限 PATCH 新增或更新這五個節點，不會寫入 `games/classroom-115/progress`。舊網頁不會讀取這些新節點，因此此步驟不影響現有使用者。

4. 在 Firebase Console 確認五個新節點存在，再 commit／push 並合併至 `main`。GitHub workflow 會先部署 phase‑1 Rules，成功後才部署本次 `public` 網頁，避免新版學生頁在投影尚未建立時上線。
5. 實機測試：教師、學生 1、學生 28、學生 29、學生 30，以及同一學生兩台裝置的寵物互動與 BOSS 攻擊。

## 教師與學生資料一致性

教師畫面會把最新 `studentStates` 覆蓋到舊 `progress.students[]` 的個人欄位。教師送出任何操作時，程式使用同一筆 RTDB 根節點 transaction，先合併 transaction 當下最新的學生狀態，再同時更新 `games/classroom-115`、`studentStates`、`studentPets`、`publicBosses` 與 `publicQuestionPapers`。若學生剛好同時互動，Firebase 會重跑教師 transaction，不會用教師先前看到的舊快照覆蓋學生結果。

根節點 transaction 僅開放老師 Email/Password 帳號；學生仍只能交易自己的 `studentStates/{uid}`。此機制已包含於 phase‑1 Rules，必須依上述順序先部署 Rules，再部署網頁。

## 免費方案的安全邊界

學生不可建立缺少 roster 的投影、修改自己的 `studentId`／擁有寵物清單、裝備未擁有的寵物，或寫入其他學生資料。不過在完全沒有可信任後端（Cloud Functions／自有伺服器）的前提下，BOSS 題目、答案與攻打密碼必須提供給前端，代幣與 BOSS 結果也無法由伺服器完整驗證。熟悉開發者工具的使用者仍可能偽造自己的遊戲結果；前端混淆只能提高查看難度，不能形成真正的安全邊界。
