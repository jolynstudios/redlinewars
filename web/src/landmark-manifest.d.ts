// The landmark payload is generated into .forge and is intentionally absent
// from clean CI checkouts. Keep the source gate type-safe without pretending
// that the large generated asset pack is available to CI; Vite still requires
// the real JSON and payload files for an actual browser build.
declare module '*landmarks/manifest.json' {
	interface LandmarkDetailMask {
		readonly file: string
		readonly bytes: number
		readonly storedBytes: number
		readonly sha256: string
		readonly size: number
		readonly channels: string
		readonly uv: number
		readonly origin: string
	}

	interface LandmarkEntry {
		readonly file: string
		readonly bytes: number
		readonly storedBytes: number
		readonly sha256: string
		readonly vertices: number
		readonly triangles: number
		readonly materialSet: string
		readonly detailMask: LandmarkDetailMask
	}

	const manifest: {
		readonly schema: number
		readonly assets: Readonly<Record<string, LandmarkEntry>>
	}
	export default manifest
}
