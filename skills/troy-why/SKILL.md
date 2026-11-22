---
name: troy-why
description: 歷史設計脈絡與決策追查工具。回答「為什麼 X 要這樣寫」、「為什麼選 A 不選 B」、回歸原因或門檻數值由來。強制從 git commit、PR/MR 紀錄與專案歷史文件查證，嚴禁看現行程式碼瞎猜，並清楚區分事實、推論與紀錄空白。
disable-model-invocation: true
---

# Troy Why — 歷史決策與脈絡追查

從**歷史紀錄**（而不是靠看現行程式碼猜測）回答「為什麼這個設計長這樣？」。

> 查「這個系統目前**怎麼運作**」請改用 `troy-how`。

## 嚴格紀律

1. 若存在 `~/.agents/CONTEXT.md`，先讀取並遵守其語言與術語規範。
2. **完全唯讀**：不修改檔案。
3. **不靠看現在的 code 硬編理由**：必須去翻引入與修改該段程式的紀錄：
   - Git 歷史：`git log -n 15 --oneline <path>`、`git log -S "<關鍵符號>" -p`、`git blame <file>` + `git show <commit>`
   - PR / MR 紀錄（若有 `gh` / `glab` 或 commit merge 訊息）
   - 專案內既有決策／歷史歸檔文件（自動偵測常見路徑：如 `docs/changes/_archive/`、`docs/epics/_archive/`、`docs/features/`、`openspec/`、`docs/decisions/`、`ADR` 等）
4. **誠實標記不確定性**：紀錄裡寫了什麼就引什麼；自己的合理推論**必須明寫 `[推論]`**；歷史紀錄沒寫的原因就直接講「紀錄未說明」，絕不腦補成既定事實。

## 輸出格式

1. **紀錄明寫的事實（Facts from Records）**
   - 按時間軸或關鍵決策列出：當時解決什麼問題、作者寫了哪些理由與取捨（每條必附具體 `commit hash` 或文件路徑／行號）。
2. **合理推論（Inferences，若有）**
   - 明確以 `[推論]` 開頭，說明是從哪些程式碼結構或時間線間接推導出的，而非歷史原文記載。
3. **紀錄未說明的空白（Gaps）**
   - 誠實列出哪些「為什麼」在現有 commit、PR 與文件中找不到答案（例如某常數閾值的最初依據未留紀錄）。
