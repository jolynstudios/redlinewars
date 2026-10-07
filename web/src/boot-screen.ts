// GPL-3.0-or-later — neutral loading status for the public source edition.
// These DOM ids also let the optional desktop launcher observe the shared AppBundle.
export interface BootScreen {
	progress(stage: string, fraction: number): { caption: string; shown: number }
	fail(error: unknown): void
	done(): void
}

export function createBootScreen(): BootScreen {
	let shown = 0
	const root = document.getElementById('boot')
	const meter = document.getElementById('boot-bar')
	document.getElementById('boot-retry')?.addEventListener('click', () => location.reload())
	return {
		progress(stage, fraction) {
			shown = Math.max(shown, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
			if (meter) meter.style.width = `${Math.round(shown * 100)}%`
			return { caption: stage.charAt(0).toUpperCase() + stage.slice(1), shown }
		},
		fail(error) {
			if (root) root.dataset.state = 'failed'
			const failure = document.getElementById('boot-fail')
			if (failure) failure.hidden = false
			const detail = document.getElementById('boot-fail-raw')
			if (detail) detail.textContent = error instanceof Error ? error.message : String(error)
		},
		done() {
			if (root) { root.dataset.state = 'ready'; root.classList.add('done'); root.hidden = true }
		},
	}
}
