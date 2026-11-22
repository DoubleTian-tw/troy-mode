#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, '..');
const SKILLS_SRC = path.join(PKG_ROOT, 'skills');

const SUPPORTED_AGENTS = ['claude', 'codex', 'gemini'];
const VALID_SCOPES = ['global', 'project'];
const VALID_MODES = ['copy', 'link'];

function readPkg() {
  return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
}

function listAvailableSkills() {
  if (!fs.existsSync(SKILLS_SRC)) return [];
  return fs
    .readdirSync(SKILLS_SRC, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('troy-'))
    .map((entry) => entry.name)
    .sort();
}

function readSkillSummary(skillName) {
  const skillMdPath = path.join(SKILLS_SRC, skillName, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) return '';
  const content = fs.readFileSync(skillMdPath, 'utf8');
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return '';
  const descMatch = match[1].match(/^description:\s*(?:>-?\s*\n([\s\S]*?)(?=\n[a-zA-Z0-9_-]+:|\n*$)|(.+))/m);
  if (!descMatch) return '';
  const raw = (descMatch[1] || descMatch[2] || '').replace(/\s+/g, ' ').trim();
  return raw.replace(/^['"]|['"]$/g, '');
}

function resolvePaths(scope, cwd = process.cwd(), homeDir = os.homedir()) {
  if (scope === 'project') {
    return {
      canonicalDir: path.join(cwd, '.agents', 'skills'),
      agentDirs: {
        claude: path.join(cwd, '.claude', 'skills'),
        codex: path.join(cwd, '.codex', 'skills'),
        gemini: path.join(cwd, '.gemini', 'skills'),
      },
    };
  }
  return {
    canonicalDir: path.join(homeDir, '.agents', 'skills'),
    agentDirs: {
      claude: path.join(homeDir, '.claude', 'skills'),
      codex: path.join(homeDir, '.codex', 'skills'),
      gemini: path.join(homeDir, '.gemini', 'config', 'skills'),
    },
  };
}

function parseCsvList(value) {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function printHelp(pkg) {
  console.log(`troy-mode v${pkg.version}

用法：
  troy-mode [command] [options]

指令：
  install     安裝 troy-* skills 到本機或專案（預設指令）
  uninstall   安全移除由本套件管理的 troy-* skills
  status      檢查目前安裝狀態與 symlink 指向
  list        列出內建的 9 個 skills

選項：
  --scope <global|project>   安裝範圍（預設：global）
  --agents <list>            目標 agent，逗號分隔：claude,codex,gemini（預設：全部）
  --skills <list>            指定要處理的 skill，逗號分隔（預設：全部 troy-*）
  --mode <copy|link>         Canonical 層方式：copy 複製檔案 / link 連回本機 repo（預設：copy）
  --force                    若目標已存在同名非 symlink 目錄，先備份再覆蓋
  --dry-run                  僅預覽將執行的動作，不實際寫入檔案
  -y, --yes                  跳過互動確認，直接依預設／參數執行
  -h, --help                 顯示說明
  -v, --version              顯示版本

範例：
  npx troy-mode
  npx troy-mode install --scope project --agents claude,codex -y
  npx troy-mode install --mode link -y
  npx troy-mode status
  npx troy-mode uninstall --scope global -y`);
}

function lstatSafe(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch {
    return null;
  }
}

function symlinkTargetMatches(linkPath, expectedTarget) {
  const stat = lstatSafe(linkPath);
  if (!stat || !stat.isSymbolicLink()) return false;
  const rawTarget = fs.readlinkSync(linkPath);
  const resolved = path.resolve(path.dirname(linkPath), rawTarget);
  return resolved === path.resolve(expectedTarget);
}

function copyDirClean(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirClean(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function createDirSymlink(target, linkPath) {
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(target, linkPath, type);
}

function backupPath(targetPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${targetPath}.bak.${stamp}`;
}

function removeEntry(targetPath) {
  const stat = lstatSafe(targetPath);
  if (!stat) return;
  if (stat.isSymbolicLink() || stat.isFile()) {
    fs.unlinkSync(targetPath);
  } else {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function prepareCanonicalSkill(skillName, canonicalDir, { mode, force, dryRun }) {
  const srcDir = path.join(SKILLS_SRC, skillName);
  const destDir = path.join(canonicalDir, skillName);
  const existing = lstatSafe(destDir);

  if (mode === 'link') {
    if (symlinkTargetMatches(destDir, srcDir)) {
      return { action: 'unchanged', path: destDir };
    }
    if (existing) {
      if (!existing.isSymbolicLink() && !force) {
        return { action: 'skipped', reason: '已存在非 symlink 目錄（可加 --force 備份覆蓋）', path: destDir };
      }
      if (!dryRun) {
        if (!existing.isSymbolicLink() && force) {
          fs.renameSync(destDir, backupPath(destDir));
        } else {
          removeEntry(destDir);
        }
      }
    }
    if (!dryRun) {
      fs.mkdirSync(canonicalDir, { recursive: true });
      createDirSymlink(srcDir, destDir);
    }
    return { action: 'linked', path: destDir, target: srcDir };
  }

  // mode === 'copy'
  if (existing) {
    if (existing.isSymbolicLink()) {
      if (!force) {
        return { action: 'skipped', reason: '目前為 symlink（可加 --force 改為實體複製）', path: destDir };
      }
      if (!dryRun) removeEntry(destDir);
    } else {
      // Updating previously copied directory: safe to replace unless we want backup on --force
      if (!dryRun) {
        if (force) {
          fs.renameSync(destDir, backupPath(destDir));
        } else {
          fs.rmSync(destDir, { recursive: true, force: true });
        }
      }
    }
  }
  if (!dryRun) {
    copyDirClean(srcDir, destDir);
  }
  return { action: existing ? 'updated' : 'copied', path: destDir };
}

function linkAgentSkill(skillName, canonicalDir, agentDir, { force, dryRun }) {
  const canonicalSkillDir = path.join(canonicalDir, skillName);
  const linkPath = path.join(agentDir, skillName);
  const existing = lstatSafe(linkPath);

  if (symlinkTargetMatches(linkPath, canonicalSkillDir)) {
    return { action: 'unchanged', path: linkPath };
  }

  if (existing) {
    if (!existing.isSymbolicLink() && !force) {
      return { action: 'skipped', reason: '已存在非 symlink 目錄（可加 --force 備份覆蓋）', path: linkPath };
    }
    if (!dryRun) {
      if (!existing.isSymbolicLink() && force) {
        fs.renameSync(linkPath, backupPath(linkPath));
      } else {
        removeEntry(linkPath);
      }
    }
  }

  if (!dryRun) {
    fs.mkdirSync(agentDir, { recursive: true });
    try {
      createDirSymlink(canonicalSkillDir, linkPath);
    } catch (err) {
      if (process.platform === 'win32') {
        copyDirClean(canonicalSkillDir, linkPath);
        return { action: 'copied-fallback', path: linkPath };
      }
      throw err;
    }
  }
  return { action: 'linked', path: linkPath, target: canonicalSkillDir };
}

async function promptSelectionIfInteractive(opts, availableSkills) {
  const shouldPrompt =
    !opts.yes &&
    !opts.agentsExplicit &&
    process.stdin.isTTY &&
    process.stdout.isTTY;

  if (!shouldPrompt) return opts;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`將安裝 ${availableSkills.length} 個 troy-* skills（scope: ${opts.scope}, mode: ${opts.mode}）`);
    const agentAnswer = await rl.question(
      `選擇目標 Agent（逗號分隔，直接按 Enter 全選 [${SUPPORTED_AGENTS.join(',')}]）：`
    );
    const chosenAgents = agentAnswer.trim() ? parseCsvList(agentAnswer) : SUPPORTED_AGENTS;
    for (const a of chosenAgents) {
      if (!SUPPORTED_AGENTS.includes(a)) {
        throw new Error(`不支援的 agent: ${a}（可選：${SUPPORTED_AGENTS.join(', ')}）`);
      }
    }
    opts.agents = chosenAgents;
    return opts;
  } finally {
    rl.close();
  }
}

async function runInstall(opts, pkg) {
  const availableSkills = listAvailableSkills();
  const targetSkills = opts.skillsExplicit ? opts.skills : availableSkills;

  for (const s of targetSkills) {
    if (!availableSkills.includes(s)) {
      throw new Error(`找不到 skill "${s}"（可用：${availableSkills.join(', ')}）`);
    }
  }

  await promptSelectionIfInteractive(opts, targetSkills);

  const { canonicalDir, agentDirs } = resolvePaths(opts.scope);
  const prefix = opts.dryRun ? '[dry-run] ' : '';

  console.log(`\n${prefix}troy-mode v${pkg.version} — 安裝開始`);
  console.log(`- Scope: ${opts.scope}`);
  console.log(`- Mode: ${opts.mode}`);
  console.log(`- Canonical: ${canonicalDir}`);
  console.log(`- Agents: ${opts.agents.join(', ')}`);
  console.log(`- Skills (${targetSkills.length}): ${targetSkills.join(', ')}\n`);

  let skippedCount = 0;

  for (const skill of targetSkills) {
    const res = prepareCanonicalSkill(skill, canonicalDir, opts);
    if (res.action === 'skipped') {
      skippedCount += 1;
      console.log(`${prefix}[skip] canonical ${skill}: ${res.reason}`);
      continue;
    }
    console.log(`${prefix}[${res.action}] ${res.path}`);

    for (const agent of opts.agents) {
      const linkRes = linkAgentSkill(skill, canonicalDir, agentDirs[agent], opts);
      if (linkRes.action === 'skipped') {
        skippedCount += 1;
        console.log(`${prefix}  [skip] ${agent}: ${linkRes.reason}`);
      } else {
        console.log(`${prefix}  [${linkRes.action}] ${agent} -> ${linkRes.path}`);
      }
    }
  }

  console.log(
    skippedCount > 0
      ? `\n${prefix}完成（有 ${skippedCount} 個項目因既有衝突而略過，詳見上方提示）。`
      : `\n${prefix}完成！所有選定的 skills 與 agent 連結已同步。`
  );
}

function runStatus(opts, pkg) {
  const availableSkills = listAvailableSkills();
  const targetSkills = opts.skillsExplicit ? opts.skills : availableSkills;
  const { canonicalDir, agentDirs } = resolvePaths(opts.scope);

  console.log(`troy-mode v${pkg.version} — 狀態檢查 (scope: ${opts.scope})`);
  console.log(`Canonical: ${canonicalDir}\n`);

  for (const skill of targetSkills) {
    const cPath = path.join(canonicalDir, skill);
    const cStat = lstatSafe(cPath);
    let cStatus = 'missing';
    if (cStat) {
      if (cStat.isSymbolicLink()) {
        const target = fs.readlinkSync(cPath);
        const exists = fs.existsSync(cPath);
        cStatus = exists ? `symlink -> ${target}` : `broken symlink -> ${target}`;
      } else {
        cStatus = 'installed (copy)';
      }
    }

    const agentStatuses = opts.agents.map((agent) => {
      const aPath = path.join(agentDirs[agent], skill);
      const aStat = lstatSafe(aPath);
      if (!aStat) return `${agent}: missing`;
      if (aStat.isSymbolicLink()) {
        if (!fs.existsSync(aPath)) return `${agent}: broken-link`;
        return symlinkTargetMatches(aPath, cPath) ? `${agent}: ok` : `${agent}: other-link`;
      }
      return `${agent}: dir(non-link)`;
    });

    console.log(`- ${skill}`);
    console.log(`  canonical: ${cStatus}`);
    console.log(`  agents:    ${agentStatuses.join(' | ')}`);
  }
}

async function runUninstall(opts, pkg) {
  const availableSkills = listAvailableSkills();
  const targetSkills = opts.skillsExplicit ? opts.skills : availableSkills;
  const { canonicalDir, agentDirs } = resolvePaths(opts.scope);
  const prefix = opts.dryRun ? '[dry-run] ' : '';

  if (!opts.yes && !opts.dryRun && process.stdin.isTTY && process.stdout.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const ans = await rl.question(
        `確定要移除 ${opts.scope} 範圍內的 ${targetSkills.length} 個 troy-* skills 嗎？(y/N) `
      );
      if (!/^y(es)?$/i.test(ans.trim())) {
        console.log('已取消。');
        return;
      }
    } finally {
      rl.close();
    }
  }

  console.log(`${prefix}troy-mode v${pkg.version} — 移除開始 (scope: ${opts.scope})`);

  for (const skill of targetSkills) {
    for (const agent of opts.agents) {
      const aPath = path.join(agentDirs[agent], skill);
      const aStat = lstatSafe(aPath);
      if (!aStat) continue;
      const canonicalSkill = path.join(canonicalDir, skill);
      const isManagedLink =
        aStat.isSymbolicLink() &&
        (symlinkTargetMatches(aPath, canonicalSkill) || opts.force);

      if (isManagedLink) {
        if (!opts.dryRun) removeEntry(aPath);
        console.log(`${prefix}[removed] ${aPath}`);
      } else {
        console.log(`${prefix}[skip] ${aPath}（非本套件 symlink，加 --force 才會移除）`);
      }
    }

    // Only remove canonical if removing all agents or no managed symlinks remain
    const cPath = path.join(canonicalDir, skill);
    const cStat = lstatSafe(cPath);
    if (cStat) {
      const stillReferenced = SUPPORTED_AGENTS.some((agent) => {
        const aPath = path.join(agentDirs[agent], skill);
        return Boolean(lstatSafe(aPath)) && symlinkTargetMatches(aPath, cPath);
      });
      if (!stillReferenced || opts.force) {
        if (!opts.dryRun) removeEntry(cPath);
        console.log(`${prefix}[removed] ${cPath}`);
      } else {
        console.log(`${prefix}[kept] ${cPath}（仍有其他 agent 連結）`);
      }
    }
  }
}

function runList(pkg) {
  const skills = listAvailableSkills();
  console.log(`troy-mode v${pkg.version} — 內建 ${skills.length} 個 Skills：\n`);
  for (const skill of skills) {
    const summary = readSkillSummary(skill);
    console.log(`- ${skill}`);
    if (summary) console.log(`  ${summary}`);
  }
}

async function main() {
  const pkg = readPkg();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      scope: { type: 'string', default: 'global' },
      agents: { type: 'string' },
      skills: { type: 'string' },
      mode: { type: 'string', default: 'copy' },
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  if (values.help) {
    printHelp(pkg);
    return;
  }
  if (values.version) {
    console.log(pkg.version);
    return;
  }

  const command = positionals[0] || 'install';
  if (!['install', 'uninstall', 'status', 'list'].includes(command)) {
    throw new Error(`未知指令 "${command}"，請執行 troy-mode --help 查看用法。`);
  }

  if (!VALID_SCOPES.includes(values.scope)) {
    throw new Error(`無效的 --scope "${values.scope}"（可選：${VALID_SCOPES.join(', ')}）`);
  }
  if (!VALID_MODES.includes(values.mode)) {
    throw new Error(`無效的 --mode "${values.mode}"（可選：${VALID_MODES.join(', ')}）`);
  }

  const agents = values.agents ? parseCsvList(values.agents) : [...SUPPORTED_AGENTS];
  for (const a of agents) {
    if (!SUPPORTED_AGENTS.includes(a)) {
      throw new Error(`不支援的 agent "${a}"（可選：${SUPPORTED_AGENTS.join(', ')}）`);
    }
  }

  const opts = {
    scope: values.scope,
    mode: values.mode,
    agents,
    agentsExplicit: Boolean(values.agents),
    skills: values.skills ? parseCsvList(values.skills) : [],
    skillsExplicit: Boolean(values.skills),
    force: values.force,
    dryRun: values['dry-run'],
    yes: values.yes,
  };

  if (command === 'list') {
    runList(pkg);
  } else if (command === 'status') {
    runStatus(opts, pkg);
  } else if (command === 'uninstall') {
    await runUninstall(opts, pkg);
  } else {
    await runInstall(opts, pkg);
  }
}

main().catch((err) => {
  console.error(`錯誤：${err.message}`);
  process.exit(1);
});
