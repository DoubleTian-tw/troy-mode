# troy-mode

跨專案 AI Agent 工作流工具包（台灣繁體中文為主），同時相容 **Claude Code**、**Codex** 與 **Gemini / Antigravity**。

以 `troy-mode` 作為 Playbook 總路由，依任務性質分流至 8 個專責 Skill，落實「先理解再動手、證據優先、雙盲驗證」的工程工作流。

## 安裝方式

### 1. npm / npx CLI（推薦：同時同步三個 Agent）

```bash
# 全域安裝（預設互動選擇 Agent，或加 -y 直接套用 claude,codex,gemini）
npx troy-mode

# 只裝到當前專案（.agents/skills + .claude/skills + .codex/skills + .gemini/skills）
npx troy-mode install --scope project -y

# 只裝特定幾個 skill
npx troy-mode install --skills troy-how,troy-why,troy-blast-radius -y

# 檢查目前安裝與 symlink 狀態
npx troy-mode status

# 安全移除（僅移除本套件管理的 troy-*，不動其他 skill）
npx troy-mode uninstall
```

常用選項：

- `--scope <global|project>`：安裝範圍（預設 `global`）
- `--agents <list>`：`claude,codex,gemini` 逗號分隔（預設全部）
- `--skills <list>`：指定要安裝的 skill（預設全部 9 個）
- `--mode <copy|link>`：`copy` 複製實體檔案（預設）；`link` 連回本機 repo 供開發同步
- `--force`：遇到同名非 symlink 目錄時先備份再覆蓋
- `--dry-run`：只預覽動作，不寫入檔案

### 2. Vercel Skills CLI

```bash
# 安裝整組
npx skills add DoubleTian-tw/troy-mode -g

# 只裝單一 skill
npx skills add DoubleTian-tw/troy-mode@troy-why -g
```

### 3. Claude Code Plugin

```text
/plugin marketplace add DoubleTian-tw/troy-mode
/plugin install troy-mode
```

### 4. Antigravity Plugin

```bash
agy plugin install https://github.com/DoubleTian-tw/troy-mode
```

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

## 本機開發與驗證

```bash
# 將本機三個 Agent 透過 symlink 連回此 repo 開發
node bin/cli.mjs install --mode link --force -y

# 驗證所有 skill frontmatter、路由表、可移植性與 CLI 行為
npm run validate
```

維護與撰寫規範見 [AGENTS.md](./AGENTS.md)。

## License

MIT
