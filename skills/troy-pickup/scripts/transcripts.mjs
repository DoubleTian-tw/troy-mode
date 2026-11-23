#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';

const VALID_SOURCES = new Set(['all', 'claude', 'codex', 'antigravity', 'cursor']);
const MAX_CLAUDE_DIR_NAME = 200;
const LOCAL_COMMAND_RE = /^\s*<(?:command-name|local-command-stdout|bash-input)>/u;

function javaHash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return h;
}

function claudeProjectDirName(workspace) {
  const name = workspace.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= MAX_CLAUDE_DIR_NAME) return name;
  return `${name.slice(0, MAX_CLAUDE_DIR_NAME)}-${Math.abs(javaHash(workspace)).toString(36)}`;
}

function cursorSlugVariants(workspace) {
  const trimmed = workspace.replace(/^[\\/]+/, '');
  return Array.from(
    new Set([
      trimmed.replace(/[^a-zA-Z0-9._-]/g, '-'),
      trimmed.replace(/[\\/]/g, '-'),
      workspace.replace(/[^a-zA-Z0-9]/g, '-'),
    ])
  );
}

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isInsideOrEqual(root, candidate) {
  if (!root || !candidate) return false;
  const r = safeRealpath(root);
  const c = safeRealpath(candidate);
  return r === c;
}

function resolveProjectRoots(projectArg) {
  const base = safeRealpath(projectArg || '.');
  const roots = new Set([base, path.resolve(projectArg || '.')]);
  try {
    const raw = execFileSync('git', ['-C', base, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        const wt = line.slice('worktree '.length).trim();
        if (wt) roots.add(safeRealpath(wt));
      }
    }
  } catch {
    // Not a git repo or git unavailable; stick to resolved project dir.
  }
  return [...roots];
}

function sanitizeText(text, maxLen = 1200) {
  if (!text || typeof text !== 'string') return '';
  let out = text
    .replace(/<USER_REQUEST>\s*/g, '')
    .replace(/\s*<\/USER_REQUEST>/g, '')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{16,}/g, '$1[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[REDACTED_TOKEN]')
    .replace(/([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*\s*[:=]\s*)(?:"[^"\n]+"|'[^'\n]+'|[^\s\n]+)/gi, '$1[REDACTED]');

  out = out.trim();
  if (out.length > maxLen) {
    out = `${out.slice(0, maxLen)}… [truncated ${out.length - maxLen} chars]`;
  }
  return out;
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((item) => item && typeof item === 'object' && (item.type === 'text' || item.type === 'input_text' || item.type === 'output_text') && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');
  }
  return '';
}

function walkJsonlFiles(rootDir, maxDepth = 3) {
  const results = [];
  if (!fs.existsSync(rootDir)) return results;

  const visit = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(full);
          results.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // Skip vanished file
        }
      } else if (entry.isDirectory() && depth < maxDepth) {
        if (entry.name === 'subagents' || entry.name === 'chunks') continue;
        visit(full, depth + 1);
      }
    }
  };

  visit(rootDir, 0);
  return results;
}

async function readHeadLines(filePath, limit = 40) {
  const lines = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // Ignore malformed line
      }
      if (lines.length >= limit) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return lines;
}

function findClaudeDirs(roots, homeDir) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');
  const projectsDir = path.join(configDir, 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const matched = new Set();
  let entries = [];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }

  for (const root of roots) {
    const exact = claudeProjectDirName(root);
    if (entries.includes(exact)) {
      matched.add(path.join(projectsDir, exact));
      continue;
    }
    if (exact.length > MAX_CLAUDE_DIR_NAME) {
      const prefix = `${exact.slice(0, MAX_CLAUDE_DIR_NAME)}-`;
      const prefMatches = entries.filter((name) => name.startsWith(prefix));
      for (const m of prefMatches) matched.add(path.join(projectsDir, m));
    }
  }
  return [...matched];
}

