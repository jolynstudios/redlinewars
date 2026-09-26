#!/usr/bin/env node
// STEELSEED — VFX scenarios in the real game (vfx.md Epic 9), for visual review.
//
// Each scenario builds a situation with real orders in a real match (tools/live-match.mjs),
// then freezes the session on the event it studies and captures the stages as screenshots.
// Scenarios measure nothing; timing belongs to vfxbaselinegate, never to a capture run.
//
//   node tools/vfxscenario.mjs --scenario=cannon [--quality=ultra|ultra-max] [--out=DIR]
//
// cannon: a 1TNK (25mm) and a 3TNK (105mm, two barrels) force-fire at open earth. Each is
// frozen at its fire event and 1, 3 and 6 ticks on (muzzle, gas, the shell leaving), then at
// its impact event and 3, 8, 20 and 50 ticks on (burst, dust, haze, settled ground and scorch).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openLiveMatch } from './live-match.mjs'

const arg = (name, fallback) => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const SCENARIO = arg('scenario', 'cannon')
const QUALITY = arg('quality', 'ultra')
const OUT = arg('out', null)
/** The preview server's port: two scenarios may run side by side on different ports. */
const PORT = Number(arg('port', 8499))
/** Override the scenario's map (a map title from the catalog). */
const MAP = arg('map', null)
/** Restrict a roster scenario to these actor types (comma list). */
const ONLY = arg('only', '').split(',').filter(Boolean)

// S05 stage A: every ground-reachable armament, fired in a real match. A use counts as shown in
// game when the simulation fired it, the renderer drew its fire (flash, streak, body or bolt),
// and its impact event arrived. That is the evidence vfxcensus reads.
const RULES = JSON.parse(readFileSync(resolve(import.meta.dirname, '../src/fx/weapon-rules.json'), 'utf8')).weapons
const rangeCells = weapon => { const r = RULES[weapon] ?? RULES[weapon.toLowerCase()]; return r ? r.range / 1024 : 5 }
const GROUND_SPECS = [
	...['1tnk', '2tnk', '3tnk', '4tnk', 'apc', 'arty', 'ctnk', 'ftrk', 'jeep', 'stnk', 'ttnk', 'v2rl'].map(type => ({ type, kind: 'vehicle' })),
	...['e1', 'e2', 'e3', 'e4', 'e7', 'shok'].map(type => ({ type, kind: 'infantry' })),
	{ type: 'spy', kind: 'infantry', targetInfantry: true }, { type: 'dog', kind: 'infantry', targetInfantry: true },
	{ type: 'gun', kind: 'defense' },
	// The flame tower and the coil accept a force-fire at bare ground but never shoot it; they get a target.
	{ type: 'ftur', kind: 'defense', targetInfantry: true }, { type: 'tsla', kind: 'defense', targetInfantry: true },
]
const EVIDENCE_FILE = resolve(import.meta.dirname, '../../docs/vfx/scenario-evidence.json')

async function installWeaponObserver(m) {
	await m.gate(() => {
		const app = globalThis.steelseed
		globalThis.__weaponObs = { fires: {}, impacts: {} }
		const name = id => app.ctx.actorTypeName(id)
		app.events.on('sim:weapon:fire', e => {
			const view = app.ctx.snapshot?.view
			if (!view || e.byteLength < 22) return
			const actor = view.getUint32(e.offset, true), weapon = name(view.getUint16(e.offset + 20, true))
			const fires = (globalThis.__weaponObs.fires[actor] ??= {})
			fires[weapon] = (fires[weapon] ?? 0) + 1
		})
		app.events.on('sim:projectile:impact', e => {
			const view = app.ctx.snapshot?.view
			if (!view || e.byteLength < 24) return
			const weapon = name(view.getUint16(e.offset + 22, true)).toLowerCase()
			globalThis.__weaponObs.impacts[weapon] = (globalThis.__weaponObs.impacts[weapon] ?? 0) + 1
		})
	})
}

/** Fire one actor's weapons at a target (a cell, or an actor to force-attack) and record evidence. */
async function fireAndRecord(m, { label, actor, weapons, cell = null, targetId = null, order = null, support = false, evidence, report, captures, date }) {
	const before = await m.gate(() => JSON.parse(JSON.stringify(globalThis.__weaponObs)))
	const fxBefore = await m.gate(() => { const fx = globalThis.steelseed.ctx.get('fx'); return { tracers: fx.stats.startedTracers, zaps: fx.teslaArcStats.struck, mends: fx.stats.mendImpacts } })
	const fired = m.freezeOn('sim:weapon:fire', { actorId: actor.id }, 30000)
	// An explicit order where OpenRA's contextual choice would be something else (a medic's heal
	// on a jeep resolves to entering it).
	const reply = order !== null ? await m.gate(({ id, order, t }) => globalThis.__live.unitOrder([id], order, { targetActorId: t }), { id: actor.id, order, t: targetId })
		: targetId !== null ? await m.attack([actor.id], targetId) : await m.forceFire([actor.id], cell.x, cell.y)
	let drawn = null
	try {
		await fired
		await m.page.waitForTimeout(200)
		drawn = await m.gate(() => { const fx = globalThis.steelseed.ctx.get('fx'), s = fx.stats; return { flash: s.visible, shells: s.shellStreaks, bodies: fx.projectileStats.bodiesDrawn, ports: s.portFires } })
		await m.shot(`${label}-fire`); captures.push(`${label}-fire`)
		if (support) {
			// A heal is drawn where it lands, so the second capture waits for the landing.
			const landed = m.freezeOn('sim:projectile:impact', { weapon: weapons[0] }, 10000)
			await m.resume()
			await landed
			await m.advanceTicks(4)
		} else await m.advanceTicks(6)
		await m.shot(`${label}-after`); captures.push(`${label}-after`)
		await m.resume()
		await m.page.waitForTimeout(4000)
	} catch (error) { await m.resume(); report.push(`${label}: no fire (${error.message})`) }
	const after = await m.gate(() => JSON.parse(JSON.stringify(globalThis.__weaponObs)))
	const fxAfter = await m.gate(() => { const fx = globalThis.steelseed.ctx.get('fx'); return { tracers: fx.stats.startedTracers, zaps: fx.teslaArcStats.struck, mends: fx.stats.mendImpacts } })
	if (drawn !== null) { drawn.tracers = fxAfter.tracers - fxBefore.tracers; drawn.zaps = fxAfter.zaps - fxBefore.zaps; drawn.mends = fxAfter.mends - fxBefore.mends }
	for (const weapon of new Set(weapons)) {
		const shots = (after.fires[actor.id]?.[weapon] ?? 0) - (before.fires[actor.id]?.[weapon] ?? 0)
		const hits = (after.impacts[weapon.toLowerCase()] ?? 0) - (before.impacts[weapon.toLowerCase()] ?? 0)
		// A heal or a repair is shown by its mend cue where OpenRA landed it, never by a shot.
		const shown = drawn !== null && (support ? drawn.mends > 0
			: drawn.flash > 0 || drawn.shells > 0 || drawn.bodies > 0 || drawn.tracers > 0 || drawn.zaps > 0)
		report.push(`${label} ${weapon}: order ${String(reply).slice(0, 70)}, fired ${shots}, impacts ${hits}, drawn ${JSON.stringify(drawn)}`)
		if (shots > 0 && hits > 0 && shown)
			evidence[`${actor.type}:Armament.Weapon:${weapon.toLowerCase()}`] = support
				? `S05 vfxscenario ${date}: fired ${shots}x, ${hits} heal impact event(s), mend cue drawn ${drawn.mends}x`
				: `S05 vfxscenario ${date}: fired ${shots}x, ${hits} impact event(s), drawn (flash ${drawn.flash}, shell ${drawn.shells}, body ${drawn.bodies}, tracer ${drawn.tracers}, bolt ${drawn.zaps})`
	}
}

function writeEvidence(evidence, actions = {}) {
	// Scenarios may run side by side (--port): a directory is created atomically, so it serves
	// as the lock around this read-merge-write.
	const lock = `${EVIDENCE_FILE}.lock`
	for (let tries = 0; ; tries++) {
		try { mkdirSync(lock); break } catch (error) {
			if (error.code !== 'EEXIST') throw error
			if (tries > 400) { rmSync(lock, { recursive: true, force: true }); continue }
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
		}
	}
	try { mergeEvidence(evidence, actions) } finally { rmSync(lock, { recursive: true, force: true }) }
}
function mergeEvidence(evidence, actions) {
	const file = existsSync(EVIDENCE_FILE) ? JSON.parse(readFileSync(EVIDENCE_FILE, 'utf8')) : { schemaVersion: 1, weapons: {}, actions: {} }
	Object.assign(file.weapons, evidence)
	file.weapons = Object.fromEntries(Object.entries(file.weapons).sort(([a], [b]) => a < b ? -1 : 1))
	file.actions = Object.fromEntries(Object.entries({ ...(file.actions ?? {}), ...actions }).sort(([a], [b]) => a < b ? -1 : 1))
	if (Object.keys(actions).length) console.log(`  evidence: ${Object.keys(actions).length} actions shown in game -> ${EVIDENCE_FILE}`)
	writeFileSync(EVIDENCE_FILE, JSON.stringify(file, null, '\t') + '\n')
	console.log(`  evidence: ${Object.keys(evidence).length} weapon uses shown in game -> ${EVIDENCE_FILE}`)
}

/** The nearest land cell (surface not water/shallow) around a point, searching outward. */
async function landNear(m, x, y, minD = 3) {
	return m.gate(({ x, y, minD }) => {
		for (let d = minD; d < 16; d++) for (let a = 0; a < 16; a++) {
			const cx = Math.round(x + Math.cos(a / 16 * Math.PI * 2) * d), cy = Math.round(y + Math.sin(a / 16 * Math.PI * 2) * d)
			const s = globalThis.__live.surface(cx, cy)
			if (s >= 0 && s !== 8 && s !== 9 && globalThis.__live.water(cx, cy) == null) return { x: cx, y: cy }
		}
		return null
	}, { x, y, minD })
}

