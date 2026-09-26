// The brand's two faces for the pre-match screens: Archivo (display) and Martian Mono (the
// HUD voice), both SIL OFL 1.1 — the same dev dependencies the landing site builds with.
//
// `new URL(asset, import.meta.url)` is Vite's asset form (as for the music): the files are
// emitted into the build as hashed assets and served from this origin, so there is no CDN
// and no request to anyone else during play (rule 4), and the service worker caches them
// like every other hashed file. The "standard" files carry both the weight and the width
// axis, which the wide display type needs. Every stack falls back to system faces while a
// face loads or if it never arrives.
const FACES: readonly (readonly [family: string, url: string, weight: string, stretch: string])[] = [
	['Archivo', new URL('../node_modules/@fontsource-variable/archivo/files/archivo-latin-standard-normal.woff2', import.meta.url).href, '100 900', '62% 125%'],
	['Martian Mono', new URL('../node_modules/@fontsource-variable/martian-mono/files/martian-mono-latin-standard-normal.woff2', import.meta.url).href, '100 800', '75% 112.5%'],
]

/** Register both faces and start fetching them; never throws, never logs an error. */
export function loadBrandFonts(): void {
	if (typeof document === 'undefined' || !('fonts' in document) || typeof FontFace !== 'function') return
	for (const [family, url, weight, stretch] of FACES) {
		const face = new FontFace(family, `url(${url}) format('woff2')`, { weight, stretch, style: 'normal', display: 'swap' })
		document.fonts.add(face)
		// A failed face is a cosmetic fallback, not an error (capture.mjs fails on console errors).
		void face.load().catch(() => {})
	}
}
