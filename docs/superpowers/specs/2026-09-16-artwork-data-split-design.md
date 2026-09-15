# 畫板資料拆分設計

## 目標

將畫板 JPEG Data URL 從每 5 秒讀取的班級進度中移出，保存到 `/artworks/classroom-115/{drawingId}`。一般進度同步只取得最新三張畫作的索引；只有使用者開啟畫板時才讀取圖片。

系統永遠只保留最新三張畫作。新增第四張時，最舊畫作立即從進度移除，並由背景清理流程刪除其 `/artworks` 圖片節點。老師後台的「畫冊」頁面、歷史畫冊及個別歷史畫作操作全部移除。

維持既有規則：頁面載入先讀雲端最新進度、本機資料不自動上傳、操作即時寫入、進度不分版本、離線時顯示「離線中」。

## 資料結構

```text
/games/classroom-115
  progress
    drawings
      0
        id: "drawing_uuid"
        savedAt: "2026-09-16T00:00:00.000Z"
      1: ...
      2: ...
    pendingArtworkDeletes
      0: "drawing_old_uuid"
  operations
  lastOperationId
  restoredAt

/artworks/classroom-115
  drawing_uuid
    id: "drawing_uuid"
    savedAt: "2026-09-16T00:00:00.000Z"
    data: "data:image/jpeg;base64,..."
```

`progress.drawings` 最多三筆，只保存 `id` 與 `savedAt`。不再使用 `progress.drawingAlbum`。`pendingArtworkDeletes` 是很小的待清理 ID 清單，不包含圖片。

圖片節點必須位於 `/games/classroom-115` 之外，避免每次班級根節點交易讀取圖片。畫作 ID 沿用 `drawing_` 前綴並以英數字、底線或連字號組成，長度為 8 至 128 字元；這同時相容既有時間戳 ID 與新版 UUID ID。圖片必須是 JPEG 或 PNG Data URL，完整字串最多 1,500,000 字元。

## 一般進度同步

現有每 5 秒讀取 `/games/classroom-115/progress` 的流程維持不變。由於 `drawings` 只剩三筆索引，一般輪詢不下載圖片內容。

一般畫面更新只根據畫作索引判斷最新作品，不能因為圖片尚未載入而刪除索引或回寫空資料。完成遷移後，進度正規化器使用 `{id, savedAt}` 並且不再產生 `drawingAlbum`。遷移前的舊 `data` 與 `drawingAlbum` 只在記憶體中原樣保留，讓其他非畫作操作不會順帶刪除舊作品。

## 畫板行為

開啟畫板時立即取得 `progress.drawings` 的最多三筆索引，並分別讀取 `/artworks/classroom-115/{drawingId}`。畫板保持開啟時，每 5 秒使用一般進度同步後的最新索引更新縮圖：

1. 比較目前顯示的畫作 ID 與最新索引。
2. 已載入且 ID 未變的圖片使用記憶體快取，不重複下載。
3. 新出現或尚未載入的 ID 才讀取對應圖片節點。
4. 已不在最新三筆的縮圖立即從畫板移除。
5. 單張圖片讀取失敗時顯示該縮圖無法載入，不影響其他圖片或一般進度同步。

因此畫板開啟期間仍每 5 秒看到其他裝置新增的最新作品；沒有新畫作時不會反覆下載相同圖片。畫板關閉時不讀取任何畫作圖片。

## 儲存與自動淘汰

畫板儲存使用同一個固定畫作 ID，流程如下：

1. 將 `{id, savedAt, data}` 冪等寫入 `/artworks/classroom-115/{drawingId}`。
2. 成功後送出 `saveDrawing` 班級操作；命令只攜帶 `{id, savedAt}`。
3. 班級交易把索引加入 `progress.drawings` 首位並截成三筆。
4. 被擠出的舊畫作 ID 加入 `progress.pendingArtworkDeletes`；操作收據也回傳該 ID。
5. 任一在線客戶端看到待清理 ID 時，刪除 `/artworks/classroom-115/{drawingId}`，成功後送出 `confirmArtworkDeletion` 操作，從待清理清單移除該 ID。

圖片刪除是冪等操作。刪除失敗或裝置中途關閉時，ID 仍留在 `pendingArtworkDeletes`，下一個在線客戶端會重試；失敗不影響最新三張畫作與其他進度功能。畫作 ID 不重複使用，因此清理舊 ID 不會誤刪新作品。

若圖片寫入成功但索引交易尚未確認，重試沿用相同 ID，不會建立重複作品。待確認操作保留原始畫作資料；索引成功建立後才清除待確認資料。

舊資料尚未完成明確遷移時，畫板仍可查看最新三張舊作品，但暫停新增畫作並提示老師先到「備份」頁遷移。其他任務、購買與設定操作必須原樣保留舊畫作欄位，不能在無意間觸發遷移或刪除。

