// Companion control plane. Does not parse OpenRA orders or simulate a world.
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const token = () => randomBytes(24).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const tiers = new Set(['information', 'support', 'command']);
const json = (ws, value) => { if (ws?.readyState === 1 && ws.bufferedAmount < 512 * 1024) ws.send(JSON.stringify(value)); };

export function createCompanionService({ originAllowed = () => false, authorizeHosted = async () => false, enabled = false, now = Date.now } = {}) {
	const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
	const sessions = new Map(), attempts = new Map();
	const reject = (ws, reason) => json(ws, { type: 'error', reason });
	function allowedAttempt(key, maximum = 5) {
		const old = attempts.get(key), time = now();
		if (!old || time - old.at >= 60000) { attempts.set(key, { at: time, count: 1 }); return true; }
		return ++old.count <= maximum;
	}
	function end(session, reason) {
		if(!sessions.delete(session.id))return; json(session.phone, { type: 'ended', reason }); json(session.primary, { type: 'ended', reason });
		session.primary?.close(1000, reason); session.phone?.close(1000, reason); if (session.pending && session.pending !== session.phone) session.pending.close(1000, reason);
	}
	wss.on('connection', (ws, request) => {
		let associated = null, role = null, chain = Promise.resolve();
		const ip = request.socket.remoteAddress ?? 'unknown';
		const authTimer = setTimeout(() => { if (!associated) ws.close(1008, 'Pairing required'); }, 10000); authTimer.unref();
		ws.on('message', (bytes, binary) => {
			chain = chain.then(async () => {
				if (binary) { ws.close(1008, 'JSON required'); return; }
				let message; try { message = JSON.parse(bytes.toString()); } catch { reject(ws, 'Invalid request'); return; }
				if (!message || typeof message !== 'object') { reject(ws, 'Invalid request'); return; }
				if (message.type === 'create' && !associated) {
					if (!allowedAttempt(`create:${ip}`, 10) || sessions.size >= 128) { reject(ws, 'Pairing capacity reached'); return; }
					if (message.kind !== 'skirmish' && message.kind !== 'hosted') { reject(ws, 'Match type required'); return; }
					if (message.kind === 'hosted' && !(await authorizeHosted(message))) { reject(ws, 'Host policy or game connection does not allow a companion'); return; }
					let code; do { code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while ([...sessions.values()].some(s => s.code === code));
					associated = { admission: message.kind === 'hosted' ? {kind:'hosted',roomId:message.roomId,nonce:message.nonce} : null, id: token(), secret: token(), code, expires: now() + 300000, primary: ws, phone: null, pending: null, phoneToken: null, tier: 'information', paused: false, lastPrimary: now(), detached: null, state: null, frames: [], cachedBytes: 0, lastAdmissionCheck: now(), intentAt: 0, intentCount: 0 };
					sessions.set(associated.id, associated); role = 'primary'; clearTimeout(authTimer);
					json(ws, { type: 'created', id: associated.id, secret: associated.secret, code, expires: associated.expires }); return;
				}
				if (message.type === 'attach' && !associated) {
					if (!allowedAttempt(`attach:${ip}`)) { reject(ws, 'Too many attempts. Try again in a minute.'); return; }
					const session = [...sessions.values()].find(s => (equal(message.secret, s.secret) || equal(message.code, s.code)) && s.expires > now() && !s.phone && !s.pending);
					if (!session) { reject(ws, 'Code expired or unavailable. Ask the commander for a new code.'); return; }
					associated = session; role = 'pending'; session.pending = ws; clearTimeout(authTimer);
					json(ws, { type: 'pending' }); json(session.primary, { type: 'approval', label: String(message.label ?? 'Companion').replace(/[\x00-\x1f]/g, '').slice(0, 40) }); return;
				}
				if (message.type === 'resume' && !associated) {
					const session = sessions.get(message.id);
					if (!session || !equal(message.token, session.phoneToken) || session.phone || session.detached === null || now() - session.detached > 30000) { reject(ws, 'Pair again on the main game'); return; }
					associated = session; role = 'phone'; session.phone = ws; session.detached = null; clearTimeout(authTimer);
					json(ws, { type: 'approved', id: session.id, token: session.phoneToken, tier: session.tier, paused: session.paused, latestSequence: session.frames.at(-1)?.state?.sequence ?? session.state?.state?.sequence ?? 0 }); if (session.state) { json(ws, session.state); for (const frame of session.frames) json(ws, frame); } return;
				}
				const session = associated; if (!session || !sessions.has(session.id)) { reject(ws, 'Pairing required'); return; }
				if (role === 'primary') {
					if (session.admission && now() - session.lastAdmissionCheck >= 1000) { session.lastAdmissionCheck = now(); if (!(await authorizeHosted(session.admission))) { end(session, 'Game connection or host policy no longer allows a companion'); return; } }
					session.lastPrimary = now();
					if (message.type === 'approve' && session.pending) {
						if (!tiers.has(message.tier)) { reject(ws, 'Choose a permission'); return; }
						if (message.accept !== true) { json(session.pending, { type: 'ended', reason: 'Pairing declined' }); session.pending.close(1000); session.pending = null; return; }
						session.phone = session.pending; session.pending = null; session.phoneToken = token(); session.tier = message.tier;
						// A pending connection becomes authorized only through this primary action.
						session.phone.joaApproved = true; session.secret = ''; session.code = '';
						json(session.phone, { type: 'approved', id: session.id, token: session.phoneToken, tier: session.tier, latestSequence: session.frames.at(-1)?.state?.sequence ?? session.state?.state?.sequence ?? 0 }); json(ws, { type: 'connected', tier: session.tier }); if (session.state) { json(session.phone, session.state); for (const frame of session.frames) json(session.phone, frame); } return;
					}
					if (message.type === 'permission' && tiers.has(message.tier)) { session.tier = message.tier; json(session.phone, { type: 'permission', tier: session.tier }); return; }
					if (message.type === 'pause') { session.paused = message.paused === true; json(session.phone, { type: 'pause', paused: session.paused }); return; }
					if (message.type === 'state') {
                        if (message.state?.grid !== undefined || message.state?.terrain !== undefined) { session.state = message; session.frames = []; session.cachedBytes=bytes.length; }
                        else { session.frames.push(message); session.cachedBytes+=bytes.length; if (session.frames.length > 25 || session.cachedBytes>8*1024*1024) { session.state = null; session.frames = []; session.cachedBytes=0; json(ws,{type:'need-baseline'}); } }
                        json(session.phone, message); return;
                    }
					if (message.type === 'result') { json(session.phone, message); return; }
					if (message.type === 'revoke') { end(session, 'Disconnected by commander'); return; }
					if (message.type === 'heartbeat') { json(session.phone, { type: 'heartbeat', at: now() }); return; }
				}
				if ((role === 'phone' || ws.joaApproved === true) && session.phone === ws && message.type === 'sync') { if (allowedAttempt(`sync:${session.id}`, 30) && session.state) { json(ws, {type:'sync-begin',latestSequence:session.frames.at(-1)?.state?.sequence ?? session.state.state?.sequence ?? 0}); json(ws, session.state); for (const frame of session.frames) json(ws, frame); } return; }
				if ((role === 'phone' || ws.joaApproved === true) && session.phone === ws && message.type === 'intent') {
					if (session.admission && !(await authorizeHosted(session.admission))) { end(session, 'Host policy or game connection no longer allows a companion'); return; }
					const time = now(); if (time - session.intentAt >= 1000) { session.intentAt = time; session.intentCount = 0; }
					if (++session.intentCount > 5 || session.paused || time - session.lastPrimary > 2000 || session.tier === 'information') { reject(ws, 'Commands unavailable'); return; }
					const action = message.intent?.action;
					if (!['support', 'repair', 'move', 'attack', 'attack-move', 'stop', 'scout'].includes(action) || (session.tier === 'support' && action !== 'support' && action !== 'repair')) { reject(ws, 'Permission does not allow this action'); return; }
					json(session.primary, { type: 'intent', intent: message.intent, tier: session.tier });
				}
				// A taunt is voice, not a command: every permission may send one, a few seconds apart.
				if ((role === 'phone' || ws.joaApproved === true) && session.phone === ws && message.type === 'taunt') {
					if (session.admission && !(await authorizeHosted(session.admission))) { end(session, 'Host policy or game connection no longer allows a companion'); return; }
					const time = now(), taunt = message.taunt;
					if (typeof taunt !== 'string' || !/^[a-z0-9-]{1,32}$/.test(taunt) || time - session.lastPrimary > 2000) { json(ws, { type: 'taunt-refused', reason: 'Taunts are unavailable right now' }); return; }
					if (time - (session.tauntAt ?? 0) < 4000) { json(ws, { type: 'taunt-refused', reason: 'One taunt every few seconds' }); return; }
					session.tauntAt = time;
					json(session.primary, { type: 'taunt', taunt });
					json(ws, { type: 'taunt-sent', taunt });
				}
				// A request is a question to the commander, not an order: it rides the taunt's
				// shape (id-validated, rate-limited, every permission may ask) and the primary
				// decides what it means.
				if ((role === 'phone' || ws.joaApproved === true) && session.phone === ws && message.type === 'request') {
					if (session.admission && !(await authorizeHosted(session.admission))) { end(session, 'Host policy or game connection no longer allows a companion'); return; }
					const time = now(), request = message.request;
					if (typeof request !== 'string' || !/^[a-z0-9-]{1,32}$/.test(request) || time - session.lastPrimary > 2000) { json(ws, { type: 'request-refused', reason: 'Questions are unavailable right now' }); return; }
					if (time - (session.requestAt ?? 0) < 6000) { json(ws, { type: 'request-refused', reason: 'One question every few seconds' }); return; }
					session.requestAt = time;
					json(session.primary, { type: 'request', request });
					json(ws, { type: 'request-sent', request });
				}
			}).catch(() => { reject(ws, 'Request failed'); });
		});
		ws.on('error', () => {});
		ws.on('close', () => {
			clearTimeout(authTimer); const session = associated; if (!session) return;
			if (session.primary === ws) end(session, 'Main game disconnected');
			else if (session.phone === ws) { session.phone = null; session.detached = now(); json(session.primary, { type: 'detached' }); }
			else if (session.pending === ws) session.pending = null;
		});
	});
	const timer = setInterval(() => {
		for (const session of sessions.values()) if (now() - session.lastPrimary > 10000 || (!session.phoneToken && session.expires < now()) || (session.detached !== null && now() - session.detached > 30000)) end(session, 'Connection expired');
		for (const [key, attempt] of attempts) if (now() - attempt.at > 60000) attempts.delete(key);
	}, 1000); timer.unref();
	return {
		upgrade(req, socket, head) {
			if (!enabled || wss.clients.size>=512 || !originAllowed(req.headers.origin)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
			wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
		},
		close() { clearInterval(timer); for (const s of [...sessions.values()]) end(s, 'Service closing'); for (const ws of wss.clients) ws.terminate(); wss.close(); },
		get size() { return sessions.size; },
	};
}
