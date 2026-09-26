// Release guard for OpenRA's native Lua dependency. A RID alone does not select
// NuGet's native content: dotnet also needs -p:TargetPlatform=<rid>. A server
// built on macOS can otherwise contain a Mach-O dylib in a Linux/Windows zip.
import fs from 'node:fs'
import path from 'node:path'

const EXPECTED = {
	'osx-arm64': { file: 'lua51.dylib', format: 'mach', machine: 0x0100000c },
	'osx-x64': { file: 'lua51.dylib', format: 'mach', machine: 0x01000007 },
	'win-x64': { file: 'lua51.dll', format: 'pe', machine: 0x8664 },
	'linux-x64': { file: 'lua51.so', format: 'elf', machine: 62 },
	'linux-arm64': { file: 'lua51.so', format: 'elf', machine: 183 },
}

export function assertNativeLua(dir, rid) {
	const expected = EXPECTED[rid]
	if (!expected) throw new Error(`native-runtime: unknown RID ${rid}`)
	const present = ['lua51.dll', 'lua51.so', 'lua51.dylib'].filter(name => fs.existsSync(path.join(dir, name)))
	if (present.length !== 1 || present[0] !== expected.file)
		throw new Error(`native-runtime: ${rid} at ${dir} needs only ${expected.file}; found ${present.join(', ') || 'none'}`)
	const data = fs.readFileSync(path.join(dir, expected.file))
	let format, machine
	if (data.length >= 20 && data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
		format = 'elf'
		if (data[4] !== 2 || data[5] !== 1) throw new Error(`native-runtime: ${rid} needs a little-endian ELF64 Lua library`)
		machine = data.readUInt16LE(18)
	} else if (data.length >= 8 && data.readUInt32LE(0) === 0xfeedfacf) {
		format = 'mach'
		machine = data.readUInt32LE(4)
	} else if (data.length >= 0x40 && data.subarray(0, 2).equals(Buffer.from('MZ'))) {
		format = 'pe'
		const offset = data.readUInt32LE(0x3c)
		if (offset + 6 > data.length || data.toString('ascii', offset, offset + 4) !== 'PE\0\0')
			throw new Error(`native-runtime: ${rid} has an invalid PE Lua library`)
		machine = data.readUInt16LE(offset + 4)
	} else throw new Error(`native-runtime: ${rid} has an unknown Lua library format`)
	if (format !== expected.format || machine !== expected.machine)
		throw new Error(`native-runtime: ${rid} needs ${expected.format} machine ${expected.machine}; found ${format} machine ${machine}`)
}

export function assertStandaloneNativeRuntime(root, rid) {
	assertNativeLua(root, rid)
	assertNativeLua(path.join(root, 'ranked-replay-verifier'), rid)
}
