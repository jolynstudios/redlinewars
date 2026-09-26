// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

const SNAPSHOT_HEADER_BYTES = 32;
const SNAPSHOT_BYTE_LENGTH_OFFSET = 8;
const RESERVED_POLL_TOKEN = -2147483648;

/**
 * Publish the readiness handle synchronously, before the host's first await.
 * The web module may begin evaluating while main.js is suspended in dotnet.create();
 * script order is therefore not a readiness signal.
 */
export function publishSteelseedBridgeReadiness() {
	if (globalThis.steelseedBridgeReady !== undefined)
		throw new Error('steelseedBridgeReady was already published');

	let resolveReady;
	let rejectReady;
	const promise = new Promise((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	globalThis.steelseedBridgeReady = promise;
	return { promise, resolve: resolveReady, reject: rejectReady };
}

/**
 * Adapt primitive [JSExport] calls into the presentation BridgeApi.
 *
 * Snapshot polling aliases the two C#-owned pinned arrays directly. The views are
 * rebuilt only when either the managed generation changes or WebAssembly.Memory.grow
 * replaces the heap ArrayBuffer. Order subjects travel in the other direction through
 * one C#-owned MemoryView obtained here and retained for the session.
 */
export function createSteelseedBridge(P, localHeapViewU8) {
	if (typeof localHeapViewU8 !== 'function')
		throw new TypeError('localHeapViewU8 must be a function');

	const orderScratch = P.OrderSubjectScratch();
	if (orderScratch == null || !Number.isSafeInteger(orderScratch.byteLength) || orderScratch.byteLength < 4)
		throw new Error('OrderSubjectScratch returned no writable capacity');
	const orderBytes = new Uint8Array(orderScratch.byteLength);

	let generation = null;
	let heapBuffer = null;
	let pointers = [0, 0];
	let capacities = [0, 0];
	let slots = [null, null];
	let validators = [null, null];

	const acquireSnapshotMetadata = () => {
		for (;;) {
			const generation0 = P.SnapshotBufferGeneration();
			const heap0 = localHeapViewU8();
			const pointer0 = P.SnapshotBufferPointer(0);
			const capacity0 = P.SnapshotBufferCapacity(0);
			const pointer1 = P.SnapshotBufferPointer(1);
			const capacity1 = P.SnapshotBufferCapacity(1);
			const generation1 = P.SnapshotBufferGeneration();
			const heap1 = localHeapViewU8();

			// Seqlock retry. Discard every value from an attempt that straddled either
			// a managed repin or a WASM heap epoch change. PollSnapshotToken is NOT
			// called again: the token remains the one whose publication we are reading.
			if (generation0 !== generation1 || heap0.buffer !== heap1.buffer)
				continue;

			if (!Number.isSafeInteger(pointer0) || pointer0 < 0 ||
				!Number.isSafeInteger(capacity0) || capacity0 < SNAPSHOT_HEADER_BYTES ||
				pointer0 + capacity0 > heap1.byteLength)
				throw new RangeError(
					`snapshot slot 0 is outside the WASM heap: ` +
					`pointer=${pointer0} capacity=${capacity0} heap=${heap1.byteLength}`,
				);
			if (!Number.isSafeInteger(pointer1) || pointer1 < 0 ||
				!Number.isSafeInteger(capacity1) || capacity1 < SNAPSHOT_HEADER_BYTES ||
				pointer1 + capacity1 > heap1.byteLength)
				throw new RangeError(
					`snapshot slot 1 is outside the WASM heap: ` +
					`pointer=${pointer1} capacity=${capacity1} heap=${heap1.byteLength}`,
				);

			const epochChanged = generation !== generation1 || heapBuffer !== heap1.buffer;
			if (!epochChanged) {
				if (pointers[0] !== pointer0 || pointers[1] !== pointer1 ||
					capacities[0] !== capacity0 || capacities[1] !== capacity1)
					throw new Error('snapshot pointer/capacity changed without a generation bump');
				return;
			}

			const base = heap1.byteOffset;
			const nextSlots = [
				new Uint8Array(heap1.buffer, base + pointer0, capacity0),
				new Uint8Array(heap1.buffer, base + pointer1, capacity1),
			];
			const nextValidators = [
				new DataView(heap1.buffer, base + pointer0, capacity0),
				new DataView(heap1.buffer, base + pointer1, capacity1),
			];

			generation = generation1;
			heapBuffer = heap1.buffer;
			pointers[0] = pointer0;
			pointers[1] = pointer1;
			capacities[0] = capacity0;
			capacities[1] = capacity1;
			slots = nextSlots;
			validators = nextValidators;
			return;
		}
	};

	// Initialise both pinned aliases while constructing the adapter. Later calls only
	// rebuild them after a generation/heap epoch change.
	acquireSnapshotMetadata();

	return Object.freeze({
		pollSnapshot() {
			const token = P.PollSnapshotToken();
			if (token === 0) return null;
			if (!Number.isInteger(token) || token === RESERVED_POLL_TOKEN)
				throw new Error(`invalid snapshot poll token ${token}`);

			const slot = token > 0 ? 0 : 1;
			const length = Math.abs(token);
			acquireSnapshotMetadata();
			if (length < SNAPSHOT_HEADER_BYTES || length > capacities[slot])
				throw new RangeError(
					`snapshot token length ${length} exceeds slot ${slot} capacity ${capacities[slot]}`,
				);
			const headerLength = validators[slot].getUint32(SNAPSHOT_BYTE_LENGTH_OFFSET, true);
			if (headerLength !== length)
				throw new Error(
					`snapshot token/header length mismatch for slot ${slot}: ${length} != ${headerLength}`,
				);
			return slots[slot];
		},

		snapshotTypeTable() {
			return P.SnapshotTypeTable();
		},

		listMaps() {
			return P.ListMaps();
		},

		getSkirmishCatalog() {
			// The bridge publishes before runMain finishes; the C# answers an
			// error object until Game.ModData exists. Surface that as null so the
			// session screen's retry loop waits for initialization (fail-closed).
			const parsed = JSON.parse(P.GetSkirmishCatalog());
			return parsed.code ? null : parsed;
		},

		startSkirmish(config) {
			// The host export takes one JSON string (StartConfig); the UI hands us
			// the already-typed config object. The result is the SessionStatus JSON.
			return JSON.parse(P.StartSkirmish(typeof config === 'string' ? config : JSON.stringify(config)));
		},

		startGeneratedSkirmish(request) {
			if (request == null)
				throw new TypeError('startGeneratedSkirmish requires a request');
			return P.StartGeneratedSkirmish(
				request.generatorType,
				request.optionId,
				request.presetChoice,
				request.tileset,
				request.botCount,
				request.botType,
			);
		},

		issueOrder(order) {
			if (order == null || !(order.subjectIds instanceof Uint32Array))
				throw new TypeError('issueOrder requires an OrderIntent with Uint32Array subjectIds');
			const count = order.subjectIds.length;
			const byteLength = count * 4;
			if (!Number.isSafeInteger(byteLength) || byteLength > orderBytes.byteLength)
				throw new RangeError(
					`order has ${count} subjects; scratch capacity is ${orderBytes.byteLength / 4}`,
				);

			// Pack little-endian explicitly. Passing the Uint32Array itself to a byte
			// MemoryView.set would convert elements, not copy their four-byte storage.
			for (let i = 0; i < count; i++) {
				const id = order.subjectIds[i];
				const p = i * 4;
				orderBytes[p] = id & 0xff;
				orderBytes[p + 1] = (id >>> 8) & 0xff;
				orderBytes[p + 2] = (id >>> 16) & 0xff;
				orderBytes[p + 3] = (id >>> 24) & 0xff;
			}
			// Copy the fixed staging array. IssueOrderN consumes only subjectCount entries,
			// so stale bytes after byteLength are deliberately irrelevant.
			orderScratch.set(orderBytes);
			return P.IssueOrderN(
				order.orderString,
				count,
				order.targetActorId,
				order.targetCellX,
				order.targetCellY,
				order.queued,
				order.targetString,
				order.extraData,
			);
		},
	});
}
