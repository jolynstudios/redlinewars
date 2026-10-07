import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export function readGameVersion(path = new URL('./game-version.json', import.meta.url)) {
	const record = JSON.parse(readFileSync(path, 'utf8'))
	assert.equal(record.schema, 1, 'Unsupported game version schema')
	assert.ok(['alpha', 'beta', 'stable'].includes(record.stage), 'Game stage must be alpha, beta or stable')
	assert.match(record.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Game version must be major.minor.patch')
	return {
		stage: record.stage,
		version: record.version,
		label: `${record.stage === 'stable' ? '' : `${record.stage[0].toUpperCase()}${record.stage.slice(1)} `}v${record.version}`,
	}
}