const scenarios = {
	// S05 stage D: the special cases. A pillbox's garrisoned rifleman (Vulcan), the English spy,
	// paratrooper variants, technicians from a sale, the medic and the mechanic on damaged
	// friendlies, and last the Demo Truck's detonation.
	async extras(m) {
		await m.devAll()
		const yard = await m.yard()
		for (const factory of ['weap', 'tent', 'barr', 'afld']) await m.build(factory)
		await installWeaponObserver(m)
		await m.hideHud()
		const siteX = Math.floor(yard.x) + 10, siteY = Math.floor(yard.y) + 12
		await m.view(siteX + 3, siteY, { zoom: 4 })
		const captures = [], evidence = {}, report = [], date = new Date().toISOString().slice(0, 10)
		const want = type => ONLY.length === 0 || ONLY.includes(type)
		const inRange = async (shooterId, victimId, range) => {
			const shooter = await m.gate(id => globalThis.__live.actor(id), shooterId)
			for (const d of [2, 3, 1]) for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
				const cell = { x: Math.round(shooter.x + dx * d), y: Math.round(shooter.y + dy * d) }
				if (d > range - 0.4) continue
				await m.moveTo([victimId], cell.x, cell.y)
				if (await m.waitFor(({ id, x, y }) => { const a = globalThis.__live.actor(id); return a && Math.hypot(a.x - x - .5, a.y - y - .5) < 1 }, { id: victimId, ...cell }, 'in range', 7000).then(() => true, () => false)) return true
			}
			return false
		}
		// The pillbox: its rifleman fires the garrisoned Vulcan through the port.
		if (want('e1')) {
			const pbox = await m.build('pbox', { near: { x: siteX, y: siteY }, minRing: 1 })
			await m.page.waitForTimeout(3000)
			await fireAndRecord(m, { label: 'garrison-pbox', actor: { ...pbox, type: 'e1' }, weapons: ['Vulcan'], cell: { x: Math.round(pbox.x + 3), y: Math.round(pbox.y) }, evidence, report, captures, date })
		}
		// The English spy and the soldiers a paradrop brings.
		if (want('spy.england')) {
			try {
				const [spy] = await m.produce('spy.england', 1)
				const [victim] = await m.produce('e1', 1)
				await inRange(spy.id, victim.id, 2.5)
				await fireAndRecord(m, { label: 'spy-england', actor: { ...spy, type: 'spy.england' }, weapons: ['SilencedPPK'], targetId: victim.id, evidence, report, captures, date })
			} catch (error) { report.push(`spy.england: ${error.message}`) }
		}
		if (want('e1r1') || want('e3r1')) {
			await m.waitFor(() => globalThis.__live.powers().some(p => /Paratroopers/i.test(p.key) && p.ready), undefined, 'paratroopers ready', 60000).catch(() => {})
			const key = await m.gate(() => globalThis.__live.powers().find(p => /Paratroopers/i.test(p.key))?.key ?? null)
			if (key) {
				await m.gate(({ key, x, y }) => globalThis.__live.playerOrder(key, { targetCell: { x, y }, extraData: 0xFFFFFFFF }), { key, x: siteX + 2, y: siteY + 3 })
				await m.waitFor(() => globalThis.__live.own('e1r1').length > 0 || globalThis.__live.own('e3r1').length > 0, undefined, 'paratroopers on the ground', 60000).catch(() => {})
				await m.page.waitForTimeout(4000)
				for (const [type, weapons] of [['e1r1', ['M1Carbine']], ['e3r1', ['Dragon']]]) {
					const [trooper] = await m.gate(t => globalThis.__live.own(t), type)
					if (!trooper) { report.push(`${type}: not dropped`); continue }
					await fireAndRecord(m, { label: `para-${type}`, actor: { ...trooper, type }, weapons, cell: { x: Math.round(trooper.x + 3), y: Math.round(trooper.y) }, evidence, report, captures, date })
				}
			} else report.push('paratroopers: no power found')
		}
		// Technicians from a sale: selling spawns a random crew, so sell until one appears.
		if (want('tecn') || want('tecn2')) {
			for (const building of ['powr', 'powr', 'powr', 'powr']) {
				if (await m.gate(() => globalThis.__live.own('tecn').length + globalThis.__live.own('tecn2').length > 0)) break
				try {
					const b = await m.build(building, { near: { x: siteX - 4, y: siteY }, minRing: 1 })
					await m.page.waitForTimeout(1500)
					await m.gate(id => globalThis.__live.unitOrder([id], 'Sell'), b.id)
					await m.page.waitForTimeout(4000)
				} catch (error) { report.push(`sell: ${error.message}`); break }
			}
			for (const type of ['tecn', 'tecn2']) {
				const [tech] = await m.gate(t => globalThis.__live.own(t), type)
				if (!tech) { report.push(`${type}: none spawned by the sales`); continue }
				await fireAndRecord(m, { label: `sale-${type}`, actor: { ...tech, type }, weapons: ['Pistol'], cell: { x: Math.round(tech.x + 3), y: Math.round(tech.y) }, evidence, report, captures, date })
			}
		}
		// The medic and the mechanic heal what a friendly gun has just damaged.
		for (const [healer, patientType, weapons] of [['medi', 'e1', ['Heal']], ['mech', 'jeep', ['Repair']]]) {
			if (!want(healer)) continue
			try {
				const [doctor] = await m.produce(healer, 1)
				const [patient] = await m.produce(patientType, 1)
				// A rifle wounds without killing, so the patient lives to be healed.
				const [gunner] = await m.produce(healer === 'medi' ? 'e1' : '2tnk', 1)
				// Park the healer out of reach first: it heals on its own the moment a wounded friend is
				// in range, which would spend the heal before the watched order below.
				const away = await landNear(m, doctor.x, doctor.y, 7)
				if (away) { await m.moveTo([doctor.id], away.x, away.y); await m.page.waitForTimeout(4000) }
				await inRange(gunner.id, patient.id, 4)
				await m.attack([gunner.id], patient.id)
				// A medic only heals the wounded, so wait for a real wound (the gunner is stopped after).
				await m.waitFor(id => (globalThis.__live.actor(id)?.health ?? 255) < 170, patient.id, 'the patient damaged', 45000).catch(() => report.push(`${healer}: the patient was never wounded`))
				await m.gate(ids => globalThis.__live.unitOrder(ids, 'Stop'), [gunner.id])
				// Close in on the patient: the cue is a few centimetres of sparks or motes.
				const at = await m.gate(id => globalThis.__live.actor(id), patient.id)
				if (at) await m.view(at.x + .5, at.y + .5, { zoom: 5 })
				await fireAndRecord(m, { label: `support-${healer}`, actor: { ...doctor, type: healer }, weapons, targetId: patient.id, order: 'Attack', support: true, evidence, report, captures, date })
				if (at) await m.view(at.x + .5, at.y + .5, { zoom: -5 })
			} catch (error) { report.push(`${healer}: ${error.message}`) }
		}
		// The MAD tank: the HUD's Detonate (its IIssueDeployOrder), the thumps, the final pulse.
		if (want('qtnk')) {
			try {
				const [mad] = await m.produce('qtnk', 1)
				const victims = await m.produce('2tnk', 2)
				for (const [k, v] of victims.entries()) await m.moveTo([v.id], Math.round(mad.x + 3 + k), Math.round(mad.y + 1))
				await m.page.waitForTimeout(4000)
				const at = await m.gate(id => globalThis.__live.actor(id), mad.id)
				await m.view(at.x + .5, at.y + .5)
				const thumped = m.freezeOn('sim:projectile:impact', { weapon: 'MADTankThump' }, 60000)
				const reply = await m.gate(id => globalThis.__live.unitOrder([id], 'Detonate'), mad.id)
				report.push(`qtnk: Detonate ${reply}`)
				await thumped; await m.advanceTicks(3)
				await m.shot('mad-1-thump'); captures.push('mad-1-thump')
				const blown = m.freezeOn('sim:projectile:impact', { weapon: 'MADTankDetonate' }, 90000)
				await m.resume(); await blown; await m.advanceTicks(4)
				await m.shot('mad-2-detonation'); captures.push('mad-2-detonation')
				await m.resume()
				evidence['qtnk:MadTank.ThumpDamageWeapon:madtankthump'] = `S05 vfxscenario ${date}: Detonate from the HUD order, thump impact drawn as the 7c0 seismic pulse`
				evidence['qtnk:MadTank.DetonationWeapon:madtankdetonate'] = `S05 vfxscenario ${date}: final MAD detonation drawn with its cratered ring`
			} catch (error) { report.push(`qtnk: ${error.message}`) }
		}
		// Last: the Demo Truck drives into open ground and detonates its MiniNuke.
		if (want('dtrk')) {
			try {
				const [truck] = await m.produce('dtrk', 1)
				// It targets neither bare ground nor friends: it drives into the bot's nearest building.
				const mark = await m.gate(({ x, y }) => globalThis.__live.enemy().filter(a => /^(fact|powr|apwr|proc|barr|tent|weap|silo|dome)$/.test(a.type)).sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0] ?? null, { x: siteX, y: siteY })
				if (!mark) throw new Error('no enemy building to drive into')
				const blast = { x: Math.floor(mark.x), y: Math.floor(mark.y) }
				await m.view(blast.x + .5, blast.y + .5)
				const before = await m.gate(() => JSON.parse(JSON.stringify(globalThis.__weaponObs)))
				const detonated = m.freezeOn('sim:projectile:impact', { weapon: 'mininuke' }, 90000)
				const order = await m.attack([truck.id], mark.id)
				report.push(`dtrk order: ${order}`)
				await detonated.catch(async error => {
					const state = await m.gate(id => ({ truck: globalThis.__live.actor(id), fires: globalThis.__weaponObs.fires[id], impacts: globalThis.__weaponObs.impacts }), truck.id)
					throw new Error(`${error.message}; truck ${JSON.stringify(state.truck)}, fires ${JSON.stringify(state.fires)}, impacts ${JSON.stringify(state.impacts)}`)
				})
				await m.page.waitForTimeout(200)
				await m.shot('dtrk-detonation'); captures.push('dtrk-detonation')
				for (const [ticks, stage] of [[6, '1'], [20, '2'], [50, '3']]) { await m.advanceTicks(ticks); await m.shot(`dtrk-${stage}`); captures.push(`dtrk-${stage}`) }
				await m.resume(); await m.page.waitForTimeout(1000)
				const after = await m.gate(() => JSON.parse(JSON.stringify(globalThis.__weaponObs)))
				const fired = (after.fires[truck.id]?.DemoTruckTargeting ?? 0) + (after.fires[truck.id]?.MiniNuke ?? 0)
				const hits = (after.impacts.mininuke ?? 0) - (before.impacts.mininuke ?? 0)
				const nuked = await m.gate(() => globalThis.steelseed.ctx.get('fx').lastNukeAt > -1e8)
				report.push(`dtrk: fire records ${fired}, MiniNuke impacts ${hits}, cloud started ${nuked}`)
				if (hits > 0) evidence['dtrk:Armament.Weapon:demotrucktargeting'] = `S05 vfxscenario ${date}: drove in and detonated; ${hits} MiniNuke impact event(s), cloud started ${nuked}`
				if (hits > 0 && nuked) evidence['dtrk:FireWarheadsOnDeath.Weapon:mininuke'] = `S05 vfxscenario ${date}: MiniNuke detonation drawn by the staged cloud`
			} catch (error) { report.push(`dtrk: ${error.message}`) }
		}
		for (const line of report) console.log(`  ${line}`)
		writeEvidence(evidence)
		return captures
	},
	// S05 stage C: the fleet on Archipelago. Guns and missiles at the nearest coast, anti-air at
	// our own heli, torpedoes at our own gunboat, depth charges at our own submerged sub.
	async naval(m) {
		await m.devAll()
		const yard = await m.yard()
		const captures = [], evidence = {}, report = [], date = new Date().toISOString().slice(0, 10)
		const weaponsOf = type => m.census.find(a => a.actor === type)?.armaments ?? []
		let syrd = null, spen = null
		try { syrd = await m.build('syrd', { minRing: 2 }) } catch (error) { report.push(`syrd: ${error.message}`) }
		try { spen = await m.build('spen', { minRing: 2 }) } catch (error) { report.push(`spen: ${error.message}`) }
		await m.build('hpad')
		await installWeaponObserver(m)
		await m.hideHud()
		const ships = {}
		for (const type of ['pt', 'dd', 'ca', 'lst'].filter(() => syrd)) try { [ships[type]] = await m.produce(type, 1) } catch (error) { report.push(`${type}: ${error.message}`) }
		for (const type of ['ss', 'msub'].filter(() => spen)) try { [ships[type]] = await m.produce(type, 1) } catch (error) { report.push(`${type}: ${error.message}`) }
		await m.page.waitForTimeout(4000)
		const want = type => ONLY.length === 0 || ONLY.includes(type)
		// Guns and missiles at the coast.
		for (const [type, weapons] of [['pt', ['2Inch']], ['dd', ['Stinger']], ['ca', ['8Inch']], ['msub', ['SubMissile']]]) {
			if (!want(type)) continue
			const ship = ships[type] && await m.gate(id => globalThis.__live.actor(id), ships[type].id)
			if (!ship) { report.push(`${type}: no ship`); continue }
			const coast = await landNear(m, ship.x, ship.y, 3)
			if (!coast) { report.push(`${type}: no land in reach`); continue }
			await m.view(ship.x, ship.y, { zoom: captures.length === 0 ? 4 : 0 })
			await fireAndRecord(m, { label: `naval-${type}`, actor: { ...ship, type }, weapons, cell: coast, evidence, report, captures, date })
		}
		// Anti-air at our own flying heli.
		const aa = [['dd', ['StingerAA']], ['msub', ['SubMissileAA']]].filter(([t]) => want(t))
		if (aa.length) {
			let [heli] = await m.produce('heli', 1)
			for (const [type, weapons] of aa) {
				const ship = ships[type] && await m.gate(id => globalThis.__live.actor(id), ships[type].id)
				if (!ship) continue
				if (!(await m.gate(id => globalThis.__live.actor(id), heli.id))) [heli] = await m.produce('heli', 1)
				await m.moveTo([heli.id], Math.round(ship.x + 3), Math.round(ship.y))
				await m.page.waitForTimeout(3500)
				await m.view(ship.x, ship.y)
				await fireAndRecord(m, { label: `naval-aa-${type}`, actor: { ...ship, type }, weapons, targetId: heli.id, evidence, report, captures, date })
			}
		}
		// Torpedoes at our own gunboat; depth charges at our own submarine.
		for (const [type, weapons, targetType] of [['ss', ['TorpTube'], 'lst'], ['pt', ['DepthCharge'], 'ss'], ['dd', ['DepthCharge'], 'msub']]) {
			if (!want(type)) continue
			const ship = ships[type] && await m.gate(id => globalThis.__live.actor(id), ships[type].id)
			const target = ships[targetType] && await m.gate(id => globalThis.__live.actor(id), ships[targetType].id)
			if (!ship || !target) { report.push(`${type} ${weapons[0]}: missing ${!ship ? type : targetType}`); continue }
			await m.moveTo([target.id], Math.round(ship.x + 3), Math.round(ship.y))
			await m.page.waitForTimeout(4000)
			await m.view(ship.x, ship.y)
			await fireAndRecord(m, { label: `naval-${type}-${weapons[0].toLowerCase()}`, actor: { ...ship, type }, weapons, targetId: target.id, evidence, report, captures, date })
		}
		for (const line of report) console.log(`  ${line}`)
		writeEvidence(evidence)
		return captures
	},
	// S05 stage B: aircraft fire at ground; every anti-air weapon fires at our own hovering heli;
	// the Airfield's parabombs drop on open ground.
	async air(m) {
		await m.devAll()
		const yard = await m.yard()
		for (const factory of ['afld', 'hpad', 'weap', 'tent', 'barr']) await m.build(factory)
		await installWeaponObserver(m)
		await m.hideHud()
		const siteX = Math.floor(yard.x) + 10, siteY = Math.floor(yard.y) + 12
		await m.view(siteX + 3, siteY, { zoom: 4 })
		const captures = [], evidence = {}, report = [], date = new Date().toISOString().slice(0, 10)
		const weaponsOf = type => m.census.find(a => a.actor === type)?.armaments ?? []
		// Aircraft against the ground.
		for (const type of ['mig', 'yak', 'heli', 'mh60'].filter(t => ONLY.length === 0 || ONLY.includes(t))) {
			let actor
			try { [actor] = await m.produce(type, 1) } catch (error) { report.push(`${type}: not produced (${error.message})`); continue }
			await m.page.waitForTimeout(2500)
			await fireAndRecord(m, { label: `air-${type}`, actor: { ...actor, type }, weapons: weaponsOf(type), cell: { x: siteX + 4, y: siteY }, evidence, report, captures, date })
		}
		// A hovering target for every anti-air weapon.
		let [target] = await m.produce('heli', 1)
		const hover = { x: siteX + 4, y: siteY - 1 }
		const keepAloft = async () => { await m.moveTo([target.id], hover.x, hover.y); await m.page.waitForTimeout(2500) }
		const shooters = [['e3', 'unit'], ['ftrk', 'unit'], ['4tnk', 'unit'], ['heli', 'unit'], ['agun', 'defense'], ['sam', 'defense']]
		for (const [type, kind] of shooters.filter(([t]) => ONLY.length === 0 || ONLY.includes(t))) {
			let actor
			try {
				actor = kind === 'defense' ? await m.build(type, { near: { x: siteX, y: siteY }, minRing: 1 }) : (await m.produce(type, 1))[0]
			} catch (error) { report.push(`${type}: not produced (${error.message})`); continue }
			if (kind === 'unit' && type !== 'heli') await m.moveTo([actor.id], siteX, siteY)
			await m.page.waitForTimeout(3000)
			await keepAloft()
			// Anti-air shoots its target down; each shooter gets a live one.
			if (!(await m.gate(id => globalThis.__live.actor(id), target.id))) { [target] = await m.produce('heli', 1); await keepAloft() }
			const aaOnly = weaponsOf(type).filter(w => /AA$|RedEye|Nike|ZSU|MammothTusk/i.test(w))
			// The target must be flying when the order goes out: anti-air cannot hit a landed helicopter.
			await m.moveTo([target.id], hover.x + (captures.length % 2 ? 1 : -1), hover.y)
			await m.page.waitForTimeout(600)
			await fireAndRecord(m, { label: `aa-${type}`, actor: { ...actor, type }, weapons: aaOnly.length ? aaOnly : weaponsOf(type), targetId: target.id, evidence, report, captures, date })
		}
		// Parabombs: the Airfield's airstrike power at open ground; the bomber's fire records name it.
		if (ONLY.length === 0 || ONLY.includes('badr.bomber')) {
			await m.waitFor(() => globalThis.__live.powers().some(p => /Airstrike|parabomb/i.test(p.key) && p.ready), undefined, 'parabombs ready', 60000).catch(() => {})
			const key = await m.gate(() => globalThis.__live.powers().find(p => /Airstrike|parabomb/i.test(p.key))?.key ?? null)
			if (key) {
				const before = await m.gate(() => JSON.parse(JSON.stringify(globalThis.__weaponObs)))
				const strike = { x: siteX + 6, y: siteY + 4 }
				await m.view(strike.x + .5, strike.y + .5)
				const landed = m.freezeOn('sim:projectile:impact', { weapon: 'parabomb' }, 60000)
				const reply = await m.gate(({ key, x, y }) => globalThis.__live.playerOrder(key, { targetCell: { x, y }, extraData: 0xFFFFFFFF }), { key, ...strike })
				try {
					await landed; await m.page.waitForTimeout(200)
					await m.shot('air-parabomb-impact'); captures.push('air-parabomb-impact')
					await m.advanceTicks(12); await m.shot('air-parabomb-after'); captures.push('air-parabomb-after')
				} catch (error) { report.push(`parabombs: ${error.message}`) }
				await m.resume(); await m.page.waitForTimeout(5000)
				const after = await m.gate(() => JSON.parse(JSON.stringify(globalThis.__weaponObs)))
				const hits = (after.impacts.parabomb ?? 0) - (before.impacts.parabomb ?? 0)
				const shots = Object.values(after.fires).reduce((n, f) => n + (f.ParaBomb ?? 0), 0) - Object.values(before.fires).reduce((n, f) => n + (f.ParaBomb ?? 0), 0)
				const bodies = await m.gate(() => globalThis.steelseed.ctx.get('fx').projectileStats.startedBodies)
				report.push(`badr.bomber ParaBomb: order ${reply}, fired ${shots}, impacts ${hits}, bomb bodies started ${bodies}`)
				if (shots > 0 && hits > 0) evidence['badr.bomber:Armament.Weapon:parabomb'] = `S05 vfxscenario ${date}: ${shots} bombs released by the airstrike power, ${hits} impact event(s), bomb bodies drawn`
			} else report.push('parabombs: no airstrike power found')
		}
		for (const line of report) console.log(`  ${line}`)
		writeEvidence(evidence)
		return captures
	},
	// Epic 7 review (S03, S13): the Atomic from the player's own silo, captured leaving the silo,
	// falling on its target, and through its stages: flash, fireball, dust front, column, cap and
	// the aftermath. Then a second strike on water. The strike's own counters are reported.
	async nuke(m) {
		await m.devAll()
		const yard = await m.yard()
		const silo = await m.build('mslo')
		const ready = async () => {
			await m.waitFor(() => globalThis.__live.powers().some(p => /Nuke/.test(p.key) && p.ready), undefined, 'the nuke ready', 90000)
			return m.gate(() => globalThis.__live.powers().find(p => /Nuke/.test(p.key)).key)
		}
		// Freeze the first frame an Atomic missile matches `test` (ascending near the silo, or in
		// its last metres over the target). The flight is the engine's own NukeLaunch.
		const freezeOnMissile = (phase, timeout) => m.page.waitForFunction(phase => {
			const app = globalThis.steelseed, p = app.ctx.snapshot?.projectiles
			if (!p) return false
			for (let i = 0; i < p.count; i++) {
				if (app.ctx.actorTypeName(p.typeId[i]).toLowerCase() !== 'atomic') continue
				const up = p.velZ[i] > 0, left = p.remainingTicks[i]
				if (phase === 'launch' ? up && left < 390 : !up && left < 24) {
					globalThis.__missile = { left, z: p.posZ[i] / 1024 }
					app.stop(); app.ctx.session.setPaused(true)
					return true
				}
			}
			return false
		}, phase, { polling: 'raf', timeout })
		const report = [], captures = []
		const shot = async stage => { await m.shot(`nuke-${stage}`); captures.push(`nuke-${stage}`) }
		const stats = () => m.gate(() => { const fx = globalThis.steelseed.ctx.get('fx'); return { strike: { ...fx.nuclearStats }, pool: { ...fx.particleStats }, lights: fx.stats.lights, scorch: fx.scorchStats.active } })
		let key = await ready()
		const target = { x: Math.floor(yard.x) + 16, y: Math.floor(yard.y) + 6 }
		await m.hideHud()
		// The burnt-grass witness: blades drawn within 2 m of ground zero, before and after.
		const grassAtZero = () => m.gate(({ x, y }) => globalThis.steelseed.ctx.get('units').sceneryCountNear('grass', x + .5, y + .5, 2), target)
		await m.view(target.x + 0.5, target.y + 0.5)
		const grassBefore = await grassAtZero()
		const siloAt = await m.gate(id => globalThis.__live.actor(id), silo?.id ?? -1).catch(() => null)
		if (siloAt) await m.view(siloAt.x + 0.5, siloAt.y + 0.5, { zoom: 2 })
		const launched = freezeOnMissile('launch', 30000)
		const reply = await m.gate(({ key, x, y }) => globalThis.__live.playerOrder(key, { targetCell: { x, y }, extraData: 0xFFFFFFFF }), { key, ...target })
		if (!/^ok/.test(reply)) throw new Error(`nuke order refused: ${reply}`)
		try { await launched; await m.page.waitForTimeout(250); await shot('0-launch'); report.push(`launch: ${JSON.stringify(await m.gate(() => globalThis.__missile))}`) }
		catch (error) { report.push(`launch: no missile seen leaving the silo (${error.message.split('\n')[0]})`) }
		await m.resume()
		await m.view(target.x + 0.5, target.y + 0.5)
		const falling = freezeOnMissile('fall', 30000)
		try { await falling; await m.page.waitForTimeout(250); await shot('1-falling'); report.push(`falling: ${JSON.stringify(await m.gate(() => globalThis.__missile))}`) }
		catch (error) { report.push(`falling: no missile seen over the target (${error.message.split('\n')[0]})`) }
		const struck = m.freezeOn('sim:projectile:impact', { weapon: 'atomic' }, 60000)
		await m.resume()
		await struck
		await m.page.waitForTimeout(250)
		await shot('2-detonation')
		let peak = await stats()
		for (const [ticks, stage] of [[2, '3-flash'], [6, '4-fireball'], [10, '5-front'], [25, '6-column'], [50, '7-cap'], [75, '8-spread'], [125, '9-settling'], [200, '10-aftermath-15s'], [500, '11-aftermath-35s']]) {
			await m.advanceTicks(ticks)
			await shot(stage)
			const now = await stats()
			if (now.pool.alive > peak.pool.alive) peak = now
			if (stage === '8-spread') report.push(`grass within 2 m of ground zero: ${grassBefore} before, ${await grassAtZero()} at 6.7 s`)
		}
		report.push(`atomic: ${JSON.stringify(await stats())}`, `atomic peak pool: ${JSON.stringify(peak.pool)}, flash peak ${peak.strike.lightPeak}`)
		await m.resume()
		// Water: the nearest open water to the yard, if the map has any.
		const wet = await m.gate(({ x, y }) => {
			for (let d = 4; d < 40; d++) for (let a = 0; a < 32; a++) {
				const cx = Math.round(x + Math.cos(a / 32 * Math.PI * 2) * d), cy = Math.round(y + Math.sin(a / 32 * Math.PI * 2) * d)
				if (globalThis.__live.surface(cx, cy) === 8) return { x: cx, y: cy }
			}
			return null
		}, { x: yard.x, y: yard.y })
		if (wet) {
			key = await ready()
			await m.view(wet.x + 0.5, wet.y + 0.5)
			const splashed = m.freezeOn('sim:projectile:impact', { weapon: 'atomic' }, 90000)
			const again = await m.gate(({ key, x, y }) => globalThis.__live.playerOrder(key, { targetCell: { x, y }, extraData: 0xFFFFFFFF }), { key, ...wet })
			if (/^ok/.test(again)) {
				await splashed
				for (const [ticks, stage] of [[10, 'water-1-dome'], [40, 'water-2-steam'], [150, 'water-3-foam']]) { await m.advanceTicks(ticks); await shot(stage) }
				report.push(`water: ${JSON.stringify(await stats())}`)
				await m.resume()
			} else report.push(`water: order refused ${again}`)
		} else report.push('water: no open water near the yard')
		for (const line of report) console.log(`  ${line}`)
		return captures
	},
	// S14 (vfx.md Epics 8 and 9): the first Tesla discharge and the first nuke of a session, live
	// and never frozen, so frame timing stays honest. Neither may create a render pipeline (the
	// renderer counts every one), and neither may stall frames against the seconds before it.
	async firstuse(m) {
		await m.devAll()
		const yard = await m.yard()
		const report = []
		const siteX = Math.floor(yard.x) + 10, siteY = Math.floor(yard.y) + 12
		// A coil and a silo need the power of two advanced plants, or the coil sits disabled.
		for (let k = 0; k < 2; k++) await m.build('apwr', { near: { x: siteX, y: siteY }, minRing: 3 })
		const coil = await m.build('tsla', { near: { x: siteX, y: siteY }, minRing: 1 })
		await m.build('mslo')
		await m.build('tent').catch(() => m.build('barr'))
		const [victim] = await m.produce('e1', 1)
		await m.hideHud()
		await m.view(coil.x + .5, coil.y + .5, { zoom: 3 })
		await m.gate(() => {
			// render.stats.pipelineCreations is per frame (reset in lateUpdate): sum it every frame.
			const rec = globalThis.__frames = { t: [], dt: [], stop: false, pipelines: 0 }
			const render = globalThis.steelseed.ctx.get('render')
			let last = performance.now()
			const loop = now => {
				rec.t.push(now); rec.dt.push(now - last); last = now
				rec.pipelines += render.stats.pipelineCreations
				if (!rec.stop) requestAnimationFrame(loop)
			}
			requestAnimationFrame(loop)
			globalThis.__firsts = {}
			const app = globalThis.steelseed
			for (const [kind, at] of [['sim:weapon:fire', 20], ['sim:projectile:impact', 22]]) app.events.on(kind, e => {
				const view = app.ctx.snapshot?.view
				if (!view) return
				const name = app.ctx.actorTypeName(view.getUint16(e.offset + at, true)).toLowerCase()
				if ((name === 'teslazap' || name === 'atomic') && !globalThis.__firsts[name]) globalThis.__firsts[name] = performance.now()
			})
		})
		const pipelines = () => m.gate(() => globalThis.__frames.pipelines)
		const p0 = await pipelines()
		await m.page.waitForTimeout(4000)
		// The coil's first discharge, at our own soldier walked into its range.
		const here = await m.gate(id => globalThis.__live.actor(id), coil.id)
		// A coil cannot close in: the target has to be standing in its range when the order goes
		// out. Cells around the coil until one is reachable (the weapons stage's search).
		let arrived = false
		search: for (const d of [3, 2, 4]) for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
			const cell = { x: Math.round(here.x + dx * d), y: Math.round(here.y + dy * d) }
			await m.moveTo([victim.id], cell.x, cell.y)
			arrived = await m.waitFor(({ id, x, y }) => { const a = globalThis.__live.actor(id); return a && Math.hypot(a.x - x - .5, a.y - y - .5) < 1 }, { id: victim.id, ...cell }, 'the target in range', 9000).then(() => true, () => false)
			if (arrived) break search
		}
		if (!arrived) report.push('tesla: the target never reached the coil\'s range')
		await m.attack([coil.id], victim.id)
		await m.waitFor(() => globalThis.__firsts.teslazap > 0, undefined, 'the first discharge', 30000).catch(() => report.push('tesla: no discharge seen'))
		await m.page.waitForTimeout(3000)
		const p1 = await pipelines()
		// The first nuke, on open ground away from the base.
		await m.waitFor(() => globalThis.__live.powers().some(p => /Nuke/.test(p.key) && p.ready), undefined, 'the nuke ready', 120000)
		const key = await m.gate(() => globalThis.__live.powers().find(p => /Nuke/.test(p.key)).key)
		const target = { x: Math.floor(yard.x) + 16, y: Math.floor(yard.y) + 6 }
		await m.view(target.x + .5, target.y + .5)
		await m.page.waitForTimeout(2000)
		const reply = await m.gate(({ key, x, y }) => globalThis.__live.playerOrder(key, { targetCell: { x, y }, extraData: 0xFFFFFFFF }), { key, ...target })
		if (!/^ok/.test(reply)) report.push(`nuke order refused: ${reply}`)
		await m.waitFor(() => globalThis.__firsts.atomic > 0, undefined, 'the first detonation', 60000).catch(() => report.push('nuke: no detonation seen'))
		await m.page.waitForTimeout(5000)
		const p2 = await pipelines()
		const frames = await m.gate(() => { globalThis.__frames.stop = true; return { t: globalThis.__frames.t, dt: globalThis.__frames.dt, firsts: globalThis.__firsts } })
		const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0 }
		const window = (from, to) => frames.dt.filter((_, i) => frames.t[i] >= from && frames.t[i] <= to)
		const firstEvent = Math.min(frames.firsts.teslazap ?? Infinity, frames.firsts.atomic ?? Infinity)
		const base = window(frames.t[0] + 500, Math.min(firstEvent, frames.t[0] + 4000) - 200)
		const summary = a => ({ frames: a.length, p50: +pct(a, .5).toFixed(1), p95: +pct(a, .95).toFixed(1), p99: +pct(a, .99).toFixed(1), worst: +Math.max(0, ...a).toFixed(1) })
		const result = {
			pipelines: { atStart: p0, afterTesla: p1, afterNuke: p2 },
			baseline: summary(base),
			tesla: frames.firsts.teslazap ? summary(window(frames.firsts.teslazap - 100, frames.firsts.teslazap + 1500)) : null,
			nuke: frames.firsts.atomic ? summary(window(frames.firsts.atomic - 100, frames.firsts.atomic + 3000)) : null,
		}
		const limit = Math.max(50, 3 * result.baseline.p99)
		const hitch = [result.tesla, result.nuke].some(w => w && w.worst > limit)
		const pass = p2 === p0 && result.tesla !== null && result.nuke !== null && !hitch
		report.push(`first use: ${JSON.stringify(result)}`, `first use: ${pass ? 'PASS' : 'FAIL'} (no pipeline created: ${p2 === p0}; worst frame limit ${limit.toFixed(1)} ms)`)
		for (const line of report) console.log(`  ${line}`)
		writeFileSync(resolve(import.meta.dirname, '../../docs/vfx/first-use.json'), JSON.stringify({ date: new Date().toISOString(), pass, limitMs: limit, ...result }, null, '\t') + '\n')
		return []
	},
	// Epic 7 / S03: paratroopers from the Airfield's real power. OpenRA holds each jumper in the
	// air (Parachutable.IsInAir, actor flag 1<<2) at a falling altitude; the renderer must draw
	// the descent under a canopy and a landing, not a squad standing on the ground throughout.
	async paradrop(m) {
		await m.devAll()
		const yard = await m.yard()
		const report = [], captures = []
		await m.build('powr').catch(error => report.push(`powr: ${error.message}`))
		await m.build('afld').catch(error => report.push(`afld: ${error.message}`))
		await m.waitFor(() => globalThis.__live.powers().some(p => /Paratroopers/i.test(p.key) && p.ready), undefined, 'paratroopers ready', 120000)
		const key = await m.gate(() => globalThis.__live.powers().find(p => /Paratroopers/i.test(p.key)).key)
		const drop = await landNear(m, Math.floor(yard.x) + 10, Math.floor(yard.y) + 4, 0) ?? { x: Math.floor(yard.x) + 10, y: Math.floor(yard.y) + 4 }
		await m.hideHud()
		await m.view(drop.x + .5, drop.y + .5, { zoom: 3 })
		const aloft = () => m.gate(() => {
			const snap = globalThis.steelseed.ctx.snapshot, a = snap.actors, out = []
			for (let i = 0; i < a.count; i++) if ((a.flags[i] & 4) !== 0) out.push({ id: a.id[i], z: a.posZ[i] / 1024 })
			return { tick: snap.tick, out, canopies: globalThis.steelseed.ctx.get('fx').parachuteStats?.drawn ?? null }
		})
		const reply = await m.gate(({ key, x, y }) => globalThis.__live.playerOrder(key, { targetCell: { x, y }, extraData: 0xFFFFFFFF }), { key, ...drop })
		report.push(`order: ${reply}`)
		// Freeze on the first frame a jumper hangs in the air.
		await m.page.waitForFunction(() => {
			const app = globalThis.steelseed, a = app.ctx.snapshot?.actors
			if (!a) return false
			for (let i = 0; i < a.count; i++) if ((a.flags[i] & 4) !== 0) { app.stop(); app.ctx.session.setPaused(true); return true }
			return false
		}, undefined, { polling: 'raf', timeout: 90000 }).then(() => true, () => { report.push('no jumper was ever flagged in the air'); return false })
		const first = await aloft()
		report.push(`in the air: ${first.out.length} jumpers at ${first.out.map(j => j.z.toFixed(1)).join(', ')} m; canopies drawn ${first.canopies}`)
		await m.page.waitForTimeout(250)
		await m.shot('paradrop-1-canopies'); captures.push('paradrop-1-canopies')
		await m.advanceTicks(25)
		const later = await aloft()
		report.push(`one second later: ${later.out.length} in the air at ${later.out.map(j => j.z.toFixed(1)).join(', ')} m`)
		await m.shot('paradrop-2-descent'); captures.push('paradrop-2-descent')
		await m.resume()
		await m.waitFor(() => { const a = globalThis.steelseed.ctx.snapshot.actors; for (let i = 0; i < a.count; i++) if ((a.flags[i] & 4) !== 0) return false; return true }, undefined, 'every jumper landed', 60000)
			.then(() => report.push('landed: no jumper left in the air'), () => report.push('landing: jumpers still flagged after 60 s'))
		await m.page.waitForTimeout(800)
		await m.shot('paradrop-3-landed'); captures.push('paradrop-3-landed')
		for (const line of report) console.log(`  ${line}`)
		return captures
	},
	// S11 and S13 (vfx.md Epic 9): rapid destruction under an Atomic. Our own column of about
	// thirty vehicles and a few buildings dies inside the strike's first second; every bound
	// must hold (particle pool, clouds, lights, scorch) and nothing may explode twice. Frame
	// intervals around the strike are recorded live, never frozen.
	async rapid(m) {
		await m.devAll()
		const yard = await m.yard()
		const report = [], captures = []
		await m.build('weap').catch(error => report.push(`weap: ${error.message}`))
		// The silo charges only on full power, and the column's factory and the targets draw a lot.
		for (let k = 0; k < 2; k++) await m.build('apwr').catch(error => report.push(`apwr: ${error.message}`))
		await m.build('mslo')
		const site = await landNear(m, Math.floor(yard.x) + 14, Math.floor(yard.y) + 8, 0) ?? { x: Math.floor(yard.x) + 14, y: Math.floor(yard.y) + 8 }
		const buildings = []
		for (const name of ['powr', 'powr', 'silo']) buildings.push(await m.build(name, { near: site, minRing: 1 }).catch(error => { report.push(`${name}: ${error.message}`); return null }))
		const column = []
		for (const [name, count] of [['1tnk', 10], ['2tnk', 10], ['jeep', 10]]) column.push(...await m.produce(name, count).catch(error => { report.push(`${name}: ${error.message}`); return [] }))
		for (const [k, unit] of column.entries()) await m.moveTo([unit.id], site.x - 2 + (k % 6), site.y - 2 + Math.floor(k / 6))
		await m.page.waitForTimeout(12000)
		await m.waitFor(() => globalThis.__live.powers().some(p => /Nuke/.test(p.key) && p.ready), undefined, 'the nuke ready', 120000)
		const key = await m.gate(() => globalThis.__live.powers().find(p => /Nuke/.test(p.key)).key)
		await m.hideHud()
		await m.view(site.x + .5, site.y + .5)
		const counters = () => m.gate(() => {
			const fx = globalThis.steelseed.ctx.get('fx'), s = fx.stats
			return { destroyed: s.acceptedDestroyedEvents, explosions: s.activeExplosions, lightsCapped: s.lightsCapped, pool: { ...fx.particleStats },
				strike: { ...fx.nuclearStats }, scorch: fx.scorchStats.active, dropped: s.droppedEvents }
		})
		const before = await counters()
		await m.gate(() => {
			const rec = globalThis.__frames = { t: [], dt: [], stop: false, peak: 0, peakDropped: 0 }
			let last = performance.now()
			const loop = now => {
				rec.t.push(now); rec.dt.push(now - last); last = now
				const fx = globalThis.steelseed.ctx.get('fx')
				rec.peak = Math.max(rec.peak, fx.particleStats.alive)
				if (!rec.stop) requestAnimationFrame(loop)
			}
			requestAnimationFrame(loop)
			globalThis.__struck = 0
			const app = globalThis.steelseed
			app.events.on('sim:projectile:impact', e => {
				const view = app.ctx.snapshot?.view
				if (view && !globalThis.__struck && app.ctx.actorTypeName(view.getUint16(e.offset + 22, true)).toLowerCase() === 'atomic') globalThis.__struck = performance.now()
			})
		})
		const reply = await m.gate(({ key, x, y }) => globalThis.__live.playerOrder(key, { targetCell: { x, y }, extraData: 0xFFFFFFFF }), { key, ...site })
		report.push(`order: ${reply}`)
		await m.waitFor(() => globalThis.__struck > 0, undefined, 'the Atomic', 60000)
		await m.page.waitForTimeout(1000)
		await m.shot('rapid-1-second'); captures.push('rapid-1-second')
		await m.page.waitForTimeout(2000)
		await m.shot('rapid-3-seconds'); captures.push('rapid-3-seconds')
		await m.page.waitForTimeout(5000)
		const after = await counters()
		const frames = await m.gate(() => { globalThis.__frames.stop = true; return { t: globalThis.__frames.t, dt: globalThis.__frames.dt, peak: globalThis.__frames.peak, struck: globalThis.__struck } })
		const pct = (a, q) => { const x = [...a].sort((p, r) => p - r); return x.length ? +x[Math.min(x.length - 1, Math.floor(q * x.length))].toFixed(1) : 0 }
		const around = frames.dt.filter((_, i) => frames.t[i] >= frames.struck - 200 && frames.t[i] <= frames.struck + 3000)
		const calm = frames.dt.filter((_, i) => frames.t[i] < frames.struck - 500)
		report.push(`deaths: ${after.destroyed - before.destroyed} destroyed events; explosions alive now ${after.explosions}`)
		report.push(`bounds: particle peak ${frames.peak} (pool dropped ${after.pool.dropped - before.pool.dropped}), clouds refused ${after.strike.refused - before.strike.refused}, lights capped ${after.lightsCapped - before.lightsCapped}, events dropped ${after.dropped - before.dropped}, scorch ${after.scorch}`)
		report.push(`frames: before p50 ${pct(calm, .5)} p95 ${pct(calm, .95)} ms; strike +3 s p50 ${pct(around, .5)} p95 ${pct(around, .95)} p99 ${pct(around, .99)} worst ${pct(around, 1)} ms (${around.length} frames)`)
		for (const line of report) console.log(`  ${line}`)
		return captures
	},
	async weapons(m) {
		await m.devAll()
		const yard = await m.yard()
		for (const factory of ['weap', 'tent', 'barr']) await m.build(factory)
		await installWeaponObserver(m)
		await m.hideHud()
		const siteX = Math.floor(yard.x) + 10, siteY = Math.floor(yard.y) + 12
		await m.view(siteX + 3, siteY, { zoom: 5 })
		const captures = [], evidence = {}, report = []
		const date = new Date().toISOString().slice(0, 10)
		for (const spec of GROUND_SPECS.filter(s => ONLY.length === 0 || ONLY.includes(s.type))) {
			let actor
			try {
				actor = spec.kind === 'defense' ? await m.build(spec.type, { near: { x: siteX, y: siteY }, minRing: 1 }) : (await m.produce(spec.type, 1))[0]
			} catch (error) { report.push(`${spec.type}: not produced (${error.message})`); continue }
			const census = m.census.find(a => a.actor === spec.type)
			const weapons = census?.armaments ?? []
			if (spec.kind !== 'defense') {
				await m.moveTo([actor.id], siteX, siteY)
				await m.waitFor(({ id, x, y }) => { const a = globalThis.__live.actor(id); return a && Math.hypot(a.x - x - .5, a.y - y - .5) < 1.5 }, { id: actor.id, x: siteX, y: siteY }, `${spec.type} at the firing spot`, 60000).catch(() => {})
			}
			const here = await m.gate(id => globalThis.__live.actor(id), actor.id)
			if (!here) { report.push(`${spec.type}: gone before firing`); continue }
			const reach = Math.max(1.5, Math.min(6, Math.min(...weapons.map(rangeCells)) - 0.6))
			let target = { x: Math.round(here.x + reach), y: Math.round(here.y) }
			let victim = null
			if (spec.targetInfantry) {
				;[victim] = await m.produce('e1', 1)
				// A fresh soldier may still be leaving the barracks when the first move goes out; the
				// target must actually stand inside the weapon's range before the attack.
				// Cells around the shooter until one is reachable and inside the weapon's range.
				const range = Math.min(...weapons.map(rangeCells))
				search: for (const d of [3, 2, 4]) for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
					const cell = { x: Math.round(here.x + dx * d), y: Math.round(here.y + dy * d) }
					if (Math.hypot(cell.x + .5 - here.x, cell.y + .5 - here.y) > range - 0.4) continue
					await m.moveTo([victim.id], cell.x, cell.y)
					const arrived = await m.waitFor(({ id, x, y }) => { const a = globalThis.__live.actor(id); return a && Math.hypot(a.x - x - .5, a.y - y - .5) < 1 }, { id: victim.id, ...cell }, 'the target in range', 7000).then(() => true, () => false)
					if (arrived) { target = cell; break search }
				}
			}
			const before = await m.gate(() => JSON.parse(JSON.stringify(globalThis.__weaponObs)))
			const fxBefore = await m.gate(() => { const fx = globalThis.steelseed.ctx.get('fx'); return { tracers: fx.stats.startedTracers, zaps: fx.teslaArcStats.struck } })
			const fired = m.freezeOn('sim:weapon:fire', { actorId: actor.id }, 20000)
			const reply = victim ? await m.attack([actor.id], victim.id) : await m.forceFire([actor.id], target.x, target.y)
			let drawn = null
			try {
				await fired
				await m.page.waitForTimeout(200)
				drawn = await m.gate(() => { const fx = globalThis.steelseed.ctx.get('fx'), s = fx.stats; return { flash: s.visible, shells: s.shellStreaks, bodies: fx.projectileStats.bodiesDrawn } })
				await m.shot(`weapons-${spec.type}-fire`); captures.push(`weapons-${spec.type}-fire`)
				await m.advanceTicks(6)
				await m.shot(`weapons-${spec.type}-after`); captures.push(`weapons-${spec.type}-after`)
				await m.resume()
				await m.page.waitForTimeout(3500)
			} catch (error) { await m.resume(); report.push(`${spec.type}: no fire (${error.message})`) }
			const after = await m.gate(() => JSON.parse(JSON.stringify(globalThis.__weaponObs)))
			// Instant hits draw their tracer or bolt when the impact pairs, after the fire frame.
			const fxAfter = await m.gate(() => { const fx = globalThis.steelseed.ctx.get('fx'); return { tracers: fx.stats.startedTracers, zaps: fx.teslaArcStats.struck } })
			if (drawn !== null) { drawn.tracers = fxAfter.tracers - fxBefore.tracers; drawn.zaps = fxAfter.zaps - fxBefore.zaps }
			for (const weapon of new Set(weapons)) {
				const shots = (after.fires[actor.id]?.[weapon] ?? 0)
				const hits = (after.impacts[weapon.toLowerCase()] ?? 0) - (before.impacts[weapon.toLowerCase()] ?? 0)
				const shown = drawn !== null && (drawn.flash > 0 || drawn.shells > 0 || drawn.bodies > 0 || drawn.tracers > 0 || drawn.zaps > 0)
				report.push(`${spec.type} ${weapon}: order ${String(reply).slice(0, 70)}, fired ${shots}, impacts ${hits}, drawn ${JSON.stringify(drawn)}`)
				if (shots > 0 && hits > 0 && shown)
					evidence[`${spec.type}:Armament.Weapon:${weapon.toLowerCase()}`] = `S05 vfxscenario weapons ${date}: fired ${shots}x, ${hits} impact event(s), drawn (flash ${drawn.flash}, shell ${drawn.shells}, body ${drawn.bodies}, tracer ${drawn.tracers}, bolt ${drawn.zaps})`
			}
			await m.gate(ids => globalThis.__live.unitOrder(ids, 'Stop'), [actor.id])
			if (spec.kind !== 'defense') await m.moveTo([actor.id], siteX - 6 - captures.length % 5, siteY + 6 + (captures.length % 4))
		}
		for (const line of report) console.log(`  ${line}`)
		const file = existsSync(EVIDENCE_FILE) ? JSON.parse(readFileSync(EVIDENCE_FILE, 'utf8')) : { schemaVersion: 1, weapons: {}, actions: {} }
		Object.assign(file.weapons, evidence)
		file.weapons = Object.fromEntries(Object.entries(file.weapons).sort(([a], [b]) => a < b ? -1 : 1))
		writeFileSync(EVIDENCE_FILE, JSON.stringify(file, null, '\t') + '\n')
		console.log(`  evidence: ${Object.keys(evidence).length} weapon uses shown in game -> ${EVIDENCE_FILE}`)
		return captures
	},
	async cannon(m) {
		await m.devAll()
		const yard = await m.yard()
		await m.build('weap')
		const [light] = await m.gate(() => globalThis.__live.own('1tnk'))
		const [heavy] = await m.produce('3tnk', 1)
		if (!light) throw new Error('no 1TNK in the heavy start')
		// A firing line east of the yard, targets six cells beyond it on open ground.
		const lineX = Math.floor(yard.x) + 8, lineY = Math.floor(yard.y) + 8
		await m.moveTo([light.id], lineX, lineY)
		await m.moveTo([heavy.id], lineX, lineY + 3)
		await m.waitFor(({ a, b, x, y }) => {
			const l = globalThis.__live, A = l.actor(a), B = l.actor(b)
			return A && B && Math.hypot(A.x - x - .5, A.y - y - .5) < 1.2 && Math.hypot(B.x - x - .5, B.y - y - 3.5) < 1.2
		}, { a: light.id, b: heavy.id, x: lineX, y: lineY }, 'the firing line', 60000)
		const captures = []
		await m.hideHud()
		// Zoom notches accumulate, so zoom once; each stage only refocuses.
		await m.view(lineX + 3, lineY + 1, { zoom: 7 })
		const stats = () => m.gate(() => { const fx = globalThis.steelseed.ctx.get('fx'); const s = fx.stats; return { tier: fx.vfxTier, gas: s.muzzleSmokeSpawns, strike: s.impactVocabularySpawns, shells: s.shellStreaks, flown: s.flownImpacts, tracers: s.startedTracers, alive: fx.particles?.stats?.alive, scorch: fx.scorchStats?.active } })
		const shoot = async (label, stage) => { await m.shot(`cannon-${label}-${stage}`); captures.push(`cannon-${label}-${stage}`); console.log(`  ${label} ${stage} ${JSON.stringify(await stats())}`) }
		for (const [label, tank, row, weapon] of [['1tnk', light, lineY, '25mm'], ['3tnk', heavy, lineY + 3, '105mm']]) {
			// Open earth five to seven cells east: the surface decides what a strike throws.
			const target = await m.gate(({ x, y }) => {
				for (let d = 6; d <= 8; d++) for (let dy = -2; dy <= 2; dy++) {
					const s = globalThis.__live.surface(x + d, y + dy)
					if (s === 0 || s === 4) return { x: x + d, y: y + dy, surface: s }
				}
				return { x: x + 6, y, surface: globalThis.__live.surface(x + 6, y) }
			}, { x: lineX, y: row })
			await m.view(lineX + 2.5, row + 0.5)
			// The muzzle: frozen on the fire event, then 1, 3 and 6 ticks on.
			const fired = m.freezeOn('sim:weapon:fire', { actorId: tank.id })
			await m.forceFire([tank.id], target.x, target.y)
			await fired
			await m.page.waitForTimeout(250)
			await shoot(label, '0-fire')
			for (const [ticks, stage] of [[1, '1-muzzle'], [2, '2-muzzle'], [3, '3-muzzle']]) { await m.advanceTicks(ticks); await shoot(label, stage) }
			// The strike: frozen on its impact event (surface ${target.surface}), then 3, 8, 20 and 50 ticks on.
			// Closer for the strike: materials, haze and the scorch are small things.
			await m.view(target.x + 0.5, target.y + 0.5, { zoom: 4 })
			const struck = m.freezeOn('sim:projectile:impact', { weapon })
			await m.resume()
			await struck
			await m.page.waitForTimeout(250)
			await shoot(label, '4-impact')
			for (const [ticks, stage] of [[3, '5-burst'], [5, '6-dust'], [12, '7-haze'], [30, '8-settled']]) { await m.advanceTicks(ticks); await shoot(label, stage) }
			await m.gate(ids => globalThis.__live.unitOrder(ids, 'Stop'), [tank.id])
			await m.resume()
			await m.view(lineX + 3, lineY + 1, { zoom: -4 })
		}
		return captures
	},
}

