#!/usr/bin/env node
// Redline Wars — the release runbook as one script.
//
//   node tools/release.mjs --source <monorepo> [--commit <sha>] [--go] [--build] [--push] [--deploy]
//
// Without --go this is a dry run: it computes the public tag, the export and
// tree paths, and prints every step it would take, changing nothing.
//
// Steps, in order (the runbook of jolynstudios-public-repo):
//   export    tools/export-release.mjs writes the classified public source of one commit.
//   assemble  merge the export's managed top-level entries into this checkout, removing tracked
//             files that disappeared. Public-only roots (README, LICENSE, notices, licenses/,
//             tools/, compliance/) are kept; untracked build output (engine/bin-browser,
//             node_modules, dist) is never touched — there is no rsync --delete.
//   notes     RELEASES.md and the README tag table must already name the new tag (human text);
//             the commit step refuses otherwise.
//   build     optional (--build): node tools/build.mjs proves the assembled tree builds.
//   commit    git add exactly the export's file list plus the public roots (never add -A in a
//             built tree — the exported .gitignore does not ignore build output), commit, tag.
//   push      --push: git push origin main <tag>. Owner action.
//   deploy    --deploy: dispatch deploy.yml components=all. Owner action. One dispatch at a
//             time (concurrency cancels queued runs); the relay needs its own run. The publish
//             job refuses to ship downloadables before the public tag exists.
//
// The post-deploy strict verification (verify-release.mjs against the CI artifacts and the live
// site) stays manual: it needs the artifacts the deploy produces. The script prints the command.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const TOOL = 'release'
const args = process.argv.slice(2)
const option = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null }
const SOURCE = option('source')
const GO = args.includes('--go') || args.includes('--push') || args.includes('--deploy')
const BUILD = args.includes('--build'), PUSH = args.includes('--push'), DEPLOY = args.includes('--deploy')
const repo = resolve(import.meta.dirname, '..')
if (!SOURCE) {
	console.error(`usage: node tools/release.mjs --source <monorepo> [--commit <sha>] [--go] [--build] [--push] [--deploy]`)
	process.exit(2)
}

const git = (repoArgs, ...rest) => execFileSync('git', [...repoArgs, ...rest], { cwd: repo, encoding: 'utf8' }).trim()
const gitAt = (cwd, ...rest) => execFileSync('git', rest, { cwd, encoding: 'utf8' }).trim()

// The public tag of a private commit: v<commit date YYYY.MM.DD>-<first seven hex>
// (mirrors engine/steelseed-host/tools/release-manifest.mjs publicTagFor).
const COMMIT = option('commit') || gitAt(SOURCE, 'rev-parse', 'HEAD')
if (!/^[0-9a-f]{40}$/.test(COMMIT)) { console.error(`${TOOL}: --commit must be a full sha (or HEAD of --source)`); process.exit(2) }
const sha7 = COMMIT.slice(0, 7)
const date = gitAt(SOURCE, 'log', '-1', '--format=%cd', '--date=format:%Y.%m.%d', COMMIT)
const TAG = `v${date}-${sha7}`
const out = resolve(tmpdir(), `redline-release-${sha7}`)
const fileList = join(tmpdir(), `redline-release-${sha7}.files`)

// The export's managed top-level entries, and the public-only roots they merge around.
const MANAGED = ['ARCHITECTURE.md', 'AUTHORS', 'RELEASE-SOURCE.json', '.gitignore', 'global.json', 'art', 'desktop', 'engine', 'web']
const PUBLIC_ROOTS = ['README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'licenses', 'tools', 'compliance']

const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
	entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
const exportFiles = () => MANAGED.flatMap(top => {
	const p = join(out, top)
	if (!existsSync(p)) return []
	return statSync(p).isDirectory() ? walk(p) : [p]
})

const say = (step, text) => console.log(`\n== ${step} ==\n${text}`)
const run = (cmd, cmdArgs, opts = {}) => {
	console.log(`+ ${cmd} ${cmdArgs.join(' ')}`)
	if (!GO) return
	const result = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...opts })
	if (result.status !== 0) { console.error(`${TOOL}: step failed (${cmd} exited ${result.status}) — nothing after it ran`); process.exit(1) }
}

