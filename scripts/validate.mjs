#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const MANUAL_ONLY_SKILLS = new Set([
  'troy-mode',
  'troy-how',
  'troy-why',
  'troy-blast-radius',
  'troy-wait-what',
  'troy-eval',
  'troy-interrogate',
  'troy-correct',
  'troy-create-verify',
  'troy-unslop',
]);

const errors = [];

function fail(msg) {
  errors.push(msg);
}

function readJson(relPath) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) {
    fail(`Missing JSON file: ${relPath}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (err) {
    fail(`Invalid JSON in ${relPath}: ${err.message}`);
    return null;
  }
}

function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const block = match[1];
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  const disableMatch = block.match(/^disable-model-invocation:\s*(true|false)\s*$/m);
  const descPresent = /^description:\s*\S+/m.test(block);
  return {
    name: nameMatch ? nameMatch[1].trim().replace(/^['"]|['"]$/g, '') : '',
    disableModelInvocation: disableMatch ? disableMatch[1] === 'true' : false,
    hasDescription: descPresent,
  };
}

function walkFiles(dir, result = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.name === '.DS_Store') {
      fail(`Forbidden .DS_Store found: ${path.relative(ROOT, fullPath)}`);
      continue;
    }
    if (entry.isDirectory()) {
      walkFiles(fullPath, result);
    } else if (entry.isFile()) {
      result.push(fullPath);
    }
  }
  return result;
}

// 1. Validate JSON manifests & version parity
const pkg = readJson('package.json');
readJson('plugin.json');
const claudePlugin = readJson('.claude-plugin/plugin.json');
readJson('.claude-plugin/marketplace.json');

if (pkg && claudePlugin && pkg.version !== claudePlugin.version) {
  fail(
    `Version mismatch: package.json (${pkg.version}) !== .claude-plugin/plugin.json (${claudePlugin.version})`
  );
}

// 2. Validate skills/
const skillsDir = path.join(ROOT, 'skills');
const skillDirs = fs
  .readdirSync(skillsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

if (skillDirs.length === 0) {
  fail('No skill directories found under skills/');
}

for (const dirName of skillDirs) {
  if (!/^troy-[a-z0-9-]+$/.test(dirName)) {
    fail(`Invalid skill directory name (must be troy-* kebab-case): ${dirName}`);
  }

  const skillMdPath = path.join(skillsDir, dirName, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    fail(`Missing SKILL.md: skills/${dirName}/SKILL.md`);
  } else {
    const content = fs.readFileSync(skillMdPath, 'utf8');
    const fm = parseFrontmatter(content);
    if (!fm) {
      fail(`Missing YAML frontmatter in skills/${dirName}/SKILL.md`);
    } else {
      if (fm.name !== dirName) {
        fail(`Frontmatter name "${fm.name}" !== directory name "${dirName}"`);
      }
      if (!fm.hasDescription) {
        fail(`Missing description in skills/${dirName}/SKILL.md`);
      }
      if (MANUAL_ONLY_SKILLS.has(dirName) && !fm.disableModelInvocation) {
        fail(`Skill "${dirName}" must set disable-model-invocation: true`);
      }
    }
  }

  const openaiYamlPath = path.join(skillsDir, dirName, 'agents', 'openai.yaml');
  if (!fs.existsSync(openaiYamlPath)) {
    fail(`Missing Codex metadata: skills/${dirName}/agents/openai.yaml`);
  } else {
    const yaml = fs.readFileSync(openaiYamlPath, 'utf8');
    for (const key of ['display_name:', 'short_description:', 'default_prompt:']) {
      if (!yaml.includes(key)) {
        fail(`Missing "${key}" in skills/${dirName}/agents/openai.yaml`);
      }
    }
  }
}

// 3. Validate troy-mode router table includes all sibling troy-* skills
const routerPath = path.join(skillsDir, 'troy-mode', 'SKILL.md');
if (fs.existsSync(routerPath)) {
  const routerContent = fs.readFileSync(routerPath, 'utf8');
  for (const dirName of skillDirs) {
    if (dirName === 'troy-mode') continue;
    if (!routerContent.includes(`\`${dirName}\``)) {
      fail(`Router skills/troy-mode/SKILL.md does not list \`${dirName}\``);
    }
  }
  const referenced = new Set(routerContent.match(/\btroy-[a-z0-9-]+\b/g) || []);
  for (const ref of referenced) {
    if (!skillDirs.includes(ref)) {
      fail(`Router skills/troy-mode/SKILL.md references unknown skill: ${ref}`);
    }
  }
}

// 4. Scan repo files for hardcoded local paths
const allFiles = walkFiles(ROOT);
for (const filePath of allFiles) {
  const rel = path.relative(ROOT, filePath);
  if (rel === 'scripts/validate.mjs') continue;
  const text = fs.readFileSync(filePath, 'utf8');
  if (/\/Users\/[A-Za-z0-9._-]+/.test(text)) {
    fail(`Hardcoded macOS user path found in ${rel}`);
  }
}

// 5. Smoke-test CLI in isolated temp directory
const cliPath = path.join(ROOT, 'bin', 'cli.mjs');
try {
  execFileSync(process.execPath, [cliPath, '--help'], { stdio: 'pipe' });
  execFileSync(process.execPath, [cliPath, 'list'], { stdio: 'pipe' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-mode-validate-'));
  try {
    const fakeHome = path.join(tmpDir, 'home');
    const fakeProj = path.join(tmpDir, 'proj');
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(fakeProj, { recursive: true });

    const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
    execFileSync(process.execPath, [cliPath, 'install', '--scope', 'global', '-y'], {
      env,
      stdio: 'pipe',
    });
    execFileSync(process.execPath, [cliPath, 'status', '--scope', 'global'], {
      env,
      stdio: 'pipe',
    });
    execFileSync(process.execPath, [cliPath, 'uninstall', '--scope', 'global', '-y'], {
      env,
      stdio: 'pipe',
    });

    execFileSync(
      process.execPath,
      [cliPath, 'install', '--scope', 'project', '--mode', 'link', '-y'],
      { cwd: fakeProj, env, stdio: 'pipe' }
    );
    execFileSync(process.execPath, [cliPath, 'uninstall', '--scope', 'project', '-y'], {
      cwd: fakeProj,
      env,
      stdio: 'pipe',
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
} catch (err) {
  fail(`CLI smoke test failed: ${err.message}`);
}

if (errors.length > 0) {
  console.error(`Validation failed (${errors.length} issues):`);
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

console.log(`Validation passed! (${skillDirs.length} skills, manifests, portability, and CLI smoke tests OK)`);
