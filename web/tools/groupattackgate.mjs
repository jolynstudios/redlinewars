// STEELSEED — a group's attack on a building (owner report, 2026-09-26: "with multiple units
// selected I cannot attack a building; some buildings offer C4 or a spy; the troops go to the
// other side, as if I clicked a nearby building").
//
// A real match. Our group is three tanks, two riflemen, an engineer, a spy and Tanya; the target
// is the enemy's construction yard. At five points over the yard (its roof and its walls):
//   - the pointer's target is the yard;
//   - the cursor is the attack: a group with anyone who attacks shows the attack, whatever an
//     engineer, spy or Tanya in it could also do (each still takes its own OpenRA order).
// A right click on the roof orders the group, every subject answered by OpenRA, the attack among
// them, and the order's cell is on the yard's footprint: a subject with no order of its own on the
// yard (the spy: a construction yard cannot be infiltrated) moves to the yard, not to the ground
// behind it. A lone engineer over the yard still shows its capture.
//
//   node tools/groupattackgate.mjs   (from web/, after `vite build` and compose)
import assert from 'node:assert/strict'
import { openLiveMatch } from './live-match.mjs'

const m = await openLiveMatch({ tool: 'groupattackgate', port: 8481, viewport: { width: 1600, height: 900 }, quality: 'high' })
try {
	await m.devAll()
	await m.yard()
	await m.build('tent')
	const specialists = []
	for (const type of ['e1', 'e1', 'e6', 'spy', 'e7']) {
		await m.gate(() => globalThis.__live.playerOrder('DevGiveCash', { extraData: 5000 }))
		specialists.push(...await m.produce(type, 1))
	}
	const tanks = (await m.gate(() => ['2tnk', '1tnk', '3tnk'].flatMap(t => globalThis.__live.own(t)))).slice(0, 3)
	assert.ok(tanks.length > 0, 'no tank in the starting army')
	const group = [...tanks, ...specialists].map(a => a.id)
	const engineer = specialists.find(a => a.type === 'e6')
	const [yard] = (await m.gate(() => globalThis.__live.enemy())).filter(a => a.type === 'fact')
	assert.ok(yard, 'the enemy has no construction yard to aim at')
	await m.gate(({ x, y }) => globalThis.__live.focus(x, y), yard)
	await m.page.waitForTimeout(900)
	const size = await m.gate(id => {
		const c = globalThis.steelseed.ctx, a = c.snapshot.actors, units = c.get('units')
		for (let i = 0; i < a.count; i++) if (a.id[i] === id) return { half: units.selectionRadiusM(a.typeId[i]) * Math.SQRT1_2, height: units.selectionHeightM(a.typeId[i]) }
		return null
	}, yard.id)
	const select = ids => m.gate(ids => { const c = globalThis.steelseed.ctx, ui = c.get('ui'); ui.selected = ids; c.get('camera').selectActors(ids) }, ids)
	const hover = async (dx, dz, h) => {
		const p = await m.gate(({ x, y, h }) => globalThis.__live.cellPx(x - 0.5, y - 0.5, h), { x: yard.x + dx * size.half, y: yard.y + dz * size.half, h: h * size.height })
		await m.page.mouse.move(p.x, p.y)
		await m.page.waitForFunction(() => { const ui = globalThis.steelseed.ctx.get('ui'); return ui.contextPreviewResolvedKey !== null && ui.contextPreviewResolvedKey === ui.contextPreviewKey }, undefined, { timeout: 5000, polling: 50 })
		return { p, ...await m.gate(() => {
			const ui = globalThis.steelseed.ctx.get('ui'), key = ui.contextPreviewKey.split(':')
			return { target: Number(key[2]), cell: [Number(key[4]), Number(key[5])], order: ui.contextPreview?.order ?? null, action: ui.commandCanvas?.dataset?.targetAction ?? null }
		}) }
	}
	// Inside the footprint: OpenRA's CenterPosition is the footprint's middle.
	const onYard = ([x, y]) => x >= Math.floor(yard.x - size.half) && x <= Math.floor(yard.x + size.half - 0.01) && y >= Math.floor(yard.y - size.half) && y <= Math.floor(yard.y + size.half - 0.01)

	await select(group)
	const points = [[0, 0, 1], [0.7, 0.2, 1], [-0.7, -0.2, 1], [0.2, 0.9, 0.4], [-0.3, -0.7, 0.9]]
	for (const [dx, dz, h] of points) {
		const seen = await hover(dx, dz, h)
		assert.equal(seen.target, yard.id, `the pointer at (${dx}, ${dz}, ${h}) is on the yard: ${JSON.stringify(seen)}`)
		assert.equal(seen.order, 'Attack', `a group with attackers shows the attack at (${dx}, ${dz}, ${h}): ${JSON.stringify(seen)}`)
		assert.equal(seen.action, 'Attack')
		assert.ok(onYard(seen.cell), `the order's cell ${seen.cell} is on the yard's footprint`)
	}
	const roof = await hover(0, -0.3, 1)
	await m.page.mouse.click(roof.p.x, roof.p.y, { button: 'right' })
	const order = await m.waitFor(() => globalThis.__orders.at(-1)?.reply ? globalThis.__orders.at(-1) : false, undefined, 'the reply to the group order')
	assert.match(order.reply, /^ok: issued (\d+)\/\1 /, `every subject answered: ${order.reply}`)
	assert.match(order.reply, /Attack/, `the group attacks: ${order.reply}`)
	assert.equal(order.targetActorId, yard.id)
	assert.ok(onYard([order.targetCell.x, order.targetCell.y]), `the order's cell ${JSON.stringify(order.targetCell)} is on the yard, not behind it`)
	await m.gate(ids => globalThis.__live.unitOrder(ids, 'Stop'), group)

	await select([engineer.id])
	const lone = await hover(0, 0, 1)
	assert.equal(lone.order, 'CaptureActor', `a lone engineer still offers its capture: ${JSON.stringify(lone)}`)
	assert.deepEqual(m.errors, [], 'page errors')
	console.log(`groupattackgate: PASS — ${group.length} subjects over the enemy yard: Attack at ${points.length} points; the click ordered ${order.reply.replace(/^ok: /, '')} at cell ${order.targetCell.x},${order.targetCell.y} on the yard; a lone engineer offers CaptureActor`)
} finally {
	await m.close()
}
