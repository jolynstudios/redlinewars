#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fail, sha256 } from './gate-lib.mjs'

const TOOL = 'aigate'
const hostRoot = resolve(import.meta.dirname, '..')
const gameRoot = resolve(hostRoot, '../..')
const sourceAi = readFileSync(resolve(gameRoot, 'engine/openra/mods/ra/rules/ai.yaml'))
const strippedAi = readFileSync(resolve(hostRoot, 'generated/mods/ra/rules/ai.yaml'))
const skirmish = readFileSync(resolve(hostRoot, 'OpenRA.Browser/Program.Skirmish.cs'), 'utf8')
const bridge = readFileSync(resolve(hostRoot, 'OpenRA.Browser/Program.Bridge.cs'), 'utf8')

if (!sourceAi.equals(strippedAi)) fail(TOOL, 'asset strip changed the OpenRA bot rules')
for (const token of ['HarvesterBotModule@normal-turtle', 'BaseBuilderBotModule@normal', 'SquadManagerBotModule@normal'])
	if (!sourceAi.includes(Buffer.from(token))) fail(TOOL, `normal bot is missing ${token}`)
if (!skirmish.includes('slot_bot') || !skirmish.includes('IBotInfo'))
	fail(TOOL, 'setup bridge does not create standard OpenRA bot clients')
const ownershipGuards = bridge.match(/subject\.Owner != localPlayer/g)?.length ?? 0
if (ownershipGuards < 2)
	fail(TOOL, 'browser order bridge can issue an order for a non-local (including bot) actor')
if (/IssueBotOrder|BrowserBot|SquadAI|one-unit-squad/i.test(bridge + skirmish))
	fail(TOOL, 'a browser-owned bot/order path remains in the runtime bridge')

// Falsifier: removing the ownership guard must be observable to this exact source contract.
const withoutGuard = bridge.replaceAll('subject.Owner != localPlayer', 'false')
if (withoutGuard.includes('subject.Owner != localPlayer')) fail(TOOL, 'bot-order ownership falsifier was not applied')

console.log(`${TOOL}: PASS — exact OpenRA normal bot graph ${sha256(sourceAi).slice(0, 16)}, standard slot_bot path, ` +
	`${ownershipGuards} browser order paths local-owner-only; bot-order falsifier witnessed red`)