/**
 * S06 / Epic 6, deaths: every vehicle, aircraft and ship produced in a real match and killed with
 * OpenRA's own developer kill (DeveloperMode DevKill: the actor dies as if destroyed). The session
 * freezes on its destruction event; captures at 0, 12 and 60 ticks show the burst, the fire and
 * what stays. The report says what each death left: the husk OpenRA spawned, the remains the
 * renderer drew or the crash it flew, the death explosions (FireWarheadsOnDeath) and the fire.
 */
scenarios.deaths = async function deaths(m) {
	await m.devAll()
	const yard = await m.yard()
	for (const factory of ['weap', 'afld', 'hpad', 'syrd', 'spen', 'tent']) try { await m.build(factory) } catch (error) { console.log(`  ${factory}: ${error.message.slice(0, 80)}`) }
	await installWeaponObserver(m)
	await m.hideHud()
	const captures = [], report = [], date = new Date().toISOString().slice(0, 10)
	const TYPES = ['1tnk', '2tnk', '3tnk', '4tnk', 'arty', 'v2rl', 'ftrk', 'jeep', 'apc', 'harv', 'mcv', 'truk', 'mrj', 'mgg', 'ctnk', 'stnk',
		'qtnk', 'dtrk', 'ttnk', 'mnly.ap', 'mnly.at', 'mig', 'yak', 'heli', 'mh60', 'tran', 'pt', 'dd', 'ca', 'ss', 'msub', 'lst']
	const probe = () => {
		const ctx = globalThis.steelseed.ctx, units = ctx.get('units'), fx = ctx.get('fx')
		const actors = globalThis.__live.own()
		return { deaths: { ...units.deathStats }, fire: { ...fx.groundFireStats }, impacts: { ...globalThis.__weaponObs.impacts },
			types: actors.map(a => a.type) }
	}
	for (const type of TYPES.filter(t => ONLY.length === 0 || ONLY.includes(t))) {
		let actor
		// DevAll grants its cash once; 31 purchases outrun it, and a queue without money waits forever.
		await m.gate(() => globalThis.__live.playerOrder('DevGiveCash'))
		try { [actor] = await m.produce(type, 1) } catch (error) { report.push(`${type}: not produced (${error.message.slice(0, 80)})`); console.log(`  ${report.at(-1)}`); continue }
		// Aircraft take off and fly a few cells out, so they die in the air and crash; ground units
		// and ships leave their factory's door for open ground or water, so the death is in view.
		const flying = ['mig', 'yak', 'heli', 'mh60', 'tran'].includes(type)
		const naval = ['pt', 'dd', 'ca', 'ss', 'msub', 'lst'].includes(type)
		const out = flying ? { x: Math.floor(yard.x) + 8, y: Math.floor(yard.y) - 6 }
			: naval ? { x: Math.round(actor.x) + 5, y: Math.round(actor.y) + 3 }
			: await landNear(m, actor.x, actor.y, 7)
		if (out) {
			await m.moveTo([actor.id], out.x, out.y)
			await m.page.waitForTimeout(flying ? 5000 : 3500)
			actor = await m.gate(id => globalThis.__live.actor(id), actor.id) ?? actor
		}
		// Close on the ground; wider for aircraft, which die at altitude above their ground point.
		await m.view(actor.x + 0.5, actor.y + 0.5, { zoom: flying ? 0 : 3, settleMs: 700 })
		const before = await m.gate(probe)
		const frozen = m.freezeOn('sim:actor:destroyed', { actorId: actor.id }, 20000)
		// DevKill's TargetString is its damage types (DeveloperMode splits it): a shell's kill.
		const reply = await m.gate(id => globalThis.__live.playerOrder('DevKill', { targetActorId: id, targetString: 'ExplosionDeath' }), actor.id)
		try {
			await frozen
			await m.page.waitForTimeout(200)
			await m.shot(`death-${type}-0`); captures.push(`death-${type}-0`)
			await m.advanceTicks(12)
			await m.shot(`death-${type}-12`); captures.push(`death-${type}-12`)
			await m.advanceTicks(48)
			await m.shot(`death-${type}-60`); captures.push(`death-${type}-60`)
			await m.resume()
			await m.page.waitForTimeout(1500)
		} catch (error) { await m.resume(); report.push(`${type}: no destruction (${error.message.slice(0, 60)}; DevKill ${String(reply).slice(0, 40)})`); console.log(`  ${report.at(-1)}`); continue }
		const after = await m.gate(probe)
		const husks = after.types.filter(t => /husk/.test(t)).filter((t, i, all) => all.indexOf(t) === i && !before.types.includes(t))
		const explosions = Object.fromEntries(Object.entries(after.impacts).map(([w, n]) => [w, n - (before.impacts[w] ?? 0)]).filter(([, n]) => n > 0))
		const remains = after.deaths.births - before.deaths.births, crashes = after.deaths.impacts - before.deaths.impacts
		const fires = (after.fire.ignited ?? 0) - (before.fire.ignited ?? 0)
		const line = `killed; husk ${husks.join('/') || 'none'}; remains drawn ${remains}; crash impacts ${crashes}; death explosions ${JSON.stringify(explosions)}; ground fires ${fires}`
		report.push(`${type}: ${line}`)
		console.log(`  ${report.at(-1)}`)
		// Written per death, so a later stall loses nothing already shown.
		writeEvidence({}, { [`${type}:death`]: `S06 vfxscenario deaths ${date}: ${line}` })
	}
	return captures
}

