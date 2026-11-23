---
name: troy-pause
description: 主動暫停目前任務並寫入跨 Agent 共用的檢查點交接檔（支援 Claude Code、Codex、Antigravity、Cursor 接力）。預設不動 Git 歷史，只記錄目標、進度、現場改動與下一步。Use when asked to "/troy-pause", "pause and handoff", "先暫停存檔", or "save progress for another agent".
disable-model-invocation: true
---

# Troy Pause — 主動暫停與跨 Agent 交接存檔

當你要收工、重啟工具，或準備把進行中的任務交給另一個 Agent（例如從 Claude Code 切去 Codex）時，留下一個乾淨、可驗證、不依賴單一工具格式的交接檢查點。

> 若存在 `~/.agents/CONTEXT.md`，先讀取並遵守其語言與安全規範。本 Skill 內附 `scripts/checkpoint.mjs`，單獨安裝即可執行，不依賴其他 `troy-*` skill。

## 核心紀律

1. **預設不動你的 Git**：除非使用者明確要求「順便建 `wip` commit」，否則**保留目前工作區修改原樣，不主動執行 `git commit`、`git stash` 或 `git push`**；只在交接檔記下現場 branch、commit 與未提交檔案清單。
2. **只停在明確要求暫停時**：若使用者說「先跑著」「繼續做」「keep going」，絕不觸發暫停或中斷執行。
3. **不執行不可逆動作**：不開 PR、不推新 branch、不修改環境變數檔（`.env*`）或敏感憑證。

## 執行流程

### Step 1：收斂當前原子步驟
- 停在安全邊界：手邊這個小改動或驗證若幾秒內可收尾就完成它，否則乾淨回復到可控狀態；不再啟動新的重型探索或子任務，並停止或等待手邊進行中的背景子代理。

### Step 2：建立本次交接檢查點目錄
執行此 Skill 同層的 `scripts/checkpoint.mjs`（先從本 `SKILL.md` 所在目錄定位 `scripts/checkpoint.mjs`）：

```bash
node <path-to-troy-pause>/scripts/checkpoint.mjs begin --project .
```

腳本會在 Git 專案的共同目錄（`<git-common-dir>/troy-mode/handoff/<uuid>/`，同 Repo 各 worktree 共用且天然不進版控；非 Git 資料夾則存於系統暫存目錄）建立專屬資料夾，並回傳 `noteTemplatePath` 與目前 `gitState`。

### Step 3：撰寫精簡交接筆記（`handoff.md`）
把筆記寫入上一步回傳的 `noteTemplatePath`，內容精簡、只放接手者真正需要的事實（**絕不寫入任何 `.env*`、金鑰或憑證內容**）：

- **原始目標與完成標準**：1~2 句講清楚最初要解什麼問題、做到什麼程度算完成。
- **已完成且實測過的項目**：列出具體改動與確實跑過的指令結果（不要把「沒測過」寫成已完成）。
- **尚未完成／進行到一半的項目**：說明卡在哪裡、目前工作區尚未 commit 的改動是什麼用途。
- **關鍵決策與踩坑點**：前一步踩過什麼雷、使用者已拍板什麼方向（避免下一個 Agent 重蹈覆轍）。
- **接手後的第一件事**：明確写出下一個 Agent 進場後要跑的第一個指令或要改的第一個檔案。
- **（選用）隨附清單或檔案**：若對話中有使用者要求帶走的問題清單、驗收項目或規格，存在同一個 checkpoint 目錄內（或指向既有專案檔案），並用標準 Markdown 相對／絕對連結 `[說明](path)` 寫在筆記裡。若僅需提及外部對話紀錄路徑，請用反引號純文字（`` `path` ``）標記，勿寫成 Markdown 連結以免觸發專案界線檢查失敗。

### Step 4：發布並立即回讀驗真
執行 `publish`（會檢查所有連結與附件存在性並計算 SHA-256，原子更新 `latest.json`），再立刻執行 `read` 確認 Cold-start 可讀：

```bash
node <path-to-troy-pause>/scripts/checkpoint.mjs publish --project . --note "<noteTemplatePath>" --agent "<目前工具名稱如 claude|codex|antigravity|cursor>"
node <path-to-troy-pause>/scripts/checkpoint.mjs read --project .
```

（若筆記有連結額外附件檔，一併加上 `--artifact "<file>"`。）

## 回報格式

簡潔回報 4 項即可（不貼整份 diff）：
1. **目前停在哪一步**與工作區狀態（branch、是否有未 commit 修改、是否建立了 `wip:` commit）。
2. **交接檔路徑**（`latest.json` 與 `handoff.md` 位置）。
3. **寫入磁碟 vs 僅驗證過的事實**（簡述已做完與待續項目）。
4. **接手提示**：告知使用者換開任一 Agent 後執行 `/troy-pickup` 即可直接續做。
