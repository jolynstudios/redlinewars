// STEELSEED — boot-sound
// The menu song ("Cold Start") starts with the loading bar and carries on into the menus
// (owner, 2026-09-25): the audio node later adopts the same player (audio/music sharedMusic),
// so nothing restarts. Browsers refuse sound until the first click or key on the page; then
// the loader shows a "Sound on" chip and the first gesture anywhere starts the song.

export interface BootSoundtrack {
	isEnabled(): boolean
	unlock(): Promise<boolean>
}

export function startBootSoundtrack(music: BootSoundtrack, chip: HTMLElement | null): void {
	// Muted on purpose (menu or M, remembered): the loader stays silent and says nothing.
	if (!music.isEnabled()) return
	void music.unlock().then(playing => {
		if (playing) return
		if (chip) chip.hidden = false
		const onGesture = (): void => {
			void music.unlock().then(started => {
				if (!started) return
				if (chip) chip.hidden = true
				document.removeEventListener('pointerdown', onGesture, true)
				document.removeEventListener('keydown', onGesture, true)
			})
		}
		document.addEventListener('pointerdown', onGesture, true)
		document.addEventListener('keydown', onGesture, true)
	})
}
