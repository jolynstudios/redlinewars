import type { BlenderAsset } from './blender-mesh'
export { decodeBlenderAsset } from './blender-mesh'
interface BlenderManifest {
	readonly schema: number
	readonly bytes: number
	readonly compression: 'gzip'
	readonly storedBytes: number
	readonly sha256: string
	readonly assets: Readonly<Record<string, BlenderAsset>>
}
// Globs deliberately support an absent local bake. Vite fingerprints a present pack.
const manifests = import.meta.glob<BlenderManifest>('../../.forge/blender/manifest.json', { eager: true, import: 'default' })
const packs = import.meta.glob<string>('../../.forge/blender/roster.ssasset.gz', { eager: true, query: '?url', import: 'default' })
export const BLENDER_HIDDEN_ACTORS = new Set(['camera', 'camera.paradrop', 'camera.spyplane', 'sonar', 'mpspawn', 'waypoint'])

export async function loadBlenderAssets(): Promise<{ manifest: BlenderManifest; bytes: Uint8Array } | null> {
	if (new URLSearchParams(location.search).get('noforge') === '1') return null
	const manifest = Object.values(manifests)[0], url = Object.values(packs)[0]
	if (!manifest && !url) return null
	if (!manifest || !url || manifest.schema !== 1) throw new Error('Blender pack manifest is missing or unsupported')
	const response = await fetch(url)
	if (!response.ok) throw new Error(`Blender pack download failed: HTTP ${response.status}`)
	const downloaded = await response.arrayBuffer()
	if (manifest.compression !== 'gzip') throw new Error('Unsupported Blender pack compression')
	// Some hosts (including Vite preview) serve .gz with Content-Encoding, so fetch
	// already decompresses it. Plain static hosts return the gzip file itself.
	const signature = new Uint8Array(downloaded, 0, Math.min(2, downloaded.byteLength))
	let buffer = downloaded
	if (signature[0] === 0x1f && signature[1] === 0x8b) {
		if (downloaded.byteLength !== manifest.storedBytes) throw new Error('Blender compressed pack byte count mismatch')
		const stream = new Blob([downloaded]).stream().pipeThrough(new DecompressionStream('gzip'))
		buffer = await new Response(stream).arrayBuffer()
	}
	if (buffer.byteLength !== manifest.bytes) throw new Error('Blender pack byte count mismatch')
	const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(b => b.toString(16).padStart(2, '0')).join('')
	if (hash !== manifest.sha256) throw new Error('Blender pack SHA-256 mismatch')
	return { manifest, bytes: new Uint8Array(buffer) }
}
