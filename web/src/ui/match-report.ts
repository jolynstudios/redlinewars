// Reports a finished match to the Redline Wars leaderboard (landing/server, POST /api/matches).
//
// Presentation only: it reads the outcome the simulation already decided and never feeds
// anything back into it. It never blocks the outcome sheet: the caller shows what happened
// to the report once the request settles. A plain local build without a landing server
// answers 404 and the report is simply dropped.
//
// A report that could not be delivered (offline, account service down, or nobody signed in
// yet) is kept in localStorage and retried when a player is signed in, so a finished match
// is not lost to a network blip or to signing in after the battle. The queue is capped and
// entries expire, so nothing old or unbounded is ever replayed.
//
// Ids are not random (hard rule 5): a skirmish is keyed by its start time, which is unique
// per player; a multiplayer match by its room and how many matches this client has started
// there, so both players' reports name the same match and the server can confirm the pair.

import { accountSubmit } from '../core/account'

export interface MatchReportStart {
	mode: 'skirmish' | 'multiplayer'
	map: string
	faction: string
	opponents: { kind: 'bot' | 'human'; bot?: string }[]
	roomId?: string
}

export type MatchResult = 'victory' | 'defeat' | 'draw'

/**
 * What happened to a report. `saved` carries the server's rating change when the match was
 * rated; `queued` and `signed-out` are kept for a later retry.
 */
export type MatchReportOutcome =
	| { kind: 'saved'; rated: boolean; delta: number | null; ratingAfter: number | null }
	| { kind: 'duplicate' }
	| { kind: 'signed-out' }
	| { kind: 'queued' }
	| { kind: 'rejected'; status: number }
	| { kind: 'no-leaderboard' }
	| { kind: 'skipped' }

interface ReportBody {
	matchId: string
	mode: MatchReportStart['mode']
	result: MatchResult
	map: string
	faction: string
	durationSec: number
	opponents: MatchReportStart['opponents']
}

interface Running extends MatchReportStart {
	matchId: string
}

const PENDING_KEY = 'redline-pending-match-reports'
const PENDING_MAX = 10
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

let running: Running | null = null
let reported = false
let flushing: Promise<number> | null = null
const matchesPerRoom = new Map<string, number>()

export function beginMatchReport(start: MatchReportStart): void {
	let matchId = `sk-${Date.now().toString(36)}`
	if (start.mode === 'multiplayer' && start.roomId) {
		const n = (matchesPerRoom.get(start.roomId) ?? 0) + 1
		matchesPerRoom.set(start.roomId, n)
		matchId = `mp-${start.roomId}-${n}`
	}
	running = { ...start, matchId: matchId.replace(/[^A-Za-z0-9:_.-]/g, '').slice(0, 80) }
	reported = false
}

/** Call once the outcome sheet is up. Later calls for the same match resolve `skipped`. */
export async function finishMatchReport(result: MatchResult, gameTimeMs: number, faction?: string): Promise<MatchReportOutcome> {
	if (!running || reported) return { kind: 'skipped' }
	reported = true
	const body: ReportBody = {
		matchId: running.matchId,
		mode: running.mode,
		result,
		map: running.map.slice(0, 64) || 'Unknown map',
		faction: (faction || running.faction).slice(0, 24),
		durationSec: Math.max(0, Math.round(gameTimeMs / 1000)),
		opponents: running.opponents.length ? running.opponents.slice(0, 7) : [{ kind: 'human' as const }],
	}
	const outcome = await send(body)
	if (outcome.kind === 'queued' || outcome.kind === 'signed-out') keep(body)
	return outcome
}

/**
 * Retry reports that could not be delivered. Call when a player is signed in; concurrent calls
 * share one pass. Resolves to the number of reports the server accepted.
 */
export function flushPendingMatchReports(): Promise<number> {
	flushing ??= (async () => {
		const now = Date.now()
		const pending = readPending().filter(entry => now - entry.queuedAt < PENDING_MAX_AGE_MS)
		const remaining: PendingReport[] = []
		let saved = 0
		for (const entry of pending) {
			const outcome = await send(entry.body)
			if (outcome.kind === 'saved') saved++
			// Still offline or still signed out: keep it. Anything else is settled one way or another.
			if (outcome.kind === 'queued' || outcome.kind === 'signed-out') remaining.push(entry)
		}
		writePending(remaining)
		return saved
	})().finally(() => { flushing = null })
	return flushing
}

async function send(body: ReportBody): Promise<MatchReportOutcome> {
	const { status, data } = await accountSubmit('/api/matches', body)
	if (status === 201 || status === 200) {
		const match = (data as { match?: { rated?: boolean; delta?: number; ratingAfter?: number } } | null)?.match
		return {
			kind: 'saved',
			rated: match?.rated === true,
			delta: typeof match?.delta === 'number' ? match.delta : null,
			ratingAfter: typeof match?.ratingAfter === 'number' ? match.ratingAfter : null,
		}
	}
	if (status === 409) return { kind: 'duplicate' }
	if (status === 401) return { kind: 'signed-out' }
	if (status === 404) return { kind: 'no-leaderboard' }
	// Unknown (network, desktop broker without a status), throttled or a server fault: retry later.
	if (status === 0 || status === 429 || status >= 500) return { kind: 'queued' }
	return { kind: 'rejected', status }
}

interface PendingReport {
	body: ReportBody
	queuedAt: number
}

function keep(body: ReportBody): void {
	const pending = readPending().filter(entry => entry.body.matchId !== body.matchId)
	pending.push({ body, queuedAt: Date.now() })
	writePending(pending)
}

function readPending(): PendingReport[] {
	try {
		const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(PENDING_KEY) ?? '[]')
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is PendingReport =>
				typeof entry?.queuedAt === 'number' && typeof entry?.body?.matchId === 'string')
			: []
	} catch {
		return []
	}
}

function writePending(pending: PendingReport[]): void {
	try {
		if (pending.length === 0) globalThis.localStorage?.removeItem(PENDING_KEY)
		else globalThis.localStorage?.setItem(PENDING_KEY, JSON.stringify(pending.slice(-PENDING_MAX)))
	} catch {
		// Storage blocked: the report for this match is lost, exactly as before the queue existed.
	}
}