if (!GO) {
	console.log(`${TOOL}: dry run (pass --go to execute export/assemble/commit; --push and --deploy are separate owner actions)
private commit : ${COMMIT}
public tag    : ${TAG}
export        : ${out}
this checkout : ${repo}`)
}

// ---------------------------------------------------------------------------------------------

say('export', `${out}`)
if (GO) rmSync(out, { recursive: true, force: true }) // a re-run must not let stale files of an earlier export survive
run(process.execPath, [join(repo, 'tools', 'export-release.mjs'), '--source', SOURCE, '--commit', COMMIT, '--out', out])

say('assemble', `merge ${MANAGED.join(', ')} into ${repo}; remove tracked files that disappeared`)
if (GO) {
	const exported = new Set(exportFiles().map(p => p.slice(out.length + 1)))
	// Tracked files only: untracked build output inside engine/ and web/ must survive.
	const tracked = git(['ls-files', '--'], ...MANAGED).split('\n').filter(Boolean)
	const gone = tracked.filter(p => !exported.has(p))
	for (const p of gone) git(['rm', '-q', '--', p])
	for (const top of MANAGED) {
		const from = join(out, top), to = join(repo, top)
		const dir = statSync(from).isDirectory()
		console.log(`+ rsync -a ${from}${dir ? '/' : ''} → ${to}`)
		const result = spawnSync('rsync', dir ? ['-a', from + '/', to + '/'] : ['-a', from, to]) // merge, never --delete
		if (result.status !== 0) { console.error(`${TOOL}: rsync failed for ${top}`); process.exit(1) }
	}
	const paths = [...exported, ...PUBLIC_ROOTS.filter(root => existsSync(join(repo, root)))]
	writeFileSync(fileList, paths.join('\n') + '\n')
	console.log(`${exported.size} exported files staged; ${gone.length} tracked files removed; list in ${fileList}`)
}

say('notes', `RELEASES.md and the README tag table must name ${TAG} (human text — edit them now)`)
if (GO && !readFileSync(join(repo, 'compliance', 'RELEASES.md'), 'utf8').includes(TAG)) {
	console.error(`${TOOL}: compliance/RELEASES.md does not mention ${TAG} — write the release note first (or this commit ships without its record)`)
	process.exit(1)
}

if (BUILD) say('build', 'prove the assembled tree builds (this is the long step)')
if (BUILD) run(process.execPath, [join(repo, 'tools', 'build.mjs')], { cwd: repo })

say('commit', `commit exactly the export list + public roots, then tag ${TAG}`)
if (GO) {
	run('git', ['add', '--pathspec-from-file=' + fileList])
	run('git', ['commit', '-m', `Release ${TAG}`, '-m', `Source of the distributed builds; exported from private commit ${sha7}.`])
	run('git', ['tag', '-a', TAG, '-m', `Redline Wars release ${TAG}`])
	console.log(`committed and tagged ${TAG} locally`)
} else {
	console.log(`git add --pathspec-from-file=<export files + ${PUBLIC_ROOTS.join(' ')}>\ngit commit -m "Release ${TAG}"\ngit tag -a ${TAG}`)
}

if (PUSH) say('push', 'owner action: publish the source before any deploy publishes binaries')
if (PUSH) run('git', ['push', 'origin', 'main', TAG])
else if (GO) console.log('\n(push skipped: pass --push to publish main + tag)')

if (DEPLOY) {
	const slug = gitAt(SOURCE, 'remote', 'get-url', 'origin').replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/')
	say('deploy', `owner action: ${slug} deploy.yml components=all — one dispatch at a time; the relay needs its own run`)
	run('gh', ['workflow', 'run', 'deploy.yml', '-f', 'components=all', '-R', slug])
} else if (GO) console.log('(deploy skipped: pass --deploy to dispatch it)')

console.log(`
post-deploy (manual): download the CI artifacts, then
  node tools/verify-release.mjs --strict --sums <SHA256SUMS> --appbundle <AppBundle.tgz> --platform-report <json> <artifacts...> https://play.redlinewars.online/steelseed
`)
