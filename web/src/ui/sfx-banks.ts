/**
 * Faction SFX banks: one per faction (england/france/germany/russia/ukraine),
 * rendered into `.forge/sfx/<faction>/` — Cartesia AAC (weapons, impacts,
 * engines) and ElevenLabs MP3 (the death clip bank, `tools/gen-death-voices.mjs`).
 * This is the bank-first layer for WORLD sounds — weapon reports, impacts, destructions,
 * the production bell, vehicle engines and infantry gait — exactly as `eva.ts`
 * is the bank-first layer for voices: the manifest joins the clip URLs at
 * boot, no runtime API calls, and the audio node falls back to its procedural
 * voices for every clip a bank lacks.
 *
 * This module exists SEPARATE from `audio/index.ts` for one reason: the Node
 * audio gates bundle `index.ts` with esbuild, which does not transform Vite's
 * `import.meta.glob`, so the glob must stay out of that import graph. The UI
 * injects the table into the node via `AudioApi.setSfxBank`.
 */

// Same Node-harness caveat as eva.ts: the glob only works under Vite.
let sfxManifests: Record<string, { schema: number; faction: string; effects: Record<string, string> }> = {}
let sfxFiles: Record<string, string> = {}
try {
	sfxManifests = import.meta.glob<{ schema: number; faction: string; effects: Record<string, string> }>(
		'../../.forge/sfx/*/manifest.json', { eager: true, import: 'default' })
	sfxFiles = import.meta.glob<string>('../../.forge/sfx/*/*.{m4a,mp3}', { eager: true, query: '?url', import: 'default' })
} catch { /* Node harness: Vite glob unavailable */ }

/** faction -> slug -> clip URL. Banks with no resolvable clips are omitted. */
export const SFX_BANKS: Record<string, Record<string, string>> = {}
for (const [mkey, manifest] of Object.entries(sfxManifests)) {
	const base = mkey.slice(0, mkey.lastIndexOf('/'))
	const table: Record<string, string> = {}
	for (const [slug, file] of Object.entries(manifest.effects)) {
		const url = sfxFiles[`${base}/${file}`]
		if (url) table[slug] = url
	}
	if (Object.keys(table).length > 0) SFX_BANKS[manifest.faction] = table
}
