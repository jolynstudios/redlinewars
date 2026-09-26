// STEELSEED — pick parity (vfx.md Epic 2): the cell under the cursor is the cell OpenRA moves to.
//
// A real match with fog on. A tank is selected with a click and sent with a right click to cells
// around it, under different cameras: turned, zoomed in and out, tilted, the window resized, at
// device pixel ratio 1 and 2, onto a slope where the ground rises, by attack-move (F, then a
// click) and by a forced attack on the ground (Ctrl + right click). For each:
//   - OpenRA's answer is "ok";
//   - the move marker lands on the clicked ground (the reticle the player saw);
//   - the tank ends on exactly the clicked cell (the simulation's answer), or, forced, fires at it.
// And a click on a cliff (ground no tank may enter) goes as OpenRA takes it: the order carries the
// clicked cell, the marker lands on it, and the tank drives as close as it can, never onto it.
// One CSS-pixel convention runs through all of it: page.mouse, canvasCss, the camera's pick.
//
// Usage (from web/, after `vite build` and compose): node tools/pickparitygate.mjs
import assert from 'node:assert/strict'
import { openLiveMatch } from './live-match.mjs'

const results = []
for (const dpr of [1, 2]) {
	const m = await openLiveMatch({ tool: `pickparitygate-dpr${dpr}`, port: 8485 + dpr, deviceScaleFactor: dpr, options: { fog: 'True' } })
	try {
		const tanks = await m.gate(() => ['2tnk', '1tnk', '3tnk', 'jeep'].flatMap(t => globalThis.__live.own(t)))
		assert.ok(tanks.length > 0, 'no own vehicle to drive')
		const tank = tanks[0]
		const cases = [
			{ label: 'default', view: {} },
			{ label: 'turned+zoomed-in', view: { rotate: 0.85, zoom: 3 } },
			{ label: 'turned-back+zoomed-out+tilted', view: { rotate: -1.7, zoom: -2, tilt: 0.18 } },
			{ label: 'resized', view: {}, resize: { width: 1180, height: 780 } },
			{ label: 'slope', view: { rotate: 0.4 }, slope: true },
			{ label: 'attack-move', view: { rotate: -0.6 }, mode: 'attackmove' },
			{ label: 'force-fire', view: { rotate: 0.3, zoom: 1 }, mode: 'force' },
			{ label: 'cliff', view: {}, mode: 'cliff' },
		]
		// Fire events by shooter, for the forced attack on the ground.
		await m.gate(() => {
			const app = globalThis.steelseed
			globalThis.__fires = {}
			app.events.on('sim:weapon:fire', e => { const v = app.ctx.snapshot?.view; if (v && e.byteLength >= 4) { const id = v.getUint32(e.offset, true); globalThis.__fires[id] = (globalThis.__fires[id] ?? 0) + 1 } })
		})
		for (const c of cases) {
			const at = await m.gate(id => globalThis.__live.actor(id), tank.id)
			if (c.resize) { await m.page.setViewportSize(c.resize); await m.page.waitForTimeout(600) }
			// The destination: open land 4 to 7 cells off, or on a slope the highest rise a tank may
			// enter. "May enter" is OpenRA's own answer (the snapshot's passability, tracked bit) on a
			// cell clear of actors; the drawn height alone would pick cliff tops.
			const mode = c.mode ?? 'move'
			const dest = await m.gate(({ x, y, slope, cliff }) => {
				const ctx = globalThis.steelseed.ctx, terrain = ctx.get('terrain'), here = terrain.heightAt(x, y)
				// The static grid covers the playable bounds only and starts at their top-left corner.
				const grid = terrain.terrainSource, snap = ctx.snapshot, TRACKED = 1 << 2, w = snap.world
				// Clear of every actor by 2.3 cells: a rock or a tree cluster covers cells well off its centre.
				const occupied = (cx, cy) => { for (let i = 0; i < snap.actors.count; i++) if (Math.hypot(snap.actors.posX[i] / 1024 - (cx + 0.5), snap.actors.posY[i] / 1024 - (cy + 0.5)) < 2.3) return true; return false }
				let best = null
				for (let d = 4; d <= 7; d++) for (let a = 0; a < 16; a++) {
					const cx = Math.round(x + Math.cos(a / 16 * Math.PI * 2) * d), cy = Math.round(y + Math.sin(a / 16 * Math.PI * 2) * d)
					const s = globalThis.__live.surface(cx, cy)
					if (s < 0 || s === 8 || s === 9) continue
					if (globalThis.__live.water(cx, cy) != null) continue
					if (cx < w.boundsLeft || cy < w.boundsTop || cx >= w.boundsRight || cy >= w.boundsBottom) continue
					const passable = !grid || (grid.passability[(cy - w.boundsTop) * grid.w + (cx - w.boundsLeft)] & TRACKED) !== 0
					// A cliff: ground no tank may enter, bare of actors (not a tree or a wall).
					if (cliff) { if (!passable && !occupied(cx, cy)) return { x: cx, y: cy, rise: 0 }; continue }
					if (!passable) continue
					if (occupied(cx, cy)) continue
					const rise = Math.abs(terrain.heightAt(cx + 0.5, cy + 0.5) - here)
					if (!slope) return { x: cx, y: cy, rise }
					if (!best || rise > best.rise) best = { x: cx, y: cy, rise }
				}
				return best
			}, { x: at.x, y: at.y, slope: Boolean(c.slope), cliff: mode === 'cliff' })
			if (!dest && mode === 'cliff') { results.push(`dpr ${dpr} ${c.label}: no impassable ground within 7 cells of the tank; skipped`); continue }
			assert.ok(dest, `${c.label}: no destination`)
			await m.view(at.x + 0.5, at.y + 0.5, c.view)
			const tankPx = await m.gate(({ x, y }) => globalThis.__live.cellPx(Math.floor(x), Math.floor(y), 0.5), at)
			await m.page.mouse.click(tankPx.x, tankPx.y)
			await m.page.waitForTimeout(250)
			const selected = await m.gate(id => globalThis.steelseed.ctx.get('ui').selected.includes(id), tank.id)
			assert.ok(selected, `${c.label}: the click did not select the tank`)
			// Bring the destination into view (focus only: the case's turn, zoom and tilt stay).
			await m.view(dest.x + 0.5, dest.y + 0.5, { settleMs: 500 })
			const px = await m.gate(({ x, y }) => globalThis.__live.cellPx(x, y), dest)
			const size = m.page.viewportSize()
			assert.ok(px.onScreen && px.x > 8 && px.y > 8 && px.x < size.width - 8 && px.y < size.height - 8, `${c.label}: the destination is off screen ${JSON.stringify(px)}`)
			const replies = await m.gate(() => globalThis.__orders.length)
			const fires0 = await m.gate(id => globalThis.__fires[id] ?? 0, tank.id)
			await m.page.mouse.move(px.x, px.y); await m.page.waitForTimeout(150)
			if (mode === 'attackmove') {
				// F arms attack-move; the next left click is the order.
				await m.page.keyboard.press('f'); await m.page.waitForTimeout(120)
				await m.page.mouse.down(); await m.page.mouse.up()
			} else if (mode === 'force') {
				await m.page.keyboard.down('Control')
				await m.page.mouse.down({ button: 'right' }); await m.page.mouse.up({ button: 'right' })
				await m.page.keyboard.up('Control')
			} else {
				await m.page.mouse.down({ button: 'right' }); await m.page.mouse.up({ button: 'right' })
			}
			if (mode === 'cliff') {
				// OpenRA takes a move onto ground the tank cannot enter (its cursor reads blocked) and
				// drives as close as it can: the order carries the clicked cell, the marker lands on
				// it, and the tank stops beside the cliff, never on it.
				const order = await m.waitFor(n => globalThis.__orders.length > n && globalThis.__orders.at(-1).reply !== null ? globalThis.__orders.at(-1) : false, replies, `${c.label}: the order reply`, 5000)
				assert.match(order.reply, /^ok/, `${c.label}: OpenRA refused (${order.reply})`)
				assert.deepEqual(order.targetCell, { x: dest.x, y: dest.y }, `${c.label}: the order's cell is not the clicked cell`)
				const marker = await m.gate(() => { const mk = globalThis.steelseed.ctx.get('ui').orderMarker; return { x: mk.x, z: mk.z, active: mk.active } })
				assert.ok(marker.active && Math.abs(marker.x - (dest.x + 0.5)) <= 0.6 && Math.abs(marker.z - (dest.y + 0.5)) <= 0.6, `${c.label}: the marker is off the clicked cell`)
				let last = null, still = 0
				for (let k = 0; k < 60 && still < 4; k++) {
					await m.page.waitForTimeout(500)
					const now = await m.gate(id => globalThis.__live.actor(id), tank.id)
					still = last && Math.hypot(now.x - last.x, now.y - last.y) < 0.05 ? still + 1 : 0
					last = now
				}
				const distance = Math.hypot(last.x - dest.x - 0.5, last.y - dest.y - 0.5)
				assert.ok(!(Math.floor(last.x) === dest.x && Math.floor(last.y) === dest.y), `${c.label}: the tank stands on the cliff`)
				assert.ok(distance <= 3, `${c.label}: the tank stopped ${distance.toFixed(1)} cells from the cliff`)
				await m.shot(`${c.label}`)
				results.push(`dpr ${dpr} ${c.label}: cell (${dest.x},${dest.y}) impassable: reply ok, marker on the clicked cell, the tank stopped ${distance.toFixed(1)} cells from it, beside the cliff`)
				continue
			}
			const reply = await m.waitFor(n => globalThis.__orders.length > n && globalThis.__orders.at(-1).reply !== null ? globalThis.__orders.at(-1) : false, replies, `${c.label}: the order reply`, 5000)
				.catch(async error => {
					await m.shot(`${c.label}-no-reply`)
					const ui = await m.gate(() => ({ selected: [...globalThis.steelseed.ctx.get('ui').selected], orders: globalThis.__orders.length, viewport: [innerWidth, innerHeight] }))
					throw new Error(`${error.message}: cursor ${JSON.stringify(px)} dest ${JSON.stringify(dest)} ${JSON.stringify(ui)}`)
				})
			assert.match(reply.reply, /^ok/, `${c.label}: OpenRA refused (${reply.reply})`)
			assert.deepEqual(reply.targetCell, { x: dest.x, y: dest.y }, `${c.label}: the order's cell is not the clicked cell`)
			const marker = await m.gate(() => { const mk = globalThis.steelseed.ctx.get('ui').orderMarker; return { x: mk.x, z: mk.z, active: mk.active } })
			assert.ok(marker.active && Math.abs(marker.x - (dest.x + 0.5)) <= 0.6 && Math.abs(marker.z - (dest.y + 0.5)) <= 0.6,
				`${c.label}: the move marker is off the clicked cell ${JSON.stringify(marker)} vs ${dest.x},${dest.y}`)
			if (mode === 'force') {
				// The forced attack on the ground: the tank opens fire at the clicked cell.
				await m.waitFor(({ id, n }) => (globalThis.__fires[id] ?? 0) > n, { id: tank.id, n: fires0 }, `${c.label}: the tank firing at the cell`, 15000)
				await m.shot(`${c.label}`)
				await m.gate(id => globalThis.__live.unitOrder([id], 'Stop'), tank.id)
				results.push(`dpr ${dpr} ${c.label}: cell (${dest.x},${dest.y}): reply ok (${String(reply.reply).slice(0, 40)}), marker on the cell, the tank fired at it`)
				if (c.resize) await m.page.setViewportSize({ width: 1600, height: 900 })
				continue
			}
			try {
				await m.waitFor(({ id, x, y }) => { const a = globalThis.__live.actor(id); return a && Math.floor(a.x) === x && Math.floor(a.y) === y }, { id: tank.id, ...dest }, `${c.label}: the tank on the clicked cell`, 40000)
			} catch (error) {
				const where = await m.gate(({ id, x, y }) => {
					const a = globalThis.__live.actor(id), grid = globalThis.steelseed.ctx.get('terrain').terrainSource, w = globalThis.steelseed.ctx.snapshot.world
					return { tank: a && { x: +a.x.toFixed(2), y: +a.y.toFixed(2) }, dest: { x, y }, passability: grid?.passability[(y - w.boundsTop) * grid.w + (x - w.boundsLeft)], surface: globalThis.__live.surface(x, y) }
				}, { id: tank.id, ...dest })
				throw new Error(`${error.message}: ${JSON.stringify(where)}`)
			}
			await m.shot(`${c.label}`)
			results.push(`dpr ${dpr} ${c.label}: cell (${dest.x},${dest.y})${c.slope ? `, rise ${dest.rise.toFixed(2)} m` : ''}: reply ok, marker on the cell, the tank arrived`)
			if (c.resize) await m.page.setViewportSize({ width: 1600, height: 900 })
		}
		assert.deepEqual(m.errors, [], 'page errors')
	} finally {
		await m.close()
	}
}
for (const line of results) console.log(`  ${line}`)
console.log(`pickparitygate: PASS — ${results.length} orders, each landing on the clicked cell (fog on, DPR 1 and 2)`)
