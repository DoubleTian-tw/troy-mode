---
name: troy-pickup
description: 跨 Agent 接續中斷任務的入口（支援讀取 /troy-pause 交接檔，或在突然斷線未存檔時自動掃描 Claude Code、Codex、Antigravity、Cursor 本機對話紀錄重建進度）。Use when asked to "/troy-pickup", "take over", "resume session", or "接手剛才做到一半的任務".
disable-model-invocation: true
---

# Troy Pickup — 跨 Agent 對話接續與進度還原

從先前的檢查點或前一個 Agent（Claude Code、Codex、Antigravity、Cursor）留下的本機對話紀錄接手任務，**讀懂已完成的軌跡，不從頭重做**。

> 若存在 `~/.agents/CONTEXT.md`，先讀取並遵守其語言與安全規範。本 Skill 內附 `scripts/checkpoint.mjs` 與 `scripts/transcripts.mjs`，單獨安裝即可獨立完成工作。

## 安全與隔離邊界

- **嚴禁跨專案偷看紀錄**：一律透過 `scripts/transcripts.mjs list --project .` 定位目前專案（含同一 Git Repo 的 worktree）的對話紀錄；**禁止**手動用 `ls`、`find` 或 `cat` 掃描 `$HOME`、`~/.claude/projects/` 等上層目錄。
- **嚴禁讀取 `.env*` 或敏感憑證**：即便舊對話或工作區提到環境變數檔，接手時一律只確認檔名存在，不讀取內容。
- **不輕信舊的口頭宣稱**：若前一手聲稱「測試全過」，對剩餘工作有影響的關鍵檢查仍需對真實產物複驗。

## 執行流程（兩條路徑，先檢查點、後撈紀錄）

### Step 1：先讀取主動交接檢查點
執行此 Skill 同層的 `scripts/checkpoint.mjs`：

```bash
node <path-to-troy-pickup>/scripts/checkpoint.mjs read --project .
```

依回傳狀態分流：

- **情境 A｜`kind: "checkpoint"`（exit `0`）**：
  1. 檢查同時也要跑一次 `transcripts.mjs list --project . --limit 3` 確認是否有**比這份 checkpoint 更新很多**的未存檔對話；若沒有（正常交接情境），直接採用此交接檔與附件內容。
  2. 對照回傳的 `drift`（`branchChanged`、`headChanged`、`dirtyFilesChanged`）與現場 `git status` / `git diff` 確認無意外偏移；若有大幅偏移先簡短點出差異並詢問是否繼續。
  3. **無誤則簡短回報「承接來源、已完成 vs 待做、接續點」，直接接著執行下一步**，不再停下來問「要不要開始」。

- **情境 B｜`kind: "unavailable"`（exit `1`）**：
  - 代表交接檔存在但檔案損毀、連結斷裂或附件已被修改。**直接回報具體錯誤原因讓使用者決定是否修復或改撈對話紀錄，禁止靜默跳過**。

- **情境 C｜`kind: "missing"`（exit `2`）**：
  - 代表上一次是突然斷線／額度用完，沒跑 `/troy-pause`。進入 **Step 2（翻舊對話紀錄）**。

---

### Step 2：突然斷線退回方案 — 撈取四家本機對話紀錄

執行 `scripts/transcripts.mjs` 列出目前專案近期對話（若使用者有指定工具，例如 `/troy-pickup claude`，加上 `--source claude`）：

```bash
node <path-to-troy-pickup>/scripts/transcripts.mjs list --project . --source all --limit 5
```

1. **挑選目標對話**：
   - 若只有 1 筆明顯最新的對話，或使用者已指定來源工具且該來源有明確最新一筆，選取該檔。
   - 若有多筆近期不同主題的對話無法判斷要接哪一段，列出最新 3~5 筆（來源工具、時間、第一句需求）請使用者選一筆後再往下。
2. **抽取降噪摘要（嚴禁整份直接讀原始 JSONL）**：
   ```bash
   node <path-to-troy-pickup>/scripts/transcripts.mjs extract --file "<選定的jsonl路徑>" --tail 20
   ```
3. **對照現場 Git 狀態**：
   - 結合 `extract` 回傳的 `keyUserMessages`、`recentAssistantMessages`、`touchedFiles`、`tailEvents`，對照現場 `git log -n 5 --oneline`、`git status --short` 與 `git diff --stat`。
   - 釐清哪些已經落地並驗證、哪些只改到一半、最後停在哪個錯誤或步驟。

### Step 3：突然斷線情境的暫停確認點（Human Gate）
- 因為是從未經整理的原對話紀錄推斷斷點，**先不修改程式碼**。
- 先向使用者回報精簡摘要：
  1. **撈取來源**：哪個工具、哪個時間點的對話、對應哪個 branch。
  2. **已完成項目**：已落地或已確認的改動（附檔案與 commit／現場狀態）。
  3. **未完成與中斷位置**：最後卡在哪裡或剩下什麼。
  4. **預計執行的第一步**：說明確認後會直接從哪裡接續做。
- **停下來等使用者回覆 OK**（除非使用者一開始就明講「直接繼續做不用問我」），確認後再開始改碼。
