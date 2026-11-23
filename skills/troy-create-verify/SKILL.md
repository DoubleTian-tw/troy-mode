---
name: troy-create-verify
description: 為目標專案建立（init）或健檢更新（audit）專屬的實機驗證 skill（verify-<app>）與功能地圖（features/）。會先從原始碼摸清啟動、操作面、驅動方式與證據留存，產出不留空殼的實機驗證腳本並實跑驗證，亦支援改版後掃描文件飄移與實機回歸。Use when asked to "/troy-create-verify", "建立專案驗證 skill", or "檢查並更新 verify skill".
disable-model-invocation: true
---

# Troy Create Verify — 專案實機驗證生成器與健檢器

替任何專案建立「能像真實使用者一樣把 App 跑起來、實際操作核心流程並留下證據」的專案專屬 `verify-<app>` skill；之後專案改版時，也用同一支 skill 做健檢同步。

> 若存在 `~/.agents/CONTEXT.md`，先讀取並遵守其語言與安全規範。本工具不依賴任何特定前端／後端框架，依目標專案結構自動調整。

## 安全紅線

- **嚴禁讀取、複製或印出任何 `.env*` 或金鑰憑證檔**；只參考 `.env.example` 或專案文件說明測試環境所需變數名稱。
- **嚴禁對 staging／production 或真實外部金流／簡訊服務執行驅動與測試**；只操作純本機開發／隔離測試環境。
- **Cleanup 不可用粗暴殺進程指令**（禁止 `pkill -f node` 這類可能誤殺使用者其他工作視窗的指令），只能紀錄並清理自己啟動的子行程 PID 與暫存狀態，且**清理時不可刪掉已產出的驗證證據檔**。

## 先判別執行模式

- **`init` 模式（建立）**：目標專案還沒有 `verify-*` skill 時採用。
- **`audit` 模式（健檢更新）**：目標專案已經有 `verify-*` skill（與其 `features/` 功能地圖），專案改版後需要檢查步驟是否過時。若專案內同時有多個 `verify-*`，先詢問使用者要檢哪一個。

## 產出路徑偵測規則

- 若目標專案存在 `.ai/skills/` 目錄慣例（由 `.ai/` 同步至 `.agents/` 的 repo）→ 產出／編輯 `.ai/skills/verify-<app>/`，完成後依該專案習慣同步 `.agents/skills/`。
- 其他一般專案 → 預設產出／編輯 `.agents/skills/verify-<app>/`（若專案另有 `.claude/skills/` 且未建立連結，完成後提示或依使用者意願同步 symlink）。

---

## 模式一：`init`（從零建立 `verify-<app>`）

### Step 1：先讀專案，只問程式碼裡看不出來的事
從 `package.json`、`Makefile`、`README`、Docker／Worker 設定、路由／Controller／既有測試套件讀出五件事（找得到的都不准問使用者）：
1. **Surface（操作面）**：Web UI、HTTP API、CLI/TUI、Edge Worker 或函式庫？
2. **Run（啟動與可用條件）**：啟動指令、Port、必要的 Migration／Seed 步驟，以及「真正可操作」的判斷訊號（不只是 Port 通了或 DB 回 OK，必須連背景 init 都完成）。
3. **Drive（驅動方式）**：優先複用專案既有測試或腳本工具（Playwright、Vitest、HTTP 腳本等），沒有時再選瀏覽器／PTY／HTTP curl。優先使用穩定的語意定位（ARIA role、`data-testid`、明確 API route），避免座標點擊或脆選擇器。
4. **Evidence（證據格式）**：截圖、回應 JSON、Exit code、Terminal transcript、DB／檔案寫入副作用與存放路徑。
5. **Isolate（隔離性）**：能否同時開兩個實例互不幹擾（Port、資料目錄、Profile）；若不能併發共用，須在文件明文規定「偵測到已有實例運行時禁止搶驅動」。

