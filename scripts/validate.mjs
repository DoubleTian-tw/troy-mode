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
  'troy-pause',
  'troy-pickup',
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

// 5. Smoke-test CLI and handoff scripts in isolated temp directory
const pauseCheckpointScript = path.join(ROOT, 'skills', 'troy-pause', 'scripts', 'checkpoint.mjs');
const pickupCheckpointScript = path.join(ROOT, 'skills', 'troy-pickup', 'scripts', 'checkpoint.mjs');
const pickupTranscriptsScript = path.join(ROOT, 'skills', 'troy-pickup', 'scripts', 'transcripts.mjs');

if (fs.existsSync(pauseCheckpointScript) && fs.existsSync(pickupCheckpointScript)) {
  const a = fs.readFileSync(pauseCheckpointScript, 'utf8');
  const b = fs.readFileSync(pickupCheckpointScript, 'utf8');
  if (a !== b) {
    fail('checkpoint.mjs differs between skills/troy-pause/scripts and skills/troy-pickup/scripts');
  }
}

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

    // Smoke-test checkpoint.mjs (begin -> publish -> read across worktree + missing/drift/sensitive guard)
    const gitProj = path.join(tmpDir, 'git-repo');
    const gitWt = path.join(tmpDir, 'git-wt');
    const otherProj = path.join(tmpDir, 'other-repo');
    fs.mkdirSync(gitProj, { recursive: true });
    fs.mkdirSync(otherProj, { recursive: true });

    execFileSync('git', ['init', '-b', 'main'], { cwd: gitProj, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitProj, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitProj, stdio: 'pipe' });
    fs.writeFileSync(path.join(gitProj, 'app.txt'), 'v1\n');
    execFileSync('git', ['add', 'app.txt'], { cwd: gitProj, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: gitProj, stdio: 'pipe' });
    execFileSync('git', ['worktree', 'add', '-b', 'feat-x', gitWt], { cwd: gitProj, stdio: 'pipe' });

    // Missing checkpoint should exit 2
    let missingCode = 0;
    try {
      execFileSync(process.execPath, [pickupCheckpointScript, 'read', '--project', gitProj], {
        env,
        stdio: 'pipe',
      });
    } catch (err) {
      missingCode = err.status;
    }
    if (missingCode !== 2) {
      throw new Error(`Expected exit code 2 for missing checkpoint, got ${missingCode}`);
    }

    const beginRes = JSON.parse(
      execFileSync(process.execPath, [pauseCheckpointScript, 'begin', '--project', gitProj], {
        env,
        encoding: 'utf8',
      })
    );
    const checklistPath = path.join(beginRes.directory, 'checklist.md');
    fs.writeFileSync(checklistPath, '- [x] step 1\n');
    fs.writeFileSync(
      beginRes.noteTemplatePath,
      '# Handoff\n\nSee [checklist](checklist.md).\n'
    );

    execFileSync(
      process.execPath,
      [
        pauseCheckpointScript,
        'publish',
        '--project',
        gitProj,
        '--note',
        beginRes.noteTemplatePath,
        '--agent',
        'claude',
      ],
      { env, stdio: 'pipe' }
    );

    // Read from linked worktree should succeed and detect worktree/branch drift
    const readRes = JSON.parse(
      execFileSync(process.execPath, [pickupCheckpointScript, 'read', '--project', gitWt], {
        env,
        encoding: 'utf8',
      })
    );
    if (readRes.kind !== 'checkpoint' || !readRes.drift.branchChanged || readRes.checkpoint.artifacts.length !== 1) {
      throw new Error(`Unexpected checkpoint read result: ${JSON.stringify(readRes)}`);
    }

    // Smoke-test transcripts.mjs across 4 agent formats + cross-project isolation + redaction
    const realGitProj = fs.realpathSync(gitProj);
    const claudeSlug = realGitProj.replace(/[^a-zA-Z0-9]/g, '-');
    const claudeDir = path.join(fakeHome, '.claude', 'projects', claudeSlug);
    const otherClaudeDir = path.join(fakeHome, '.claude', 'projects', fs.realpathSync(otherProj).replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(otherClaudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'sess-claude-1.jsonl'),
      [
        JSON.stringify({ type: 'mode', sessionId: 'sess-claude-1' }),
        JSON.stringify({ type: 'user', cwd: realGitProj, sessionId: 'sess-claude-1', gitBranch: 'main', message: { role: 'user', content: 'Fix auth token sk-1234567890abcdefghij' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(realGitProj, 'app.txt') } }, { type: 'text', text: 'Updated app.txt' }] } }),
      ].join('\n') + '\n'
    );
    fs.writeFileSync(
      path.join(otherClaudeDir, 'sess-other.jsonl'),
      JSON.stringify({ type: 'user', cwd: fs.realpathSync(otherProj), message: { role: 'user', content: 'Secret other project' } }) + '\n'
    );

    const codexDir = path.join(fakeHome, '.codex', 'sessions', '2026', '11', '23');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'rollout-2026-11-23T01-00-00-codex1.jsonl'),
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'codex1', cwd: realGitProj, git: { branch: 'main' } } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue parser refactor' }] } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done step 1' }] } }),
      ].join('\n') + '\n'
    );

    const agyLogDir = path.join(fakeHome, '.gemini', 'antigravity-cli', 'brain', 'agy-conv-1', '.system_generated', 'logs');
    fs.mkdirSync(agyLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(agyLogDir, 'transcript.jsonl'),
      [
        JSON.stringify({ type: 'USER_INPUT', created_at: '2026-11-23T02:00:00Z', content: `<USER_REQUEST>\nInspect ${realGitProj}\n</USER_REQUEST>` }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', created_at: '2026-11-23T02:00:05Z', content: 'Checked repo', tool_calls: [{ name: 'read_file', args: { Path: path.join(realGitProj, 'app.txt') } }] }),
      ].join('\n') + '\n'
    );

    const cursorDir = path.join(fakeHome, '.cursor', 'projects', realGitProj.replace(/^[\\/]+/, '').replace(/[\\/]/g, '-'), 'agent-transcripts', 'cur-1');
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(
      path.join(cursorDir, 'cur-1.jsonl'),
      JSON.stringify({ role: 'user', content: 'Check CSS layout' }) + '\n'
    );

    const listRes = JSON.parse(
      execFileSync(
        process.execPath,
        [pickupTranscriptsScript, 'list', '--project', gitProj, '--source', 'all', '--limit', '10'],
        { env, encoding: 'utf8' }
      )
    );
    const sources = new Set(listRes.sessions.map((s) => s.source));
    if (!sources.has('claude') || !sources.has('codex') || !sources.has('antigravity') || !sources.has('cursor')) {
      throw new Error(`Expected all 4 sources in transcripts list, got: ${[...sources].join(',')}`);
    }
    if (listRes.sessions.some((s) => s.id === 'sess-other')) {
      throw new Error('Cross-project transcript leaked into list output');
    }

    const extractRes = JSON.parse(
      execFileSync(
        process.execPath,
        [pickupTranscriptsScript, 'extract', '--file', path.join(claudeDir, 'sess-claude-1.jsonl')],
        { env, encoding: 'utf8' }
      )
    );
    if (
      extractRes.format !== 'claude' ||
      extractRes.keyUserMessages[0]?.text.includes('sk-1234567890abcdefghij') ||
      !extractRes.keyUserMessages[0]?.text.includes('[REDACTED_TOKEN]')
    ) {
      throw new Error(`Transcript extraction or redaction failed: ${JSON.stringify(extractRes)}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
} catch (err) {
  fail(`CLI/handoff smoke test failed: ${err.message}`);
}

if (errors.length > 0) {
  console.error(`Validation failed (${errors.length} issues):`);
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

console.log(`Validation passed! (${skillDirs.length} skills, manifests, portability, and CLI smoke tests OK)`);
