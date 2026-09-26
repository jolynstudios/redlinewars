#!/usr/bin/env node
// nodeparitygate (§9.2, T1.0, GPU-free): the node inside every built artifact must be
// byte for byte a fresh assembleNode() of the same RID at the same commit.
//
//   node nodeparitygate.mjs <artifactDir>…
//
// Per artifact (the argument is the artifact's node root — the zip root, the npm
// package root, or the app bundle's Resources/steelseed-node directory):
//   1. its node-assembly.json files exist on disk and hash to what they claim
//      (catches hand edits);
//   2. its node file set equals a fresh assembly's set (nothing extra — an artifact
//      may not carry a node file absent from node-manifest.json — nothing missing);
//   3. every file's sha256 equals the fresh assembly's hash, and the commit matches.
// Globally: no packager source lists node runtime files by hand — a packager source
// may mention only assemble-node.mjs and node-cli.mjs; anything else must go through
// assembleNode().
// Prints exactly one PASS/FAIL line; exits non-zero on fail.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleNode } from './assemble-node.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../..');

// A packager never lists node files (§4.7); naming assemble-node.mjs / node-cli.mjs is allowed.
const PACKAGER_SOURCES = [
  'desktop/package.mjs',
  'engine/steelseed-host/tools/pack-npm.mjs',
  'engine/steelseed-host/tools/pack-node.mjs',
];
const PACKAGER_ALLOWED_NAMES = new Set(['assemble-node.mjs', 'node-cli.mjs']);

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

function nodeTreeRoots(files) {
  return [...new Set(files.map((f) => f.path.split('/')[0]))];
}

function checkPackagerSources(manifest, failures) {
  const banned = manifest.runtime.filter((name) => !PACKAGER_ALLOWED_NAMES.has(name));
  for (const rel of PACKAGER_SOURCES) {
    const file = path.join(repoRoot, rel);
    if (!fs.existsSync(file)) continue; // packager not present at this commit — nothing to scan
    const text = fs.readFileSync(file, 'utf8');
    for (const name of banned)
      if (text.includes(name))
        failures.push(`packager source ${rel} mentions node runtime file "${name}" (packagers must call assembleNode(), §4.7)`);
  }
}

async function checkArtifact(artifactDir, failures) {
  const relLabel = path.relative(repoRoot, artifactDir);
  const label = relLabel.startsWith('..') ? artifactDir : relLabel;
  const assemblyPath = path.join(artifactDir, 'node-assembly.json');
  if (!fs.existsSync(assemblyPath)) {
    failures.push(`${label}: no node-assembly.json — not an assembled node artifact (run assemble-node.mjs first)`);
    return;
  }
  let claimed;
  try {
    claimed = JSON.parse(fs.readFileSync(assemblyPath, 'utf8'));
  } catch (err) {
    failures.push(`${label}: node-assembly.json does not parse: ${err.message}`);
    return;
  }
  if (!claimed || claimed.rid == null || !Array.isArray(claimed.files)) {
    failures.push(`${label}: node-assembly.json lacks {rid, files[]}`);
    return;
  }

  // (1) the artifact's own claims vs its bytes
  for (const f of claimed.files) {
    const file = path.join(artifactDir, f.path);
    if (!fs.existsSync(file)) {
      failures.push(`${label}: manifest lists "${f.path}" but it is missing from the artifact`);
      continue;
    }
    const actual = sha256File(file);
    if (actual !== f.sha256) failures.push(`${label}: "${f.path}" edited by hand (sha256 ${f.sha256} -> ${actual})`);
  }

  // (2)+(3) fresh assembly of the same rid at the same commit
  let fresh;
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeparity-'));
    fresh = await assembleNode({ rid: claimed.rid, out: tmp });
  } catch (err) {
    failures.push(`${label}: fresh assembly for rid "${claimed.rid}" failed: ${err.message}`);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    return;
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  if (claimed.commit !== fresh.commit)
    failures.push(`${label}: built at commit ${claimed.commit}, repository is at ${fresh.commit} — rebuild the artifact`);

  const freshByPath = new Map(fresh.files.map((f) => [f.path, f.sha256]));
  const artifactFiles = new Set();
  for (const root of nodeTreeRoots(fresh.files)) {
    const dir = path.join(artifactDir, root);
    if (!fs.existsSync(dir)) continue;
    for (const file of listFilesRecursive(dir))
      artifactFiles.add(path.relative(artifactDir, file).split(path.sep).join('/'));
  }

  for (const f of fresh.files) {
    if (!artifactFiles.has(f.path)) {
      failures.push(`${label}: missing node file "${f.path}" (present in a fresh assembly)`);
      continue;
    }
    const actual = sha256File(path.join(artifactDir, f.path));
    if (actual !== freshByPath.get(f.path))
      failures.push(`${label}: "${f.path}" differs from a fresh assembly (sha256 mismatch)`);
  }
  for (const rel of artifactFiles)
    if (!freshByPath.has(rel))
      failures.push(`${label}: contains node file "${rel}" that node-manifest.json does not name`);
}

async function main() {
  const artifactDirs = process.argv.slice(2).filter((a) => a !== '--');
  if (artifactDirs.length === 0) {
    console.error('usage: node nodeparitygate.mjs <artifactDir>…');
    process.exitCode = 2;
    return;
  }

  const failures = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(scriptDir, 'node-manifest.json'), 'utf8'));
  for (const dir of artifactDirs) await checkArtifact(path.resolve(dir), failures);
  checkPackagerSources(manifest, failures);

  if (failures.length > 0) {
    console.log(`nodeparitygate: FAIL (${failures.length}) — ${failures.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log(`nodeparitygate: PASS (${artifactDirs.length} artifact${artifactDirs.length === 1 ? '' : 's'})`);
  }
}

await main();
