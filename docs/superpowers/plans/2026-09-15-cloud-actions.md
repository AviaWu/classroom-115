# 雲端操作同步實作計畫

**已核准需求：** 開頁及重新整理讀取最新雲端；不自動上傳本機進度、不比較進度版本；每 5 秒背景讀取；使用者操作立即寫入且不顯示處理中；離線顯示「離線中」並停用資料修改；備份移至教師後台。使用者已同意並行衝突、重複操作、空資料、草稿保留及備份還原規則。

**架構：** 保留 Firebase Realtime Database 的 `games/classroom-115/progress` 最新進度。使用交易在最新雲端內容上套用單筆操作，並原子記錄 `operations/{operationId}` 收據；收據只防止重複執行，不儲存進度版本。資料庫規則拒絕未附新操作收據的舊客戶端整份覆寫。

**執行方式：** 本工作階段持續完成；已核准規則不再重複要求批准。操作 reducer 與頁面／同步控制器分檔工作，整合後共同驗證。

- [x] `public/game-operations.mjs` + `tests/game-operations.test.mjs`：純操作規則、資源交易、協力一次發獎、固定抽獎樣本、每日寵物互動、教師欄位變更與排程。先寫失敗測試。
- [x] `public/cloud-sync.mjs` + `tests/cloud-sync.test.mjs`：只讀啟動、5 秒輪詢、背景操作、不確定結果的收據查證、重連先讀、拒絕舊讀取回應。
- [x] `public/firebase-store.mjs`：Firebase 交易與收據處理，交易重試不重新抽獎；只在明確操作時移除舊同步欄位。
- [x] `public/index.html` + `tests/page-integration.test.mjs`：逐一接入任務、購買、樂透、衣櫃、寵物、背景、互動、協力、畫板與教師所有修改；保留開啟的視窗、頁籤、輸入及畫板；備份使用伺服器最新讀取。
- [x] `database.rules.json` + `tests/database-rules.emulator.mjs`：防止舊寫入、驗證收據不可改寫、限制登入使用者與進度格式；以本機模擬器測試。
- [x] `docs/database-structure.md` 與部署文件：實際資料節點、欄位、關聯、寫入行為、正式部署順序與驗證結果。
- [x] 執行 Node 測試、資料庫規則模擬器及瀏覽器整合檢查；檢查 diff，交付修改與結構表。

**驗證指令：** `node --test tests/*.test.mjs`；`firebase emulators:exec --config firebase.emulator.json --project demo-classroom-sync --only database "npm run test:emulator"`。測試不得連線正式資料庫寫入。

**完成驗證：** 71 個 Node／DOM 測試、25 個 Firebase 規則／真實 REST 交易模擬器測試通過；Chrome 隔離測試頁確認購買扣款、樂透扣券與結果、原視窗保留、後台備份入口。`git diff --check` 通過。未部署正式網站，未寫入正式遊戲資料。
