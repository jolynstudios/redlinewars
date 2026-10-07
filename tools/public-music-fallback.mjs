// Official songs are separate creative assets. The public sample uses silence
// at the same URLs, leaving the common soundtrack player unchanged.
export const PUBLIC_MUSIC_SHA256 = 'ed3b73e698379f6aafbfc652cd1075632c304993dd9761cd68c0de9c749b921a'
export const PUBLIC_MUSIC_FILES = Object.freeze([
	'mechanized-expansion', 'dusk-over-the-field', 'solo-mission', 'beyond-the-enemy-lines',
	'we-hold-the-line', 'hard-won-victory', 'quiet-burial',
].map(name => `art/music/${name}.m4a`))
export function writePublicMusicFallbacks(write, silentM4a) {
	for (const path of PUBLIC_MUSIC_FILES) write(path, silentM4a)
}

// The public UI omits the private HUD's SFX-bank loader. These two silent voice
// entries use the common EVA glob instead, exercising both packaged codecs.
export function writePublicVoiceFallbacks(write, silentM4a, silentMp3) {
	write('web/.forge/voices/allied/unit_ready.m4a', silentM4a)
	write('web/.forge/voices/allied/build_placed.mp3', silentMp3)
	write('web/.forge/voices/allied/manifest.json', Buffer.from(JSON.stringify({
		bank: 'allied', lines: { unit_ready: 'unit_ready.m4a', build_placed: 'build_placed.mp3' },
	}) + '\n'))
}
