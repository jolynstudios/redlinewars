// Ranked transport binding adapter. OpenRA sends its protocol/client index in
// the first eight server bytes; later SyncInfo orders expose assigned slot/team.
// This module deliberately fails closed on missing or conflicting evidence.

function readDotNetString(buffer, offset) {
	let length = 0; let shift = 0; let cursor = offset;
	for (let i = 0; i < 5; i++) {
		if (cursor >= buffer.length) return null;
		const byte = buffer[cursor++];
		length |= (byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) {
			if (length < 0 || cursor + length > buffer.length) return null;
			return { value: buffer.subarray(cursor, cursor + length).toString('utf8'), next: cursor + length };
		}
		shift += 7;
	}
	return null;
}

function parseServerOrder(packet) {
	if (!Buffer.isBuffer(packet) || packet.length < 6) return null;
	const type = packet[4];
	const name = readDotNetString(packet, 5);
	if (!name) return null;
	let targetOffset = name.next;
	if (type === 0xff) {
		// Current OpenRA server orders use OrderType.Fields.  SyncInfo only
		// carries TargetString (0x04), so any preceding variable-size fields are
		// not a shape this security adapter will guess at.
		if (targetOffset + 2 > packet.length) return null;
		const fields = packet.readUInt16LE(targetOffset);
		if ((fields & 0x04) === 0 || (fields & (0x01 | 0x80)) !== 0) return null;
		targetOffset += 2;
	} else if (type !== 0xfe) return null;
	const target = readDotNetString(packet, targetOffset);
	return target ? { name: name.value, target: target.value } : null;
}

function parseSyncInfoClients(target) {
	const clients = new Map();
	if (typeof target !== 'string') return clients;
	const text = target.replaceAll('\r\n', '\n');
	const pattern = /(?:^|\n)Client@(\d+):\n([\s\S]*?)(?=\n(?:Client@|Slot@|GlobalSettings|DisabledSpawnPoints)|$)/g;
	for (const match of text.matchAll(pattern)) {
		const body = match[2];
		const field = name => new RegExp(`(?:^|\\n)\\s*${name}:\\s*([^\\n]+)`).exec(`\n${body}`)?.[1]?.trim() ?? null;
		const team = Number(field('Team'));
		const slot = field('Slot');
		if (!Number.isInteger(team) || !slot || slot === 'null') continue;
		clients.set(Number(match[1]), { team, slot });
	}
	return clients;
}

function seatFromSlot(slot) {
	const match = /(?:Multi|Player|Slot)(\d+)$/i.exec(String(slot));
	return match ? Number(match[1]) + 1 : null;
}

function claimBody(token) {
	try { return JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8')); }
	catch { return null; }
}

export function rankedObserveServerBytes(room, channel, chunk, closeChannel, maxFrameBytes = 16 * 1024 * 1024) {
	if (!room.ranked || room.rankedBindingError) return;
	channel.observeBuffer = Buffer.concat([channel.observeBuffer ?? Buffer.alloc(0), chunk]);
	if (channel.clientIndex === undefined && channel.observeBuffer.length >= 8) {
		const protocolVersion = channel.observeBuffer.readInt32LE(0);
		const clientIndex = channel.observeBuffer.readInt32LE(4);
		channel.observeBuffer = channel.observeBuffer.subarray(8);
		if (protocolVersion !== 7 || clientIndex < 0 || clientIndex > 255 || room.rankedBindingByClient.has(clientIndex) || room.rankedBindings.has(channel.claim)) {
			room.rankedBindingError = room.rankedBindings.has(channel.claim) ? 'duplicate-participant-claim' : 'invalid-or-duplicate-client-index';
			closeChannel();
			return;
		}
		channel.clientIndex = clientIndex;
		room.rankedBindingByClient.set(clientIndex, channel.claim);
		room.rankedBindings.set(channel.claim, { chanId: channel.chanId, clientIndex });
	}
	while (channel.observeBuffer.length >= 8) {
		const length = channel.observeBuffer.readInt32LE(0);
		if (length < 4 || length > maxFrameBytes) {
			room.rankedBindingError = 'invalid-server-frame';
			closeChannel();
			return;
		}
		// Server.CreateFrame writes `length = frame(4) + orders`, with the
		// client index outside that count.  The complete wire frame is the
		// eight-byte length/client header followed by `length` bytes.
		if (channel.observeBuffer.length < 8 + length) return;
		const packet = channel.observeBuffer.subarray(8, 8 + length);
		channel.observeBuffer = channel.observeBuffer.subarray(8 + length);
		const order = parseServerOrder(packet);
		if (!order || order.name !== 'SyncInfo') continue;
		const clients = parseSyncInfoClients(order.target);
		for (const [claim, binding] of room.rankedBindings) {
			const client = clients.get(binding.clientIndex);
			if (!client) continue;
			const expectedSeat = seatFromSlot(client.slot);
			const payload = claimBody(claim);
			if (!payload || !room.participantClaims.includes(claim) || expectedSeat === null || payload.seat !== expectedSeat || payload.team !== client.team) {
				room.rankedBindingError = 'ranked-seat-or-team-mismatch';
				closeChannel();
				return;
			}
			binding.seat = expectedSeat;
			binding.team = client.team;
		}
	}
}