async function scanClaude(roots, homeDir) {
  const dirs = findClaudeDirs(roots, homeDir);
  const candidates = [];
  for (const dir of dirs) {
    for (const file of walkJsonlFiles(dir, 2)) {
      const head = await readHeadLines(file.path, 35);
      let sessionId = path.basename(file.path, '.jsonl');
      let cwd = null;
      let branch = null;
      let openingPrompt = '';
      for (const rec of head) {
        if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
        if (!branch && typeof rec.gitBranch === 'string') branch = rec.gitBranch;
        if (typeof rec.sessionId === 'string') sessionId = rec.sessionId;
        if (!openingPrompt && rec.type === 'user' && !rec.isMeta) {
          const text = extractTextContent(rec.message?.content);
          if (text && !LOCAL_COMMAND_RE.test(text)) {
            openingPrompt = sanitizeText(text, 160);
          }
        }
      }
      if (cwd && !roots.some((r) => isInsideOrEqual(r, cwd))) continue;
      candidates.push({
        source: 'claude',
        id: sessionId,
        path: file.path,
        mtimeMs: file.mtimeMs,
        updatedAt: new Date(file.mtimeMs).toISOString(),
        cwd,
        branch,
        openingPrompt: openingPrompt || '(no opening prompt found in head)',
      });
    }
  }
  return candidates;
}