## 移除老師畫冊

老師後台移除「畫冊」導覽按鈕、畫冊頁面、歷史作品列表、歷史畫作下載及手動刪除功能。老師仍可從一般畫板看到與其他使用者相同的最新三張作品。

畫作不再保存歷史。被第四張新作擠出的作品無法從介面或備份恢復，完成自動清理後也不保留於資料庫。

## 備份、還原與舊資料遷移

下載備份時先讀最新 `progress`，再讀取最多三筆畫作圖片，輸出與既有格式相容的單一 JSON；備份內 `drawings` 每筆重新包含 `data`，不輸出 `drawingAlbum` 或 `pendingArtworkDeletes`。尚未遷移的舊畫作直接使用進度內既有的 `data`。任何最新畫作讀取失敗時停止產生備份，避免建立不完整備份。

還原備份時，只從 `drawings` 取有效且包含完整圖片的最新三張；舊 `drawingAlbum` 不還原。每張作品配置新的畫作 ID，先寫入獨立作品節點，再以不含 `data` 的索引還原 `progress`。新的 ID 可避免還原與其他裝置正在執行的舊圖片刪除互相衝突。

部署新版後，第一次讀到仍在 `progress` 內含 `data` 或 `drawingAlbum` 的舊資料時，只在記憶體辨識，不因開頁自動寫入。老師後台「備份」頁提供明確的「清除舊畫作資料」操作；確認畫面說明全部舊畫作會永久刪除。操作以單一班級交易清空 `progress.drawings` 並移除 `drawingAlbum`，不搬移舊圖片。

## Firebase 規則

`database.rules.json` 新增 `/artworks/classroom-115/{drawingId}` 規則：

- 沿用目前的匿名登入要求。
- 節點鍵與 `id` 必須一致；ID 以 `drawing_` 開頭、只含英數字／底線／連字號，長度 8 至 128 字元。
- `savedAt` 必須是 20 至 40 字元的 ISO 8601 字串。
- `data` 必須符合 JPEG 或 PNG Data URL 前綴，完整字串最多 1,500,000 字元。
- 一般進度規則要求 `drawings` 最多三筆。新格式每筆只能保存 `id`、`savedAt`，不得保存 `data`。
- 遷移前既有的 `data` 與 `drawingAlbum` 只能在非遷移操作中保持完全相同，不可新增或修改；`migrateArtworks`、`restore` 或 `initialize` 成功後不得再出現。
- `pendingArtworkDeletes` 只能保存符合畫作 ID 格式的字串。

這些規則延續現有合作式匿名客戶端的安全邊界，不新增教師身分授權系統。

## 錯誤與離線行為

- 一般進度成功、圖片讀取失敗：一般功能保持可用，畫作位置顯示載入失敗。
- 離線開啟畫板：顯示「離線中」，不把本機圖片回寫雲端。
- 儲存圖片失敗：不送出畫作索引操作，保留同一筆待確認資料供重試。
- 索引操作回應遺失：依既有操作收據查證，不重複建立畫作。
- 自動刪除失敗：保留待清理 ID，恢復連線後重試，不重新顯示已淘汰作品。
- 舊資料尚未遷移：仍可顯示舊 `drawings` 的三張圖片；一般輪詢會繼續下載舊圖片，直到老師完成一次明確遷移。

## 測試與驗收

- 單元測試確認 `saveDrawing` 只保存索引、永遠最多三筆，第四張加入時回傳最舊 ID 並排入清理。
- 單元測試確認 `confirmArtworkDeletion` 只移除已成功刪除的待清理 ID，重試不會誤刪新作品。
- 儲存介面測試確認畫作路徑讀、寫、刪除及相同 ID 重試。
- Firebase 模擬器測試確認畫作規則、大小限制、無效 Data URL、三張上限，以及一般進度拒絕 `data` 與 `drawingAlbum`。
- DOM 整合測試確認一般 5 秒刷新不讀圖片、畫板開啟時只讀最新三張、相同 ID 不重複讀取、畫板新增作品時只讀新 ID。
- DOM 整合測試確認老師後台不存在畫冊入口或歷史畫作功能。
- 備份與還原測試確認只輸出及還原最新三張、缺圖不產生不完整備份、舊格式畫冊不會復原。
- 舊資料清理測試確認開頁不寫入，只有老師明確確認後才清空 `drawings` 並移除 `drawingAlbum`。

以 2026-09-14 的現有備份估算，一般進度單次讀取可由約 308 KB 降至約 24 KB；畫作 metadata 與待清理 ID 增加量很小。實際傳輸量仍以部署後 Firebase Usage 與瀏覽器網路紀錄驗證。
