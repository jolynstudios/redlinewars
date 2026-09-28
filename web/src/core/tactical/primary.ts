import { encodeFrame } from './transport'
import type { TacticalState } from './model'
import { HeaderFlag } from '../snapshot'
import type { Ctx } from '../ctx'
import { loadCompanionConfig } from '../net-config'
import { executeIntent, type CompanionIntent } from './commands'
import { TacticalModel, type Permission } from './model'
import { drawQr } from './qr'
import './style.css'
import { joaMark } from './logo'
import { tauntById, type Taunt } from './taunts'
import { requestById, type Ask } from './requests'

/** One opt-in connection for the primary game. All simulation commands remain on Ctx. */
export class PrimaryCompanion {
	private ws: WebSocket | null = null
	private session = ''
	private sequence = 0
	private generation = 0
	private tier: Permission = 'information'
	private paused = false
	private epoch = 0
	private primarySequence = 0
	private pending = false
	private linked = false
	private endedNoted = false
	/** Rises with every world the primary loads: one pairing follows many battles. */
	private matchEpoch = 0
	private seen = new Set<string>()
	private model = new TacticalModel()
	private previous: TacticalState | null = null
	private timer: number | null = null
	private panel: HTMLDialogElement
	private status: HTMLElement
	private code: HTMLElement
	private qr: HTMLCanvasElement
	private permission: HTMLSelectElement
	private approve: HTMLButtonElement
	/** Shares the pairing page URL that carries the one-time secret, next to the QR. */
	private share: HTMLButtonElement
	private shareUrl = ''
	private trigger: HTMLButtonElement
	/** Whether the companion service exists for this deployment: the HUD pill and the tutorial
	 * both care, and neither wants to wait for the first dialog open to find out. */
	private serviceEnabled = false
	/** The command bar's JOA entry on the menu screen: the same pairing dialog, always visible. */
	private barButton: HTMLButtonElement | null = null
	private openBar = (): void => { this.panel.showModal() }
	private syncBar = (): void => {
		if (!this.barButton) return
		const state = this.barButton.querySelector('#session-joa-state')
		if (this.linked) { this.barButton.dataset.linked = ''; if (state) state.textContent = 'Linked' }
		else { delete this.barButton.dataset.linked; if (state) state.textContent = '' }
	}
	private dispose: (() => void)[] = []
	constructor(private ctx: Ctx, private groups: () => ReadonlyMap<number, number[]>, private network: () => boolean, private identity: () => Promise<{roomId:string;nonce:string}|null>, private onTaunt: (taunt: Taunt) => void = () => {}, private onRequest: (ask: Ask) => void = () => {}) {
		this.panel = document.createElement('dialog'); this.panel.className = 'joa-pair'; this.panel.setAttribute('aria-label', 'JOA companion connection')
		this.panel.innerHTML = `<div class="joa-pair-head">${joaMark(40)}<div><p class="joa-kicker">Joint Operations Assistant</p><h2>JOA companion</h2></div><button data-close aria-label="Close">×</button></div><p data-status role="status">Scan the code with a phone or tablet to follow and support your battle. You stay in command.</p><div class="joa-pair-scan"><canvas data-qr aria-label="Scan to connect"></canvas><strong data-code></strong><button data-share hidden>Send link</button></div><label>Device permission<select data-tier><option value="information">Spectator · view only</option><option value="support">Technician · repairs and support weapons</option><option value="command">Commander · groups and aircraft</option></select></label><div class="joa-pair-actions"><button data-connect>Connect a device</button><button data-approve hidden>Approve device</button><button data-decline hidden>Decline</button><button data-pause>Pause companion control</button><button data-disconnect>Disconnect</button></div>`
		this.status = this.panel.querySelector('[data-status]')!; this.code = this.panel.querySelector('[data-code]')!; this.qr = this.panel.querySelector('[data-qr]')!; this.permission = this.panel.querySelector('[data-tier]')!; this.approve = this.panel.querySelector('[data-approve]')!; this.share = this.panel.querySelector('[data-share]')!
		this.qr.hidden = true; document.body.append(this.panel)
		this.trigger = document.createElement('button'); this.trigger.className = 'hud-action joa-trigger'; this.trigger.innerHTML = `${joaMark(22, '')}<span class="joa-trigger__dot" aria-hidden="true"></span><span class="joa-trigger__label">Companion</span><span class="joa-trigger__cut" role="button" aria-label="Disconnect companion">×</span>`; this.trigger.setAttribute('aria-label', 'Companion'); this.trigger.title = 'Companion · connect a phone or tablet with JOA'; this.trigger.setAttribute('aria-haspopup', 'dialog'); this.trigger.onclick = () => this.panel.showModal()
		// The cut severs the link in one tap, without opening the pairing console.
		this.trigger.querySelector<HTMLElement>('.joa-trigger__cut')!.addEventListener('click', event => { event.stopPropagation(); if (this.linked) this.disconnect() })
		;(document.getElementById('hud-controls') ?? document.body).prepend(this.trigger)
		void loadCompanionConfig().then(config => { this.serviceEnabled = !!(config.companionEnabled && config.companionOrigin) })
		this.syncTrigger()
		// The menu screen keeps JOA in the command bar itself, not only behind the settings sheet.
		this.barButton = document.getElementById('session-joa-open') as HTMLButtonElement | null
		if (this.barButton) {
			const mark = this.barButton.querySelector('#session-joa-mark')
			if (mark) mark.innerHTML = joaMark(18, '')
			this.barButton.addEventListener('click', this.openBar)
			this.panel.addEventListener('close', this.syncBar)
			this.syncBar()
		}
		this.panel.querySelector<HTMLButtonElement>('[data-close]')!.onclick = () => this.panel.close()
		this.panel.querySelector<HTMLButtonElement>('[data-connect]')!.onclick = () => { void this.connect() }
		// The QR encodes this same URL; sharing it lets a friend join without typing
		// the code. The five-minute expiry and the approval step both still apply.
		this.share.onclick = () => {
			if (!this.shareUrl) return
			if (navigator.share) void navigator.share({ title: 'Join my battle with JOA', url: this.shareUrl }).catch(() => {})
			else void navigator.clipboard?.writeText(this.shareUrl).then(
				() => { this.status.textContent = 'Link copied. It opens the companion with the code filled in and expires in five minutes.' },
				() => { this.status.textContent = 'Copy failed. Enter the code on the companion page instead.' })
		}
		this.approve.onclick = () => { this.tier = this.permission.value as Permission; this.send({ type: 'approve', accept: true, tier: this.tier }); this.pending = false; this.approve.hidden = true; delete this.approve.dataset.attention; this.panel.querySelector<HTMLElement>('[data-decline]')!.hidden = true; this.syncTrigger() }
		this.panel.querySelector<HTMLButtonElement>('[data-decline]')!.onclick = () => { this.send({ type: 'approve', accept: false, tier: this.permission.value }); this.pending = false; this.approve.hidden = true; delete this.approve.dataset.attention; this.panel.querySelector<HTMLElement>('[data-decline]')!.hidden = true; this.syncTrigger() }
		this.permission.onchange = () => { if (!this.pending) { this.tier = this.permission.value as Permission; this.send({ type: 'permission', tier: this.tier }); this.syncTrigger() } }
		this.panel.querySelector<HTMLButtonElement>('[data-disconnect]')!.onclick = () => this.disconnect()
		this.panel.querySelector<HTMLButtonElement>('[data-pause]')!.onclick = event => { this.paused = !this.paused; (event.currentTarget as HTMLButtonElement).textContent = this.paused ? 'Resume companion control' : 'Pause companion control'; this.send({ type: 'pause', paused: this.paused }); this.syncTrigger() }
		// A new world is the next battle, not the end of the pairing: reset the projection and
		// keep the link, so the companion follows straight into the next match. publish() still
		// refuses a world whose host disabled companions.
		this.dispose.push(ctx.events.on('session:new-world', () => { this.model.reset(); this.previous = null; this.matchEpoch++; this.endedNoted = false; if (this.linked && this.timer !== null) this.status.textContent = 'Battle starting…' }), ctx.events.on('presentation:primary-order', () => { this.epoch++; this.primarySequence=this.sequence }))
	}
	private send(message: unknown): boolean { if (this.ws?.readyState !== WebSocket.OPEN || this.ws.bufferedAmount >= 512 * 1024) return false; this.ws.send(JSON.stringify(message)); return true }
	/** The settings sheet and the HUD button share one pairing dialog. Pairing with no battle
	 * running is the intended path: the link stands by and joins the next world. */
	open(): void { this.panel.showModal() }
	isLinked(): boolean { return this.linked }
	/** The tutorial's companion step needs the service's existence, not a live device. */
	hudAvailable(): boolean { return this.serviceEnabled }
	/** The HUD trigger is also the link's status pill: it names the tier the device carries,
	 * glows with the link's state, and its cut severs the link in one tap. */
	private tierLabel(): string { return this.tier === 'information' ? 'Spectator' : this.tier === 'support' ? 'Technician' : 'Commander' }
	private syncTrigger(): void {
		const state = this.linked ? this.paused ? 'paused' : 'linked' : this.pending ? 'pending' : ''
		if (state) this.trigger.dataset.state = state; else delete this.trigger.dataset.state
		this.trigger.querySelector<HTMLElement>('.joa-trigger__label')!.textContent = this.linked ? this.tierLabel() : this.pending ? 'Device' : 'Companion'
		this.trigger.setAttribute('aria-label', this.linked ? `Companion · linked · ${this.tierLabel()}` : 'Companion')
		this.trigger.title = this.linked ? `Companion · ${this.tierLabel()} linked · × disconnects` : 'Companion · connect a phone or tablet with JOA'
		this.trigger.querySelector<HTMLElement>('.joa-trigger__cut')!.setAttribute('aria-hidden', String(!this.linked))
	}
	private async connect(): Promise<void> {
		this.disconnect(); const generation=this.generation
		const admission = this.network() ? await this.identity() : null
		if(generation!==this.generation)return
		if (this.network() && !admission) { this.status.textContent = 'Your active game connection cannot authorize a companion.'; return }
		const config = await loadCompanionConfig()
		if(generation!==this.generation)return
		if (!config.companionEnabled || !config.companionOrigin) { this.status.textContent = 'JOA companion service is unavailable. Your main game continues normally.'; return }
		const endpoint = new URL('/v2/companion/ws', config.companionOrigin); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
		this.status.textContent = 'Connecting to JOA…'; const ws = new WebSocket(endpoint); this.ws = ws
		ws.onopen = () => this.send({ type: 'create', kind: this.network() ? 'hosted' : 'skirmish', ...admission })
		ws.onmessage = event => { let m; try { m = JSON.parse(event.data) } catch { return }
			if (m.type === 'created') { this.session = m.id; this.code.textContent = m.code; this.qr.hidden = false; const page = new URL('companion.html', config.companionPageOrigin ?? location.href); page.hash = `p=${m.secret}`; this.shareUrl = page.href; this.share.hidden = false; try { drawQr(this.qr, page.href) } catch { this.qr.hidden = true }; this.status.textContent = 'Scan the QR code, send the link, or enter this code on the companion page. Code expires in five minutes.'; this.timer = window.setInterval(() => this.publish(), 200) }
			else if (m.type === 'approval') { this.pending = true; this.status.textContent = `${m.label} wants to connect. Choose a permission, then approve.`; this.approve.hidden = false; this.approve.dataset.attention = ''; this.panel.querySelector<HTMLElement>('[data-decline]')!.hidden = false; this.syncTrigger(); if (!this.panel.open) this.panel.showModal() }
			else if (m.type === 'connected') { this.linked = true; this.qr.hidden = true; this.code.textContent = ''; this.share.hidden = true; this.shareUrl = ''; this.status.textContent = 'Companion connected. You remain in command.'; this.syncTrigger(); this.syncBar(); if (this.panel.open) this.panel.close() }
			else if (m.type === 'need-baseline') this.previous=null
			else if (m.type === 'intent') { const epoch = this.epoch; window.setTimeout(() => { void this.command(m.intent, m.tier, epoch) }, 0) }
			else if (m.type === 'taunt') { const taunt = tauntById(m.taunt); if (taunt) this.onTaunt(taunt) }
			else if (m.type === 'request') { const ask = requestById(m.request); if (ask) this.onRequest(ask) }
			else if (m.type === 'error' || m.type === 'ended') this.status.textContent = m.reason
			else if (m.type === 'detached') this.status.textContent = 'Companion disconnected. Waiting briefly for it to return.'
		}
		ws.onerror = () => { this.status.textContent = 'Could not connect. Check your internet connection and try again.' }
		ws.onclose = () => { if (this.ws === ws) { this.disconnect(); this.status.textContent = 'JOA connection closed. Your main game is still in control.' } }
	}
	private publish(): void {
		const snap = this.ctx.snapshot
		// Between battles (menu, loading): keep the pairing warm with heartbeats only.
		if (!snap?.world) { if (this.linked) this.status.textContent = 'Companion standing by. It joins your next battle automatically.'; this.send({ type: 'heartbeat' }); return }
		// Checked per world, so a later match that forbids companions still ends the link.
		if ((snap.flags & HeaderFlag.companionAllowed) === 0) { this.disconnect(); this.status.textContent = 'JOA support commanders are disabled for this match.'; return }
		const state = this.model.project(this.ctx, this.groups(), this.session, ++this.sequence, this.matchEpoch)
		if (!state) { this.send({ type: 'heartbeat' }); return }
		if (state.ended && !this.endedNoted) {
			this.endedNoted = true
			this.status.textContent = (state.outcome === 'victory' ? 'Victory.' : state.outcome === 'defeat' ? 'Defeat.' : 'Battle concluded.') + ' The result is on the companion screen; the link waits for your next battle.'
		}
		if (this.ctx.simHealth.stalled) state.paused = true
		if (this.send({ type: 'state', state: encodeFrame(state, this.previous) })) this.previous = state; this.send({ type: 'heartbeat' })
	}
	private async command(intent: CompanionIntent, tier: Permission, epoch: number): Promise<void> {
		if (!intent || typeof intent.id !== 'string' || !this.ws) return
		if (this.ctx.simHealth.stalled || this.paused || tier !== this.tier || epoch !== this.epoch || intent.sequence<=this.primarySequence || this.seen.has(intent.id)) { this.send({type:'result',id:intent.id,status:'rejected',reason: epoch !== this.epoch || intent.sequence<=this.primarySequence ? 'Main commander issued a newer order' : 'Control paused, permission changed, or request already processed'}); return }
		this.seen.add(intent.id); if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!)
		const state = this.model.project(this.ctx, this.groups(), this.session, this.sequence)
		if (!state) return
		const result = await executeIntent(this.ctx, intent, state, this.tier)
		this.send({ type: 'result', id: intent.id, status: result.startsWith('ok') ? 'submitted' : 'rejected', reason: result })
	}
	disconnect(): void { this.generation++; this.send({ type: 'revoke' }); const ws = this.ws; this.ws = null; ws?.close(); if (this.timer !== null) clearInterval(this.timer); this.timer = null; this.session = ''; this.sequence = 0; this.primarySequence=0; this.seen.clear(); this.model.reset(); this.previous = null; this.paused = false; this.pending = false; this.linked = false; this.endedNoted = false; this.qr.hidden = true; this.code.textContent = ''; this.share.hidden = true; this.shareUrl = ''; this.approve.hidden = true; delete this.approve.dataset.attention; this.panel.querySelector<HTMLElement>('[data-decline]')!.hidden = true; this.panel.querySelector<HTMLButtonElement>('[data-pause]')!.textContent = 'Pause companion control'; this.syncTrigger(); this.syncBar(); this.status.textContent = 'Disconnected. Connect a device when you are ready.' }
	stop(): void { this.disconnect(); this.dispose.forEach(fn => fn()); this.panel.remove(); this.trigger.remove(); this.barButton?.removeEventListener('click', this.openBar); this.barButton = null }
}