/**
 * Epic 3/6/7, special actions in a real match, each through the path a player uses (HUD clicks for
 * the powers, the unit's own order for an action), with what OpenRA did and what the screen showed:
 *   gps       the tech centre's satellite: OpenRA fires it the moment it charges; it rises out of
 *             the tech centre and allies read "Satellite launched".
 *   spyplane  the airfield's spy plane: the beacon stands until the U2 is over the target area.
 *   parabombs the bomber's parabombs fall under chutes.
 *   mrj, mgg  selected, they show the ranges OpenRA shows (jammer 18 and 5 cells, gap 7).
 *   ctnk      the Chrono Tank jumps and flashes at both ends.
 *   mnly      each minelayer (AP, AT) lays a mine at its feet.
 *   stnk      the stealth tank cloaks when idle, and the snapshot says so.
 *   spy       the spy takes a soldier's disguise.
 *   e6, thf   an engineer and a thief walk into the enemy base: a capture, an infiltration.
 *   c4        Riki's demolition charge on a neutral structure.
 *   downwash  a helicopter lifting off and flying low washes the ground (Ultra).
 *   materials 90mm into a tree (splinters) and the shallows (wet mud); a rifle's spent cases.
 *   flamer    E4's flame packets, the contact fire they light and its going out.
 *   msubaa    the missile sub's anti-air missile at an aircraft (sea maps: --map=Archipelago).
 *   incoming  an enemy nuclear launch reaches us as OpenRA's Incoming warning, never a beacon.
 *   fake      the FAKE tag's UI path, with a synthetic status naming an enemy structure revealed.
 *   sonar     the sonar pulse's UI path, with a synthetic status (the real power needs a spy in
 *             an enemy sub pen): the fired pulse is drawn on the water where it was sent.
 */
