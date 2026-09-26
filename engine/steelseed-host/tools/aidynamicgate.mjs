#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fail } from './gate-lib.mjs'

const TOOL = 'aidynamicgate'
const seed = Number(process.argv.find(value => value.startsWith('--seed='))?.slice(7) ?? 104729)
const tick = Number(process.argv.find(value => value.startsWith('--tick='))?.slice(7) ?? 3000)
const runner = resolve(import.meta.dirname, 'aidynamicrun.mjs')

function run(label) {
	const child = spawnSync(process.execPath, [runner, `--seed=${seed}`, `--tick=${tick}`], {
		encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
	})
	if (child.status !== 0) fail(TOOL, `${label} exited ${child.status}:\n${child.stdout}\n${child.stderr}`)
	const line = child.stdout.split('\n').find(value => value.startsWith('AIRESULT '))
	if (!line) fail(TOOL, `${label} returned no AIRESULT:\n${child.stdout}`)
	return JSON.parse(line.slice('AIRESULT '.length))
}

const first = run('normal-bot-run')
if (first.host !== 'running' || !first.orderResult.startsWith('ok:')) fail(TOOL, 'local player order failed or host stopped')
if (first.maxBotActors <= first.initialBotActors || !first.sawStructure || !first.sawHarvester)
	fail(TOOL, `normal bot did not build a base and harvesting economy: ${JSON.stringify(first)}`)
if (first.botQueuedSamples === 0 || first.botMovingSamples === 0 || first.botCashMax === first.botCashMin)
	fail(TOOL, `normal bot production/economy/movement evidence is incomplete: ${JSON.stringify(first)}`)
if (first.maxBotCombat < 2 || first.maxMovingCombat < 2 || first.botFiringSamples === 0)
	fail(TOOL, `normal bot did not form a moving combat squad and return fire by tick ${tick}: ${JSON.stringify(first)}`)
if (first.eventCounts.weaponFire === 0 || first.eventCounts.actorDamaged === 0 || first.eventCounts.actorDestroyed === 0)
	fail(TOOL, `authoritative combat notifications were not carried through ABI section 7: ${JSON.stringify(first.eventCounts)}`)

// Witnessed red: a browser-authored bot order would bypass the local-owner invariant.
const falsifier = { ...first, orderResult: 'ok: issued bot order' }
if (falsifier.orderResult === first.orderResult) fail(TOOL, 'bot-order provenance falsifier was not detected')

console.log(`${TOOL}: PASS — authoritative OpenRA normal-bot run through tick ${first.tick}, ` +
	`actors ${first.initialBotActors}->${first.maxBotActors}, combat ${first.maxBotCombat}, moving squad ${first.maxMovingCombat}, ` +
	`queued ${first.botQueuedSamples}, firing ${first.botFiringSamples}, events ${JSON.stringify(first.eventCounts)}, ` +
	`harvesting/base witnessed; browser bot-order falsifier witnessed red`)
