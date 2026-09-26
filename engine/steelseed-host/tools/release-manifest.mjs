// The release manifest (compliance.md §3): every desktop package, node zip and npm node package
// carries RELEASE-MANIFEST.json, which names the public source it was built from (repository,
// tag, commit), its build id (simBuild, modHash, app version), a digest of its contents and the
// licence texts that travel with it. A file cannot hold its own hash, so the artifact's sha256
// goes into <artifact>.release.json beside it (and into the release's SHA256SUMS).
//
//   node release-manifest.mjs <artifact.zip | artifact.tgz>...    writes each artifact's
//                                                                 <artifact>.release.json from
//                                                                 the manifest inside it
//
// The packagers call releaseManifest() on their staged contents and writeSidecar() on the
// finished artifact. A build that is not on a tag, or whose tracked files differ from the tag,
// says so in the manifest (source.tag null, source.dirty true); tools/verify-release.mjs
// --require-manifest refuses such an artifact for release.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SOURCE_REPOSITORY = 'https://github.com/jolynstudios/redlinewars';
export const MANIFEST_NAME = 'RELEASE-MANIFEST.json';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * The public source of this build. A public checkout names its own tag and commit, and the private
 * commit it was exported from (RELEASE-SOURCE.json). The official build runs in the private
 * repository: its public source is the export of this commit, tagged v<commit date>-<short sha>
 * (tools/export-release.mjs in the public repository), so the manifest names that tag and this
 * commit as the source commit, and no public commit.
 */
export function sourceIdentity() {
  const commit = git(['rev-parse', 'HEAD']);
  if (!commit) throw new Error('release-manifest: not a git checkout — build releases from a git checkout');
  const dirty = (git(['status', '--porcelain', '--untracked-files=no']) ?? '') !== '';
  const releaseSource = path.join(repoRoot, 'RELEASE-SOURCE.json');
  if (fs.existsSync(releaseSource)) {
    const tag = git(['describe', '--tags', '--exact-match', 'HEAD']);
    const sourceCommit = JSON.parse(fs.readFileSync(releaseSource, 'utf8')).sourceCommit ?? null;
    return {
      repository: SOURCE_REPOSITORY,
      tag,
      commit,
      url: `${SOURCE_REPOSITORY}/tree/${tag ?? commit}`,
      dirty,
      ...(sourceCommit && { sourceCommit }),
    };
  }
  const tag = publicTagFor(commit, git(['log', '-1', '--format=%cd', '--date=format:%Y.%m.%d', 'HEAD']));
  return { repository: SOURCE_REPOSITORY, tag, commit: null, url: `${SOURCE_REPOSITORY}/tree/${tag}`, dirty, sourceCommit: commit };
}

/** The public tag of a private commit: v<commit date YYYY.MM.DD>-<first seven hex digits>. */
export function publicTagFor(commit, date) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '') || !/^\d{4}\.\d{2}\.\d{2}$/.test(date ?? '')) throw new Error(`release-manifest: no public tag for ${commit} ${date}`);
  return `v${date}-${commit.slice(0, 7)}`;
}

function listFiles(dir, base = dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, found);
    else if (entry.isFile()) found.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return found;
}

/**
 * { files, sha256 } over every file under dir (sorted "path\tsha256" lines), leaving out the
 * manifest and any path that starts with one of `skip`.
 */
export function contentDigest(dir, skip = []) {
  const hash = createHash('sha256');
  let files = 0;
  for (const rel of listFiles(dir)) {
    if (rel === MANIFEST_NAME || skip.some(prefix => rel.startsWith(prefix))) continue;
    hash.update(`${rel}\t${createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex')}\n`);
    files++;
  }
  return { files, sha256: hash.digest('hex') };
}

/**
 * The manifest for one artifact. `contents` maps a label to a staged directory, or to
 * { dir, skip } for paths the artifact will not carry, whose digest is recorded; `licenseTexts`
 * are the paths of the licence files inside the artifact.
 */
export function releaseManifest({ artifact, kind, rid = null, build, contents, licenseTexts }) {
  const source = sourceIdentity();
  return {
    schema: 1,
    product: 'Redline Wars: Fractured Order',
    artifact,
    kind,
    ...(rid && { rid }),
    source,
    build: build ? { simBuild: build.simBuild ?? null, modHash: build.modHash ?? null, ...(build.app && { app: build.app }) } : null,
    contents: Object.fromEntries(Object.entries(contents).map(([label, spec]) =>
      [label, typeof spec === 'string' ? contentDigest(spec) : { ...contentDigest(spec.dir, spec.skip), skipped: spec.skip }])),
    license: 'GPL-3.0-or-later',
    licenseTexts,
    notice: 'Free software under the GNU General Public License, version 3 or later, with NO WARRANTY. '
      + `Corresponding source: ${source.url}. Built on OpenRA (c) The OpenRA Developers and Contributors. `
      + 'Third-party components and their licences are listed in the third-party notices. The Redline Wars '
      + 'name, logo and the separately licensed art are not licensed under the GPL.',
    artifactHash: `The artifact's sha256 is published beside it in ${artifact}.release.json and in SHA256SUMS.`,
  };
}

export function writeManifest(dir, manifest) {
  const file = path.join(dir, MANIFEST_NAME);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

/** Writes <artifact>.release.json: the manifest plus the finished artifact's size and sha256. */
export function writeSidecar(artifactPath, manifest) {
  const hash = createHash('sha256');
  const fd = fs.openSync(artifactPath, 'r');
  const chunk = Buffer.alloc(8 << 20);
  try {
    for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  const sidecar = `${artifactPath}.release.json`;
  fs.writeFileSync(sidecar, `${JSON.stringify({ ...manifest, artifactBytes: fs.statSync(artifactPath).size, artifactSha256: hash.digest('hex') }, null, 2)}\n`);
  return sidecar;
}

/** The manifest inside a zip or tgz artifact (null when it has none). */
export function readEmbeddedManifest(artifactPath) {
  const name = path.basename(artifactPath);
  const listing = name.endsWith('.tgz')
    ? execFileSync('tar', ['-tzf', artifactPath], { encoding: 'utf8', maxBuffer: 64 << 20 })
    : execFileSync('unzip', ['-Z1', artifactPath], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const member = listing.split('\n').find(line => line === MANIFEST_NAME || line.endsWith(`/${MANIFEST_NAME}`) && line.split('/').length === 2);
  if (!member) return null;
  const text = name.endsWith('.tgz')
    ? execFileSync('tar', ['-xzOf', artifactPath, member], { encoding: 'utf8' })
    : execFileSync('unzip', ['-p', artifactPath, member], { encoding: 'utf8' });
  return JSON.parse(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const artifacts = process.argv.slice(2);
  if (!artifacts.length) {
    console.error('usage: node release-manifest.mjs <artifact.zip | artifact.tgz>...');
    process.exit(2);
  }
  for (const artifact of artifacts) {
    const manifest = readEmbeddedManifest(artifact);
    if (!manifest) {
      console.error(`release-manifest: ${artifact} carries no ${MANIFEST_NAME}`);
      process.exit(1);
    }
    console.log(`release-manifest: ${writeSidecar(artifact, manifest)}`);
  }
}