scenarios.special = async function special(m) {
	await m.devAll()
	await m.gate(() => globalThis.__live.playerOrder('DevGiveCash', { extraData: 60000 }))
	const yard = await m.yard()
	// The Ukraine airfield's powers are proven on their own: then it is the only airfield.
	const ukraineOnly = ONLY.length > 0 && ONLY.every(o => o === 'ukraine')
	for (const factory of ukraineOnly ? ['weap', 'tent', 'afld.ukraine'] : ['weap', 'tent', 'barr', 'afld', 'atek', 'dome'])
		try { await m.build(factory) } catch (error) { console.log(`  ${factory}: ${error.message.slice(0, 80)}`) }
	const captures = [], report = [], actions = {}, date = new Date().toISOString().slice(0, 10)
	const want = type => ONLY.length === 0 || ONLY.includes(type)
	const site = { x: Math.floor(yard.x) + 9, y: Math.floor(yard.y) + 9 }
	const fx = () => m.gate(() => { const f = globalThis.steelseed.ctx.get('fx'); return { ...f.stats, bombs: f.parachuteStats.bombs, contrails: f.aircraftContrailStats } })
	const record = (key, line) => { report.push(`${key}: ${line}`); actions[key] = `S02 vfxscenario special ${date}: ${line}` }
	const clickCell = async (x, y, button = 'left') => {
		const px = await m.gate(({ x, y }) => globalThis.__live.cellPx(x, y), { x, y })
		await m.page.mouse.move(px.x, px.y); await m.page.waitForTimeout(120)
		await m.page.mouse.down({ button }); await m.page.mouse.up({ button }); await m.page.waitForTimeout(150)
	}
	// A unit fresh from its factory stands in the door among others: drive it to open land first
	// (a distinct spot per call), then select it the way a player does and confirm the click took.
	let outings = 0
	const driveOut = async unit => {
		const out = await landNear(m, unit.x, unit.y, 7 + 2 * (outings++ % 4))
		if (!out) return unit
		await m.moveTo([unit.id], out.x, out.y)
		await m.waitFor(({ id, x, y }) => { const a = globalThis.__live.actor(id); return !a || (Math.floor(a.x) === x && Math.floor(a.y) === y) }, { id: unit.id, ...out }, `${unit.type} in the open`, 40000).catch(() => {})
		await m.page.waitForTimeout(600)
		return await m.gate(id => globalThis.__live.actor(id), unit.id) ?? unit
	}
	const selectByClick = async unit => {
		await m.view(unit.x, unit.y, { zoom: -2 })
		const px = await m.gate(({ x, y }) => globalThis.__live.cellPx(Math.floor(x), Math.floor(y), 0.5), unit)
		await m.page.mouse.click(px.x, px.y); await m.page.waitForTimeout(500)
		const selected = await m.gate(id => globalThis.steelseed.ctx.get('ui').selected.includes(id), unit.id)
		if (!selected) throw new Error(`the click did not select the ${unit.type}`)
	}
	const beaconUp = () => m.gate(() => [...document.querySelectorAll('svg path')].some(p => p.getAttribute('fill') === 'rgba(255,86,64,0.85)' && p.style.display !== 'none'))
	const firePower = async (pattern, cell) => {
		const key = await m.waitFor(p => globalThis.__live.powers().find(x => new RegExp(p, 'i').test(x.key) && x.ready)?.key ?? false, pattern, `${pattern} ready`, 90000)
		await m.view(cell.x + 0.5, cell.y + 0.5, { zoom: 1 })
		await m.page.click(`#hud-support-list button[data-power="${key}"]`); await m.page.waitForTimeout(200)
		await clickCell(cell.x, cell.y)
		await m.waitFor(k => !globalThis.__live.powers().find(x => x.key === k)?.ready, key, `${key} fired`, 10000)
		return key
	}

	if (want('gps')) try {
		const before = (await fx()).satelliteLaunches
		const atek = (await m.gate(() => globalThis.__live.own('atek')))[0]
		await m.view(atek.x + 0.5, atek.y + 0.5, { zoom: 2 })
		await m.waitFor(n => globalThis.steelseed.ctx.get('fx').stats.satelliteLaunches > n, before, 'the satellite launch', 120000)
		await m.page.waitForTimeout(700); await m.shot('gps-1'); captures.push('gps-1')
		await m.page.waitForTimeout(900); await m.shot('gps-2'); captures.push('gps-2')
		const notice = await m.gate(() => document.getElementById('hud-notice')?.textContent ?? '')
		record('atek:GpsPower', `launched by OpenRA on charge; drawn rising from the tech centre (${(await fx()).satelliteLaunches - before} launch); notice "${notice.slice(0, 60)}"`)
	} catch (error) { report.push(`gps: ${error.message.slice(0, 100)}`) }

	if (want('spyplane')) try {
		const target = { x: site.x + 6, y: site.y - 10 }
		const key = await firePower('spyplane', target)
		const up = await beaconUp()
		const u2 = await m.waitFor(() => globalThis.__live.own('u2')[0] ?? false, undefined, 'the U2 in the air', 20000)
		await m.view(u2.x + 0.5, u2.y + 0.5, { zoom: 1 }); await m.page.waitForTimeout(1500)
		await m.shot('spyplane-1'); captures.push('spyplane-1')
		await m.waitFor(({ x, y }) => { const u = globalThis.__live.own('u2')[0]; return !u || Math.hypot(u.x - x, u.y - y) < 6 }, target, 'the U2 over the target area', 60000)
		await m.page.waitForTimeout(600)
		const down = !(await beaconUp())
		const trail = (await fx()).contrails
		record('afld:AirstrikePower', `spy plane: ${key} accepted; beacon ${up ? 'posted' : 'MISSING'} and ${down ? 'removed when the U2 reached the target area' : 'STILL UP'}; U2 flew (contrail stats ${JSON.stringify(trail).slice(0, 80)})`)
	} catch (error) { report.push(`spyplane: ${error.message.slice(0, 100)}`) }

	if (want('parabombs')) try {
		const target = { x: site.x - 6, y: site.y + 6 }
		const key = await firePower('parabombs', target)
		const up = await beaconUp()
		await m.waitFor(() => globalThis.steelseed.ctx.get('fx').parachuteStats.bombs > 0, undefined, 'a parabomb under its chute', 60000)
		const bomb = await m.gate(() => { const c = globalThis.steelseed.ctx.get('fx').projectiles?.chutes; return c && c.count ? { x: c.x[0], z: c.z[0] } : null })
		if (bomb) await m.view(bomb.x, bomb.z, { zoom: 3, settleMs: 200 })
		await m.shot('parabombs-1'); captures.push('parabombs-1')
		record('afld:AirstrikePower', `${actions['afld:AirstrikePower'] ? actions['afld:AirstrikePower'].replace(/^S02 vfxscenario special [0-9-]+: /, '') + '; ' : ''}parabombs: ${key} accepted; beacon ${up ? 'posted' : 'MISSING'}; parabombs drawn under chutes (${(await fx()).bombs} at capture)`)
	} catch (error) { report.push(`parabombs: ${error.message.slice(0, 100)}`) }

	for (const [type, expected, trait] of [['mrj', 2, 'JamsMissiles'], ['mgg', 1, 'CreatesShroud']]) {
		if (!want(type)) continue
		try {
			const unit = await driveOut((await m.produce(type, 1))[0])
			await selectByClick(unit)
			const outlines = await m.gate(() => [...document.querySelectorAll('svg path[stroke-dasharray="7 5"]')].filter(p => p.style.display !== 'none' && (p.getAttribute('d') ?? '').length > 0).map(p => p.getAttribute('stroke')))
			await m.shot(`${type}-ranges`); captures.push(`${type}-ranges`)
			if (outlines.length !== expected) throw new Error(`selected, but ${outlines.length} range outline(s) drawn (expected ${expected})`)
			record(`${type}:${trait}`, `selected by a click in the open; ${outlines.length} range outline(s) drawn on the ground as OpenRA's WithRangeCircle (${outlines.join(', ')})`)
			await m.page.keyboard.press('Escape')
		} catch (error) { report.push(`${type}: ${error.message.slice(0, 100)}`) }
	}

	if (want('ctnk')) try {
		const [tank] = await m.produce('ctnk', 1)
		const dest = await landNear(m, tank.x + 7, tank.y, 0)
		const before = (await fx()).teleports
		await m.view(tank.x + 3.5, tank.y + 0.5, { zoom: 2 })
		const reply = await m.gate(({ id, x, y }) => globalThis.__live.unitOrder([id], 'PortableChronoTeleport', { targetCell: { x, y } }), { id: tank.id, ...dest })
		await m.waitFor(n => globalThis.steelseed.ctx.get('fx').stats.teleports > n, before, 'the Chrono Tank jump', 15000)
		await m.shot('ctnk-jump'); captures.push('ctnk-jump')
		const after = await m.gate(id => globalThis.__live.actor(id), tank.id)
		record('ctnk:PortableChrono', `order ${String(reply).slice(0, 40)}; jumped to (${Math.floor(after.x)},${Math.floor(after.y)}) for (${dest.x},${dest.y}); drawn as a jump with chrono flashes (${(await fx()).teleports - before})`)
	} catch (error) { report.push(`ctnk: ${error.message.slice(0, 100)}`) }

	// The roster's minelayers are the AP and AT variants (mnly.ap lays minp, mnly.at lays minv).
	for (const type of ['mnly.ap', 'mnly.at']) if (want('mnly') || want(type)) try {
		const layer = await driveOut((await m.produce(type, 1))[0])
		const mines = () => globalThis.__live.own().filter(a => /^min[pv]$/.test(a.type)).length
		const before = await m.gate(mines)
		const reply = await m.gate(({ id, x, y }) => globalThis.__live.unitOrder([id], 'PlaceMine', { targetCell: { x, y } }), { id: layer.id, x: Math.floor(layer.x), y: Math.floor(layer.y) })
		await m.waitFor(n => globalThis.__live.own().filter(a => /^min[pv]$/.test(a.type)).length > n, before, 'a mine laid', 20000)
		await m.view(layer.x + 0.5, layer.y + 0.5, { zoom: 3 }); await m.shot(`${type}-mine`); captures.push(`${type}-mine`)
		const laid = await m.gate(() => globalThis.__live.own().filter(a => /^min[pv]$/.test(a.type)).map(a => a.type))
		record(`${type}:Minelayer`, `order ${String(reply).slice(0, 40)}; ${laid.length - before} own mine(s) laid and drawn (${[...new Set(laid)].join(', ')})`)
	} catch (error) { report.push(`${type}: ${error.message.slice(0, 100)}`) }

	if (want('stnk')) try {
		const [tank] = await m.produce('stnk', 1)
		await m.view(tank.x + 0.5, tank.y + 0.5, { zoom: 3 })
		const cloaked = await m.waitFor(id => {
			const snap = globalThis.steelseed.ctx.snapshot
			for (let i = 0; i < snap.actors.count; i++) if (snap.actors.id[i] === id) return (snap.actors.flags[i] & 2) !== 0
			return false
		}, tank.id, 'the stealth tank cloaked', 30000).then(() => true, () => false)
		await m.shot('stnk-cloaked'); captures.push('stnk-cloaked')
		if (!cloaked) throw new Error('the cloaked flag was never set')
		record('stnk:Cloak', 'cloaked flag set after its CloakDelay; the owner still sees it with the disguise ring (contrail, track and wake emitters stand down for cloaked actors)')
	} catch (error) { report.push(`stnk: ${error.message.slice(0, 100)}`) }

	for (const spyType of ['spy', 'spy.england']) if (want(spyType)) try {
		const [spy] = await m.produce(spyType, 1)
		const enemy = (await m.gate(() => globalThis.__live.enemy())).filter(a => /^e[1-4]$/.test(a.type))[0]
		const [soldier] = enemy ? [enemy] : await m.produce('e1', 1)
		const reply = await m.gate(({ id, t }) => globalThis.__live.unitOrder([id], 'Disguise', { targetActorId: t }), { id: spy.id, t: soldier.id })
		// The snapshot keeps the spy's identity in typeId and its disguise in displayTypeId.
		const worn = await m.waitFor(id => {
			const ctx = globalThis.steelseed.ctx, a = ctx.snapshot.actors
			for (let i = 0; i < a.count; i++) if (a.id[i] === id && a.displayTypeId[i] !== a.typeId[i]) return ctx.actorTypeName(a.displayTypeId[i])
			return false
		}, spy.id, 'the disguise worn', 60000).catch(() => null)
		const now = await m.gate(id => globalThis.__live.actor(id), spy.id) ?? spy
		await m.view(now.x + 0.5, now.y + 0.5, { zoom: 3 })
		await m.shot(`${spyType}-disguise`); captures.push(`${spyType}-disguise`)
		if (!worn) throw new Error(`Disguise ${String(reply).slice(0, 30)}, but the spy never wore it`)
		record(`${spyType}:Disguise`, `order on ${enemy ? 'an enemy' : 'an own'} ${soldier.type} ${String(reply).slice(0, 20)}; the spy now presents as ${worn} (displayTypeId), with the owner's disguise ring`)
		await m.page.keyboard.press('Escape')
	} catch (error) { report.push(`${spyType}: ${error.message.slice(0, 100)}`) }

	if (want('e6') || want('thf')) try {
		const enemies = await m.gate(() => globalThis.__live.enemy())
		// A neutral tech building (oil derrick, hospital, ...) is the capture a player makes first;
		// an enemy base building only when the map has none.
		const neutral = await m.gate(() => {
			const snap = globalThis.steelseed.ctx.snapshot, me = snap.world.renderPlayer, out = []
			for (let i = 0; i < snap.actors.count; i++) {
				const type = globalThis.steelseed.ctx.actorTypeName(snap.actors.typeId[i])
				if (snap.actors.owner[i] !== me && /^(oilb|hosp|miss|bio|fcom)$/.test(type) && snap.players.some(p => p.id === snap.actors.owner[i] && p.relation === 3))
					out.push({ id: snap.actors.id[i], type, x: snap.actors.posX[i] / 1024, y: snap.actors.posY[i] / 1024, owner: snap.actors.owner[i] })
			}
			return out
		})
		const building = neutral.sort((a, b) => Math.hypot(a.x - yard.x, a.y - yard.y) - Math.hypot(b.x - yard.x, b.y - yard.y))[0]
			?? enemies.find(a => /^(fact|powr|apwr|barr|tent|proc|weap)$/.test(a.type))
		const refinery = enemies.find(a => a.type === 'proc' || a.type === 'silo')
		const [engineer] = want('e6') && building ? await m.produce('e6', 1) : [null]
		const [thief] = want('thf') && refinery ? await m.produce('thf', 1) : [null]
		const cashBefore = await m.gate(() => globalThis.steelseed.ctx.snapshot.players.find(p => p.id === globalThis.steelseed.ctx.snapshot.world.renderPlayer)?.cash ?? null)
		if (engineer) await m.gate(({ id, t }) => globalThis.__live.unitOrder([id], 'CaptureActor', { targetActorId: t }), { id: engineer.id, t: building.id })
		if (thief) await m.gate(({ id, t }) => globalThis.__live.unitOrder([id], 'Infiltrate', { targetActorId: t }), { id: thief.id, t: refinery.id })
		if (engineer) {
			const captured = await m.waitFor(({ t, me }) => { const a = globalThis.__live.actor(t); return a && a.owner === me }, { t: building.id, me: await m.gate(() => globalThis.steelseed.ctx.snapshot.world.renderPlayer) }, 'the capture', 150000).then(() => true, () => false)
			const b = await m.gate(t => globalThis.__live.actor(t), building.id)
			if (b) { await m.view(b.x + 0.5, b.y + 0.5, { zoom: 2 }); await m.shot('e6-capture'); captures.push('e6-capture') }
			if (captured) record('e6:Captures', `captured the ${neutral.includes(building) ? 'neutral' : 'enemy'} ${building.type}: it is now owned by the player`)
			else report.push(`e6: did not capture the ${building.type} within 150 s (engineer ${await m.gate(id => globalThis.__live.actor(id) ? 'alive' : 'lost', engineer.id)})`)
		}
		if (thief) {
			const stole = await m.waitFor(id => !globalThis.__live.actor(id), thief.id, 'the infiltration', 150000).then(() => true, () => false)
			const cashAfter = await m.gate(() => globalThis.steelseed.ctx.snapshot.players.find(p => p.id === globalThis.steelseed.ctx.snapshot.world.renderPlayer)?.cash ?? null)
			if (stole && cashAfter > cashBefore) record('thf:Infiltrates', `entered the enemy ${refinery.type}; own cash ${cashBefore} -> ${cashAfter}`)
			else report.push(`thf: ${stole ? `entered, but cash ${cashBefore} -> ${cashAfter}` : `did not reach the enemy ${refinery.type} within 150 s`}`)
		}
	} catch (error) { report.push(`e6/thf: ${error.message.slice(0, 100)}`) }

	// Neutral structures on the map (oil derricks, hospitals, the tech centre), nearest first.
	const neutralsOf = pattern => m.gate(({ pattern, x, y }) => {
		const ctx = globalThis.steelseed.ctx, snap = ctx.snapshot, re = new RegExp(pattern), out = []
		for (let i = 0; i < snap.actors.count; i++) {
			const type = ctx.actorTypeName(snap.actors.typeId[i])
			if (!re.test(type) || !snap.players.some(p => p.id === snap.actors.owner[i] && p.relation === 3) || snap.actors.health[i] === 0) continue
			out.push({ id: snap.actors.id[i], type, x: snap.actors.posX[i] / 1024, y: snap.actors.posY[i] / 1024 })
		}
		return out.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))
	}, { pattern, x: yard.x, y: yard.y })

	if (want('c4')) try {
		// Riki's demolition charge on a neutral structure: the C4 order, the delay, the blast.
		const [target] = await neutralsOf('^(hosp|miss|oilb|bio|fcom)$')
		if (!target) throw new Error('no neutral structure on this map')
		const riki = await driveOut((await m.produce('e7', 1))[0])
		await installWeaponObserver(m)
		const reply = await m.gate(({ id, t }) => globalThis.__live.unitOrder([id], 'C4', { targetActorId: t }), { id: riki.id, t: target.id })
		await m.view(target.x + 0.5, target.y + 0.5, { zoom: 1 })
		await m.waitFor(id => globalThis.__live.actor(id) === null, target.id, 'the demolished structure', 90000)
		await m.page.waitForTimeout(250); await m.shot('e7-c4'); captures.push('e7-c4')
		record('e7:Demolition', `C4 on the neutral ${target.type} (${String(reply).slice(0, 20)}): Riki walked in, set the charge and after its DetonationDelay the structure was destroyed, drawn as a building collapse`)
	} catch (error) { report.push(`c4: ${error.message.slice(0, 100)}`) }

	if (want('downwash')) try {
		// A helicopter low over open ground blows up what lies there (Ultra): landing and lifting.
		try { await m.build('hpad') } catch (error) { report.push(`hpad: ${error.message.slice(0, 60)}`) }
		const heli = (await m.produce('heli', 1))[0]
		const spot = await landNear(m, heli.x, heli.y, 6)
		await m.view(heli.x + 0.5, heli.y + 0.5, { zoom: 2 })
		await m.gate(() => { globalThis.__wash = 0; const fx = globalThis.steelseed.ctx.get('fx'); const step = () => { globalThis.__wash = Math.max(globalThis.__wash, fx.downwashStats.washing); if (globalThis.__wash < 1e9) requestAnimationFrame(step) }; requestAnimationFrame(step) })
		await m.moveTo([heli.id], spot.x, spot.y)
		await m.waitFor(() => globalThis.__wash > 0, undefined, 'a helicopter low enough to wash', 30000)
		await m.page.waitForTimeout(300); await m.shot('heli-downwash'); captures.push('heli-downwash')
		const peak = await m.gate(() => globalThis.__wash)
		record('heli:RotorDownwash', `lifting off and flying low over open ground: the rotor washed it (up to ${peak} helicopter(s) washing at once; dust off earth, spray off water), cosmetic only`)
	} catch (error) { report.push(`downwash: ${error.message.slice(0, 100)}`) }

	if (want('materials')) try {
		// Weapon energy against what it hits: a tank's shells into a tree (wood splinters) and into
		// the shallows (wet mud), and a rifleman's spent cases.
		const tank = await driveOut((await m.produce('2tnk', 1))[0])
		const stats = () => m.gate(() => { const s = globalThis.steelseed.ctx.get('fx').stats; return { wood: s.woodStrikes, mud: s.mudStrikes, casings: s.casings } })
		const s0 = await stats()
		const tree = await m.gate(({ x, y }) => {
			const ctx = globalThis.steelseed.ctx, snap = ctx.snapshot
			let best = null
			for (let i = 0; i < snap.actors.count; i++) {
				const type = ctx.actorTypeName(snap.actors.typeId[i])
				if (!/^(t[0-9]+|tc[0-9]+)$/.test(type)) continue
				const d = Math.hypot(snap.actors.posX[i] / 1024 - x, snap.actors.posY[i] / 1024 - y)
				if (!best || d < best.d) best = { id: snap.actors.id[i], x: snap.actors.posX[i] / 1024, y: snap.actors.posY[i] / 1024, d }
			}
			return best
		}, tank)
		if (tree) {
			await m.view(tree.x + 0.5, tree.y + 0.5, { zoom: 2 })
			await m.attack([tank.id], tree.id)
			await m.waitFor(n => globalThis.steelseed.ctx.get('fx').stats.woodStrikes > n, s0.wood, 'splinters off the tree', 30000).catch(() => {})
			await m.shot('wood-strike'); captures.push('wood-strike')
			await m.gate(id => globalThis.__live.unitOrder([id], 'Stop'), tank.id)
		}
		const shallow = await m.gate(({ x, y }) => {
			for (let d = 2; d < 40; d++) for (let a = 0; a < 32; a++) {
				const cx = Math.round(x + Math.cos(a / 32 * Math.PI * 2) * d), cy = Math.round(y + Math.sin(a / 32 * Math.PI * 2) * d)
				if (globalThis.__live.surface(cx, cy) === 9) return { x: cx, y: cy }
			}
			return null
		}, tank)
		if (shallow) {
			await m.view(shallow.x + 0.5, shallow.y + 0.5, { zoom: 2 })
			await m.forceFire([tank.id], shallow.x, shallow.y)
			await m.waitFor(n => globalThis.steelseed.ctx.get('fx').stats.mudStrikes > n, s0.mud, 'wet mud off the shallows', 30000).catch(() => {})
			await m.shot('mud-strike'); captures.push('mud-strike')
			await m.gate(id => globalThis.__live.unitOrder([id], 'Stop'), tank.id)
		}
		const rifle = await driveOut((await m.produce('e1', 1))[0])
		await m.view(rifle.x + 0.5, rifle.y + 0.5, { zoom: 3 })
		await m.forceFire([rifle.id], Math.floor(rifle.x) + 4, Math.floor(rifle.y))
		await m.waitFor(n => globalThis.steelseed.ctx.get('fx').stats.casings > n, s0.casings, 'a spent case', 20000).catch(() => {})
		await m.shot('casings'); captures.push('casings')
		await m.gate(id => globalThis.__live.unitOrder([id], 'Stop'), rifle.id)
		const s1 = await stats()
		// Each material on its own row: a map may offer trees but no shallows, or the reverse.
		if (s1.wood > s0.wood) record('fx:materials.wood', `a 2TNK's 90mm into a tree on ${m.map.title}: ${s1.wood - s0.wood} strike(s) threw wood splinters`)
		if (s1.mud > s0.mud) record('fx:materials.mud', `a 2TNK's 90mm into the shallows on ${m.map.title}: ${s1.mud - s0.mud} strike(s) threw wet mud instead of a water column`)
		if (s1.casings > s0.casings) record('fx:materials.casings', `an E1's rifle at the ground on ${m.map.title}: ${s1.casings - s0.casings} spent case(s) thrown from the side of the gun`)
		report.push(`materials: wood ${s1.wood - s0.wood}${tree ? '' : ' (no tree near)'}, mud ${s1.mud - s0.mud}${shallow ? '' : ' (no shallows near)'}, casings ${s1.casings - s0.casings}`)
	} catch (error) { report.push(`materials: ${error.message.slice(0, 140)}`) }

	if (want('flamer')) try {
		// E4's flamer: each shot a packet of flame (the fire events), contact fire where it lands,
		// and that fire always going out, leaving cooling smoke.
		await installWeaponObserver(m)
		const trooper = await driveOut((await m.produce('e4', 1))[0])
		const target = await landNear(m, trooper.x, trooper.y, 3)
		const fire = () => m.gate(() => ({ ...globalThis.steelseed.ctx.get('fx').groundFireStats }))
		const f0 = await fire()
		await m.view(target.x + 0.5, target.y + 0.5, { zoom: 3 })
		await m.forceFire([trooper.id], target.x, target.y)
		const c0 = await m.gate(() => globalThis.steelseed.ctx.get('fx').stats.contactFires ?? 0)
		await m.waitFor(({ id }) => Object.values(globalThis.__weaponObs.fires[id] ?? {}).reduce((a, b) => a + b, 0) >= 3, { id: trooper.id }, 'three flame packets', 20000)
		// A packet lands a moment after it leaves the nozzle: wait for the contact fires themselves.
		await m.waitFor(n => (globalThis.steelseed.ctx.get('fx').stats.contactFires ?? 0) > n, c0, 'a contact fire', 10000).catch(() => {})
		await m.shot('flamer-firing'); captures.push('flamer-firing')
		await m.gate(id => globalThis.__live.unitOrder([id], 'Stop'), trooper.id)
		const shots = await m.gate(id => globalThis.__weaponObs.fires[id] ?? {}, trooper.id)
		const lit = await fire()
		await m.page.waitForTimeout(2500); await m.shot('flamer-cooling'); captures.push('flamer-cooling')
		// The contact fire goes out on its own clock (ground-fire: finite, never persistent).
		const out = await m.waitFor(n => (globalThis.steelseed.ctx.get('fx').groundFireStats.active ?? 0) <= n, f0.active ?? 0, 'the flames out', 90000).then(() => true, () => false)
		if (!((lit.ignited ?? 0) > (f0.ignited ?? 0))) {
			const why = await m.gate(() => { const s = globalThis.steelseed.ctx.get('fx').stats; return { contactFires: s.contactFires, accepted: s.acceptedImpactEvents, unpaired: s.unpairedImpacts, vocabulary: s.impactVocabularySpawns, impacts: globalThis.__weaponObs.impacts } })
			throw new Error(`no contact fire (${JSON.stringify(lit)}; ${JSON.stringify(why).slice(0, 300)})`)
		}
		record('e4:Armament.Flamer', `a forced attack on the ground: ${JSON.stringify(shots)} flame packets, one per shot; ${(lit.ignited ?? 0) - (f0.ignited ?? 0)} contact fire(s) lit where they landed${out ? ', all out again on their own clock, leaving cooling smoke' : ''}`)
	} catch (error) { report.push(`flamer: ${error.message.slice(0, 120)}`) }

	if (want('msubaa')) try {
		// The missile sub's anti-air missile at an aircraft (a forced attack on an own helicopter).
		try { await m.build('spen') } catch (error) { report.push(`spen: ${error.message.slice(0, 60)}`) }
		try { await m.build('hpad') } catch (error) { report.push(`hpad: ${error.message.slice(0, 60)}`) }
		await installWeaponObserver(m)
		let sub = (await m.produce('msub', 1))[0]
		const heli = (await m.produce('heli', 1))[0]
		// Both out on open water, a few cells apart: the sub surfaces to fire.
		const sea = await m.gate(({ x, y }) => {
			for (let d = 4; d < 30; d++) for (let a = 0; a < 24; a++) {
				const cx = Math.round(x + Math.cos(a / 24 * Math.PI * 2) * d), cy = Math.round(y + Math.sin(a / 24 * Math.PI * 2) * d)
				let open = true
				for (let dy = -3; dy <= 3 && open; dy++) for (let dx = -3; dx <= 5 && open; dx++) open = globalThis.__live.surface(cx + dx, cy + dy) === 8
				if (open) return { x: cx, y: cy }
			}
			return null
		}, sub)
		if (!sea) throw new Error('no open water near the sub pen')
		await m.moveTo([sub.id], sea.x, sea.y)
		await m.moveTo([heli.id], sea.x + 4, sea.y)
		await m.page.waitForTimeout(9000)
		sub = await m.gate(id => globalThis.__live.actor(id), sub.id) ?? sub
		await m.view(sub.x + 2, sub.y + 0.5, { zoom: 1 })
		const reply = await m.attack([sub.id], heli.id)
		const fired = await m.waitFor(id => Object.entries(globalThis.__weaponObs.fires[id] ?? {}).some(([w, n]) => /submissileaa/i.test(w) && n > 0), sub.id, 'the anti-air missile', 30000).then(() => true, () => false)
		await m.page.waitForTimeout(400); await m.shot('msub-aa'); captures.push('msub-aa')
		const fires = await m.gate(id => globalThis.__weaponObs.fires[id] ?? {}, sub.id)
		if (!fired) throw new Error(`no SubMissileAA (attack ${String(reply).slice(0, 60)}; fires ${JSON.stringify(fires)})`)
		writeEvidence({ 'msub:Armament.Weapon:submissileaa': `S05 vfxscenario special ${date}: a forced attack on an aircraft: SubMissileAA fired ${JSON.stringify(fires)} and drawn on its own anti-air path` })
		report.push(`msubaa: SubMissileAA fired at the helicopter ${JSON.stringify(fires)}`)
	} catch (error) { report.push(`msubaa: ${error.message.slice(0, 100)}`) }

	if (ukraineOnly) {
		// Each of its three powers through the HUD, with the Ukraine airfield the only one standing.
		const done = []
		for (const [pattern, target] of [['spyplane', { x: site.x + 6, y: site.y - 10 }], ['parabombs', { x: site.x - 6, y: site.y + 6 }], ['paratroop', { x: site.x + 2, y: site.y + 4 }]]) try {
			const key = await firePower(pattern, target)
			done.push(key)
		} catch (error) { report.push(`ukraine ${pattern}: ${error.message.slice(0, 100)}`) }
		const air = done.filter(k => /spy|parabomb/i.test(k)), para = done.filter(k => /paratroop/i.test(k))
		if (air.length) record('afld.ukraine:AirstrikePower', `with the Ukraine airfield the only one, ${air.join(' and ')} through the HUD, accepted by OpenRA (the charge restarted)`)
		if (para.length) record('afld.ukraine:ParatroopersPower', `with the Ukraine airfield the only one, ${para.join(', ')} through the HUD, accepted by OpenRA (the charge restarted)`)
	}

	if (want('incoming')) try {
		// An enemy's launch, as the host reports it (Program.SupportPowers Launches): OpenRA gives
		// its target side the Incoming warning and no beacon (the beacon is the launcher's allies').
		const text = 'Warning: nuclear missile launch detected.'
		await m.gate(text => {
			const ctx = globalThis.steelseed.ctx, real = ctx.supportPowers.bind(ctx), tick = ctx.snapshot.tick
			const launch = { id: 424242, key: 'NukePowerInfoOrder', player: 1, allied: false, tick, text, targetX: 0, targetY: 0, beaconTicks: 0 }
			ctx.supportPowers = () => { const status = real() ?? { schemaVersion: 2, timestepMs: 40, powers: [] }; return { ...status, launches: [...(status.launches ?? []), launch] } }
		}, text)
		const notice = await m.waitFor(t => (document.getElementById('hud-notice')?.textContent ?? '').includes(t) ? document.getElementById('hud-notice').textContent : false, text, 'the incoming warning', 5000)
		await m.page.waitForTimeout(300)
		const beacon = await beaconUp()
		await m.shot('incoming-warning'); captures.push('incoming-warning')
		if (beacon) throw new Error('a beacon was posted for an enemy launch')
		record('mslo:NukePower.incoming', `an enemy launch reached the target side as the Incoming warning ("${notice.slice(0, 50)}") with no beacon, as OpenRA shows it`)
	} catch (error) { report.push(`incoming: ${error.message.slice(0, 100)}`) }

	if (want('fake')) try {
		// The FAKE tag's UI path, with a synthetic status naming a visible enemy structure as
		// revealed (OpenRA's own verdict is spyinfiltrationgate's): the HUD tags it, and only it.
		const enemy = (await m.gate(() => globalThis.__live.enemy())).find(a => /^(fact|powr|apwr|proc|barr|tent|weap|dome)$/.test(a.type))
		if (!enemy) throw new Error('no enemy structure in view')
		await m.gate(id => {
			const ctx = globalThis.steelseed.ctx, real = ctx.supportPowers.bind(ctx)
			ctx.supportPowers = () => { const status = real() ?? { schemaVersion: 2, timestepMs: 40, powers: [] }; return { ...status, revealed: [id] } }
		}, enemy.id)
		await m.view(enemy.x + 0.5, enemy.y + 0.5, { zoom: 1 })
		const tags = await m.waitFor(() => { const shown = [...document.querySelectorAll('.hud-fake-tag')].filter(t => t.style.display !== 'none'); return shown.length ? shown.length : false }, undefined, 'the FAKE tag', 5000)
		await m.shot('fake-tag'); captures.push('fake-tag')
		report.push(`fake: UI path (synthetic revealed status): ${tags} FAKE tag over the enemy ${enemy.type}`)
		if (tags !== 1) throw new Error(`${tags} tags for one revealed structure`)
	} catch (error) { report.push(`fake: ${error.message.slice(0, 100)}`) }

	if (want('sonar')) try {
		// Synthetic status: a ready sonar pulse the HUD can fire. OpenRA refuses the order (the
		// player owns no such power), so the status flips to charging to stand in for the verdict.
		const water = await m.gate(({ x, y }) => {
			for (let d = 0; d < 90; d++) for (let a = 0; a < 48; a++) {
				const cx = Math.round(x + Math.cos(a / 48 * Math.PI * 2) * d), cy = Math.round(y + Math.sin(a / 48 * Math.PI * 2) * d)
				if (globalThis.__live.water(cx, cy) != null && (globalThis.__live.surface(cx, cy) === 8 || globalThis.__live.surface(cx, cy) === 9)) return { x: cx, y: cy }
			}
			return null
		}, { x: yard.x, y: yard.y })
		if (!water) throw new Error('no open water on this map')
		await m.gate(() => {
			const ctx = globalThis.steelseed.ctx, real = ctx.supportPowers.bind(ctx)
			globalThis.__sonar = { ready: true }
			ctx.supportPowers = () => {
				const status = real() ?? { schemaVersion: 2, timestepMs: 40, powers: [] }
				const sonar = { key: 'SpawnActorPowerInfoOrder', title: 'Sonar Pulse (synthetic)', active: true, ready: globalThis.__sonar.ready,
					remainingTicks: globalThis.__sonar.ready ? 0 : 700, totalTicks: 750, needsSource: false, beaconTicks: 0, beaconUnit: null, beaconRangeCells: 0, effectTicks: 250 }
				return { ...status, powers: [...status.powers, sonar] }
			}
		})
		const before = (await fx()).sonarPulses
		await m.view(water.x + 0.5, water.y + 0.5, { zoom: 1 })
		await m.page.waitForTimeout(700)
		await m.page.click('#hud-support-list button[data-power="SpawnActorPowerInfoOrder"]'); await m.page.waitForTimeout(200)
		await clickCell(water.x, water.y)
		await m.gate(() => { globalThis.__sonar.ready = false })
		await m.waitFor(n => globalThis.steelseed.ctx.get('fx').stats.sonarPulses > n, before, 'the sonar pulse drawn', 10000)
		await m.page.waitForTimeout(900); await m.shot('sonar-pulse'); captures.push('sonar-pulse')
		report.push(`sonar: UI path (synthetic status): a fired pulse on open water at (${water.x},${water.y}) is drawn (${(await fx()).sonarPulses - before} pulse)`)
	} catch (error) { report.push(`sonar: ${error.message.slice(0, 100)}`) }

	for (const line of report) console.log(`  ${line}`)
	writeEvidence({}, actions)
	return captures
}

