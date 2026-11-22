---
name: troy-how
description: 唯讀探索與架構走讀工具。回答「X 怎麼運作」、「這條請求怎麼流過系統」、「新邏輯應該放在哪一層 / 哪個模組」等問題，輸出清晰的心智模型與檔案行號依據。Use when asked how code works, architecture walkthroughs, or placement/ownership questions.
disable-model-invocation: true
---

# Troy How — 程式運作與架構走讀

唯讀探索 codebase，回答「這塊程式實際怎麼運作？」與「新程式該放在哪一層／誰擁有這份狀態？」的問題。

> 查「**為什麼**當初這樣設計」請改用 `troy-why`；查「改動會打壞什麼」請改用 `troy-blast-radius`。

## 執行規範

1. 若存在 `~/.agents/CONTEXT.md`，先讀取並遵守其語言與術語規範。
2. **完全唯讀**：嚴禁修改任何檔案或執行會改變狀態的指令。
3. 若 scope 模糊，先簡短說明你的詮釋範圍並開始探索（若專案有大量檔案，可派一個唯讀 subagent 一次探索整理）。
4. **必須核對真實檔案與行號**，不可憑記憶猜測符號或流程。

## 探索步驟

1. **找入口點（Entrypoints）**：從路由 Controller、CLI 指令、Worker / Queue Consumer 或前端頁面元件出發，抓出真實觸發點。
2. **追完整呼叫鏈（Call Graph & Data Flow）**：
   - 沿線讀實際呼叫的 Service、Helper、Middleware、Guard、Validator 與 ORM / SQL 查詢，列出資料如何轉換、狀態在哪裡寫入與持久化。
   - 若專案有架構或功能文件（例如 `docs/features/`、`AGENTS.md`），比對文件與實際程式碼是否一致（若有落差直接點出）。
3. **釐清歸屬與分層（Ownership & Placement）**：
   - 若問題涉及「應該放哪裡」，明確指出各層職責（例如邊界驗證 vs 業務邏輯 vs 資料存取）與誰是該狀態的唯一 Owner。

## 輸出格式

用資深工程師給同事上手的心智模型格式輸出（精簡、無廢話，重要關係超過 3 個元件時附漸進小圖或精簡流程圖）：
1. **一句話定位**：這個子系統在系統中扮演什麼角色。
2. **核心資料流／呼叫鏈**：附真實 `file:line` 路徑。
3. **關鍵狀態歸屬與設計邊界**：誰擁有什麼狀態、有哪些隱含前置條件或陷阱。
4. **（若問落點／如何擴充）建議放置位置與理由**。
