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
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SOURCE_REPOSITORY = 'https://github.com/jolynstudios/redlinewars';
export const MANIFEST_NAME = 'RELEASE-MANIFEST.json';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

/** Public source identity. RELEASE-SOURCE.json is historical attribution only. */
export function sourceIdentity({ root = repoRoot, readGit } = {}) {
  const resolvedRoot = path.resolve(root);
  const git = readGit ?? (args => {
    try { return execFileSync('git', ['-C', resolvedRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return null; }
  });
  const top = git(['rev-parse', '--show-toplevel']);
  if (!top || path.resolve(top) !== resolvedRoot)
    throw new Error('release-manifest: the public source root must be its own git checkout');
  const commit = git(['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('release-manifest: public checkout has no commit');
  const tag = git(['describe', '--tags', '--exact-match', 'HEAD']) || null;
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  if (status === null) throw new Error('release-manifest: cannot inspect public checkout status');
  return { repository: SOURCE_REPOSITORY, tag, commit,
    url: `${SOURCE_REPOSITORY}/tree/${tag ?? commit}`, dirty: status !== '' };
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

// One desktop resource policy. Source QA still hashes the complete AppBundle;
// installers omit presentation source maps without changing any runtime file.
export const DESKTOP_APP_BUNDLE_PROJECTION = Object.freeze({
  schema: 1, policy: 'desktop-no-presentation-source-maps-v1',
  excluded: Object.freeze(['steelseed/**/*.map']),
});
export const DESKTOP_APP_BUNDLE_FILTER = Object.freeze(['**/*', '!steelseed/**/*.map']);

/** Paired additive metadata; older complete-bundle identities remain supported. */
export function appBundleIdentityMetadata(identity) {
  if (identity.appBundleProjection === undefined) {
    assert.equal(identity.inputs?.appBundle, undefined, 'Full AppBundle input requires an explicit projection');
    return {};
  }
  assert.deepEqual(identity.appBundleProjection, DESKTOP_APP_BUNDLE_PROJECTION, 'Unknown AppBundle projection');
  const input = identity.inputs?.appBundle;
  assert.ok(input && Number.isSafeInteger(input.files) && input.files >= 0
    && /^[0-9a-f]{64}$/.test(input.sha256), 'Projected candidate requires a valid complete AppBundle input identity');
  assert.deepEqual(Object.keys(input).sort(), ['files', 'sha256'], 'Unexpected AppBundle input fields');
  return { inputs: { appBundle: { ...input } }, appBundleProjection: DESKTOP_APP_BUNDLE_PROJECTION };
}

/** Digest of precisely the AppBundle files selected by the desktop copier. */
export function desktopAppBundleDigest(dir) {
  const hash = createHash('sha256');
  let files = 0;
  for (const rel of listFiles(dir)) {
    if (rel === MANIFEST_NAME || rel.startsWith('steelseed/') && rel.endsWith('.map')) continue;
    hash.update(`${rel}\t${createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex')}\n`);
    files++;
  }
  return { files, sha256: hash.digest('hex') };
}

/** Compare source QA's full input AND its exact Windows/desktop projection. */
export function assertDesktopAppBundleIdentity(dir, identity) {
  appBundleIdentityMetadata(identity);
  if (identity.appBundleProjection === undefined) {
    assert.deepEqual(contentDigest(dir), identity.contents.appBundle, 'Complete legacy AppBundle identity differs');
    return;
  }
  assert.deepEqual(contentDigest(dir), identity.inputs.appBundle, 'Complete AppBundle input differs');
  assert.deepEqual(desktopAppBundleDigest(dir), identity.contents.appBundle, 'Shipped AppBundle projection differs');
}

/**
 * The manifest for one artifact. `contents` maps a label to a staged directory, or to
 * { dir, skip } for paths the artifact will not carry, or the fixed desktop AppBundle
 * projection (with its complete input recorded separately); `licenseTexts`
 * are the paths of the licence files inside the artifact.
 */
export function releaseManifest({ artifact, kind, rid = null, build, contents, licenseTexts, sourceOptions }) {
  const projected = Object.entries(contents).filter(([, spec]) => typeof spec === 'object' && spec?.projection !== undefined);
  for (const [label, spec] of projected) {
    assert.equal(kind, 'desktop', 'AppBundle projection is only supported for desktop artifacts');
    assert.equal(label, 'appBundle', 'Projection is only supported for the shared AppBundle');
    assert.equal(spec.projection, DESKTOP_APP_BUNDLE_PROJECTION.policy, 'Unknown AppBundle projection');
    assert.equal(spec.skip, undefined, 'AppBundle projection cannot have additional exclusions');
  }
  const source = sourceIdentity(sourceOptions);
  return {
    schema: 1,
    product: 'Redline Wars public source edition',
    artifact,
    kind,
    ...(rid && { rid }),
    source,
    build: build ? { simBuild: build.simBuild ?? null, modHash: build.modHash ?? null, ...(build.app && { app: build.app }) } : null,
    contents: Object.fromEntries(Object.entries(contents).map(([label, spec]) =>
      [label, typeof spec === 'string' ? contentDigest(spec) : spec.projection !== undefined
        ? desktopAppBundleDigest(spec.dir) : { ...contentDigest(spec.dir, spec.skip), skipped: spec.skip }])),
    ...(projected.length && { inputs: { appBundle: contentDigest(projected[0][1].dir) },
      appBundleProjection: DESKTOP_APP_BUNDLE_PROJECTION }),
    license: 'GPL-3.0-or-later',
    licenseTexts,
    notice: 'Free software under the GNU General Public License, version 3 or later, with NO WARRANTY. '
      + `Corresponding source: ${source.url}. `
      + `Built on OpenRA (c) The OpenRA Developers and Contributors. `
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
export function writeSidecar(artifactPath, manifest, { sourceOptions } = {}) {
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
  if (process.platform === 'win32' && !name.endsWith('.tgz')) {
    // PowerShell ZIPs may use backslashes and native unzip emits CRLF. Read the
    // exact entry through the built-in ZIP API, without depending on a Unix tool.
    const quotedPath = path.resolve(artifactPath).replaceAll("'", "''");
    const script = `
      $ErrorActionPreference = 'Stop'
      [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $archive = [System.IO.Compression.ZipFile]::OpenRead('${quotedPath}')
      try {
        foreach ($entry in $archive.Entries) {
          $member = $entry.FullName.Replace('\\', '/')
          if ($member -eq '${MANIFEST_NAME}' -or ($member.EndsWith('/${MANIFEST_NAME}') -and $member.Split('/').Length -eq 2)) {
            $reader = New-Object System.IO.StreamReader($entry.Open())
            try { [Console]::Write($reader.ReadToEnd()) } finally { $reader.Dispose() }
            break
          }
        }
      } finally { $archive.Dispose() }
    `;
    const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' });
    return text ? JSON.parse(text) : null;
  }
  const listing = name.endsWith('.tgz')
    ? execFileSync('tar', ['-tzf', artifactPath], { encoding: 'utf8', maxBuffer: 64 << 20 })
    : execFileSync('unzip', ['-Z1', artifactPath], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const member = listing.split(/\r?\n/).find(line => line === MANIFEST_NAME || line.endsWith(`/${MANIFEST_NAME}`) && line.split('/').length === 2);
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