/**
 * Epic 1/3/6: the generic actions a player takes with own actors, each through the path the HUD
 * uses, with what OpenRA did (vfx.md: "per non-weapon action record ... UI path,
 * accepted/rejected response, bridge state/event, animation ... end/cancel behaviour").
 *   passengers  every producible soldier rides an APC and every vehicle an LST: it leaves the
 *               world on entry and stands again after the unload (Passenger, Cargo). The
 *               Chinook, the jeep and the stealth tank carry a rifleman each.
 *   husks       a mechanic enters each own wreck and OpenRA rebuilds the vehicle
 *               (InfiltrateForTransform).
 *   harvest     the refinery's harvester fills at the ore and empties at home (Harvester); one
 *               killed while loaded leaves the full wreck.
 *   deploy      an MCV unpacks into a yard and the yard packs up again (Transforms); the
 *               demolition truck's deploy sets it off (GrantConditionOnDeploy); the MAD tank
 *               thumps and detonates (MadTank).
 *   depots      a damaged tank mends at the service depot (Repair), a damaged boat at the naval
 *               yard and at the sub pen (RepairNear): RepairsUnits.
 *   dog         the dog leaps at a soldier (AttackLeap).
 *   cloak       mines, the submarines and the thief: the cloaked or submerged flag OpenRA sets.
 *   buildings   every sellable structure is built, hit by own tanks' forced fire, mended with the
 *               HUD Repair button (health rises under the repair mark) and sold with the Sell
 *               button (it leaves, cash rises); the pillboxes take a garrison first.
 * The player's own forced fire is the one way a player hurts an own actor, so damage comes from it.
 *   mines       each mine type, killed where it lies, detonates with its own weapon.
 *   truck       the supply truck delivers its cash to the own refinery (DeliversCash).
 *   ammo        the artillery's two death profiles, rolled by OpenRA (LoadedChance).
 *   paradrop    the Soviet Paratroopers drop the rank variants (e1r1, e3r1), which then ride an APC.
 *   technicians a sold power plant releases its crew; a technician among them rides an APC.
 * Parts run in the order above; --only takes part names (passengers, lst, husks, harvest, deploy,
 * depots, dog, cloak, paradrop, technicians, mines, truck, ammo, buildings) or single actor types.
 */
