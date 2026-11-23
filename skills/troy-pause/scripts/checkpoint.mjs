#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const SENSITIVE_BASENAME = /^(?:\.env(?:\..+)?|secrets\.json|.*\.pem|.*\.key|id_rsa|id_ed25519)$/i;

function isSensitiveFile(filePath) {
  const base = path.basename(filePath);
  if (/^\.env\.example$/i.test(base)) return false;
  return SENSITIVE_BASENAME.test(base);
}

function runGit(projectDir, args) {
  return execFileSync('git', ['-C', projectDir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolveProjectIdentity(projectArg) {
  const projectDir = fs.realpathSync(path.resolve(projectArg || '.'));
  try {
    const worktree = fs.realpathSync(runGit(projectDir, ['rev-parse', '--show-toplevel']));
    const gitCommonDir = fs.realpathSync(
      runGit(projectDir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    );
    return {
      isGit: true,
      projectDir,
      worktree,
      gitCommonDir,
      store: path.join(gitCommonDir, 'troy-mode', 'handoff'),
    };
  } catch {
    const slug = createHash('sha256').update(projectDir).digest('hex').slice(0, 16);
    return {
      isGit: false,
      projectDir,
      worktree: projectDir,
      gitCommonDir: null,
      store: path.join(os.tmpdir(), 'troy-mode-handoff', slug),
    };
  }
}

function readGitState(identity) {
  if (!identity.isGit) {
    return {
      isGit: false,
      worktree: identity.worktree,
      branch: null,
      head: null,
      dirtyFiles: [],
    };
  }

  let branch = null;
  try {
    branch = runGit(identity.worktree, ['symbolic-ref', '--short', 'HEAD']) || null;
  } catch {
    try {
      branch = runGit(identity.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']) || null;
    } catch {
      branch = null;
    }
  }

  let head = null;
  try {
    head = runGit(identity.worktree, ['rev-parse', 'HEAD']) || null;
  } catch {
    head = null;
  }

  let dirtyFiles = [];
  try {
    const raw = runGit(identity.worktree, ['status', '--porcelain=v1']);
    if (raw) {
      dirtyFiles = raw
        .split('\n')
        .map((line) => line.trimEnd())
        .filter(Boolean);
    }
  } catch {
    dirtyFiles = [];
  }

  return {
    isGit: true,
    worktree: identity.worktree,
    branch,
    head,
    dirtyFiles,
  };
}

function ensureOwnedFile(filePath, allowedRoots, label) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error(`Missing ${label}`);
  }
  const canonical = fs.realpathSync(path.resolve(filePath));
  if (isSensitiveFile(canonical)) {
    throw new Error(`Refusing sensitive file for ${label}: ${canonical}`);
  }
  const stat = fs.statSync(canonical);
  if (!stat.isFile()) {
    throw new Error(`Expected regular file for ${label}: ${canonical}`);
  }
  if (!allowedRoots.some((root) => isInside(root, canonical))) {
    throw new Error(`File for ${label} must stay inside project or handoff store: ${canonical}`);
  }
  return {
    path: canonical,
    sha256: sha256File(canonical),
    size: stat.size,
  };
}

function verifyStoredFile(record, allowedRoots, label) {
  if (!record || typeof record !== 'object' || typeof record.path !== 'string' || typeof record.sha256 !== 'string') {
    throw new Error(`Invalid file record for ${label}`);
  }
  if (isSensitiveFile(record.path)) {
    throw new Error(`Refusing sensitive file in checkpoint: ${record.path}`);
  }
  const canonical = fs.realpathSync(record.path);
  if (!allowedRoots.some((root) => isInside(root, canonical))) {
    throw new Error(`Checkpoint ${label} escaped project/store boundary: ${canonical}`);
  }
  if (!fs.statSync(canonical).isFile()) {
    throw new Error(`Checkpoint ${label} is not a file: ${canonical}`);
  }
  const actualHash = sha256File(canonical);
  if (actualHash !== record.sha256) {
    throw new Error(`Checkpoint ${label} changed after publish: ${canonical}`);
  }
  return {
    path: canonical,
    sha256: actualHash,
  };
}

function extractLocalMarkdownLinks(notePath, allowedRoots) {
  const raw = fs
    .readFileSync(notePath, 'utf8')
    .replace(/^\uFEFF/, '')
    .replaceAll('\r\n', '\n')
    .replace(/^ {0,3}((`|~)\2{2,}).*\n[\s\S]*?(?:^ {0,3}\1\2*[ \t]*$|(?![\s\S]))/gm, ' ')
    .replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, ' ');

  const resolved = [];
  const matches = raw.matchAll(/\[[^\]]*\]\((?:<([^<>]+)>|([^)\s]+))\)/g);
  for (const [, angled, bare] of matches) {
    const target = angled ?? bare;
    if (!target || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
    const cleanTarget = decodeURIComponent(target.split('#')[0]);
    const abs = path.resolve(path.dirname(notePath), cleanTarget);
    if (!fs.existsSync(abs)) {
      throw new Error(`Broken local link in handoff note: ${target} -> ${abs}`);
    }
    const canonical = fs.realpathSync(abs);
    if (isSensitiveFile(canonical)) {
      throw new Error(`Refusing link to sensitive file in handoff note: ${canonical}`);
    }
    if (!allowedRoots.some((root) => isInside(root, canonical))) {
      throw new Error(`Local link escapes project/store boundary: ${target} -> ${canonical}`);
    }
    resolved.push(canonical);
  }
  return resolved;
}

function computeDrift(publishedGit, currentGit, identity) {
  const prevDirty = new Set(publishedGit?.dirtyFiles || []);
  const currDirty = new Set(currentGit?.dirtyFiles || []);
  const addedDirty = [...currDirty].filter((x) => !prevDirty.has(x));
  const resolvedDirty = [...prevDirty].filter((x) => !currDirty.has(x));

  return {
    worktreeChanged: publishedGit?.worktree ? publishedGit.worktree !== identity.worktree : false,
    branchChanged: (publishedGit?.branch ?? null) !== (currentGit?.branch ?? null),
    headChanged: (publishedGit?.head ?? null) !== (currentGit?.head ?? null),
    dirtyFilesChanged: addedDirty.length > 0 || resolvedDirty.length > 0,
    addedDirty,
    resolvedDirty,
  };
}

function cmdBegin(identity) {
  fs.mkdirSync(identity.store, { recursive: true, mode: 0o700 });
  const directory = path.join(identity.store, randomUUID());
  fs.mkdirSync(directory, { mode: 0o700 });
  const gitState = readGitState(identity);
  console.log(
    JSON.stringify(
      {
        kind: 'directory',
        store: identity.store,
        directory,
        noteTemplatePath: path.join(directory, 'handoff.md'),
        gitState,
      },
      null,
      2
    )
  );
}

function cmdPublish(identity, values) {
  fs.mkdirSync(identity.store, { recursive: true, mode: 0o700 });
  const allowedNoteRoots = [identity.store];
  const allowedArtifactRoots = [identity.store, identity.worktree, identity.projectDir];

  const note = ensureOwnedFile(values.note, allowedNoteRoots, '--note');
  const artifacts = (values.artifact || []).map((artPath) =>
    ensureOwnedFile(artPath, allowedArtifactRoots, '--artifact')
  );

  const linkedPaths = extractLocalMarkdownLinks(note.path, allowedArtifactRoots);
  for (const linked of linkedPaths) {
    if (linked === note.path) continue;
    if (!artifacts.some((a) => a.path === linked) && fs.statSync(linked).isFile()) {
      artifacts.push(ensureOwnedFile(linked, allowedArtifactRoots, 'linked file'));
    }
  }

  const gitState = readGitState(identity);
  const checkpoint = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceAgent: values.agent || 'unknown',
    isGit: identity.isGit,
    gitCommonDir: identity.gitCommonDir,
    worktree: identity.worktree,
    branch: gitState.branch,
    head: gitState.head,
    dirtyFiles: gitState.dirtyFiles,
    note: { path: note.path, sha256: note.sha256 },
    artifacts: artifacts.map((a) => ({ path: a.path, sha256: a.sha256 })),
  };

  const latestPath = path.join(identity.store, 'latest.json');
  const tmpPath = path.join(identity.store, `latest.${randomUUID()}.tmp`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, latestPath);

  console.log(
    JSON.stringify(
      {
        kind: 'published',
        latestPath,
        checkpoint,
      },
      null,
      2
    )
  );
}

function cmdRead(identity) {
  const latestPath = path.join(identity.store, 'latest.json');
  if (!fs.existsSync(latestPath)) {
    console.log(JSON.stringify({ kind: 'missing', store: identity.store }, null, 2));
    process.exit(2);
  }

  let record;
  try {
    record = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
    if (!record || record.schemaVersion !== 1) {
      throw new Error('Unsupported handoff schemaVersion');
    }
    const allowedRoots = [identity.store, identity.worktree, identity.projectDir];
    if (record.worktree && record.worktree !== identity.worktree && fs.existsSync(record.worktree)) {
      allowedRoots.push(fs.realpathSync(record.worktree));
    }

    const note = verifyStoredFile(record.note, [identity.store], 'note');
    const artifacts = (record.artifacts || []).map((a, idx) =>
      verifyStoredFile(a, allowedRoots, `artifact[${idx}]`)
    );
    extractLocalMarkdownLinks(note.path, allowedRoots);

    const currentGit = readGitState(identity);
    const drift = computeDrift(
      {
        worktree: record.worktree,
        branch: record.branch ?? null,
        head: record.head ?? null,
        dirtyFiles: record.dirtyFiles || [],
      },
      currentGit,
      identity
    );

    const noteContent = fs.readFileSync(note.path, 'utf8');

    console.log(
      JSON.stringify(
        {
          kind: 'checkpoint',
          latestPath,
          checkpoint: {
            ...record,
            note,
            artifacts,
          },
          noteContent,
          currentGit,
          drift,
        },
        null,
        2
      )
    );
  } catch (err) {
    console.log(
      JSON.stringify(
        {
          kind: 'unavailable',
          latestPath,
          error: err.message,
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string', default: '.' },
      note: { type: 'string' },
      artifact: { type: 'string', multiple: true, default: [] },
      agent: { type: 'string', default: 'unknown' },
    },
  });

  const [operation] = positionals;
  if (positionals.length !== 1 || !['begin', 'publish', 'read'].includes(operation)) {
    throw new Error(
      'Usage: checkpoint.mjs <begin|publish|read> --project <dir> [--note <file> --artifact <file> --agent <name>]'
    );
  }

  const identity = resolveProjectIdentity(values.project);

  if (operation === 'begin') {
    cmdBegin(identity);
  } else if (operation === 'publish') {
    cmdPublish(identity, values);
  } else {
    cmdRead(identity);
  }
} catch (err) {
  console.error(JSON.stringify({ kind: 'error', error: err.message }));
  process.exit(1);
}