async function scanCodex(roots, homeDir) {
  const codexHome = process.env.CODEX_HOME || path.join(homeDir, '.codex');
  const searchDirs = [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')];
  const files = [];
  for (const d of searchDirs) {
    files.push(...walkJsonlFiles(d, 4));
  }
  // Pre-sort by mtime and inspect up to newest 250 files for responsiveness
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const candidates = [];

  for (const file of files.slice(0, 250)) {
    const head = await readHeadLines(file.path, 25);
    const meta = head.find((r) => r?.type === 'session_meta');
    if (!meta || !meta.payload) continue;

    const payload = meta.payload;
    const candidateCwds = [
      ...(typeof payload.cwd === 'string' ? [payload.cwd] : []),
      ...(Array.isArray(payload.runtime_workspace_roots) ? payload.runtime_workspace_roots : []),
    ];
    if (!candidateCwds.some((c) => roots.some((r) => isInsideOrEqual(r, c)))) continue;

    let openingPrompt = '';
    for (const rec of head) {
      if (rec?.type === 'event_msg' && rec.payload?.type === 'user_message' && typeof rec.payload.message === 'string') {
        openingPrompt = sanitizeText(rec.payload.message, 160);
        break;
      }
      if (rec?.type === 'response_item' && rec.payload?.type === 'message' && rec.payload?.role === 'user') {
        const text = extractTextContent(rec.payload.content);
        if (text && !text.startsWith('<environment_context>') && !text.startsWith('# AGENTS.md')) {
          openingPrompt = sanitizeText(text, 160);
          break;
        }
      }
    }

    candidates.push({
      source: 'codex',
      id: payload.session_id || payload.id || path.basename(file.path, '.jsonl'),
      path: file.path,
      mtimeMs: file.mtimeMs,
      updatedAt: new Date(file.mtimeMs).toISOString(),
      cwd: payload.cwd || candidateCwds[0] || null,
      branch: payload.git?.branch || null,
      openingPrompt: openingPrompt || '(no opening prompt found in head)',
    });
  }
  return candidates;
}

async function scanCursor(roots, homeDir) {
  const cursorProjects = path.join(homeDir, '.cursor', 'projects');
  if (!fs.existsSync(cursorProjects)) return [];

  const matchedDirs = new Set();
  let entries = [];
  try {
    entries = fs.readdirSync(cursorProjects, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }

  for (const root of roots) {
    for (const variant of cursorSlugVariants(root)) {
      if (entries.includes(variant)) {
        matchedDirs.add(path.join(cursorProjects, variant, 'agent-transcripts'));
      }
    }
  }

  const candidates = [];
  for (const dir of matchedDirs) {
    for (const file of walkJsonlFiles(dir, 2)) {
      const head = await readHeadLines(file.path, 20);
      let openingPrompt = '';
      for (const rec of head) {
        const role = rec?.role || rec?.message?.role;
        if (role === 'user') {
          const text = extractTextContent(rec?.content ?? rec?.message?.content);
          if (text) {
            openingPrompt = sanitizeText(text, 160);
            break;
          }
        }
      }
      candidates.push({
        source: 'cursor',
        id: path.basename(file.path, '.jsonl'),
        path: file.path,
        mtimeMs: file.mtimeMs,
        updatedAt: new Date(file.mtimeMs).toISOString(),
        cwd: roots[0],
        branch: null,
        openingPrompt: openingPrompt || '(no opening prompt found in head)',
      });
    }
  }
  return candidates;
}

function queryAntigravityDb(baseDir, roots) {
  const dbPath = path.join(baseDir, 'conversation_summaries.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    const out = execFileSync(
      'sqlite3',
      [
        '-json',
        `file:${dbPath}?mode=ro`,
        "SELECT conversation_id, title, workspace_uris, parent_conversation_id, last_modified_time FROM conversation_summaries WHERE parent_conversation_id = '' ORDER BY last_modified_time DESC LIMIT 200;",
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const rows = JSON.parse(out || '[]');
    const matched = new Map();
    for (const row of rows) {
      const uris = String(row.workspace_uris || '');
      const decoded = decodeURIComponent(uris);
      const hit = roots.some((r) => uris.includes(r) || decoded.includes(r));
      if (hit && row.conversation_id) {
        matched.set(row.conversation_id, {
          title: row.title || '',
          lastModified: row.last_modified_time || null,
        });
      }
    }
    return matched;
  } catch {
    return null;
  }
}

async function scanAntigravity(roots, homeDir) {
  const bases = Array.from(
    new Set([
      ...(process.env.ANTIGRAVITY_HOME ? [process.env.ANTIGRAVITY_HOME] : []),
      path.join(homeDir, '.gemini', 'antigravity-cli'),
      path.join(homeDir, '.gemini', 'antigravity'),
    ])
  );

  const candidates = [];
  const seenFiles = new Set();

  for (const base of bases) {
    const brainDir = path.join(base, 'brain');
    if (!fs.existsSync(brainDir)) continue;
    const dbMatch = queryAntigravityDb(base, roots);

    let convDirs = [];
    try {
      convDirs = fs.readdirSync(brainDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }

    for (const convId of convDirs) {
      const logPath = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(logPath) || seenFiles.has(logPath)) continue;
      if (dbMatch !== null && !dbMatch.has(convId)) continue;

      const stat = fs.statSync(logPath);
      const head = await readHeadLines(logPath, 25);

      if (dbMatch === null) {
        const headText = JSON.stringify(head);
        if (!roots.some((r) => headText.includes(r))) continue;
      }

      let openingPrompt = dbMatch?.get(convId)?.title || '';
      for (const rec of head) {
        if (rec?.type === 'USER_INPUT' && typeof rec.content === 'string') {
          openingPrompt = sanitizeText(rec.content, 160);
          break;
        }
      }

      seenFiles.add(logPath);
      candidates.push({
        source: 'antigravity',
        id: convId,
        path: logPath,
        mtimeMs: stat.mtimeMs,
        updatedAt: new Date(stat.mtimeMs).toISOString(),
        cwd: roots[0],
        branch: null,
        openingPrompt: openingPrompt || '(no opening prompt found in head)',
      });
    }
  }
  return candidates;
}

function detectFormat(head, filePath) {
  if (head.some((r) => r?.type === 'session_meta')) return 'codex';
  if (head.some((r) => r?.type === 'USER_INPUT' || r?.type === 'PLANNER_RESPONSE')) return 'antigravity';
  if (head.some((r) => r?.sessionId || r?.type === 'user' || r?.type === 'assistant')) return 'claude';
  if (filePath.includes(`${path.sep}.cursor${path.sep}`)) return 'cursor';
  return 'generic';
}

function collectFilePathsFromToolInput(inputObj, touchedFiles) {
  if (!inputObj || typeof inputObj !== 'object') return;
  for (const key of ['file_path', 'path', 'Path', 'TargetFile', 'target_file', 'AbsolutePath']) {
    const val = inputObj[key];
    if (typeof val === 'string' && val.length > 0 && !val.includes('.env')) {
      touchedFiles.add(val);
    }
  }
}

async function cmdExtract(filePath, tailCount, maxChars) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Transcript file not found: ${resolved}`);
  }
  const head = await readHeadLines(resolved, 20);
  const format = detectFormat(head, resolved);

  let sessionId = path.basename(resolved, '.jsonl');
  let cwd = null;
  let branch = null;
  let startedAt = null;
  let endedAt = null;
  const userMessages = [];
  const assistantHighlights = [];
  const toolCounts = {};
  const touchedFiles = new Set();
  const events = [];

  const stream = fs.createReadStream(resolved, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const recordTool = (name, argsObj, ts) => {
    if (!name) return;
    toolCounts[name] = (toolCounts[name] || 0) + 1;
    collectFilePathsFromToolInput(argsObj, touchedFiles);
    events.push({ kind: 'tool', tool: name, at: ts || null });
  };

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      const ts = rec.timestamp || rec.created_at || null;
      if (ts && !startedAt) startedAt = ts;
      if (ts) endedAt = ts;

      if (format === 'codex') {
        if (rec.type === 'session_meta' && rec.payload) {
          sessionId = rec.payload.session_id || rec.payload.id || sessionId;
          cwd = rec.payload.cwd || cwd;
          branch = rec.payload.git?.branch || branch;
        } else if (rec.type === 'event_msg' && rec.payload?.type === 'user_message') {
          const text = sanitizeText(rec.payload.message, maxChars);
          if (text) {
            userMessages.push({ at: ts, text });
            events.push({ kind: 'user', at: ts, text });
          }
        } else if (rec.type === 'response_item' && rec.payload?.type === 'message') {
          const role = rec.payload.role;
          if (role === 'user') {
            const raw = extractTextContent(rec.payload.content);
            if (raw && !raw.startsWith('<environment_context>') && !raw.startsWith('# AGENTS.md')) {
              const text = sanitizeText(raw, maxChars);
              if (text && userMessages[userMessages.length - 1]?.text !== text) {
                userMessages.push({ at: ts, text });
                events.push({ kind: 'user', at: ts, text });
              }
            }
          } else if (role === 'assistant') {
            const text = sanitizeText(extractTextContent(rec.payload.content), maxChars);
            if (text) {
              assistantHighlights.push({ at: ts, text });
              events.push({ kind: 'assistant', at: ts, text });
            }
          }
        } else if (rec.type === 'response_item' && (rec.payload?.type === 'custom_tool_call' || rec.payload?.type === 'function_call')) {
          let parsedArgs = null;
          try {
            parsedArgs = typeof rec.payload.arguments === 'string' ? JSON.parse(rec.payload.arguments) : rec.payload.input;
          } catch {
            parsedArgs = null;
          }
          recordTool(rec.payload.name, parsedArgs, ts);
        }
      } else if (format === 'antigravity') {
        const parentDirName = path.basename(path.resolve(path.dirname(resolved), '..', '..'));
        if (parentDirName && parentDirName !== 'brain') sessionId = parentDirName;
        if (rec.type === 'USER_INPUT' && typeof rec.content === 'string') {
          const text = sanitizeText(rec.content, maxChars);
          if (text) {
            userMessages.push({ at: ts, text });
            events.push({ kind: 'user', at: ts, text });
          }
        } else if (rec.type === 'PLANNER_RESPONSE') {
          if (typeof rec.content === 'string' && rec.content.trim()) {
            const text = sanitizeText(rec.content, maxChars);
            assistantHighlights.push({ at: ts, text });
            events.push({ kind: 'assistant', at: ts, text });
          }
          if (Array.isArray(rec.tool_calls)) {
            for (const tc of rec.tool_calls) {
              recordTool(tc.name, tc.args, ts);
            }
          }
        }
      } else {
        // claude & cursor / generic
        if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
        if (!branch && typeof rec.gitBranch === 'string') branch = rec.gitBranch;
        if (typeof rec.sessionId === 'string') sessionId = rec.sessionId;

        if (rec.type === 'user' && !rec.isMeta) {
          const raw = extractTextContent(rec.message?.content);
          if (raw && !LOCAL_COMMAND_RE.test(raw)) {
            const text = sanitizeText(raw, maxChars);
            if (text) {
              userMessages.push({ at: ts, text });
              events.push({ kind: 'user', at: ts, text });
            }
          }
        } else if (rec.type === 'assistant' && Array.isArray(rec.message?.content)) {
          const texts = [];
          for (const block of rec.message.content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              texts.push(block.text);
            } else if (block?.type === 'tool_use') {
              recordTool(block.name, block.input, ts);
            }
          }
          const combined = sanitizeText(texts.join('\n'), maxChars);
          if (combined) {
            assistantHighlights.push({ at: ts, text: combined });
            events.push({ kind: 'assistant', at: ts, text: combined });
          }
        } else if (rec.role === 'user' || rec.message?.role === 'user') {
          const text = sanitizeText(extractTextContent(rec.content ?? rec.message?.content), maxChars);
          if (text) {
            userMessages.push({ at: ts, text });
            events.push({ kind: 'user', at: ts, text });
          }
        } else if (rec.role === 'assistant' || rec.message?.role === 'assistant') {
          const text = sanitizeText(extractTextContent(rec.content ?? rec.message?.content), maxChars);
          if (text) {
            assistantHighlights.push({ at: ts, text });
            events.push({ kind: 'assistant', at: ts, text });
          }
        }
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const headUsers = userMessages.slice(0, 2);
  const tailUsers = userMessages.length > 2 ? userMessages.slice(-4) : [];
  const mergedUsers = [...headUsers];
  for (const item of tailUsers) {
    if (!mergedUsers.includes(item)) mergedUsers.push(item);
  }

  console.log(
    JSON.stringify(
      {
        format,
        sessionId,
        path: resolved,
        cwd,
        branch,
        startedAt,
        endedAt,
        counts: {
          userMessages: userMessages.length,
          assistantMessages: assistantHighlights.length,
          tools: toolCounts,
        },
        keyUserMessages: mergedUsers,
        recentAssistantMessages: assistantHighlights.slice(-4),
        touchedFiles: [...touchedFiles].slice(0, 40),
        tailEvents: events.slice(-tailCount),
      },
      null,
      2
    )
  );
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string', default: '.' },
      source: { type: 'string', default: 'all' },
      limit: { type: 'string', default: '8' },
      file: { type: 'string' },
      tail: { type: 'string', default: '20' },
      'max-chars': { type: 'string', default: '1000' },
    },
  });

  const [command] = positionals;
  if (!command || !['list', 'extract'].includes(command)) {
    throw new Error(
      'Usage: transcripts.mjs <list|extract> [--project <dir> --source <all|claude|codex|antigravity|cursor> --limit <n>] [--file <path> --tail <n>]'
    );
  }

  if (command === 'extract') {
    if (!values.file) throw new Error('extract requires --file <path>');
    const tail = Math.max(1, Number.parseInt(values.tail, 10) || 20);
    const maxChars = Math.max(100, Number.parseInt(values['max-chars'], 10) || 1000);
    await cmdExtract(values.file, tail, maxChars);
    return;
  }

  const source = String(values.source || 'all').toLowerCase();
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`Invalid --source "${values.source}". Expected one of: all, claude, codex, antigravity, cursor`);
  }
  const limit = Math.max(1, Number.parseInt(values.limit, 10) || 8);
  const roots = resolveProjectRoots(values.project);
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();

  const tasks = [];
  if (source === 'all' || source === 'claude') tasks.push(scanClaude(roots, homeDir));
  if (source === 'all' || source === 'codex') tasks.push(scanCodex(roots, homeDir));
  if (source === 'all' || source === 'antigravity') tasks.push(scanAntigravity(roots, homeDir));
  if (source === 'all' || source === 'cursor') tasks.push(scanCursor(roots, homeDir));

  const nested = await Promise.all(tasks);
  const sessions = nested.flat().sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);

  console.log(
    JSON.stringify(
      {
        projectRoots: roots,
        source,
        sessions,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ kind: 'error', error: err.message }));
  process.exit(1);
});
