#!/usr/bin/env node
// One assembler for the node (L27, §4.7, T1.0): the ONLY way any artifact obtains a node —
// the desktop app, the npm package, the per-OS zips, CI and the gates all call this.
// Copies exactly the entries of node-manifest.json into the layout roomhost.mjs expects,
// then writes node-assembly.json = {commit, rid, files:[{path, sha256}]}. It never builds
// anything and never spawns dotnet/npm; a listed path that is missing fails loudly.
//
//   node assemble-node.mjs --rid <rid> --out <dir>
//
// rid accepts a platform id (mapped to its server runtime id) or an already-mapped id:
//   darwin-arm64 -> osx-arm64   darwin-x64 -> osx-x64   win32-x64 -> win-x64
//   win32-arm64  -> win-x64     linux-x64 -> linux-x64  linux-arm64 -> linux-arm64
//
// Output layout (mirrors roomhost.mjs: scriptDir = <out>/steelseed-host/tools,
// engineRoot = <out>, so `ws` resolves up through <out>/node_modules):
//   <out>/steelseed-host/tools/<manifest.runtime>   from engine/steelseed-host/tools/
//   <out>/steelseed-host/generated/…                from engine/steelseed-host/<manifest.data>
//   <out>/node_modules/<name>/…                     from engine/node_modules/<name>
//   <out>/bin-standalone/<rid>/…                    from engine/bin-standalone/<rid> (when present)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceIdentity } from './release-manifest.mjs';
import assert from 'node:assert/strict';
import { assertStandaloneNativeRuntime } from './native-runtime.mjs';

const RID_MAP = {
  'darwin-arm64': 'osx-arm64',
  'darwin-x64': 'osx-x64',
  'win32-x64': 'win-x64',
  'win32-arm64': 'win-x64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(scriptDir, '..'); // engine/steelseed-host
const engineRoot = path.resolve(scriptDir, '../..'); // engine/

export function resolveRid(rid) {
  if (Object.values(RID_MAP).includes(rid)) return rid;
  if (RID_MAP[rid]) return RID_MAP[rid];
  throw new Error(
    `assemble-node: unknown rid "${rid}" (expected one of ${Object.keys(RID_MAP).join(', ')} ` +
      `or ${Object.values(RID_MAP).join(', ')})`,
  );
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function copyInto(src, destRel, outRoot, files) {
  if (fs.statSync(src).isFile()) {
    const dest = path.join(outRoot, destRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // A copy-on-write clone saves staging space where supported; Node falls back to a regular copy.
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_FICLONE);
    files.push({ path: destRel.split(path.sep).join('/'), sha256: sha256File(dest) });
    return;
  }
  for (const srcFile of listFilesRecursive(src)) {
    const rel = path.join(destRel, path.relative(src, srcFile));
    const dest = path.join(outRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(srcFile, dest, fs.constants.COPYFILE_FICLONE);
    files.push({ path: rel.split(path.sep).join('/'), sha256: sha256File(dest) });
  }
}

function readManifest() {
  const manifestPath = path.join(scriptDir, 'node-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const key of ['runtime', 'modules', 'data', 'examples'])
    if (!Array.isArray(manifest[key])) throw new Error(`assemble-node: node-manifest.json "${key}" must be an array`);
  return manifest;
}

export function assemblySource({ root = path.resolve(engineRoot, '..'), readGit } = {}) {
  return { commit: sourceIdentity({ root, readGit }).commit.slice(0, 12) };
}

export async function assembleNode({ rid, out }) {
  if (!rid) throw new Error('assemble-node: --rid <rid> is required');
  if (!out) throw new Error('assemble-node: --out <dir> is required');
  const resolvedRid = resolveRid(rid);
  const outRoot = path.resolve(out);
  const source = assemblySource();
  const manifest = readManifest();

  // Resolve every source before touching the output so a missing path fails loudly
  // with the complete list instead of leaving a half-written assembly behind.
  const copies = [];
  for (const name of manifest.runtime)
    copies.push({ label: `runtime "${name}"`, src: path.join(scriptDir, name), dest: path.join('steelseed-host', 'tools', name) });
  for (const name of manifest.data)
    copies.push({ label: `data "${name}"`, src: path.join(hostRoot, name), dest: path.join('steelseed-host', name) });
  for (const name of manifest.modules)
    copies.push({ label: `module "${name}"`, src: path.join(engineRoot, 'node_modules', name), dest: path.join('node_modules', name) });

  const missing = copies.filter((c) => !fs.existsSync(c.src)).map((c) => `${c.label}: ${c.src}`);
  const standaloneSrc = path.join(engineRoot, 'bin-standalone', resolvedRid);
  const hasStandalone = fs.existsSync(standaloneSrc);
  if (missing.length > 0)
    throw new Error(`assemble-node: node-manifest.json lists paths that do not exist:\n  ${missing.join('\n  ')}`);
  // The whole-dir "generated" copy cannot prove per-file completeness: the
  // resolved-RA catalog exports (what verify-release's node coverage checks)
  // must exist, or the assembly fails loudly instead of shipping a node that
  // silently lacks them.
  for (const exportName of ['ra-visual-manifest.json', 'ra-trait-audit.json'])
    if (!fs.existsSync(path.join(hostRoot, 'generated', exportName)))
      throw new Error(`assemble-node: steelseed-host/generated/${exportName} is missing — run "node steelseed-host/tools/export-ra-catalog.mjs" first`);
  if (hasStandalone) assertStandaloneNativeRuntime(standaloneSrc, resolvedRid);

  fs.mkdirSync(outRoot, { recursive: true });
  const files = [];
  for (const c of copies) await copyInto(c.src, c.dest, outRoot, files);
  if (hasStandalone) await copyInto(standaloneSrc, path.join('bin-standalone', resolvedRid), outRoot, files);
  files.sort((a, b) => a.path.localeCompare(b.path));

  assert.deepEqual(assemblySource(), source, 'Public source commit changed during node assembly');
  const assembly = { ...source, rid: resolvedRid, files };
  fs.writeFileSync(path.join(outRoot, 'node-assembly.json'), JSON.stringify(assembly, null, 2) + '\n');
  return assembly;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
  };
  const assembly = await assembleNode({ rid: flag('--rid'), out: flag('--out') });
  console.log(`assemble-node: ${assembly.files.length} files -> rid ${assembly.rid} @ ${assembly.commit}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
