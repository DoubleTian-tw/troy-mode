# troy-mode

跨專案 AI Agent 工作流工具包（繁體中文為主），同時相容 **Claude Code**、**Codex** 與 **Gemini / Antigravity**。

以 `troy-mode` 作為 Playbook 總路由，依任務性質分流至 8 個專責 Skill，落實「先理解再動手、證據優先、雙盲驗證」的工程工作流。

## 內建 Skills

| Skill | 定位 | 觸發方式 |
| :--- | :--- | :--- |
| `troy-mode` | 個人跨專案工作流總入口（Playbook Router） | 手動 (`/troy-mode`, `$troy-mode`) |
| `troy-how` | 唯讀追蹤程式呼叫鏈、模組邊界與 State Owner | 手動 |
| `troy-why` | 查證 `git log` / PR / 歷史文件，區分事實、推論與空白 | 手動 |
| `troy-blast-radius` | 找出 grep 看不到的隱性耦合並實跑證實關鍵假設 | 手動 |
| `troy-grilling` | 依設計樹逐輪深度盤問，逼出未定決策 | 自動 / 手動 |
| `troy-research` | 從一手來源查證技術與產品問題，產出可追溯筆記 | 自動 / 手動 |
| `troy-teach-me` | 觀念採蘇格拉底式引導；Review 採白話直解 + 漸進小圖 | 自動 / 手動 |
| `troy-wait-what` | 將上一段難懂的 AI 回覆用台灣繁中白話重述 | 手動 |
| `troy-eval` | 雙盲 A/B 評測工作流程，驗證 skill／規範改動前後差異 | 手動 |

## 安裝方式（建置中）

- **Skills CLI**：`npx skills add <owner>/troy-mode -g`
- **npm CLI**：`npx troy-mode`（規劃中）
- **Plugin**：Claude Code Plugin / Antigravity Plugin（規劃中）

## License

MIT
