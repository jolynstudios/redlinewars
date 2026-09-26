#!/usr/bin/env node
// Protect RTS drag selection, group rings and camera/order selection synchronisation.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const TOOL = 'selectiongate'
const webRoot = resolve(import.meta.dirname, '..')
const ui = readFileSync(resolve(webRoot, 'src/ui/index.ts'), 'utf8')
const camera = readFileSync(resolve(webRoot, 'src/camera/index.ts'), 'utf8')
const input = readFileSync(resolve(webRoot, 'src/core/input.ts'), 'utf8')
const units = readFileSync(resolve(webRoot, 'src/units/index.ts'), 'utf8')
const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8')
const manifest = JSON.parse(readFileSync(resolve(webRoot, 'src/core/ra-visual-manifest.json'), 'utf8'))

const failures = []
const fail = message => failures.push(message)
const uiWitnesses = [
	['drag threshold', 'DRAG_SELECT_THRESHOLD_PX'],
	['visible SVG selection box', "document.createElementNS(SVG_NAMESPACE, 'rect')"],
	['held-button drag rendering', 'this.selectionDragged && (pointer.buttons & 1) !== 0'],
	['release-time selection', '(pointer.released & 1) === 0'],
	['local ownership filter', 'actors.owner[i] !== this.renderPlayerId'],
	['mobile actor filter', 'units.groupSelectable(actorName)'],
	['shift-additive selection', 'const additive = (modifiers & 2) !== 0'],
	['release-captured select modifier', 'if (event.button === 0) this.selectModifiers = modifierBits(event)'],
	['key-state fallback for additive select', ': this.pointerModifiers(ctx)'],
	['per-actor group rings', 'for (let s = 0; s < this.selected.length && count < MAX_SELECTION; s++)'],
	['camera/order selection sync', "ctx.get<CameraApi>('camera').selectActors(this.selected)"],
]
for (const [label, witness] of uiWitnesses)
	if (!ui.includes(witness)) fail(`UI lost ${label} witness`)

for (const [label, witness] of [
	['pointer capture', 'canvas.setPointerCapture(e.pointerId)'],
	['release capture outside canvas', 'this.pendingReleased |= bit'],
]) if (!input.includes(witness)) fail(`input lost ${label} witness`)

if (!camera.includes('selectActors(actorIds: readonly number[])') || !camera.includes('this.selection.push(actorId)'))
	fail('camera no longer accepts the complete UI-resolved group for contextual orders')
if (!units.includes("entry?.renderable === true && entry.role === 'unit'"))
	fail('units no longer classifies drag-selectable actors from the resolved visual manifest')
if (html.includes('#hud-selection { display: none; }'))
	fail('responsive layout hides selection feedback and deploy controls')

const mobile = Object.values(manifest.actors ?? {}).filter(actor => actor.renderable && actor.role === 'unit')
if (mobile.length !== 82)
	fail(`resolved mobile selection corpus drifted: ${mobile.length}, expected 82`)

if (failures.length > 0) {
	for (const failure of failures) console.error(`  ${failure}`)
	console.error(`${TOOL}: FAIL — drag/group selection drifted`)
	process.exit(1)
}

console.log(`${TOOL}: PASS — visible drag box selects ${mobile.length} local mobile actor types, preserves shift groups and synchronises orders`)
