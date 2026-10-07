// The shared Vite build also imports these two tracked audio banks directly.
// Index declared, hash-pinned outputs only; discovery never grants rights.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

export function trackedAudioInputs({ repoRoot, gitFiles, musicManifestSha256 }) {
	const tracked = new Set(gitFiles), entries = []
	const banks = [
		{ dir: 'art/music', metadata: 'manifest.json', rows: 'tracks' },
		{ dir: 'art/voices/riki', metadata: 'provenance.json', rows: 'assets' },
	]
	const root = realpathSync(repoRoot)
	for (const bank of banks) {
		const dir = join(repoRoot, bank.dir)
		if (!existsSync(dir)) continue // A source-only export has no shipped bank to discover.
		assert.ok(lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink(), `${bank.dir}: tracked bank must be a real directory`)
		const read = name => {
			const label = `${bank.dir}/${name}`, file = join(dir, name)
			assert.ok(tracked.has(label), `${label}: build input must be Git-tracked`)
			assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), `${label}: build input must be a regular file`)
			assert.equal(realpathSync(file), join(root, label), `${label}: source path escapes through a symlink`)
			return { label, file, bytes: readFileSync(file) }
		}
		const metadataInput = read(bank.metadata)
		if (bank.rows === 'tracks') {
			assert.match(musicManifestSha256, /^[a-f0-9]{64}$/, 'Owner soundtrack record must pin the exact reviewed manifest')
			assert.equal(createHash('sha256').update(metadataInput.bytes).digest('hex'), musicManifestSha256, 'Owner soundtrack manifest differs from the reviewed record')
		}
		const metadata = JSON.parse(metadataInput.bytes)
		assert.equal(metadata.schema, 1, `${bank.dir}: unknown metadata schema`)
		const rows = metadata[bank.rows]
		assert.ok(Array.isArray(rows) && rows.length > 0, `${bank.dir}: missing declared audio outputs`)
		const mapping = bank.rows === 'assets' ? JSON.parse(read('manifest.json').bytes) : null
		if (mapping) {
			assert.equal(metadata.provider, 'ElevenLabs', 'Riki provider differs from the declared provenance rule')
			assert.equal(mapping.schema, 1)
			assert.equal(mapping.bank, 'tanya')
			assert.ok(mapping.lines && typeof mapping.lines === 'object')
			assert.equal(Object.keys(mapping.lines).length, rows.length, 'Riki bank and provenance disagree')
		}
		const names = new Set(), ids = new Set()
		for (const row of rows) {
			assert.match(row.file, /^[A-Za-z0-9][A-Za-z0-9._-]*\.m4a$/, `${bank.dir}: unsafe output name`)
			const id = mapping ? row.slug : row.id
			assert.ok(typeof id === 'string' && id && !ids.has(id), `${bank.dir}: missing/duplicate output id`)
			assert.ok(!names.has(row.file), `${bank.dir}: duplicate output file`)
			ids.add(id); names.add(row.file)
			assert.match(row.sha256, /^[a-f0-9]{64}$/, `${bank.dir}/${row.file}: missing pinned output hash`)
			assert.ok(Number.isSafeInteger(row.bytes) && row.bytes > 0, `${bank.dir}/${row.file}: missing output size`)
			if (mapping) assert.equal(mapping.lines[id], row.file, 'Riki bank and provenance disagree')
			const input = read(row.file)
			const sha256 = createHash('sha256').update(input.bytes).digest('hex')
			assert.equal(sha256, row.sha256, `${input.label}: output differs from its pinned hash`)
			assert.equal(input.bytes.length, row.bytes, `${input.label}: output differs from its pinned size`)
			entries.push({ sha256, label: input.label, file: input.file, manifest: null })
		}
		for (const name of readdirSync(dir))
			if (/\.(m4a|mp3|wav|ogg|opus)$/i.test(name)) assert.ok(names.has(name), `${bank.dir}/${name}: undeclared audio cannot inherit provenance`)
	}
	return entries
}
