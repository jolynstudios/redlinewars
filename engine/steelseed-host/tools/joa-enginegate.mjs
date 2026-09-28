#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {bootRuntime,configFor,waitForSnapshot} from './runtime-fixture.mjs';
const actors=JSON.parse(readFileSync(new URL('../generated/ra-visual-source.json',import.meta.url))).actors;
const hero=actors.jackson, commando=actors.e7;
assert.ok(hero&&commando);
const traits=a=>a.traits??a.Traits;
assert.ok(traits(hero), 'resolved hero missing');
const runtime=await bootRuntime();
const catalog=runtime.bridge.getSkirmishCatalog(),map=catalog.maps.find(m=>m.slots.length>=2&&!m.slots[0].locks.faction);
assert.ok(map);
const option=map.options.find(o=>o.id==='joa-companion');assert.equal(option.defaultValue,'True');
const config=configFor(catalog,map);config.local.faction='england';config.slots.find(s=>s.slot===config.local.slot).faction='england';const enabled=process.argv.includes('--enabled');config.options['joa-companion']=enabled?'True':'False';
const result=runtime.bridge.startSkirmish(config);assert.ok(['started','running','loading'].includes(result.status),JSON.stringify(result));
const {header}=await waitForSnapshot(runtime,{minimumTick:2});assert.equal(header.flags&16,enabled?16:0,'immutable host policy must reach the shared WASM snapshot');
const support=runtime.bridge.getSupportPowers();assert.ok(support.inventory&&Object.values(support.inventory).every(n=>Number.isInteger(n)&&n>=0));
assert.ok(runtime.bridge.snapshotTypeTable().includes('jackson'));
console.log('JOA engine: PASS resolved hero, lobby option, native start, captured snapshot policy and owned inventory');
