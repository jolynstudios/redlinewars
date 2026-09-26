// STEELSEED — ui/tutorial-steps
// The first-match tutorial's content and rules, free of the DOM so the tests can run them:
// which steps exist, when a step is done, what its live status line says, and whether the
// tutorial may start at all. The build steps come from ui/build-order (the manifest).

import type { BuildOrder, BuildStep } from './build-order'

export const TUTORIAL_STORAGE_KEY = 'redline-tutorial'

/** One structure in the player's Structures/Defense queues, by actor type. */
export interface QueueItemState {
	readonly buildable: boolean
	readonly current: boolean
	readonly ready: boolean
	readonly queued: number
	/** 0–100 while current. */
	readonly progress: number
}

/** What the tutorial reads from the match each tick. */
export interface TutorialWorld {
	/** Actor type → how many the local player owns. */
	readonly owned: ReadonlyMap<string, number>
	/** The Structures/Defense queue items, by actor type; empty until a Construction Yard works. */
	readonly queue: ReadonlyMap<string, QueueItemState>
	readonly powerDrawn: number
	readonly powerSupplied: number
}

export type StepKind = 'welcome' | 'deploy' | 'economy' | 'production' | 'build' | 'power' | 'later' | 'army' | 'minimap' | 'controls'

export interface TutorialStep {
	readonly id: string
	readonly kind: StepKind
	readonly title: string
	readonly body: string
	/** CSS selector of the HUD element the ring shows; null centres the card. */
	readonly target: string | null
	/** Build steps: the structure, its place in the order and the owned count that completes it. */
	readonly build?: BuildStep & { readonly index: number; readonly total: number }
}

export interface TutorialStatus {
	readonly state: 'locked' | 'idle' | 'building' | 'ready' | 'done'
	readonly text: string
}

const money = (value: number): string => `$${value.toLocaleString('en-US')}`
const power = (value: number): string => value > 0 ? `+${value} power` : `${value} power`

/** One plain sentence on what a building is for, from its manifest role. */
export function purpose(step: BuildStep): string {
	if (step.role === 'power')
		return step.count > 1 ? 'A second one: the next building would push your power into the red.' : 'Every other building needs power.'
	if (step.role === 'economy')
		return step.freeUnit ? `Turns ore into credits, and a free ${step.freeUnit} comes with it: your income.` : 'Turns ore into credits: your income.'
	if (step.role === 'production') {
		const kind = step.produces[0]
		return kind === 'Infantry' ? 'Trains infantry.' : kind === 'Vehicle' ? 'Builds tanks and other vehicles.'
			: kind === 'Aircraft' ? 'Builds aircraft.' : kind === 'Ship' ? 'Builds ships.' : 'Adds a production queue.'
	}
	if (step.radar && step.reveal > 0)
		return `Radar: uncovers the ground ${Math.round(step.reveal)} cells around it${step.unlocks.length > 0 ? `, and unlocks ${joinNames(step.unlocks)}` : ''}.`
	return step.unlocks.length > 0 ? `Unlocks ${joinNames(step.unlocks)}.` : 'Opens the next tier of buildings.'
}

