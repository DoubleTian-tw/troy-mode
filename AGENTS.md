# AGENTS.md — troy-mode 專案開發與維護規範

本專案為跨 Agent（Claude Code、Codex、Gemini / Antigravity）的繁體中文工程工作流工具包。

## 1. 單一真實來源（SSOT）

- 所有 Skill 的唯一原始碼位於 `skills/troy-*/`。
- **嚴禁**直接修改 `~/.agents/skills/`、`~/.claude/skills/`、`~/.codex/skills/`、`~/.gemini/config/skills/` 內的檔案；本機開發時應透過 `node bin/cli.mjs install --mode link -y` 串接本 Repo。

## 2. Skill 結構與命名規範

每個 Skill 目錄必須符合以下結構：

```text
skills/<skill-name>/
├── SKILL.md
├── agents/
│   └── openai.yaml
└── assets/            # 選用
```

1. **命名一致**：資料夾名稱、Frontmatter `name`、`skills/troy-mode/SKILL.md` 路由表三者必須 **100% 字串一致**（`kebab-case`，一律以 `troy-` 開頭）。
2. **觸發權限分類**：
   - 唯讀查證、總路由、重述、評測與重型驗證／根治／潤稿類（`troy-mode`, `troy-how`, `troy-why`, `troy-blast-radius`, `troy-wait-what`, `troy-eval`, `troy-interrogate`, `troy-correct`, `troy-create-verify`, `troy-unslop`）必須宣告 `disable-model-invocation: true`，避免平常對話誤觸發。
   - 互動引導與研究類（`troy-grilling`, `troy-research`, `troy-teach-me`）保留自動觸發，並須在 `description` 寫明清楚的觸發時機與關鍵詞。
3. **Codex Metadata**：每個 Skill 皆須補齊 `agents/openai.yaml`（含 `display_name`、`short_description`、`default_prompt`）。

## 3. 可移植性與降級邊界

- **禁止硬編碼本機路徑或私人資訊**：`skills/`、`bin/`、`scripts/` 內嚴禁出現本機使用者絕對路徑（如 `/Users/<user>`、`/home/<user>`）、個人帳號資訊或特定私人專案的內部路徑。
- **獨立運作與優雅降級**：使用者可能透過 `npx skills add DoubleTian-tw/troy-mode@troy-why` 只安裝單一 Skill。引用 `~/.agents/CONTEXT.md` 或其他 `troy-*` Skill 時，必須採用「若存在／若已安裝則調用，否則獨立完成」的寫法。

## 4. 改動驗證與發版紀律

1. 任何檔案異動後必跑：
   ```bash
   npm run validate
   ```
2. 調整核心 Skill（`troy-how`, `troy-why`, `troy-blast-radius`, `troy-mode` 等）的執行步驟或規範時，建議使用 `troy-eval` 執行雙盲 A/B 評測確認無退化後再合併。
3. 發版前同步更新 `package.json` 與 `.claude-plugin/plugin.json` 的 `version`（維持版本一致），並先執行 `npm pack --dry-run` 確認打包清單無多餘檔案。
