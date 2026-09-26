// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

const SNAPSHOT_HEADER_BYTES = 32;
const SNAPSHOT_BYTE_LENGTH_OFFSET = 8;
const RESERVED_POLL_TOKEN = -2147483648;
const PLACEMENT_MAGIC = 0x4c505353;
const PLACEMENT_HEADER_BYTES = 40;
const PLACEMENT_CELL_BYTES = 12;
const PLACEMENT_STATUS = [
	'valid', 'no-world', 'paused', 'invalid-queue', 'unknown-actor', 'not-building',
	'queue-cannot-build', 'not-ready', 'invalid-variant', 'outside-map', 'blocked',
	'out-of-base-radius', 'no-plug-target',
];
const PLACEMENT_ORDER = ['none', 'PlaceBuilding', 'LineBuild', 'PlacePlug'];

/** Decode the pinned Placement ABI before the worker posts the result to the page. */
export function decodePlacement(memoryView, issued = false) {
	const bytes = new Uint8Array(memoryView.byteLength);
	bytes.set(memoryView);
	if (bytes.byteLength < PLACEMENT_HEADER_BYTES)
		throw new RangeError('placement ABI header is truncated');
	const view = new DataView(bytes.buffer);
	if (view.getUint32(0, true) !== PLACEMENT_MAGIC) {
		const prefix = Array.from(bytes.subarray(0, 16), value => value.toString(16).padStart(2, '0')).join(' ');
		throw new Error(`placement ABI magic mismatch: ${prefix}`);
	}
	if (view.getUint16(4, true) !== 1)
		throw new Error(`unsupported placement ABI ${view.getUint16(4, true)}`);
	const byteLength = view.getUint32(8, true);
	const cellCount = view.getUint16(36, true);
	if (byteLength !== PLACEMENT_HEADER_BYTES + cellCount * PLACEMENT_CELL_BYTES || byteLength > bytes.byteLength)
		throw new RangeError(`placement ABI length mismatch ${byteLength}/${bytes.byteLength}`);
	const statusCode = view.getUint8(6);
	const orderCode = view.getUint8(7);
	const cells = new Array(cellCount);
	for (let index = 0; index < cellCount; index++) {
		const offset = PLACEMENT_HEADER_BYTES + index * PLACEMENT_CELL_BYTES;
		const flags = view.getUint8(offset + 8);
		cells[index] = Object.freeze({
			x: view.getInt32(offset, true),
			y: view.getInt32(offset + 4, true),
			valid: (flags & 1) !== 0,
			lineBuild: (flags & 4) !== 0,
			flags,
		});
	}
	return Object.freeze({
		statusCode,
		status: PLACEMENT_STATUS[statusCode] ?? 'internal-error',
		valid: statusCode === 0,
		issued: issued && statusCode === 0,
		tick: view.getInt32(12, true),
		orderType: PLACEMENT_ORDER[orderCode] ?? 'none',
		producerId: view.getUint32(16, true),
		queueId: view.getUint16(20, true),
		variant: view.getUint16(22, true),
		topLeft: Object.freeze({ x: view.getInt32(24, true), y: view.getInt32(28, true) }),
		dimensions: Object.freeze({ x: view.getUint16(32, true), y: view.getUint16(34, true) }),
		modifiers: view.getUint16(38, true),
		cells: Object.freeze(cells),
	});
}

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
export function createSteelseedBridge(P, localHeapViewU8, mp = null) {
	if (typeof localHeapViewU8 !== 'function')
		throw new TypeError('localHeapViewU8 must be a function');

	const orderScratch = P.OrderSubjectScratch();
	if (orderScratch == null || !Number.isSafeInteger(orderScratch.byteLength) || orderScratch.byteLength < 4)
		throw new Error('OrderSubjectScratch returned no writable capacity');
	const orderBytes = new Uint8Array(orderScratch.byteLength);
	const copyOrderSubjects = order => {
		if (order == null || !(order.subjectIds instanceof Uint32Array))
			throw new TypeError('order requires Uint32Array subjectIds');
		const subjectCount = order.subjectCount ?? order.subjectIds.length;
		if (!Number.isInteger(subjectCount) || subjectCount < 0 || subjectCount > order.subjectIds.length)
			throw new RangeError(`invalid subjectCount ${subjectCount}/${order.subjectIds.length}`);
		const byteLength = subjectCount * Uint32Array.BYTES_PER_ELEMENT;
		if (!Number.isSafeInteger(byteLength) || byteLength > orderBytes.byteLength)
			throw new RangeError(
				`order has ${subjectCount} subjects; scratch capacity is ${orderBytes.byteLength / 4}`,
			);

		orderBytes.fill(0);
		// Pack little-endian explicitly. Passing the Uint32Array itself to a byte
		// MemoryView.set would convert elements instead of copying their storage.
		for (let i = 0; i < subjectCount; i++) {
			const id = order.subjectIds[i];
			const p = i * Uint32Array.BYTES_PER_ELEMENT;
			orderBytes[p] = id & 0xff;
			orderBytes[p + 1] = (id >>> 8) & 0xff;
			orderBytes[p + 2] = (id >>> 16) & 0xff;
			orderBytes[p + 3] = (id >>> 24) & 0xff;
		}
		orderScratch.set(orderBytes);
		return subjectCount;
	};

	let generation = null;
	let heapBuffer = null;
	let pointers = [0, 0];
	let capacities = [0, 0];
	let slots = [null, null];
	let validators = [null, null];
	let placementHeapBuffer = null;
	let placementPointer = -1;
	let placementCapacity = 0;
	let placementScratch = null;

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
	const acquirePlacement = () => {
		for (;;) {
			const heap0 = localHeapViewU8();
			const pointer = P.PlacementBufferPointer();
			const capacity = P.PlacementBufferCapacity();
			const heap1 = localHeapViewU8();
			if (heap0.buffer !== heap1.buffer) continue;
			if (!Number.isSafeInteger(pointer) || pointer < 0 ||
				!Number.isSafeInteger(capacity) || capacity < PLACEMENT_HEADER_BYTES ||
				pointer + capacity > heap1.byteLength)
				throw new RangeError(`placement buffer lies outside WebAssembly memory: ${pointer}/${capacity}`);
			if (placementHeapBuffer !== heap1.buffer || placementPointer !== pointer || placementCapacity !== capacity) {
				placementHeapBuffer = heap1.buffer;
				placementPointer = pointer;
				placementCapacity = capacity;
				placementScratch = new Uint8Array(heap1.buffer, heap1.byteOffset + pointer, capacity);
			}
			return;
		}
	};
	const readPlacement = (byteLength, issued = false) => {
		acquirePlacement();
		if (!Number.isSafeInteger(byteLength) || byteLength < PLACEMENT_HEADER_BYTES ||
			byteLength > placementScratch.byteLength)
			throw new RangeError(`invalid placement ABI length ${byteLength}/${placementScratch.byteLength}`);
		const decoded = decodePlacement(placementScratch.subarray(0, byteLength), issued);
		if (PLACEMENT_HEADER_BYTES + decoded.cells.length * PLACEMENT_CELL_BYTES !== byteLength)
			throw new RangeError(`placement ABI published length mismatch ${byteLength}`);
		return decoded;
	};

	// Initialise both pinned aliases while constructing the adapter. Later calls only
	// rebuild them after a generation/heap epoch change.
	acquireSnapshotMetadata();

	return Object.freeze({
		hostStatus() {
			try { return P.HostStatus(); } catch (error) { return `error:${String(error)}`; }
		},

		getSyncProbe() {
			return P.GetSyncProbe();
		},

		getConnectionProbe() {
			return P.GetConnectionProbe();
		},

		getServerErrorProbe() {
			return P.GetServerErrorProbe();
		},

		getLobbyPlayersProbe() {
			return P.GetLobbyPlayersProbe();
		},

		getSupportPowers() {
			try { return JSON.parse(P.GetSupportPowers()); } catch { return null; }
		},

		getSessionStatus() {
			try { return JSON.parse(P.GetSessionStatus()); } catch { return null; }
		},

		async setPaused(paused) {
			return P.SetPaused(Boolean(paused));
		},

		async setWsEndpoint(url) {
			return P.SetWsEndpoint(String(url));
		},

		async joinMultiplayer(host, port, password = '') {
			return P.JoinMultiplayer(String(host), Number(port), String(password ?? ''));
		},

		async lobbyClaimPlayerSlot() {
			return P.LobbyClaimPlayerSlot();
		},

		async lobbySetReady() {
			P.LobbySetReady();
		},

		async lobbySetNotReady() {
			P.LobbySetNotReady();
		},

		async lobbySetFaction(factionId) {
			return P.LobbySetFaction(String(factionId));
		},

		async lobbySetTeam(team) {
			return P.LobbySetTeam(Number(team));
		},

		async lobbySetColor(color) {
			return P.LobbySetColor(String(color));
		},

		async lobbySetOption(id, value) {
			return P.LobbySetOption(String(id), String(value));
		},

		async lobbySetSpawn(point) {
			return P.LobbySetSpawn(Number(point));
		},

		async lobbySetSpawnFor(clientIndex, point) {
			return P.LobbySetSpawnFor(Number(clientIndex), Number(point));
		},

		async lobbyClearSpawns() {
			return P.LobbyClearSpawns();
		},

		async lobbyAddBots() {
			return P.LobbyAddBots();
		},

		async lobbyCloseEmptySlots() {
			return P.LobbyCloseEmptySlots();
		},

		async lobbyCloseSlotsDownTo(seats) {
			return P.LobbyCloseSlotsDownTo(Number(seats));
		},

		async lobbyStartGame() {
			P.LobbyStartGame();
		},

		async setPlayerName(name) {
			return P.SetPlayerName(String(name));
		},

		async probeConnection() {
			return P.GetConnectionProbe();
		},

		async probeLobby() {
			return P.GetLobbyPlayersProbe();
		},

		async getVisibilityProbe() {
			return P.GetVisibilityProbe();
		},

		async getServerError() {
			return P.GetServerErrorProbe();
		},

		async leaveMultiplayer() {
			return P.LeaveMultiplayer();
		},

		async getMpCloseInfo() {
			return mp && typeof mp.getCloseInfo === 'function' ? mp.getCloseInfo() : null;
		},

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

		queryBuildingPlacement(request) {
			return readPlacement(P.QueryBuildingPlacement(
				request.queueId,
				request.actorType,
				request.cellX,
				request.cellY,
				request.variant ?? 0,
				request.modifiers ?? 0,
			));
		},

		placeBuildingValidated(request) {
			return readPlacement(P.PlaceBuildingValidated(
				request.queueId,
				request.actorType,
				request.cellX,
				request.cellY,
				request.variant ?? 0,
				request.modifiers ?? 0,
			), true);
		},

		issueOrder(order) {
			const subjectCount = copyOrderSubjects(order);
			return P.IssueOrderN(
				order.orderString,
				subjectCount,
				order.targetActorId ?? 0,
				order.targetCellX ?? -1,
				order.targetCellY ?? -1,
				Boolean(order.queued),
				order.targetString ?? '',
				// OpenRA's ExtraData is a uint; the export takes its 32 bits as an int.
				(order.extraData ?? 0) | 0,
				order.extraCellX ?? -1,
				order.extraCellY ?? -1,
			);
		},

		queryContextOrder(order) {
			if (typeof P.QueryContextOrderN !== 'function') return null;
			const result = P.QueryContextOrderN(
				copyOrderSubjects(order),
				order.targetActorId ?? 0,
				order.targetCellX ?? -1,
				order.targetCellY ?? -1,
				Boolean(order.targetFrozen),
				order.modifiers ?? 0,
			);
			if (!result) return null;
			const [name, cursor = ''] = result.split('\n');
			return { order: name, cursor };
		},

		issueContextOrder(order) {
			const subjectCount = copyOrderSubjects(order);
			return P.IssueContextOrderN(
				subjectCount,
				order.targetActorId ?? 0,
				order.targetCellX ?? -1,
				order.targetCellY ?? -1,
				Boolean(order.targetFrozen),
				order.modifiers ?? 0,
			);
		},
	});
}
