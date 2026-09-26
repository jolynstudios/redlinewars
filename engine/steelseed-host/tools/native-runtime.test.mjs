import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { assertNativeLua, assertStandaloneNativeRuntime } from './native-runtime.mjs'

function fixture(rid) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `redline-native-${rid}-`))
	const file = rid.startsWith('osx') ? 'lua51.dylib' : rid.startsWith('win') ? 'lua51.dll' : 'lua51.so'
	const data = Buffer.alloc(128)
	if (rid.startsWith('linux')) {
		Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(data)
		data.writeUInt16LE(rid.endsWith('arm64') ? 183 : 62, 18)
	} else if (rid.startsWith('osx')) {
		data.writeUInt32LE(0xfeedfacf, 0)
		data.writeUInt32LE(rid.endsWith('arm64') ? 0x0100000c : 0x01000007, 4)
	} else {
		data.write('MZ', 0)
		data.writeUInt32LE(64, 0x3c)
		data.write('PE\0\0', 64)
		data.writeUInt16LE(0x8664, 68)
	}
	fs.writeFileSync(path.join(dir, file), data)
	return { dir, file, data }
}

test('every shipping RID accepts only its own native Lua format and architecture', t => {
	for (const rid of ['osx-arm64', 'osx-x64', 'win-x64', 'linux-x64', 'linux-arm64']) {
		const { dir, file, data } = fixture(rid)
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
		assert.doesNotThrow(() => assertNativeLua(dir, rid), rid)
		const other = rid === 'linux-x64' ? 'linux-arm64' : 'linux-x64'
		assert.throws(() => assertNativeLua(dir, other), /native-runtime:/, `${rid} must not pass as ${other}`)
		fs.writeFileSync(path.join(dir, file), Buffer.alloc(data.length))
		assert.throws(() => assertNativeLua(dir, rid), /unknown Lua library format/)
	}
})

test('an assembled server and verifier both need the exact native file, without stale foreign files', t => {
	const { dir, file, data } = fixture('linux-x64')
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
	const verifier = path.join(dir, 'ranked-replay-verifier')
	fs.mkdirSync(verifier)
	fs.writeFileSync(path.join(verifier, file), data)
	assert.doesNotThrow(() => assertStandaloneNativeRuntime(dir, 'linux-x64'))
	fs.writeFileSync(path.join(verifier, 'lua51.dylib'), data)
	assert.throws(() => assertStandaloneNativeRuntime(dir, 'linux-x64'), /needs only lua51.so/)
})
