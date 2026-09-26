// The desktop landing: intro, console, and every function the shell (main.mjs) calls.
//
// A classic script (file:// cannot load ES modules). Main calls, after the page loaded:
//   setLoader(state)  setLoaderProgress(pct, stage)  setPlayers(text)  setMusicIcon(on)
//   __redlineDonateStatus(status)  __redlineUpdateRequired(info)
//   __redlineMultiplayer({ on })  __redlineLandingVisible(bool)  __redlineOpenCredits()
// The query carries port, music, intro ('1' on a cold start only) and visible.
(() => {
	'use strict'
	const query = new URLSearchParams(location.search)
	const bridge = window.redline
	const $ = id => document.getElementById(id)
	const root = document.documentElement
	const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || root.dataset.motion === 'reduced'
	const safe = fn => { try { fn() } catch (err) { console.warn('[landing]', err) } }

	// ─── shell state at load (a rebuilt landing paints the right state at once) ───
	let shellState = {}
	try { shellState = bridge?.getShellStateSync?.() ?? {} } catch { shellState = {} }
	const port = query.get('port') ?? String(shellState.port ?? '')
	$('port-label').textContent = port || '—'
	const build = typeof shellState.build === 'string' ? shellState.build.slice(0, 8) : ''
	$('build-id').textContent = build || '—'
	$('app-version').textContent = shellState.version ? `v${shellState.version}` : ''

	// ─── music: the AppBundle's theme, only while the landing is on screen and past the studio card ───
	const audio = $('landing-music')
	const musicUrl = query.get('music')
	if (musicUrl) {
		audio.src = musicUrl
		audio.volume = 0
	}
	const soundBtn = $('sound-btn')
	let wantMusic = true
	let visible = query.get('visible') !== '0'
	let introStage = root.dataset.intro === 'run' ? 'studio' : 'done'
	let fade = 0
	const musicAllowed = () => wantMusic && visible && introStage !== 'studio'
	const applyMusic = () => {
		soundBtn.setAttribute('aria-pressed', String(wantMusic))
		soundBtn.querySelector('.sound__label').textContent = wantMusic ? 'Music on' : 'Music off'
		if (!musicUrl) return
		cancelAnimationFrame(fade)
		if (!musicAllowed()) {
			audio.pause()
			return
		}
		void audio.play().then(() => {
			// A 0.9 s fade to the game's default music volume.
			const start = performance.now()
			const from = audio.volume
			const step = now => {
				const t = Math.min(1, (now - start) / 900)
				audio.volume = from + (0.32 - from) * t
				if (t < 1) fade = requestAnimationFrame(step)
			}
			fade = requestAnimationFrame(step)
		}).catch(() => {})
	}
	window.setMusicIcon = on => { wantMusic = on === true; applyMusic() }
	window.__redlineLandingVisible = on => { visible = on === true; applyMusic() }
	soundBtn.addEventListener('click', () => bridge?.toggleMusic?.())
	try { wantMusic = (bridge?.getMusicSync?.() ?? 'on') !== 'off' } catch { wantMusic = true }

	// ─── engine loader (mirrored from the game page's meter) ───
	const loaderEl = $('loader')
	const loaderFill = $('loader-bar')
	const loaderPct = $('loader-pct')
	const loaderText = $('loader-text')
	const introFill = $('intro-fill')
	const introPct = $('intro-pct')
	const introStageText = $('intro-stage')
	const startCaption = $('start-caption')
	const boot = { state: 'laden', pct: 0, stage: '' }
	const clampPct = pct => Math.max(0, Math.min(100, Math.round(Number(pct) || 0)))
	const renderBoot = () => {
		const p = boot.state === 'klaar' ? 100 : boot.pct
		loaderFill.style.transform = `scaleX(${p / 100})`
		introFill.style.transform = `scaleX(${p / 100})`
		loaderPct.textContent = `${p}%`
		introPct.textContent = `${p}%`
		loaderEl.dataset.state = boot.state
		let text
		if (boot.state === 'klaar') text = 'Engine ready'
		else if (boot.state === 'wachten') text = 'Starting as soon as the engine is ready…'
		else if (boot.state === 'fout') text = 'The engine did not start — relaunch the app'
		else text = boot.stage || 'Loading the engine in the background…'
		loaderText.textContent = text
		introStageText.textContent = boot.state === 'klaar' ? 'Engine ready' : (boot.stage || 'Booting the engine')
		startCaption.textContent = boot.state === 'klaar' ? 'Engine ready' : boot.state === 'fout' ? 'Engine unavailable' : 'Starts the moment the engine is ready'
		startCaption.dataset.ready = String(boot.state === 'klaar')
	}
	window.setLoaderProgress = (pct, stage) => {
		boot.pct = Math.max(boot.pct, clampPct(pct))
		if (stage) boot.stage = String(stage)
		renderBoot()
	}
	window.setLoader = state => {
		boot.state = ['klaar', 'wachten', 'fout'].includes(state) ? state : 'laden'
		if (boot.state === 'laden') boot.stage = ''
		renderBoot()
	}
	const loaderAtLoad = shellState.loader
	if (loaderAtLoad && typeof loaderAtLoad === 'object') {
		boot.pct = clampPct(loaderAtLoad.pct)
		boot.stage = String(loaderAtLoad.stage ?? '')
		boot.state = ['klaar', 'wachten', 'fout'].includes(loaderAtLoad.state) ? loaderAtLoad.state : 'laden'
	}
	renderBoot()

	window.setPlayers = text => { $('players-value').textContent = String(text) }
	if (typeof shellState.players === 'string') window.setPlayers(shellState.players)

	// ─── actions ───
	$('start-skirmish').addEventListener('click', () => bridge?.start?.())
	$('start-multiplayer').addEventListener('click', () => bridge?.startMultiplayer?.())
	$('host-game').addEventListener('click', () => (bridge?.hostGame ? bridge.hostGame() : bridge?.startMultiplayer?.()))
	$('website-link').addEventListener('click', () => bridge?.openWebsite?.())

	// ─── multiplayer switch (default on; the shell stores it) ───
	const mpModule = $('mp-module')
	const mpSwitch = [...document.querySelectorAll('#mp-switch [data-mp]')]
	let mpOn = shellState.multiplayer !== false
	try { if (typeof bridge?.getMultiplayerSync === 'function') mpOn = bridge.getMultiplayerSync() !== false } catch {}
	const renderMp = () => {
		mpModule.dataset.mp = mpOn ? 'on' : 'off'
		for (const b of mpSwitch) {
			const on = (b.dataset.mp === 'on') === mpOn
			b.setAttribute('aria-checked', String(on))
			b.tabIndex = on ? 0 : -1
		}
		$('mp-on-body').inert = !mpOn
		$('rooms-row').hidden = !mpOn
	}
	window.__redlineMultiplayer = s => { mpOn = !(s && s.on === false); renderMp() }
	const setMp = async on => {
		if (on === mpOn || !bridge?.setMultiplayer) return
		for (const b of mpSwitch) b.disabled = true
		try { mpOn = (await bridge.setMultiplayer(on)) !== false } catch { /* keep what the shell reports */ }
		for (const b of mpSwitch) b.disabled = false
		renderMp()
	}
	for (const b of mpSwitch) b.addEventListener('click', () => void setMp(b.dataset.mp === 'on'))
	$('mp-switch').addEventListener('keydown', event => {
		if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
		event.preventDefault()
		const next = !mpOn
		mpSwitch.find(b => (b.dataset.mp === 'on') === next)?.focus()
		void setMp(next)
	})
	renderMp()

	// ─── host for others (the shell's donate capacity) ───
	const donateToggle = $('donate-toggle')
	const donateMax = $('donate-max')
	const donateStatus = $('donate-status')
	const donateDrain = $('donate-drain')
	const maxButtons = [...document.querySelectorAll('#donate-max-seg [data-max]')]
	const renderDonate = raw => {
		const s = raw || {}
		donateToggle.checked = s.enabled === true
		if (Number(s.maxMatches) >= 1) donateMax.value = String(Math.max(1, Math.min(2, Number(s.maxMatches))))
		for (const b of maxButtons) {
			const on = b.dataset.max === donateMax.value
			b.setAttribute('aria-checked', String(on))
			b.tabIndex = on ? 0 : -1
		}
		const count = `${Number(s.matches ?? 0)} ${Number(s.matches) === 1 ? 'match' : 'matches'} · ${Number(s.players ?? 0)} players`
		let text
		let tone
		if (s.multiplayerOff) { text = 'Multiplayer is off — turn it on to host for others.'; tone = 'off' }
		else if (s.draining) { text = `Finishing up — ${count}; no new matches.`; tone = 'warn' }
		else if (s.active) { text = `Hosting — ${count} (up to ${s.maxMatches ?? 1}).`; tone = 'ok' }
		else if (s.paused) { text = 'Paused while your own match is hosted here.'; tone = 'warn' }
		else if (s.starting) { text = 'Starting…'; tone = 'warn' }
		else if (s.error) { text = `Unavailable: ${s.error}`; tone = 'bad' }
		else if (s.enabled) { text = 'On — getting ready.'; tone = 'warn' }
		else { text = 'Off — your computer hosts only your own games.'; tone = 'off' }
		donateStatus.textContent = text
		donateStatus.dataset.tone = tone
		donateDrain.hidden = !s.active || s.draining === true
		$('mp-drain-note').hidden = !(s.draining && !mpOn)
		if (s.draining && !mpOn) $('mp-drain-note').textContent = `Hosting for others is finishing — ${count}.`
	}
	window.__redlineDonateStatus = renderDonate
	safe(() => renderDonate(shellState.donate ?? bridge?.getDonateConfigSync?.() ?? {}))
	donateToggle.addEventListener('change', async () => {
		donateToggle.disabled = true
		try { renderDonate(await bridge?.setDonateHosting?.({ enabled: donateToggle.checked })) }
		catch (err) { donateToggle.checked = !donateToggle.checked; renderDonate({ enabled: donateToggle.checked, error: String(err?.message || err) }) }
		finally { donateToggle.disabled = false }
	})
	const setMax = async value => {
		if (donateMax.value === value) return
		donateMax.value = value
		for (const b of maxButtons) b.disabled = true
		try { renderDonate(await bridge?.setDonateHosting?.({ maxMatches: Number(value) })) }
		catch (err) { renderDonate({ error: String(err?.message || err) }) }
		finally { for (const b of maxButtons) b.disabled = false }
	}
	for (const b of maxButtons) b.addEventListener('click', () => void setMax(b.dataset.max))
	donateDrain.addEventListener('click', async () => {
		try { renderDonate(await bridge?.drainDonateHosting?.()) } catch (err) { renderDonate({ error: String(err?.message || err) }) }
	})

	// ─── overlays: credits sheet and the S14 update dialog (focus trap, Esc, focus returns) ───
	const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
	const openOverlay = (el, initial) => {
		const opener = document.activeElement
		el.hidden = false
		requestAnimationFrame(() => (initial ?? el.querySelector(FOCUSABLE))?.focus())
		const close = () => {
			el.hidden = true
			el.removeEventListener('keydown', onKey)
			el.removeEventListener('pointerdown', onScrim)
			opener?.focus?.()
		}
		const onKey = event => {
			if (event.key === 'Escape') { event.preventDefault(); close(); return }
			if (event.key !== 'Tab') return
			const list = [...el.querySelectorAll(FOCUSABLE)].filter(f => f.getClientRects().length > 0)
			if (!list.length) return
			const at = list.indexOf(document.activeElement)
			if (event.shiftKey && at <= 0) { event.preventDefault(); list[list.length - 1].focus() }
			else if (!event.shiftKey && at === list.length - 1) { event.preventDefault(); list[0].focus() }
		}
		const onScrim = event => { if (event.target === el) close() }
		el.addEventListener('keydown', onKey)
		el.addEventListener('pointerdown', onScrim)
		return close
	}

	const credits = $('credits-sheet')
	const legalView = $('legal-view')
	let closeCredits = null
	const openCredits = () => {
		if (!credits.hidden) return
		legalView.hidden = true
		closeCredits = openOverlay(credits, $('credits-close'))
	}
	window.__redlineOpenCredits = () => { if (introStage !== 'done') finishIntro(); openCredits() }
	$('credits-open').addEventListener('click', openCredits)
	$('footer-credits').addEventListener('click', openCredits)
	$('credits-close').addEventListener('click', () => closeCredits?.())
	$('credits-web').addEventListener('click', () => bridge?.openWebsite?.('credits'))
	$('report-bug').addEventListener('click', () => bridge?.openWebsite?.('issues'))
	for (const b of document.querySelectorAll('[data-legal]')) {
		b.addEventListener('click', async () => {
			let text = null
			try { text = await bridge?.legalText?.(b.dataset.legal) } catch { text = null }
			legalView.textContent = typeof text === 'string' ? text : 'This text is not available in this build.'
			legalView.hidden = false
			legalView.scrollTop = 0
		})
	}

	const updateModal = $('update-modal')
	let closeUpdate = null
	window.__redlineUpdateRequired = info => {
		const url = info && typeof info.downloadUrl === 'string' ? info.downloadUrl : ''
		updateModal.dataset.downloadUrl = url
		$('update-download').hidden = !url
		const own = info && typeof info.own === 'string' ? info.own.slice(0, 8) : ''
		const wanted = info && Array.isArray(info.accepted) ? info.accepted.map(b => String(b).slice(0, 8)).join(', ') : ''
		const builds = $('update-builds')
		builds.textContent = own && wanted ? `Jouw versie ${own} · online vereist ${wanted}` : ''
		builds.hidden = !builds.textContent
		if (updateModal.hidden) closeUpdate = openOverlay(updateModal, $('update-close'))
	}
	$('update-download').addEventListener('click', () => {
		const url = updateModal.dataset.downloadUrl
		if (url) bridge?.openDownload?.(url)
	})
	$('update-close').addEventListener('click', () => closeUpdate?.())

	// ─── intro: studio card → title card → hand-off into the landing ───
	const app = $('app')
	const intro = $('intro')
	const timers = []
	let finished = false
	const later = (ms, fn) => timers.push(setTimeout(() => safe(fn), ms))
	function finishIntro(skipped = false) {
		if (finished) return
		finished = true
		for (const t of timers) clearTimeout(t)
		introStage = 'done'
		root.dataset.intro = skipped ? 'skip' : 'handoff'
		app.inert = false
		const settle = () => {
			root.dataset.intro = 'done'
			intro.hidden = true
			// A keyboard skip hands the keyboard to Start — after the key is released, so the
			// skip can never start a match. Mouse users and a natural end keep a clean screen.
			if (skippedByKey) focusStart()
		}
		setTimeout(() => safe(settle), skipped ? 200 : reducedMotion() ? 150 : 600)
		applyMusic()
	}
	let keyHeld = false
	let skippedByKey = false
	const focusStart = () => {
		if (keyHeld) { window.addEventListener('keyup', () => setTimeout(focusStart, 0), { once: true }); return }
		if (!document.activeElement || document.activeElement === document.body) $('start-skirmish').focus({ preventScroll: true })
	}
	if (introStage === 'studio') {
		app.inert = true
		const skip = event => {
			if (introStage === 'done') return
			if (event.type === 'keydown') {
				keyHeld = true
				skippedByKey = true
				window.addEventListener('keyup', () => { keyHeld = false }, { once: true })
			}
			event.preventDefault()
			event.stopPropagation()
			finishIntro(true)
		}
		window.addEventListener('keydown', skip, { capture: true, once: true })
		intro.addEventListener('pointerdown', skip, { once: true })
		const run = () => {
			try {
				// One layout read: where the title card's wordmark must land in the hero.
				const from = $('intro-wordmark').getBoundingClientRect()
				const to = $('hero-wordmark').getBoundingClientRect()
				if (from.width > 0 && to.width > 0) {
					const s = to.width / from.width
					intro.style.setProperty('--hx', `${to.left + to.width / 2 - (from.left + from.width / 2)}px`)
					intro.style.setProperty('--hy', `${to.top + to.height / 2 - (from.top + from.height / 2)}px`)
					intro.style.setProperty('--hs', String(s))
				}
			} catch { intro.classList.add('intro--fade') }
			root.dataset.intro = 'studio'
			const reduced = reducedMotion()
			later(reduced ? 1500 : 1900, () => { introStage = 'title'; root.dataset.intro = 'title'; applyMusic() })
			later(reduced ? 3000 : 4050, () => finishIntro(false))
		}
		// The faces are local; wait for them briefly so the words do not reflow mid-animation.
		Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 400))]).then(() => safe(run))
		window.addEventListener('resize', () => intro.classList.add('intro--fade'), { once: true })
	} else {
		intro.hidden = true
		root.dataset.intro = 'done'
	}
	applyMusic()
})()