**前置檢查**：先驗證目前 checkout 能否正常建置與啟動；若底座原本就壞掉，**直接回報卡點與修法，不對壞掉的版本硬寫假驗證流程**。

### Step 2：產出 `verify-<app>/SKILL.md` 與功能地圖
寫入正確 YAML frontmatter（`name: verify-<app>` 與清楚的 `description`）並落實以下五個具體段落（**嚴禁留佔位符或待補字樣**）：
- **Launch**：從空狀態（含 migration／seed）到真正可操作所需的完整指令與就緒判斷、以及結束後的 teardown。
- **Doctor**：一條唯讀快速健檢指令，能確認「行程活著、跑的是目前 build、Port 歸我們所有、測試認證有效」。異常時先跑這條。
- **Drive**：實寫可執行的操作方式與穩定定位點（寫真實 route / selector / script，不寫泛用範例）。
- **Evidence**：規定必須同時檢查「動作結果＋系統副作用（寫入的檔案、DB row、回傳內容）」及證據留存路徑；若走 test-mode／dry-run，必須實測它真的跳過外部副作用而非只看參數名稱。
- **Cleanup**：如何只關掉這次啟動的行程與暫存檔，並確保 Proof 證據在 teardown 後仍存在。

同時在 `verify-<app>/features/` 下建立：
- `README.md`（功能總索引，每行對應一張功能卡）
- 每項主要使用者功能各一份 `<feature>.md`（涵蓋：來源程式進入點、前置條件／權限、操作步驟、預期可見畫面或回應＋實際副作用）。

### Step 3：實際跑通至少一項功能才算交卷
依剛寫好的 `verify-<app>/SKILL.md` 實跑一輪完整閉環：**Launch → Doctor → 實測至少 1 個核心功能並留存 Evidence → Cleanup（並確認 Evidence 仍保留在指定路徑）**。若跑不過，直接修好驗證腳本直到實跑成功才回報完成。

---

## 模式二：`audit`（改版後健檢與同步 `verify-<app>`）

### 編輯權限鐵律
**只能修改 `verify-<app>/` 底下的檔案（`SKILL.md`、`features/` 與驗證專用 helper）。嚴禁在 `audit` 過程順手改動產品程式碼！**

### 執行步驟
1. **索引清點**：核對 `features/README.md` 與 `features/*.md`，清掉孤兒頁、重複項與漏列檔。
2. **原始碼平行比對**：針對每張功能卡（可平行派唯讀 subagent）檢查最新原始碼，找出「程式已經改流程或刪欄位，但文件還寫舊的」文件飄移，以及最近 Git 異動中新增卻漏進地圖的使用者功能。
3. **實機全功能回歸（Live Pass）**：即使原始碼看起來沒飄移，仍必須依 `Launch` 與 `Doctor` 規則實跑每個功能一次，守住三條不變量：
   - 不健康不驅動（開跑前與任何一次失敗後都必重跑 `Doctor`；若 UI 卡住或狀態污染，直接重置狀態或重啟實例，不硬猜往下跑）。
   - Cleanup 後複查 Evidence 確實留存在目標位置。
   - 若某功能因缺少外部授權／前置資格無法觸及，明確標記為 `verified-unreachable` 並記下具體前提（若連地圖都漏寫該前提，一併修補地圖）。
4. **問題分流處理**：
   - 文件／操作順序過時 → 更新 `SKILL.md` 或 `features/*.md`。
   - 驗證腳本／定位器壞掉 → 修補驗證腳本並**實機重跑確認修好**。
   - 產品功能本身真的壞了 → **列為 Product Bug 回報使用者**，絕不在文件裡硬掰改寫成「正常行為」來掩蓋故障。
5. **結案定性**：明確宣告本次結果為 `clean`（全數通過無飄移）、`changed`（已修補文件或腳本並重測通過）或 `blocked`（卡關項目與真實阻礙）。
