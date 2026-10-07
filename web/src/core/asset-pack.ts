import { sha256Hex } from './sha256'

/** Integrity-checked offline art pack; supports hosts with or without Content-Encoding. */
export async function fetchAssetPack(url: string, manifest: { bytes: number; storedBytes: number; sha256: string }): Promise<Uint8Array> {
	if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > 256 * 1048576 ||
		!Number.isSafeInteger(manifest.storedBytes) || manifest.storedBytes < 1 || !/^[a-f0-9]{64}$/.test(manifest.sha256))
		throw new Error('Invalid art pack manifest')
	const response = await fetch(url)
	if (!response.ok) throw new Error(`Art pack download failed: HTTP ${response.status}`)
	let buffer = await response.arrayBuffer()
	const signature = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength))
	if (signature[0] === 0x1f && signature[1] === 0x8b) {
		if (buffer.byteLength !== manifest.storedBytes) throw new Error('Compressed art pack size mismatch')
		buffer = await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
	}
	if (buffer.byteLength !== manifest.bytes) throw new Error('Art pack size mismatch')
	if (await sha256Hex(buffer) !== manifest.sha256)
		throw new Error('Art pack SHA-256 mismatch')
	return new Uint8Array(buffer)
}