function joinNames(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? ''
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The facts line of a build card: cost · power · needs. */
export function facts(step: BuildStep): string {
	const parts = [money(step.cost), power(step.power)]
	if (step.needs.length > 0) parts.push(`needs ${joinNames(step.needs)}`)
	return parts.join(' · ')
}

export function tutorialSteps(order: BuildOrder, options: { readonly multiplayer: boolean }): TutorialStep[] {
	const steps: TutorialStep[] = [
		{
			id: 'welcome', kind: 'welcome', target: null,
			title: 'Welcome, Commander',
			body: 'A quick tour of the HUD and a proven build order. The match keeps running while you read, and you can skip whenever you like.',
		},
		{
			id: 'deploy', kind: 'deploy', target: '#hud-deploy',
			title: 'Deploy your MCV',
			body: options.multiplayer
				? 'Click your Mobile Construction Vehicle, the big truck at your start, then click Deploy / expand. It unpacks into a Construction Yard, which builds every structure.'
				: 'Your Mobile Construction Vehicle is selected. Click Deploy / expand: it unpacks into a Construction Yard, which builds every structure.',
		},
		{
			id: 'economy', kind: 'economy', target: '#hud-economy',
			title: 'Credits and power',
			body: 'Credits pay for everything; ore your trucks deliver counts as credits. Power reads drawn / supplied: when drawn is higher, production slows down.',
		},
		{
			id: 'production', kind: 'production', target: '#hud-production',
			title: 'Build from here',
			body: 'Click a building to start it. When it says READY · PLACE, click it (or its card above the compass), then click open ground near your base: green cells fit. Esc or right click cancels.',
		},
	]
	order.core.forEach((build, index) => steps.push({
		id: `build-${index}`, kind: 'build', target: `#hud-queues .hud-item[data-actor-name="${build.type}"]`,
		title: build.count > 1 ? `${build.name} (second)` : build.name,
		body: purpose(build),
		build: { ...build, index, total: order.core.length },
	}))
	const advanced = order.later.find(step => step.role === 'power')
	steps.push({
		id: 'power', kind: 'power', target: '#hud-economy .hud-power-stat',
		title: 'Keep the power up',
		body: `Every building draws power. When the Power numbers turn red, build another Power Plant${advanced ? `; the ${advanced.name} (${power(advanced.power)}) opens after ${joinNames(advanced.needs)}` : ''}.`,
	})
	if (order.later.length > 0)
		steps.push({
			id: 'later', kind: 'later', target: '#hud-production',
			title: 'What comes next',
			body: order.later.map(step => `${step.name}: ${step.role === 'power' ? power(step.power) : purpose(step).replace(/\.$/, '').toLowerCase()}${step.needs.length ? `, needs ${joinNames(step.needs)}` : ''}.`).join(' '),
		})
	steps.push(
		{
			id: 'army', kind: 'army', target: '#hud-selection',
			title: 'Command your army',
			body: 'Left click or drag to select and box select. Right click to command: move, attack, capture. Ctrl + right click forces fire.',
		},
		{
			id: 'minimap', kind: 'minimap', target: '#hud-overview',
			title: 'The minimap',
			body: 'Click it to move the camera; right click it to send the selected units there. H flies the camera home to your base.',
		},
		{
			id: 'controls', kind: 'controls', target: '#hud-controls',
			title: 'Menu and Keys',
			body: 'Menu pauses a skirmish, changes settings and replays this tutorial. Keys lists every control. Good luck, Commander.',
		},
	)
	return steps
}

/** A Construction Yard counts once its queue works: it unpacks before it can build. */
export function stepComplete(step: TutorialStep, world: TutorialWorld): boolean {
	if (step.kind === 'deploy') return (world.owned.get('fact') ?? 0) > 0 && world.queue.size > 0
	if (step.kind === 'build' && step.build) return (world.owned.get(step.build.type) ?? 0) >= step.build.count
	return false
}

/** A build step whose structure the queue never offers (tech level, rules) is skipped. */
export function stepUnavailable(step: TutorialStep, world: TutorialWorld): boolean {
	return step.kind === 'build' && step.build !== undefined && world.queue.size > 0 && !world.queue.has(step.build.type)
}

/** The live line under a build card. */
export function buildStatus(step: TutorialStep, world: TutorialWorld): TutorialStatus {
	const build = step.build
	if (!build) return { state: 'idle', text: '' }
	if (stepComplete(step, world)) return { state: 'done', text: `✓ ${build.name} built` }
	const item = world.queue.get(build.type)
	if (!item) return { state: 'locked', text: world.queue.size === 0 ? 'Deploy your MCV first.' : `Unlocks after ${joinNames(build.needs)}.` }
	if (item.ready) return { state: 'ready', text: 'Ready: click it, then click open ground near your base.' }
	if (item.current) return { state: 'building', text: `Building… ${Math.max(0, Math.min(100, Math.round(item.progress)))}%` }
	if (!item.buildable) return { state: 'locked', text: `Unlocks after ${joinNames(build.needs)}.` }
	return { state: 'idle', text: `Click ${build.name} in the build list to start it.` }
}

export function lowPower(world: TutorialWorld): boolean {
	return world.powerDrawn > world.powerSupplied
}

/** Storage may be missing or throw (private mode, blocked site data): never break the match. */
export function tutorialDone(storage: Pick<Storage, 'getItem'> | null | undefined): boolean {
	try { return storage?.getItem(TUTORIAL_STORAGE_KEY) === 'done' } catch { return false }
}

export function markTutorialDone(storage: Pick<Storage, 'setItem'> | null | undefined): void {
	try { storage?.setItem(TUTORIAL_STORAGE_KEY, 'done') } catch { /* not persisted: it may show again */ }
}

/**
 * `?tutorial=on` forces it (and replays ignore the flag); `?tutorial=off` and automated
 * browsers (every Playwright gate reports navigator.webdriver) never see it on their own.
 */
export function tutorialMode(search: string, webdriver: boolean): 'on' | 'off' | 'auto' {
	const value = new URLSearchParams(search).get('tutorial')
	if (value === 'on') return 'on'
	if (value === 'off' || webdriver) return 'off'
	return 'auto'
}

export function shouldAutoStart(search: string, webdriver: boolean, storage: Pick<Storage, 'getItem'> | null | undefined): boolean {
	const mode = tutorialMode(search, webdriver)
	return mode === 'on' || (mode === 'auto' && !tutorialDone(storage))
}