scenarios.actions = async function actions(m) {
	await m.devAll()
	const topUp = () => m.gate(() => globalThis.__live.playerOrder('DevGiveCash'))
	await topUp()
	const yard = await m.yard()
	await installWeaponObserver(m)
	await m.gate(() => {
		globalThis.__harvested = 0
		globalThis.steelseed.events.on('sim:resource:harvested', () => { globalThis.__harvested++ })
	})
	const captures = [], date = new Date().toISOString().slice(0, 10)
	const part = name => ONLY.length === 0 || ONLY.includes(name)
	const record = (key, line) => { console.log(`  ${key}: ${line}`); writeEvidence({}, { [key]: `S15 vfxscenario actions ${date}: ${line}` }) }
	const fail = (key, error) => console.log(`  ${key}: NOT SHOWN — ${String(error?.message ?? error).slice(0, 180)}`)
	const actorOf = id => m.gate(id => globalThis.__live.actor(id), id)
	const me = await m.gate(() => globalThis.steelseed.ctx.snapshot.world.renderPlayer)
	const funds = () => m.gate(me => { const p = globalThis.steelseed.ctx.snapshot.players.find(q => q.id === me); return p ? p.cash + p.resources : 0 }, me)
	const flagsOf = id => m.gate(id => { const a = globalThis.steelseed.ctx.snapshot.actors; for (let i = 0; i < a.count; i++) if (a.id[i] === id) return a.flags[i]; return null }, id)
	let outings = 0
	const driveOut = async (unit, minD = 6) => {
		const out = await landNear(m, unit.x, unit.y, minD + 2 * (outings++ % 4))
		if (!out) return unit
		await m.moveTo([unit.id], out.x, out.y)
		await m.waitFor(({ id, x, y }) => { const a = globalThis.__live.actor(id); return !a || (Math.floor(a.x) === x && Math.floor(a.y) === y) }, { id: unit.id, ...out }, `${unit.type} in the open`, 40000).catch(() => {})
		await m.page.waitForTimeout(400)
		return await actorOf(unit.id) ?? unit
	}
	// A long scenario outlives the bot's patience: its army is cleared from around the base
	// before each purchase (its buildings stay, so the match runs on). No action's rules change.
	const clearThreats = () => m.gate(({ x, y }) => {
		const snap = globalThis.steelseed.ctx.snapshot, hostile = new Set(snap.players.filter(p => p.relation === 2).map(p => p.id))
		for (const a of globalThis.__live.enemy()) {
			const i = [...snap.actors.id].indexOf(a.id)
			if (i < 0 || !hostile.has(a.owner) || Math.hypot(a.x - x, a.y - y) > 35) continue
			if (/^(fact|powr|apwr|proc|silo|barr|tent|weap|afld|hpad|dome|fix|atek|stek|spen|syrd|kenn|mslo|iron|pdox|gap|agun|sam|gun|ftur|tsla|pbox|hbox)$/.test(a.type)) continue
			globalThis.__live.playerOrder('DevKill', { targetActorId: a.id, targetString: 'ExplosionDeath' })
		}
	}, { x: yard.x, y: yard.y })
	const make = async (type, out = true) => {
		await topUp()
		await clearThreats()
		const [unit] = await m.produce(type, 1)
		return out ? driveOut(unit) : unit
	}
	const building = async type => {
		await topUp()
		await clearThreats()
		const before = new Set((await m.gate(t => globalThis.__live.own(t), type)).map(a => a.id))
		await m.build(type)
		return m.waitFor(({ t, b }) => globalThis.__live.own(t).find(a => !b.includes(a.id)) ?? false, { t: type, b: [...before] }, `a new ${type}`, 30000)
	}
	const standing = type => m.gate(t => globalThis.__live.own(t)[0] ?? null, type)
	const ensure = async type => (await standing(type)) ?? building(type)
	/** Enter, then unload: the passenger leaves the world on entry and stands again after. */
	const ride = async (passenger, transport) => {
		const reply = await m.gate(({ p, t }) => globalThis.__live.unitOrder([p], 'EnterTransport', { targetActorId: t }), { p: passenger.id, t: transport.id })
		if (!/^ok/.test(reply)) throw new Error(`EnterTransport refused: ${reply}`)
		await m.waitFor(id => globalThis.__live.actor(id) === null, passenger.id, `${passenger.type} aboard`, 45000)
		if (!(await actorOf(transport.id))) throw new Error('the transport is gone')
		await m.page.waitForTimeout(300)
		await m.gate(t => globalThis.__live.unitOrder([t], 'Unload'), transport.id)
		const back = await m.waitFor(id => globalThis.__live.actor(id) ?? false, passenger.id, `${passenger.type} unloaded`, 45000)
		return back
	}
	/**
	 * Own forced fire until the target is below `limit` of 255, then the shooters stop. The shells
	 * splash, so every other own actor they grazed is healed back (DevHeal): forty sessions beside
	 * the yard would otherwise wear it down.
	 */
	const hurt = async (targetId, shooters, limit = 200) => {
		const start = (await actorOf(targetId))?.health ?? 0
		await m.attack(shooters.map(s => s.id), targetId)
		const hit = await m.waitFor(({ id, limit }) => { const a = globalThis.__live.actor(id); return a && a.health <= limit ? a.health : false }, { id: targetId, limit }, 'the forced fire to land', 45000)
		await m.gate(ids => globalThis.__live.unitOrder(ids, 'Stop'), shooters.map(s => s.id))
		await m.page.waitForTimeout(600)
		await m.gate(id => { for (const a of globalThis.__live.own()) if (a.id !== id && a.health < 255) globalThis.__live.playerOrder('DevHeal', { targetActorId: a.id, targetString: 'heal' }) }, targetId)
		return { start, hit: (await actorOf(targetId))?.health ?? hit }
	}
	/** Select by a click on the actor, trying a few heights up its body before giving up. */
	let lastClick = ''
	// The centre at three heights, then the corners low down: a taller neighbour in front can
	// cover a building's middle from this camera, never all of it.
	const clickActor = async (unit, points = [[0, 0, 1], [0, 0, 0.5], [0, 0, 1.8], [-0.7, -0.7, 0.4], [0.7, -0.7, 0.4], [-0.7, 0.7, 0.4], [0.7, 0.7, 0.4]]) => {
		for (const [dx, dy, h] of points) {
			const px = await m.gate(({ x, y, h }) => {
				const render = globalThis.steelseed.ctx.get('render'), terrain = globalThis.steelseed.ctx.get('terrain'), vp = render.camera.viewProj
				const wy = terrain.heightAt(x, y) + h, w = vp[3] * x + vp[7] * wy + vp[11] * y + vp[15], rect = globalThis.steelseed.ctx.canvas.getBoundingClientRect()
				return { x: rect.left + ((vp[0] * x + vp[4] * wy + vp[8] * y + vp[12]) / w * 0.5 + 0.5) * rect.width, y: rect.top + (0.5 - (vp[1] * x + vp[5] * wy + vp[9] * y + vp[13]) / w * 0.5) * rect.height }
			}, { x: unit.x + dx, y: unit.y + dy, h })
			// Only where the world itself is under the pointer: a HUD button there (a selected
			// yard's Deploy, say) would take the click instead.
			if (!(await m.gate(({ x, y }) => document.elementFromPoint(x, y)?.id === 'viewport', px))) { lastClick = `at +${dx},${dy} h ${h}: HUD under the pointer`; continue }
			await m.page.mouse.click(px.x, px.y); await m.page.waitForTimeout(350)
			const got = await m.gate(({ id, x, y }) => {
				const ui = globalThis.steelseed.ctx.get('ui'), el = document.elementFromPoint(x, y)
				return { ok: ui.selected.includes(id), selected: [...ui.selected].map(s => `${s}:${globalThis.__live.actor(s)?.type ?? '?'}`), under: el ? `${el.tagName}#${el.id}.${String(el.className?.baseVal ?? el.className ?? '').slice(0, 30)}` : 'nothing' }
			}, { id: unit.id, x: px.x, y: px.y })
			if (got.ok) return true
			lastClick = `at +${dx},${dy} h ${h}: under the cursor ${got.under}, selected ${got.selected.join(',') || 'nothing'}`
			await m.page.keyboard.press('Escape')
		}
		return false
	}

	let apc = null
	if (part('passengers')) {
		for (const factory of ['weap', 'tent', 'barr', 'kenn', 'hpad']) try { await ensure(factory) } catch (error) { fail(factory, error) }
		try { apc = await make('apc') } catch (error) { fail('apc', error) }
		let carried = 0
		for (const type of ['e1', 'e2', 'e3', 'e4', 'e6', 'e7', 'dog', 'mech', 'medi', 'shok', 'spy', 'spy.england', 'thf', 'e1r1', 'e3r1']) {
			if (!apc || !(ONLY.length === 0 || ONLY.includes('passengers') || ONLY.includes(type))) continue
			try {
				const soldier = await make(type, false)
				const back = await ride(soldier, apc)
				carried++
				record(`${type}:Passenger`, `EnterTransport into an APC accepted; it left the world on entry and stood again at (${Math.floor(back.x)},${Math.floor(back.y)}) after the unload`)
				await m.gate(id => globalThis.__live.playerOrder('DevKill', { targetActorId: id, targetString: 'ExplosionDeath' }), soldier.id)
			} catch (error) { fail(`${type}:Passenger`, error) }
		}
		if (carried) record('apc:Cargo', `${carried} soldier types boarded and were unloaded (Unload order) in turn`)
		for (const type of ['tran', 'jeep', 'stnk']) {
			try {
				const transport = await make(type, type !== 'tran')
				const rifleman = await make('e1', false)
				const back = await ride(rifleman, transport)
				record(`${type}:Cargo`, `a rifleman boarded (left the world) and was unloaded at (${Math.floor(back.x)},${Math.floor(back.y)})`)
				await m.gate(id => globalThis.__live.playerOrder('DevKill', { targetActorId: id, targetString: 'ExplosionDeath' }), rifleman.id)
			} catch (error) { fail(`${type}:Cargo`, error) }
		}
	}

	if (part('lst')) try {
		await ensure('weap'); await ensure('syrd')
		const lst = await make('lst', false)
		// A water cell against the shore, near the base: the landing craft beaches there.
		const beach = await m.gate(({ x, y }) => {
			const land = (cx, cy) => { const s = globalThis.__live.surface(cx, cy); return s >= 0 && s !== 8 && s !== 9 && globalThis.__live.water(cx, cy) == null }
			for (let d = 3; d < 45; d++) for (let a = 0; a < 48; a++) {
				const cx = Math.round(x + Math.cos(a / 48 * Math.PI * 2) * d), cy = Math.round(y + Math.sin(a / 48 * Math.PI * 2) * d)
				if (globalThis.__live.surface(cx, cy) !== 8 || globalThis.__live.water(cx, cy) == null) continue
				for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (land(cx + dx, cy + dy) && land(cx + 2 * dx, cy + 2 * dy)) return { x: cx, y: cy, landX: cx + 2 * dx, landY: cy + 2 * dy }
			}
			return null
		}, { x: yard.x, y: yard.y })
		if (!beach) throw new Error('no beach near the base')
		await m.moveTo([lst.id], beach.x, beach.y)
		await m.waitFor(({ id, x, y }) => { const a = globalThis.__live.actor(id); return a && Math.hypot(a.x - x - 0.5, a.y - y - 0.5) < 1.5 }, { id: lst.id, ...beach }, 'the LST on the beach', 60000)
		await m.view(beach.x + 0.5, beach.y + 0.5, { zoom: 1 })
		let carried = 0
		const VEHICLES = ['1tnk', '2tnk', '3tnk', '4tnk', 'apc', 'arty', 'ctnk', 'dtrk', 'ftrk', 'harv', 'jeep', 'mcv', 'mgg', 'mnly.ap', 'mnly.at', 'mrj', 'qtnk', 'stnk', 'truk', 'ttnk', 'v2rl']
		// Named vehicle types narrow the part to them; the part name alone runs them all.
		const named = VEHICLES.filter(t => ONLY.includes(t))
		for (const type of named.length ? named : VEHICLES) {
			try {
				const vehicle = await make(type, false)
				const back = await ride(vehicle, lst)
				carried++
				record(`${type}:Passenger`, `EnterTransport into an LST on the beach accepted; it left the world on entry and drove off at (${Math.floor(back.x)},${Math.floor(back.y)}) after the unload`)
				if (carried === 1) { await m.shot('lst-unload'); captures.push('lst-unload') }
				await m.gate(id => globalThis.__live.playerOrder('DevDispose', { targetActorId: id }), vehicle.id)
			} catch (error) { fail(`${type}:Passenger`, error) }
		}
		if (carried) record('lst:Cargo', `${carried} vehicle types boarded on the beach and were unloaded in turn`)
	} catch (error) { fail('lst', error) }

	if (part('husks')) {
		for (const factory of ['weap', 'tent']) try { await ensure(factory) } catch (error) { fail(factory, error) }
		for (const [type, husk] of [['2tnk', '2tnk.husk'], ['3tnk', '3tnk.husk'], ['4tnk', '4tnk.husk'], ['harv', 'harv.emptyhusk'], ['mcv', 'mcv.husk'], ['mgg', 'mgg.husk']]) {
			if (!(ONLY.length === 0 || ONLY.includes('husks') || ONLY.includes(husk))) continue
			try {
				const vehicle = await make(type)
				const before = new Set((await m.gate(t => globalThis.__live.own(t), type)).map(a => a.id))
				await m.gate(id => globalThis.__live.playerOrder('DevKill', { targetActorId: id, targetString: 'ExplosionDeath' }), vehicle.id)
				const wreck = await m.waitFor(({ t, x, y }) => globalThis.__live.own(t).find(a => Math.hypot(a.x - x, a.y - y) < 2) ?? false, { t: husk, x: vehicle.x, y: vehicle.y }, `the ${husk}`, 15000)
				const mech = await make('mech', false)
				const reply = await m.gate(({ id, t }) => globalThis.__live.unitOrder([id], 'Infiltrate', { targetActorId: t }), { id: mech.id, t: wreck.id })
				const rebuilt = await m.waitFor(({ t, b, x, y }) => globalThis.__live.own(t).find(a => !b.includes(a.id) && Math.hypot(a.x - x, a.y - y) < 2) ?? false, { t: type, b: [...before], x: wreck.x, y: wreck.y }, `the ${type} rebuilt`, 60000)
				await m.view(rebuilt.x + 0.5, rebuilt.y + 0.5, { zoom: 2 }); await m.shot(`husk-${type}`); captures.push(`husk-${type}`)
				record(`${husk}:InfiltrateForTransform`, `a mechanic's Infiltrate (${String(reply).slice(0, 20)}) on the own wreck: OpenRA turned it into a working ${type} (id ${rebuilt.id}) where it lay`)
			} catch (error) { fail(`${husk}:InfiltrateForTransform`, error) }
		}
	}

	if (part('harvest')) try {
		const proc = await ensure('proc')
		const harv = await m.waitFor(() => globalThis.__live.own('harv')[0] ?? false, undefined, 'the refinery harvester', 30000)
		// The richest ore near the refinery the snapshot publishes (resources, row-major from the
		// bounds' corner): the most density in a 5x5 patch, so a load is a full load.
		const ore = await m.gate(({ x, y }) => {
			const snap = globalThis.steelseed.ctx.snapshot, r = snap.resources, w = snap.world
			if (!r) return null
			const at = (cx, cy) => cx < 0 || cy < 0 || cx >= r.w || cy >= r.h ? 0 : r.density[cy * r.w + cx]
			let best = null
			for (let i = 0; i < r.w * r.h; i++) if (r.density[i] > 0) {
				const ix = i % r.w, iy = Math.floor(i / r.w), cx = w.boundsLeft + ix, cy = w.boundsTop + iy, d = Math.hypot(cx - x, cy - y)
				if (d > 30) continue
				let sum = 0
				for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) sum += at(ix + dx, iy + dy)
				const score = sum - d * 0.5
				if (!best || score > best.score) best = { x: cx, y: cy, d, score }
			}
			return best
		}, proc)
		if (!ore) throw new Error('no ore on the map')
		// Rich ore, so that a load is a full load (DeveloperMode's own ore growth).
		await m.gate(() => globalThis.__live.playerOrder('DevGrowResources'))
		const f0 = await funds()
		const reply = await m.gate(({ id, x, y }) => globalThis.__live.unitOrder([id], 'Harvest', { targetCell: { x, y } }), { id: harv.id, x: ore.x, y: ore.y })
		// On the field: it stops moving on the ore for a while (picking up), then drives home.
		await m.waitFor(({ id, x, y }) => { const a = globalThis.__live.actor(id); return a && Math.hypot(a.x - x - 0.5, a.y - y - 0.5) < 4 }, { id: harv.id, ...ore }, 'the harvester at the ore', 90000)
		const loaded = await actorOf(harv.id)
		await m.view(loaded.x + 0.5, loaded.y + 0.5, { zoom: 2 }); await m.page.waitForTimeout(2500); await m.shot('harvest'); captures.push('harvest')
		// No purchase runs meanwhile, so a rise in funds is the load emptied into the refinery.
		const dumped = await m.waitFor(({ me, f }) => { const p = globalThis.steelseed.ctx.snapshot.players.find(q => q.id === me); return p && p.cash + p.resources > f ? p.cash + p.resources : false }, { me, f: f0 }, 'the ore unloaded at the refinery', 180000).catch(() => null)
		if (!dumped) throw new Error(`Harvest ${String(reply).slice(0, 20)}: at the ore, but no load reached the refinery in 180 s`)
		record('harv:Harvester', `Harvest on the ore at (${ore.x},${ore.y}) (${String(reply).slice(0, 20)}): it drove to the field, filled up and emptied into the refinery (funds ${f0} -> ${dumped})`)
		if (part('husks') || ONLY.includes('harv.fullhusk')) {
			// A loaded harvester's wreck: back on the field for a while, then it dies with ore aboard.
			await m.waitFor(({ id, x, y }) => { const a = globalThis.__live.actor(id); return a && Math.hypot(a.x - x - 0.5, a.y - y - 0.5) < 4 }, { id: harv.id, ...ore }, 'the harvester back at the ore', 90000)
			// Its load is not published (HarvesterHuskModifier leaves the full wreck from half a load
			// up), so it is taken as it leaves the field for home, when it carries all it gathered.
			// Wherever it chose to gather: after a spell away from the refinery, the moment it turns
			// for home (the distance to the refinery falling) it carries its whole load.
			await m.gate(({ x, y }) => { globalThis.__trip = { x, y, away: 0, last: performance.now(), d: NaN, closing: 0 } }, proc)
			await m.waitFor(id => {
				const a = globalThis.__live.actor(id), t = globalThis.__trip
				if (!a) return false
				const now = performance.now(), d = Math.hypot(a.x - t.x, a.y - t.y)
				if (d > 6) t.away += now - t.last
				t.closing = d < t.d - 0.01 ? t.closing + (now - t.last) : 0
				t.last = now; t.d = d
				return t.away > 15000 && t.closing > 1200 && d > 5
			}, harv.id, 'the harvester heading home loaded', 240000)
			const now = await actorOf(harv.id)
			await m.gate(id => globalThis.__live.playerOrder('DevKill', { targetActorId: id, targetString: 'ExplosionDeath' }), harv.id)
			const wreck = await m.waitFor(({ x, y }) => globalThis.__live.own().find(a => /^harv\..*husk$/.test(a.type) && Math.hypot(a.x - x, a.y - y) < 2) ?? false, { x: now.x, y: now.y }, 'the harvester wreck', 15000)
			if (wreck.type !== 'harv.fullhusk') throw new Error(`a loaded harvester left ${wreck.type}`)
			const before = new Set((await m.gate(() => globalThis.__live.own('harv'))).map(a => a.id))
			await ensure('tent')
			const mech = await make('mech', false)
			await m.gate(({ id, t }) => globalThis.__live.unitOrder([id], 'Infiltrate', { targetActorId: t }), { id: mech.id, t: wreck.id })
			const rebuilt = await m.waitFor(({ b, x, y }) => globalThis.__live.own('harv').find(a => !b.includes(a.id) && Math.hypot(a.x - x, a.y - y) < 2) ?? false, { b: [...before], x: wreck.x, y: wreck.y }, 'the harvester rebuilt', 60000)
			record('harv.fullhusk:InfiltrateForTransform', `a harvester killed while loaded left harv.fullhusk; a mechanic's Infiltrate turned it into a working harv (id ${rebuilt.id})`)
		}
	} catch (error) { fail('harvest', error) }

	if (part('deploy')) {
		try {
			await ensure('weap')
			let mcv = await make('mcv')
			const yards = new Set((await m.gate(() => globalThis.__live.own('fact'))).map(a => a.id))
			// The yard unpacks only onto buildable ground (RA's Clear and Road: soil, grass, road),
			// so the MCV is driven to a 5x5 block of it, clear of every actor.
			const spots = await m.gate(({ x, y }) => {
				const ctx = globalThis.steelseed.ctx, snap = ctx.snapshot, w = snap.world, out = []
				const buildable = (cx, cy) => { const s = globalThis.__live.surface(cx, cy); return (s === 0 || s === 4 || s === 5) && globalThis.__live.water(cx, cy) == null && cx > w.boundsLeft + 1 && cy > w.boundsTop + 1 && cx < w.boundsRight - 2 && cy < w.boundsBottom - 2 }
				for (let d = 8; d < 28 && out.length < 6; d++) for (let a = 0; a < 24 && out.length < 6; a++) {
					const cx = Math.round(x + Math.cos(a / 24 * Math.PI * 2) * d), cy = Math.round(y + Math.sin(a / 24 * Math.PI * 2) * d)
					let ok = true
					for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2 && ok; dx++) ok = buildable(cx + dx, cy + dy)
					for (let i = 0; i < snap.actors.count && ok; i++) if (Math.hypot(snap.actors.posX[i] / 1024 - cx - 0.5, snap.actors.posY[i] / 1024 - cy - 0.5) < 3.5) ok = false
					if (ok) out.push({ x: cx, y: cy })
				}
				return out
			}, { x: yard.x, y: yard.y })
			let fact = null, reply = ''
			const dust0 = await m.gate(() => globalThis.steelseed.ctx.get('fx').stats.deployDust ?? 0)
			for (const spot of spots) {
				await m.moveTo([mcv.id], spot.x, spot.y)
				await m.waitFor(({ id, x, y }) => { const a = globalThis.__live.actor(id); return a && Math.floor(a.x) === x && Math.floor(a.y) === y }, { id: mcv.id, ...spot }, 'the MCV on its spot', 40000).catch(() => {})
				reply = await m.gate(id => globalThis.__live.unitOrder([id], 'DeployTransform'), mcv.id)
				fact = await m.waitFor(b => globalThis.__live.own('fact').find(a => !b.includes(a.id)) ?? false, [...yards], 'the MCV unpacked', 12000).catch(() => null)
				if (fact) break
			}
			if (!fact) throw new Error(`the MCV found no spot to unpack among ${spots.length} (${String(reply).slice(0, 30)})`)
			await m.view(fact.x + 0.5, fact.y + 0.5, { zoom: 1 }); await m.shot('mcv-deployed'); captures.push('mcv-deployed')
			const dust = (await m.gate(() => globalThis.steelseed.ctx.get('fx').stats.deployDust ?? 0)) - dust0
			record('mcv:Transforms', `DeployTransform ${String(reply).slice(0, 20)}: the MCV unpacked into a construction yard (id ${fact.id}) where it stood, its make frames from OpenRA${dust > 0 ? ', stabilizer dust as it set down (Ultra)' : ''}`)
			const mcvs = new Set((await m.gate(() => globalThis.__live.own('mcv'))).map(a => a.id))
			// A yard still unpacking cannot pack up again: let its make frames finish first.
			await m.page.waitForTimeout(4000)
			const back = await m.gate(id => globalThis.__live.unitOrder([id], 'DeployTransform'), fact.id)
			const packed = await m.waitFor(b => globalThis.__live.own('mcv').find(a => !b.includes(a.id)) ?? false, [...mcvs], 'the yard packed up', 30000)
			record('fact:Transforms', `DeployTransform ${String(back).slice(0, 20)} on the yard: it packed up into an MCV (id ${packed.id}); the yard left the world`)
		} catch (error) { fail('mcv/fact:Transforms', error) }
		try {
			const truck = await driveOut(await make('dtrk'), 12)
			const before = await m.gate(() => ({ ...globalThis.__weaponObs.impacts }))
			const reply = await m.gate(id => globalThis.__live.unitOrder([id], 'GrantConditionOnDeploy'), truck.id)
			await m.view(truck.x + 0.5, truck.y + 0.5, { zoom: 0, settleMs: 100 })
			await m.waitFor(n => (globalThis.__weaponObs.impacts.mininuke ?? 0) > n, before.mininuke ?? 0, 'the demolition charge', 30000)
			await m.page.waitForTimeout(250); await m.shot('dtrk-deploy'); captures.push('dtrk-deploy')
			record('dtrk:GrantConditionOnDeploy', `deploy order ${String(reply).slice(0, 20)}: the truck set itself off (MiniNuke impact event, drawn as the small nuclear strike)`)
		} catch (error) { fail('dtrk:GrantConditionOnDeploy', error) }
		try {
			const mad = await driveOut(await make('qtnk'), 12)
			const before = await m.gate(() => ({ ...globalThis.__weaponObs.impacts }))
			const reply = await m.gate(id => globalThis.__live.unitOrder([id], 'Detonate'), mad.id)
			await m.view(mad.x + 0.5, mad.y + 0.5, { zoom: 0, settleMs: 100 })
			await m.waitFor(n => (globalThis.__weaponObs.impacts.madtankthump ?? 0) > n, before.madtankthump ?? 0, 'the first thump', 30000)
			await m.shot('qtnk-thump'); captures.push('qtnk-thump')
			await m.waitFor(n => (globalThis.__weaponObs.impacts.madtankdetonate ?? 0) > n, before.madtankdetonate ?? 0, 'the detonation', 60000)
			const after = await m.gate(() => ({ ...globalThis.__weaponObs.impacts }))
			record('qtnk:MadTank', `Detonate ${String(reply).slice(0, 20)}: ${(after.madtankthump ?? 0) - (before.madtankthump ?? 0)} seismic thumps, then the detonation (MADTankThump and MADTankDetonate impact events, drawn as rings and the cratered blast)`)
		} catch (error) { fail('qtnk:MadTank', error) }
	}

	if (part('depots')) {
		try {
			await ensure('weap'); const fix = await ensure('fix')
			const patient = await make('2tnk'), shooter = await make('2tnk')
			const { start, hit } = await hurt(patient.id, [shooter])
			const reply = await m.gate(({ id, t }) => globalThis.__live.unitOrder([id], 'Repair', { targetActorId: t }), { id: patient.id, t: fix.id })
			const mended = await m.waitFor(({ id, h }) => { const a = globalThis.__live.actor(id); return a && a.health > h + 20 ? a.health : false }, { id: patient.id, h: hit }, 'the depot repair', 60000)
			const at = await actorOf(patient.id)
			await m.view(at.x + 0.5, at.y + 0.5, { zoom: 2 }); await m.shot('fix-repair'); captures.push('fix-repair')
			record('fix:RepairsUnits', `a tank hit by own forced fire (${start} -> ${hit} of 255), sent with Repair (${String(reply).slice(0, 20)}): it drove onto the depot and mended to ${mended}`)
		} catch (error) { fail('fix:RepairsUnits', error) }
		for (const yardType of ['syrd', 'spen']) {
			try {
				const dock = await ensure(yardType)
				const patient = await make('pt', false), shooter = await make('pt', false)
				const { start, hit } = await hurt(patient.id, [shooter])
				const reply = await m.gate(({ id, t }) => globalThis.__live.unitOrder([id], 'RepairNear', { targetActorId: t }), { id: patient.id, t: dock.id })
				const mended = await m.waitFor(({ id, h }) => { const a = globalThis.__live.actor(id); return a && a.health > h + 20 ? a.health : false }, { id: patient.id, h: hit }, `the ${yardType} repair`, 60000)
				record(`${yardType}:RepairsUnits`, `a gunboat hit by own forced fire (${start} -> ${hit} of 255), sent with RepairNear (${String(reply).slice(0, 20)}): it docked and mended to ${mended}`)
				for (const boat of [patient, shooter]) await m.gate(id => globalThis.__live.playerOrder('DevDispose', { targetActorId: id }), boat.id)
			} catch (error) { fail(`${yardType}:RepairsUnits`, error) }
		}
	}

	if (part('dog')) try {
		await ensure('kenn'); await ensure('tent')
		const dog = await make('dog'), soldier = await make('e1', false)
		await m.moveTo([soldier.id], Math.floor(dog.x) + 3, Math.floor(dog.y))
		await m.page.waitForTimeout(2500)
		const before = await m.gate(() => ({ ...globalThis.__weaponObs.impacts }))
		const start = await actorOf(dog.id)
		await m.view(start.x + 1.5, start.y + 0.5, { zoom: 3 })
		await m.attack([dog.id], soldier.id)
		await m.waitFor(id => globalThis.__live.actor(id) === null, soldier.id, 'the soldier down', 30000)
		const end = await actorOf(dog.id)
		await m.shot('dog-leap'); captures.push('dog-leap')
		const after = await m.gate(() => ({ ...globalThis.__weaponObs.impacts }))
		record('dog:AttackLeap', `a forced attack on a soldier: the dog closed ${Math.hypot(end.x - start.x, end.y - start.y).toFixed(1)} cells with its leap and the DogJaw landed (${(after.dogjaw ?? 0) - (before.dogjaw ?? 0)} impact); the soldier died`)
	} catch (error) { fail('dog:AttackLeap', error) }

	if (part('cloak')) {
		for (const factory of ['weap', 'tent']) try { await ensure(factory) } catch (error) { fail(factory, error) }
		for (const [layer, mine] of [['mnly.ap', 'minp'], ['mnly.at', 'minv']]) try {
			const unit = await make(layer)
			const before = new Set((await m.gate(t => globalThis.__live.own(t), mine)).map(a => a.id))
			await m.gate(({ id, x, y }) => globalThis.__live.unitOrder([id], 'PlaceMine', { targetCell: { x, y } }), { id: unit.id, x: Math.floor(unit.x), y: Math.floor(unit.y) })
			const laid = await m.waitFor(({ t, b }) => globalThis.__live.own(t).find(a => !b.includes(a.id)) ?? false, { t: mine, b: [...before] }, `a ${mine}`, 30000)
			const cloaked = await m.waitFor(id => { const a = globalThis.steelseed.ctx.snapshot.actors; for (let i = 0; i < a.count; i++) if (a.id[i] === id) return (a.flags[i] & 2) !== 0; return false }, laid.id, 'the mine cloaked', 20000).then(() => true, () => false)
			if (!cloaked) throw new Error('the cloaked flag was never set on the mine')
			record(`${layer}:Minelayer`, `PlaceMine under it: OpenRA laid a ${mine} (id ${laid.id})`)
			record(`${mine}:Cloak`, 'the laid mine carries the cloaked flag (hidden from enemies; the owner still sees it)')
		} catch (error) { fail(`${mine}:Cloak`, error) }
		for (const type of ['ss', 'msub']) try {
			await ensure('spen')
			const sub = await make(type, false)
			await m.moveTo([sub.id], Math.floor(sub.x) + 3, Math.floor(sub.y) + 2)
			const flags = await m.waitFor(id => { const a = globalThis.steelseed.ctx.snapshot.actors; for (let i = 0; i < a.count; i++) if (a.id[i] === id && (a.flags[i] & (2 | 128)) !== 0) return a.flags[i]; return false }, sub.id, `the ${type} submerged`, 40000)
			record(`${type}:Cloak`, `submerged on its own: flags ${(flags & 128) ? 'submerged' : ''}${(flags & 2) ? ' cloaked' : ''} (drawn under the surface for its owner, withheld from enemies)`)
		} catch (error) { fail(`${type}:Cloak`, error) }
		try {
			const thief = await make('thf')
			const cloaked = await m.waitFor(id => { const a = globalThis.steelseed.ctx.snapshot.actors; for (let i = 0; i < a.count; i++) if (a.id[i] === id) return (a.flags[i] & 2) !== 0; return false }, thief.id, 'the thief cloaked', 30000).then(() => true, () => false)
			if (!cloaked) throw new Error('the cloaked flag was never set on the idle thief')
			record('thf:Cloak', 'idle, the thief carries the cloaked flag (the owner sees it with the disguise ring)')
		} catch (error) { fail('thf:Cloak', error) }
	}

	if (part('gap')) try {
		// The gap generator building's shroud range while selected, as the mobile one's.
		const gap = await building('gap')
		await m.view(gap.x + 0.5, gap.y + 0.5, { zoom: -2 })
		if (!(await clickActor(gap))) throw new Error('the click did not select the gap generator')
		const outlines = await m.gate(() => [...document.querySelectorAll('svg path[stroke-dasharray="7 5"]')].filter(p => p.style.display !== 'none' && (p.getAttribute('d') ?? '').length > 0).length)
		await m.shot('gap-range'); captures.push('gap-range')
		if (outlines !== 1) throw new Error(`${outlines} range outline(s) drawn (expected 1)`)
		record('gap:CreatesShroud', 'selected by a click; its 6-cell shroud range drawn on the ground (CreatesShroud Range 6c0)')
		await m.page.keyboard.press('Escape')
	} catch (error) { fail('gap:CreatesShroud', error) }

	if (part('paradrop')) try {
		// The Soviet airfield's Paratroopers drop the rank variants (e1r1, e3r1) from a Badger: the
		// power's own path through the HUD, then each paratrooper rides an APC like any soldier.
		await ensure('afld'); await ensure('weap')
		const carrier = apc && await actorOf(apc.id) ? await actorOf(apc.id) : await make('apc')
		const key = await m.waitFor(() => globalThis.__live.powers().find(p => /paratroop/i.test(p.key) && p.ready)?.key ?? false, undefined, 'the paratroopers ready', 120000)
		const drop = await landNear(m, carrier.x, carrier.y, 4)
		const before = new Set((await m.gate(() => globalThis.__live.own().filter(a => /^e[13]r1$/.test(a.type)))).map(a => a.id))
		await m.view(drop.x + 0.5, drop.y + 0.5, { zoom: 0 })
		await m.page.click(`#hud-support-list button[data-power="${key}"]`); await m.page.waitForTimeout(200)
		const px = await m.gate(({ x, y }) => globalThis.__live.cellPx(x, y), drop)
		await m.page.mouse.click(px.x, px.y); await m.page.waitForTimeout(200)
		const badger = await m.waitFor(() => globalThis.__live.own().find(a => /^badr/.test(a.type)) ?? false, undefined, 'the Badger in the air', 30000)
		const landed = await m.waitFor(b => {
			const jumpers = globalThis.__live.own().filter(a => /^e[13]r1$/.test(a.type) && !b.includes(a.id))
			const snap = globalThis.steelseed.ctx.snapshot
			const down = jumpers.filter(j => { for (let i = 0; i < snap.actors.count; i++) if (snap.actors.id[i] === j.id) return (snap.actors.flags[i] & 4) === 0; return false })
			return down.length >= 2 && down.length === jumpers.length ? down : false
		}, [...before], 'the paratroopers on the ground', 90000)
		await m.shot('paradrop-landed'); captures.push('paradrop-landed')
		record('afld:ParatroopersPower', `${key} through the HUD: a ${badger.type} dropped ${landed.length} paratroopers (${[...new Set(landed.map(j => j.type))].join(', ')}) that fell under canopies (parachuting flag) and landed`)
		record('badr:Cargo', `the paratrooper Badger carried ${landed.length} soldiers and released them over the drop cell`)
		for (const type of ['e1r1', 'e3r1']) {
			const jumper = landed.find(j => j.type === type)
			if (!jumper) { fail(`${type}:Passenger`, 'none dropped'); continue }
			try {
				const back = await ride(jumper, carrier)
				record(`${type}:Passenger`, `a dropped ${type} (Paratroopers) boarded an APC (left the world) and stood again at (${Math.floor(back.x)},${Math.floor(back.y)}) after the unload`)
			} catch (error) { fail(`${type}:Passenger`, error) }
		}
	} catch (error) { fail('paradrop', error) }

	if (part('technicians')) try {
		// Selling a gun turret releases its crew (SpawnActorsOnSell: tecn); they are the player's.
		await ensure('weap')
		const carrier = apc && await actorOf(apc.id) ? await actorOf(apc.id) : await make('apc')
		// SpawnActorsOnSell draws the crew from the building's list at random (a rifleman
		// guaranteed; technicians of both kinds and civilians by chance), so power plants are sold
		// until each of the crew types a player can only get this way has come out once.
		// Power plants release technicians; the civilian c10 comes only out of a tech centre.
		const WANT = ['tecn', 'tecn2', 'c10'], SOURCE = { tecn: 'powr', tecn2: 'powr', c10: 'atek' }, found = new Map()
		// Named crew types narrow the part to them; the part name alone takes all three.
		const named = WANT.filter(t => ONLY.includes(t)), wanted = named.length ? named : WANT
		for (let k = 0; k < 18 && wanted.some(t => !found.has(t)); k++) {
			const plant = await building(SOURCE[wanted.find(t => !found.has(t))])
			await m.page.waitForTimeout(3000) // a structure cannot be sold while it is still going up
			const before = new Set((await m.gate(() => globalThis.__live.own().map(a => a.id))))
			await m.gate(id => globalThis.__live.unitOrder([id], 'Sell', { targetActorId: id }), plant.id)
			await m.waitFor(id => globalThis.__live.actor(id) === null, plant.id, 'the plant sold', 30000)
			await m.page.waitForTimeout(1500)
			const crew = await m.gate(({ b, want }) => globalThis.__live.own().filter(a => want.includes(a.type) && !b.includes(a.id)), { b: [...before], want: WANT })
			for (const c of crew) if (!found.has(c.type)) found.set(c.type, c)
		}
		if (found.size === 0) throw new Error('eighteen sold buildings released none of the crew types')
		record(`${SOURCE[[...found.keys()][0]]}:SpawnActorsOnSell`, `sold, the buildings released their crews, among them own ${[...found.keys()].join(', ')}`)
		for (const [type, crew] of found) {
			const back = await ride(crew, carrier)
			record(`${type}:Passenger`, `the crew from a sold building (an own ${type}) boarded an APC (left the world) and stood again at (${Math.floor(back.x)},${Math.floor(back.y)}) after the unload`)
		}
		for (const type of wanted) if (!found.has(type)) fail(`${type}:Passenger`, 'not among the crews of eighteen sold buildings')
	} catch (error) { fail('technicians', error) }

	if (part('mines')) {
		// A mine's detonation is its own weapon (minp APMine, minv ATMine): killed where it lies,
		// its FireWarheadsOnDeath goes off exactly as under a tread.
		for (const [layer, mine, weapon] of [['mnly.ap', 'minp', 'apmine'], ['mnly.at', 'minv', 'atmine']]) try {
			const unit = await make(layer)
			const before = new Set((await m.gate(t => globalThis.__live.own(t), mine)).map(a => a.id))
			await m.gate(({ id, x, y }) => globalThis.__live.unitOrder([id], 'PlaceMine', { targetCell: { x, y } }), { id: unit.id, x: Math.floor(unit.x), y: Math.floor(unit.y) })
			const laid = await m.waitFor(({ t, b }) => globalThis.__live.own(t).find(a => !b.includes(a.id)) ?? false, { t: mine, b: [...before] }, `a ${mine}`, 30000)
			await m.moveTo([unit.id], Math.floor(unit.x) + 6, Math.floor(unit.y)); await m.page.waitForTimeout(2500)
			await m.view(laid.x + 0.5, laid.y + 0.5, { zoom: 2, settleMs: 400 })
			const n0 = await m.gate(w => globalThis.__weaponObs.impacts[w] ?? 0, weapon)
			await m.gate(id => globalThis.__live.playerOrder('DevKill', { targetActorId: id, targetString: 'ExplosionDeath' }), laid.id)
			await m.waitFor(({ w, n }) => (globalThis.__weaponObs.impacts[w] ?? 0) > n, { w: weapon, n: n0 }, `the ${weapon} detonation`, 15000)
			await m.page.waitForTimeout(150); await m.shot(`${mine}-detonation`); captures.push(`${mine}-detonation`)
			record(`${mine}:death`, `laid by the ${layer}; destroyed where it lay, it detonated with its own ${weapon} warheads (impact event), drawn by that weapon's profile`)
		} catch (error) { fail(`${mine}:death`, error) }
	}

	if (part('truck')) try {
		const proc = await ensure('proc')
		const truck = await make('truk')
		const f0 = await funds()
		const reply = await m.gate(({ id, t }) => globalThis.__live.unitOrder([id], 'DeliverCash', { targetActorId: t }), { id: truck.id, t: proc.id })
		await m.waitFor(id => globalThis.__live.actor(id) === null, truck.id, 'the delivery', 60000)
		await m.page.waitForTimeout(500)
		const f1 = await funds()
		if (!(f1 > f0)) throw new Error(`delivered, but funds ${f0} -> ${f1}`)
		record('truk:DeliversCash', `DeliverCash to the own refinery (${String(reply).slice(0, 20)}): the truck drove in and was spent; funds ${f0} -> ${f1} (Payload 500)`)
	} catch (error) { fail('truk:DeliversCash', error) }

	if (part('ammo')) try {
		// ARTY's death rolls its LoadedChance (75): ArtilleryExplode loaded, UnitExplodeSmall empty.
		const seen = {}
		for (let k = 0; k < 10 && !(seen.artilleryexplode && seen.unitexplodesmall); k++) {
			const gun = await make('arty')
			const before = await m.gate(() => ({ ...globalThis.__weaponObs.impacts }))
			await m.gate(id => globalThis.__live.playerOrder('DevKill', { targetActorId: id, targetString: 'ExplosionDeath' }), gun.id)
			await m.waitFor(id => globalThis.__live.actor(id) === null, gun.id, 'the artillery dead', 10000)
			await m.page.waitForTimeout(400)
			const after = await m.gate(() => ({ ...globalThis.__weaponObs.impacts }))
			for (const w of ['artilleryexplode', 'unitexplodesmall']) if ((after[w] ?? 0) > (before[w] ?? 0)) seen[w] = (seen[w] ?? 0) + 1
		}
		if (!(seen.artilleryexplode && seen.unitexplodesmall)) throw new Error(`only ${JSON.stringify(seen)} in ten deaths`)
		record('arty:death', `both death profiles OpenRA rolls (LoadedChance 75): ArtilleryExplode ${seen.artilleryexplode}x loaded, UnitExplodeSmall ${seen.unitexplodesmall}x empty, each drawn by its weapon`)
	} catch (error) { fail('arty:death', error) }

	if (part('buildings')) {
		const cameraHeight = 1.25 * await m.gate(() => globalThis.steelseed.ctx.get('camera').heightGoal)
		await ensure('weap'); await ensure('tent')
		const shooters = [await make('2tnk'), await make('2tnk')]
		// Every sellable structure a player can build; barb, cycl and wood are placed on maps for
		// Neutral only (the census marks their sale order-unavailable).
		const SELL = ['afld', 'afld.ukraine', 'agun', 'apwr', 'atef', 'atek', 'barr', 'brik', 'dome', 'domf', 'facf', 'fapw', 'fenc', 'fix', 'fixf', 'fpwr',
			'ftur', 'gap', 'gun', 'hbox', 'hpad', 'iron', 'kenn', 'mslf', 'mslo', 'pbox', 'pdof', 'pdox', 'powr', 'proc', 'sam', 'sbag', 'silo', 'spen', 'stek', 'syrd',
			'syrf', 'tenf', 'tent', 'tsla', 'weaf', 'weap', 'fact']
		const WALLS = new Set(['brik', 'fenc', 'sbag'])
		// Named structure types narrow the part to them; the part name alone runs them all.
		const namedTypes = SELL.filter(t => ONLY.includes(t))
		for (const type of namedTypes.length ? namedTypes : SELL) {
			try {
				const b = type === 'fact' ? await standing('fact') : type === 'weap' ? await standing('weap') ?? await building(type) : await building(type)
				if (!b) throw new Error(`no ${type}`)
				if (type === 'hbox' || type === 'pbox') try {
					// A pillbox is built manned (Cargo InitialUnits e1, MaxWeight 1): its rifleman comes
					// out on Unload, then a rocket soldier takes his place (PassengerConditions) and leaves.
					const before = new Set((await m.gate(() => globalThis.__live.own('e1'))).map(a => a.id))
					await m.page.waitForTimeout(2500)
					await m.gate(id => globalThis.__live.unitOrder([id], 'Unload'), b.id)
					const crew = await m.waitFor(({ ids, x, y }) => globalThis.__live.own('e1').find(a => !ids.includes(a.id) && Math.hypot(a.x - x, a.y - y) < 4) ?? false, { ids: [...before], x: b.x, y: b.y }, 'the garrison out', 20000)
					const rocket = await make('e3', false)
					const back = await ride(rocket, b)
					record(`${type}:Cargo`, `built manned: its rifleman (id ${crew.id}) came out on Unload; a rocket soldier went in (left the world) and came out again at (${Math.floor(back.x)},${Math.floor(back.y)})`)
				} catch (error) { fail(`${type}:Cargo`, error) }
				if (type === 'hbox') {
					const cloaked = await m.waitFor(id => { const a = globalThis.steelseed.ctx.snapshot.actors; for (let i = 0; i < a.count; i++) if (a.id[i] === id) return (a.flags[i] & 2) !== 0; return false }, b.id, 'the camo pillbox cloaked', 20000).then(() => true, () => false)
					if (cloaked) record('hbox:Cloak', 'idle, the camo pillbox carries the cloaked flag')
					else fail('hbox:Cloak', 'the cloaked flag was never set')
				}
				// The same height every time (view's zoom is relative, so steps would pile up), a little
				// above the default, so a building's neighbours rarely cover it.
				await m.gate(h => { globalThis.steelseed.ctx.get('camera').heightGoal = h }, cameraHeight)
				await m.view(b.x + 0.5, b.y + 0.5, { settleMs: 700 })
				if (!WALLS.has(type)) {
					const { start, hit } = await hurt(b.id, shooters)
					// The shooters park away from it, so the player's click finds the building.
					await m.gate(({ ids, x, y }) => globalThis.__live.unitOrder(ids, 'Move', { targetCell: { x, y } }), { ids: shooters.map(t => t.id), x: Math.floor(yard.x) - 4, y: Math.floor(yard.y) + 6 })
					await m.page.waitForTimeout(2500)
					if (!(await clickActor(b))) { await m.shot(`select-failed-${type}`); throw new Error(`the click did not select it (${lastClick})`) }
					await m.page.click('#hud-repair')
					const mended = await m.waitFor(({ id, h }) => { const a = globalThis.__live.actor(id); return a && a.health > h + 8 ? a.health : false }, { id: b.id, h: hit }, 'the repair', 45000)
					const mark = await m.gate(() => [...document.querySelectorAll('.hud-repair-mark')].some(g => g.style.display !== 'none'))
					if (captures.length < 60 && ['weap', 'proc', 'powr', 'tsla', 'iron'].includes(type)) { await m.shot(`repair-${type}`); captures.push(`repair-${type}`) }
					record(`${type}:RepairableBuilding`, `hit by own forced fire (${start} -> ${hit} of 255); selected, the HUD Repair button: health rose to ${mended}${mark ? ' under the repair mark' : ''}`)
					await m.page.keyboard.press('Escape')
				}
				const f0 = await funds()
				await m.page.click('#hud-sell'); await m.page.waitForTimeout(200)
				const now = await actorOf(b.id)
				// A wall stands knee-high: the click that finds it is low on the cell.
				let sold = false
				const points = WALLS.has(type) ? [[0, 0, 0.3], [0, 0, 0.15], [0, 0, 0.6]]
					: [[0, 0, 0.8], [0, 0, 0.4], [0, 0, 1.4], [-0.7, -0.7, 0.4], [0.7, -0.7, 0.4], [-0.7, 0.7, 0.4], [0.7, 0.7, 0.4]]
				for (const [dx, dy, h] of points) {
					const px = await m.gate(({ x, y, h }) => {
						const render = globalThis.steelseed.ctx.get('render'), terrain = globalThis.steelseed.ctx.get('terrain'), vp = render.camera.viewProj
						const wy = terrain.heightAt(x, y) + h, w = vp[3] * x + vp[7] * wy + vp[11] * y + vp[15], rect = globalThis.steelseed.ctx.canvas.getBoundingClientRect()
						return { x: rect.left + ((vp[0] * x + vp[4] * wy + vp[8] * y + vp[12]) / w * 0.5 + 0.5) * rect.width, y: rect.top + (0.5 - (vp[1] * x + vp[5] * wy + vp[9] * y + vp[13]) / w * 0.5) * rect.height }
					}, { x: WALLS.has(type) ? Math.floor(now.x) + 0.5 : now.x + dx, y: WALLS.has(type) ? Math.floor(now.y) + 0.5 : now.y + dy, h })
					if (!(await m.gate(({ x, y }) => document.elementFromPoint(x, y)?.id === 'viewport', px))) continue
					await m.page.mouse.click(px.x, px.y)
					sold = await m.waitFor(id => globalThis.__live.actor(id) === null, b.id, 'the building sold', 6000).then(() => true, () => false)
					if (sold) break
				}
				const notice = await m.gate(() => document.getElementById('hud-notice')?.textContent ?? '')
				await m.page.keyboard.press('Escape')
				if (!sold) { await m.shot(`sell-failed-${type}`); throw new Error(`the Sell click never took (notice "${notice.slice(0, 60)}")`) }
				const f1 = await funds()
				record(`${type}:Sellable`, `the Sell button and a click on it: OpenRA dismantled it (funds ${f0} -> ${f1})`)
			} catch (error) { fail(`${type}:buildings`, error); await m.page.keyboard.press('Escape').catch(() => {}) }
		}
	}
	return captures
}

