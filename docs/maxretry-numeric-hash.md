# 衣櫃 maxretry：根因與修正（2026-09-20）

## 已重現的原因

正式分頁登入老師後，28 號衣櫃按「脫下」會拋出 Firebase SDK 12.19.0 的 `maxretry`。
該學生的一筆舊 BOSS 進度含 `hp: 9007199254740991`（`Number.MAX_SAFE_INTEGER`）。
SDK 的 `doubleToIEEE754String()` 使用 `Math.log` 計算指數，在此邊界算出 `4340000000000000`，正確 IEEE 754 編碼應為 `433fffffffffffff`。
客戶端交易 hash 因而與伺服器不同，伺服器持續回覆 `datastale`，直到 SDK 用盡重試次數。

這與多分頁衝突、資料庫 Rules、交易節點太大或快取尚未載入無關。
把交易縮到單一學生或預先訂閱仍包含此數值，所以不能解決。
`tests/firebase-transaction.emulator.mjs` 使用同版 SDK、上述數值及沒有其他寫入者的本機資料庫，重現相同錯誤。

## 修正

- `public/firebase-rest-client.mjs` 統一提供伺服器讀取與 ETag 交易。資料仍依既有授權和 Rules 存取，412 時重新取得最新狀態並計算操作。
- `public/index.html` 的教師房間、單一學生衣櫃及學生個人狀態交易共用此傳輸層；即時監聽仍用 Firebase SDK。
- 協調流程的讀取也向伺服器取得最新值，避免 REST 提交後立即讀到舊 SDK 快取。
- 保留原有節點範圍、收據、還原屏障及投影計畫。不需要調整 Rules、migration 或改寫舊 BOSS 數值。
- 服裝與背景穿脫仍只交易對應學生，先檢查持有狀態、目錄及已知還原時間。依使用情境，本階段不額外處理多老師分頁恰巧同時還原／刪除目錄的競態。

## 驗證紀錄

- Node／DOM 測試 200 項通過。
- Firebase Emulator 測試 48 項通過，包含 SDK 故障重現、ETag 衣櫃／背景穿脫、數值保留、真正衝突、伺服器時間戳與老師投影協調／去重。
- Chrome 本機新版連同一個正式 Firebase，以老師帳號操作：27、28 號各完成脫下及穿回原服裝，沒有 `maxretry`。
- 原正式分頁讀到 28 號脫下的狀態；重新整理後確認 27 號「女生活動服裝 2」、28 號「甲霸尚贏」均已恢復。
- 正式資料操作僅限 27、28 號衣櫃。網站程式尚待使用者自行 commit、push 與部署。

## 本機 Java

已確認 Homebrew OpenJDK 26.0.1 可執行，並在此 Mac 的 `~/.zshenv` 設定：

```sh
export JAVA_HOME="/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
```

使用 `opt/openjdk` 穩定路徑，避免升級後版本目錄改名。新 shell 的 `java -version` 已驗證可用。
CI 沿用 Java 21；無需安裝其他 JDK。
