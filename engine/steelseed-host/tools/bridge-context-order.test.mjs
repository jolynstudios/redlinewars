import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const bridgeSource = await readFile(
	new URL('../OpenRA.Browser/wwwroot/openra-steelseed-bridge.js', import.meta.url),
	'utf8',
);
const { createSteelseedBridge } = await import(
	`data:text/javascript;base64,${Buffer.from(bridgeSource).toString('base64')}`
);

const createFixture = () => {
	const heap = new Uint8Array(256);
	const scratch = new Uint8Array(16);
	const calls = [];
	const placement = new DataView(heap.buffer, 128, 128);
	placement.setUint32(0, 0x4c505353, true);
	placement.setUint16(4, 1, true);
	placement.setUint8(6, 0);
	placement.setUint8(7, 1);
	placement.setUint32(8, 52, true);
	placement.setInt32(12, 417, true);
	placement.setUint32(16, 77, true);
	placement.setUint16(20, 2, true);
	placement.setInt32(24, 19, true);
	placement.setInt32(28, 27, true);
	placement.setUint16(32, 2, true);
	placement.setUint16(34, 2, true);
	placement.setUint16(36, 1, true);
	placement.setInt32(40, 19, true);
	placement.setInt32(44, 27, true);
	placement.setUint8(48, 1);
	const program = {
		OrderSubjectScratch: () => ({ byteLength: scratch.byteLength, set: bytes => scratch.set(bytes) }),
		SnapshotBufferGeneration: () => 1,
		SnapshotBufferPointer: slot => slot === 0 ? 0 : 64,
		SnapshotBufferCapacity: () => 64,
		IssueOrderN: (...args) => { calls.push(['generic', ...args]); return 'generic-result'; },
		QueryContextOrderN: (...args) => { calls.push(['query', ...args]); return 'Move\nmove'; },
		IssueContextOrderN: (...args) => { calls.push(['context', ...args]); return 'context-result'; },
		PlacementBufferPointer: () => 128,
		PlacementBufferCapacity: () => 128,
		QueryBuildingPlacement: (...args) => { calls.push(['placement-query', ...args]); return 52; },
		PlaceBuildingValidated: (...args) => { calls.push(['placement-place', ...args]); return 52; },
	};
	return { bridge: createSteelseedBridge(program, () => heap), calls, scratch };
};

test('context orders cross the JavaScript-to-WASM adapter with the selected subject prefix', () => {
	const { bridge, calls, scratch } = createFixture();
	const order = {
		subjectIds: Uint32Array.of(0x12345678, 0x90abcdef),
		subjectCount: 1,
		targetActorId: 42,
		targetCellX: 12,
		targetCellY: 9,
		targetFrozen: true,
		modifiers: 4,
	};

	assert.deepEqual(bridge.queryContextOrder(order), { order: 'Move', cursor: 'move' });
	assert.deepEqual(calls[0], ['query', 1, 42, 12, 9, true, 4]);
	assert.deepEqual(Array.from(scratch), [0x78, 0x56, 0x34, 0x12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

	assert.equal(bridge.issueContextOrder(order), 'context-result');
	assert.deepEqual(calls[1], ['context', 1, 42, 12, 9, true, 4]);
});

test('placement query and click-time validation survive the worker bridge adapter', () => {
	const { bridge, calls } = createFixture();
	const request = { queueId: 2, actorType: 'powr', cellX: 19, cellY: 27, variant: 0, modifiers: 1 };
	const query = bridge.queryBuildingPlacement(request);
	assert.equal(query.valid, true);
	assert.equal(query.issued, false);
	assert.equal(query.orderType, 'PlaceBuilding');
	assert.deepEqual(query.cells, [{ x: 19, y: 27, valid: true, lineBuild: false, flags: 1 }]);
	const placed = bridge.placeBuildingValidated(request);
	assert.equal(placed.valid, true);
	assert.equal(placed.issued, true);
	assert.deepEqual(calls, [
		['placement-query', 2, 'powr', 19, 27, 0, 1],
		['placement-place', 2, 'powr', 19, 27, 0, 1],
	]);
});

test('generic orders honor subjectCount instead of issuing to the entire backing array', () => {
	const { bridge, calls, scratch } = createFixture();
	assert.equal(bridge.issueOrder({
		orderString: 'Move',
		subjectIds: Uint32Array.of(7, 8),
		subjectCount: 1,
	}), 'generic-result');
	// Trailing -1, -1: no ExtraLocation (Chronoshift's source cell rides there).
	assert.deepEqual(calls[0], ['generic', 'Move', 1, 0, -1, -1, false, '', 0, -1, -1]);
	assert.deepEqual(Array.from(scratch), [7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('support power orders carry uint.MaxValue extra data and the Chronoshift source cell', () => {
	const { bridge, calls } = createFixture();
	bridge.issueOrder({
		orderString: 'Chronoshift',
		subjectIds: new Uint32Array(0),
		subjectCount: 0,
		targetCellX: 30,
		targetCellY: 20,
		extraData: 0xFFFFFFFF,
		extraCellX: 12,
		extraCellY: 9,
	});
	// OpenRA's ExtraData is a uint; the int32 export receives its 32 bits (uint.MaxValue as -1).
	assert.deepEqual(calls[0], ['generic', 'Chronoshift', 0, 0, 30, 20, false, '', -1, 12, 9]);
});

test('invalid subject prefixes fail before calling the WASM export', () => {
	const { bridge, calls } = createFixture();
	assert.throws(() => bridge.issueContextOrder({
		subjectIds: Uint32Array.of(1),
		subjectCount: 2,
	}), /invalid subjectCount/);
	assert.deepEqual(calls, []);
});