/**
 * Epic 6/S06: the map's own civilians and creeps, which no player ever commands (the census marks
 * their orders unavailable) but every player can shoot. One of each type in view is killed where
 * the map placed it (DevKill, a shell's damage types) and its death is recorded as drawn. Run on
 * the maps that place them: --map=Climax, Ridges, Sidestep, "Ore Gardens", Archipelago.
 */
scenarios.civilians = async function civilians(m) {
	await installWeaponObserver(m)
	await m.hideHud()
	const captures = [], date = new Date().toISOString().slice(0, 10)
	const CIV = /^(c[0-9]+|einstein|gnrl|tecn2?|ant|warriorant|zombie|chan|delphi)$/
	const probe = () => m.gate(() => {
		const ctx = globalThis.steelseed.ctx, units = ctx.get('units')
		return { deaths: { ...units.deathStats }, impacts: { ...globalThis.__weaponObs.impacts } }
	})
	const targets = await m.gate(civ => {
		const ctx = globalThis.steelseed.ctx, snap = ctx.snapshot, me = snap.world.renderPlayer, out = {}, re = new RegExp(civ)
		for (let i = 0; i < snap.actors.count; i++) {
			const type = ctx.actorTypeName(snap.actors.typeId[i])
			if (snap.actors.owner[i] === me || !re.test(type) || out[type] || snap.actors.health[i] === 0) continue
			out[type] = { id: snap.actors.id[i], type, x: snap.actors.posX[i] / 1024, y: snap.actors.posY[i] / 1024, owner: snap.actors.owner[i] }
		}
		return Object.values(out)
	}, CIV.source)
	console.log(`  ${targets.length} civilian/creep types on ${m.map.title}: ${targets.map(t => t.type).join(', ')}`)
	for (const t of targets.filter(t => ONLY.length === 0 || ONLY.includes(t.type))) {
		try {
			await m.view(t.x + 0.5, t.y + 0.5, { zoom: 3, settleMs: 600 })
			const before = await probe()
			const frozen = m.freezeOn('sim:actor:destroyed', { actorId: t.id }, 15000)
			const reply = await m.gate(id => globalThis.__live.playerOrder('DevKill', { targetActorId: id, targetString: 'ExplosionDeath' }), t.id)
			await frozen
			await m.page.waitForTimeout(150)
			await m.shot(`civ-${t.type}-0`); captures.push(`civ-${t.type}-0`)
			await m.advanceTicks(12)
			await m.shot(`civ-${t.type}-12`); captures.push(`civ-${t.type}-12`)
			await m.resume()
			await m.page.waitForTimeout(800)
			const after = await probe()
			const remains = after.deaths.births - before.deaths.births
			const explosions = Object.fromEntries(Object.entries(after.impacts).map(([w, n]) => [w, n - (before.impacts[w] ?? 0)]).filter(([, n]) => n > 0))
			if (remains < 1) throw new Error(`killed (DevKill ${String(reply).slice(0, 20)}), but no remains were drawn`)
			const line = `the map's ${t.type} killed where it stood (DevKill, a shell's damage types): its death drawn (remains ${remains}${Object.keys(explosions).length ? `, explosions ${JSON.stringify(explosions)}` : ''}) on ${m.map.title}`
			console.log(`  ${t.type}: ${line}`)
			writeEvidence({}, { [`${t.type}:death`]: `S06 vfxscenario civilians ${date}: ${line}` })
		} catch (error) { await m.resume().catch(() => {}); console.log(`  ${t.type}: NOT SHOWN — ${error.message.slice(0, 140)}`) }
	}
	return captures
}

const run = scenarios[SCENARIO]
if (!run) throw new Error(`unknown scenario ${SCENARIO}; known: ${Object.keys(scenarios).join(', ')}`)
const MAP_FOR = { naval: 'Archipelago', deaths: 'Archipelago', actions: 'Archipelago' }
const m = await openLiveMatch({ tool: `vfxscenario${PORT === 8499 ? '' : `-${PORT}`}`, port: PORT, quality: QUALITY, mapTitle: MAP ?? MAP_FOR[SCENARIO] ?? 'Altercation', ...(OUT ? { shots: resolve(OUT) } : {}) })
m.census = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../docs/vfx/census.json'), 'utf8')).actors
try {
	const captures = await run(m)
	if (m.errors.length) throw new Error(`page errors: ${m.errors.join('; ')}`)
	console.log(`vfxscenario ${SCENARIO} (${QUALITY}): ${captures.length} captures in ${m.shots}`)
	for (const c of captures) console.log(`  ${join(m.shots, c)}.png`)
} finally {
	await m.close()
}
