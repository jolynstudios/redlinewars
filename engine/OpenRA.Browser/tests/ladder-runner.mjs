// Unattended round-robin ladder for the Red Alert benchmark (BENCHMARK.md):
// resolves a manifest of entrant models into a deterministic schedule —
// tracks in manifest order, ordered pairings (A,B) and (B,A) for the side
// swap, round-robin interleaved so a pairing never runs back-to-back while
// other pairings remain — and plays it strictly one game at a time through
// match-runner.mjs (two WASM games contend for CPU and corrupt results;
// never run matches concurrently). Every game spends real money, so the
// ladder is defensive by construction: strict CLI and manifest validation,
// a sidecar/port preflight before every launch, a budget gate before every
// game, a crash-safe ledger (temp file + rename) that --resume replays and
// that blocks an accidental fresh start without it, and hard stops after
// repeated infrastructure failure.
// Usage:
//   node ladder-runner.mjs --manifest <path> [--dry-run] [--resume]
// --dry-run prints the fully resolved schedule as JSON and exits 0 without
// touching the ledger, the sidecar, or match-runner.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
// match-runner hardcodes its artifact root (tests/match-results/<label>) and
// defaults to this game port; the sidecar holds the OpenRouter key at 4112.
// The ladder must agree with all three or every game would be censored.
const matchResultsRoot = path.join(testsDir, 'match-results');
const MatchRunnerPort = 8379;
const SidecarHealthUrl = 'http://127.0.0.1:4112/health';
// match-runner enforces its own wall clock, but a wedged Playwright call
// would hang the whole unattended ladder; the watchdog is the backstop.
const WatchdogGraceMs = 10 * 60_000;

const args = process.argv.slice(2);
// The ladder spends real money: unknown flags must never fall through to
// defaults and silently start a run (same policy as match-runner).
const usage = 'Usage: node ladder-runner.mjs --manifest <path> [--dry-run] [--resume]';
const valueFlags = new Set(['manifest']);
const booleanFlags = new Set(['dry-run', 'resume']);
const parsed = new Map();

const argumentError = message => {
	console.error(`${message}\n${usage}`);
	process.exit(2);
};

for (let i = 0; i < args.length; i++) {
	const token = args[i];
	if (!token.startsWith('--') || token.length === 2) {
		argumentError(`Unexpected argument '${token}'.`);
	}

	const name = token.slice(2);
	if (!valueFlags.has(name) && !booleanFlags.has(name)) {
		argumentError(`Unknown flag ${token}.`);
	}

	if (parsed.has(name)) {
		argumentError(`Flag ${token} was supplied more than once.`);
	}

	if (booleanFlags.has(name)) {
		parsed.set(name, true);
		continue;
	}

	const value = args[++i];
	if (value == null || value.startsWith('-')) {
		argumentError(`Flag ${token} requires a non-flag value.`);
	}

	parsed.set(name, value);
}

if (!parsed.has('manifest'))
	argumentError('--manifest is required.');
const dryRun = parsed.has('dry-run');
const resume = parsed.has('resume');
const manifestFile = path.resolve(parsed.get('manifest'));

const manifestError = message => {
	console.error(`Manifest error in ${manifestFile}: ${message}`);
	process.exit(2);
};

let manifest;
try {
	manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
} catch (error) {
	manifestError(`cannot read or parse: ${error.message}`);
}

if (typeof manifest !== 'object' || manifest == null || Array.isArray(manifest))
	manifestError('top level must be a JSON object.');

// A misspelled key would silently drop a constraint on a money-spending run;
// both unknown and missing keys are hard errors.
const knownKeys = ['era', 'entrants', 'tracks', 'gamesPerPairing', 'assistedPlaybook', 'faction',
	'capPerGameUsd', 'budgetTotalUsd', 'minutesPerGame', 'cooldownSeconds', 'resultsDir'];
for (const key of Object.keys(manifest)) {
	if (!knownKeys.includes(key)) {
		manifestError(`unknown key '${key}' (known: ${knownKeys.join(', ')}).`);
	}
}

for (const key of knownKeys) {
	if (key !== 'assistedPlaybook' && !(key in manifest)) {
		manifestError(`missing required key '${key}'.`);
	}
}

const asNumber = value => typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;

const era = manifest.era;
// Labels must satisfy match-runner's --label validation ([A-Za-z0-9._-]).
if (typeof era !== 'string' || !/^[A-Za-z0-9._-]+$/.test(era))
	manifestError("'era' must be a non-empty string of letters, numbers, dot, underscore, or hyphen.");

if (!Array.isArray(manifest.entrants) || manifest.entrants.length < 2)
	manifestError("'entrants' must be an array of at least two { model, effort } entries.");
const entrants = manifest.entrants.map((entrant, index) => {
	const where = `entrants[${index}]`;
	if (typeof entrant !== 'object' || entrant == null || Array.isArray(entrant)) {
		manifestError(`${where} must be an object.`);
	}

	for (const key of Object.keys(entrant)) {
		if (key !== 'model' && key !== 'effort') {
			manifestError(`${where} has unknown key '${key}' (known: model, effort).`);
		}
	}

	if (typeof entrant.model !== 'string' || entrant.model.length === 0) {
		manifestError(`${where}.model must be a non-empty OpenRouter model id.`);
	}

	const effort = entrant.effort ?? '';
	if (!['', 'low', 'medium', 'high'].includes(effort)) {
		manifestError(`${where}.effort must be low, medium, or high (or omitted for the provider default).`);
	}

	return { model: entrant.model, effort };
});

const models = entrants.map(entrant => entrant.model);
if (new Set(models).size !== models.length)
	manifestError("'entrants' must not repeat a model id (mirror games are calibration, not ladder games).");

// Slugged model ids are embedded in match labels; a bad id must fail here,
// once, instead of censoring every scheduled game at spawn time.
const slugOf = model => model.replaceAll('/', '-').replaceAll('.', '-');
for (const model of models) {
	if (!/^[A-Za-z0-9._-]+$/.test(slugOf(model))) {
		manifestError(`model id '${model}' contains characters that cannot form a match label.`);
	}
}

if (new Set(models.map(slugOf)).size !== models.length)
	manifestError('two entrant model ids collapse to the same label slug.');

const tracks = manifest.tracks;
if (!Array.isArray(tracks) || tracks.length === 0)
	manifestError("'tracks' must be a non-empty array drawn from ['raw', 'assisted'].");
for (const track of tracks) {
	if (track !== 'raw' && track !== 'assisted') {
		manifestError(`unknown track '${JSON.stringify(track)}' (known: raw, assisted).`);
	}
}

if (new Set(tracks).size !== tracks.length)
	manifestError("'tracks' must not repeat a track.");

const gamesPerPairing = manifest.gamesPerPairing;
if (!Number.isInteger(gamesPerPairing) || gamesPerPairing < 1)
	manifestError("'gamesPerPairing' must be a positive integer (BENCHMARK.md asks for N >= 3).");

const faction = manifest.faction;
if (typeof faction !== 'string' || !/^[A-Za-z0-9_-]+$/.test(faction))
	manifestError("'faction' must be a faction id like 'russia'.");

const capUsd = asNumber(manifest.capPerGameUsd);
if (!Number.isFinite(capUsd) || capUsd <= 0)
	manifestError("'capPerGameUsd' must be a positive number (string or number).");
const capString = String(manifest.capPerGameUsd);

const budgetTotalUsd = asNumber(manifest.budgetTotalUsd);
if (!Number.isFinite(budgetTotalUsd) || budgetTotalUsd <= 0)
	manifestError("'budgetTotalUsd' must be a positive number.");
if (budgetTotalUsd < capUsd)
	manifestError(`'budgetTotalUsd' ($${budgetTotalUsd}) is below 'capPerGameUsd' ($${capUsd}); no game could ever start.`);

const minutesPerGame = asNumber(manifest.minutesPerGame);
if (!Number.isFinite(minutesPerGame) || minutesPerGame <= 0)
	manifestError("'minutesPerGame' must be a positive number.");

const cooldownSeconds = asNumber(manifest.cooldownSeconds);
if (!Number.isFinite(cooldownSeconds) || cooldownSeconds < 0)
	manifestError("'cooldownSeconds' must be zero or a positive number.");

if (typeof manifest.resultsDir !== 'string' || manifest.resultsDir.length === 0)
	manifestError("'resultsDir' must be a non-empty path.");
const resultsRoot = path.resolve(testsDir, manifest.resultsDir);
if (resultsRoot !== matchResultsRoot)
	manifestError(`'resultsDir' must resolve to ${matchResultsRoot} — match-runner hardcodes its artifact root ` +
		'there, and pointing the ladder anywhere else would misclassify every game as censored.');

let assistedPlaybook = '';
if ('assistedPlaybook' in manifest) {
	assistedPlaybook = manifest.assistedPlaybook;
	if (typeof assistedPlaybook !== 'string' || !/^[A-Za-z0-9_-]+$/.test(assistedPlaybook)) {
		manifestError("'assistedPlaybook' must be a playbook name (letters, numbers, underscore, hyphen).");
	}
}

if (tracks.includes('assisted')) {
	if (assistedPlaybook === '') {
		manifestError("'assistedPlaybook' is required when 'tracks' includes 'assisted'.");
	}

	// match-runner reads this file after booting the browser; missing it would
	// crash every assisted game after minutes of setup instead of failing now.
	const playbookFile = path.join(testsDir, '../agent-sidecar/knowledge/playbooks', `${assistedPlaybook}.md`);
	if (!existsSync(playbookFile)) {
		manifestError(`assisted playbook not found: ${playbookFile}`);
	}
}

// Schedule: tracks in manifest order; ordered pairs (side swap) sorted by
// model id (codepoint order — locale-independent for determinism); games
// interleaved round-robin (one game of every pairing per round) so repeat
// games of a pairing never run back-to-back while other pairings remain.
const byModel = (a, b) => a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
const sortedEntrants = [...entrants].sort(byModel);
const orderedPairs = [];
for (const one of sortedEntrants) {
	for (const two of sortedEntrants) {
		if (one !== two) {
			orderedPairs.push([one, two]);
		}
	}
}

const schedule = [];
for (const track of tracks) {
	for (let game = 1; game <= gamesPerPairing; game++) {
		for (const [one, two] of orderedPairs) {
			schedule.push({
				seq: schedule.length + 1,
				label: `${era}-${track}-g${game}-${slugOf(one.model)}-vs-${slugOf(two.model)}`,
				track,
				game,
				model1: one.model,
				model2: two.model,
				effort1: one.effort,
				effort2: two.effort,
				playbook1: track === 'assisted' ? assistedPlaybook : '',
				playbook2: track === 'assisted' ? assistedPlaybook : ''
			});
		}
	}
}

const ledgerPath = path.join(resultsRoot, 'ladder-ledger.json');
const readLedger = () => {
	if (!existsSync(ledgerPath)) {
		return [];
	}

	const ledgerError = detail => {
		console.error(`Ledger error in ${ledgerPath}: ${detail} Refusing to guess at spend history.`);
		process.exit(2);
	};
	let entries;
	try {
		entries = JSON.parse(readFileSync(ledgerPath, 'utf8'));
	} catch (error) {
		ledgerError(`cannot read or parse (${error.message}).`);
	}

	if (!Array.isArray(entries)) {
		ledgerError('top level is not an array.');
	}

	return entries;
};

const writeLedger = entries => {
	// Temp file + rename is atomic on one filesystem: a crash mid-write can
	// never leave a torn ledger that would corrupt resume/budget accounting.
	const temp = `${ledgerPath}.tmp-${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(entries, null, 1)}\n`);
	renameSync(temp, ledgerPath);
};

const records = resume ? readLedger() : [];
// Completed games are never replayed (that would double-spend); censored
// games measured our plumbing, not the models, and get another attempt.
const done = new Set(records
	.filter(record => record.outcome === 'resolved' || record.outcome === 'unfinished')
	.map(record => record.label));
const runnable = schedule.filter(game => !done.has(game.label));
const ledgerSpend = () => records.reduce((sum, record) =>
	sum + (Number.isFinite(record.spendUsd) ? record.spendUsd : capUsd), 0);

if (dryRun) {
	console.log(JSON.stringify({
		era,
		tracks,
		faction,
		gamesPerPairing,
		capPerGameUsd: capString,
		budgetTotalUsd,
		minutesPerGame,
		cooldownSeconds,
		assistedPlaybook: assistedPlaybook || null,
		resultsDir: resultsRoot,
		totalGames: schedule.length,
		alreadyRecorded: schedule.length - runnable.length,
		maxNewSpendUsd: Math.min(budgetTotalUsd, runnable.length * capUsd),
		games: runnable.map(game => ({
			seq: game.seq, label: game.label, track: game.track, game: game.game,
			model1: game.model1, model2: game.model2, effort1: game.effort1, effort2: game.effort2,
			playbook1: game.playbook1, playbook2: game.playbook2
		}))
	}, null, 1));
	process.exit(0);
}

if (!resume && existsSync(ledgerPath)) {
	console.error(`A ladder ledger already exists at ${ledgerPath}. Starting fresh would re-run ` +
		'(and re-pay for) recorded games; pass --resume to continue it, or move the ledger aside deliberately.');
	process.exit(2);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let currentChild = null;

async function stopChild(child) {
	if (child == null || child.exitCode != null || child.signalCode != null)
		return;

	const exited = new Promise(resolve => child.once('exit', resolve));
	child.kill('SIGTERM');
	await Promise.race([exited, delay(2000)]);
	if (child.exitCode == null && child.signalCode == null) {
		child.kill('SIGKILL');
		await Promise.race([exited, delay(2000)]);
	}
}

// An orphaned match-runner keeps spending after the ladder dies; take the
// live child down with us on Ctrl-C / kill.
const onSignal = signal => {
	const exitCode = signal === 'SIGINT' ? 130 : 143;
	void stopChild(currentChild).finally(() => process.exit(exitCode));
};
process.once('SIGINT', () => onSignal('SIGINT'));
process.once('SIGTERM', () => onSignal('SIGTERM'));

async function probe(url, timeoutMs) {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
		return response;
	} catch {
		return null;
	}
}

// The sidecar must be up (it holds the OpenRouter key; without it every seat
// no-ops while the meter runs) and match-runner's port must be free (it
// refuses to adopt an already-serving port and would exit before playing).
async function preflight() {
	const health = await probe(SidecarHealthUrl, 3000);
	let healthy = false;
	if (health != null && health.ok) {
		try {
			healthy = (await health.json())?.ok === true;
		} catch {
			healthy = false;
		}
	} else {
		await health?.body?.cancel();
	}

	if (!healthy)
		return `sidecar health check failed (${SidecarHealthUrl} did not return ok:true)`;

	const port = await probe(`http://127.0.0.1:${MatchRunnerPort}/`, 1000);
	if (port != null) {
		await port.body?.cancel();
		return `port ${MatchRunnerPort} is already serving HTTP (an old game server is still up)`;
	}

	return null;
}

async function runMatch(game) {
	const runnerArgs = [path.join(testsDir, 'match-runner.mjs'),
		'--model1', game.model1, '--model2', game.model2,
		'--faction1', faction, '--faction2', faction,
		'--cap', capString, '--minutes', String(minutesPerGame), '--label', game.label];
	if (game.effort1) runnerArgs.push('--effort1', game.effort1);
	if (game.effort2) runnerArgs.push('--effort2', game.effort2);
	if (game.playbook1) runnerArgs.push('--playbook1', game.playbook1);
	if (game.playbook2) runnerArgs.push('--playbook2', game.playbook2);

	const child = spawn(process.execPath, runnerArgs, { cwd: testsDir, stdio: ['ignore', 'pipe', 'pipe'] });
	currentChild = child;
	let stdout = '';
	child.stdout.on('data', chunk => {
		const text = String(chunk);
		stdout = `${stdout}${text}`.slice(-16000);
		process.stdout.write(text);
	});
	child.stderr.on('data', chunk => process.stderr.write(String(chunk)));

	let timedOut = false;
	const watchdog = setTimeout(() => {
		timedOut = true;
		console.error(`[ladder] watchdog: ${game.label} exceeded ${minutesPerGame} minutes plus grace; killing it.`);
		void stopChild(child);
	}, minutesPerGame * 60_000 + WatchdogGraceMs);
	const exitCode = await new Promise(resolve => {
		child.once('error', error => {
			console.error(`[ladder] could not spawn match-runner: ${error.message}`);
			resolve(-1);
		});
		child.once('exit', code => resolve(code ?? -1));
	});
	clearTimeout(watchdog);
	currentChild = null;
	return { exitCode, stdout, timedOut };
}

const parseTerminal = (stdout, label) => {
	const line = stdout.split('\n').reverse().find(text => text.startsWith(`MATCH ${label} TERMINAL:`));
	if (line == null) {
		return { state: null, spendUsd: null };
	}

	return {
		state: line.match(/ state=(\S+)/)?.[1] ?? null,
		spendUsd: line.match(/ spend=\$([0-9]+(?:\.[0-9]+)?)(?:\s|$)/) != null
			? Number(line.match(/ spend=\$([0-9]+(?:\.[0-9]+)?)(?:\s|$)/)[1])
			: null
	};
};

// Metrics and the leaderboard are best-effort bookkeeping: their failure
// must never lose the game record or stop the ladder.
async function runTool(name, toolArgs) {
	const child = spawn(process.execPath, toolArgs, { cwd: testsDir, stdio: ['ignore', 'pipe', 'pipe'] });
	let tail = '';
	const capture = chunk => { tail = `${tail}${chunk}`.slice(-500); };
	child.stdout.on('data', capture);
	child.stderr.on('data', capture);
	const code = await new Promise(resolve => {
		child.once('error', () => resolve(-1));
		child.once('exit', code => resolve(code ?? -1));
	});
	if (code !== 0) {
		console.error(`[ladder] ${name} exited ${code} (continuing): ${tail.trim().slice(-300)}`);
	}
}

// Host agent ids look like 'agent-1-<guid>' (older tooling used 'agent1');
// the seat number is what maps a winner back to model1/model2.
const winnerSeat = winner => {
	if (typeof winner !== 'string') {
		return null;
	}

	const seat = winner.match(/^agent-?([12])(-|$)/);
	return seat != null ? Number(seat[1]) : null;
};

function printSummary() {
	const rows = new Map();
	for (const record of records) {
		const key = `${record.track}|${record.model1}|${record.model2}`;
		if (!rows.has(key)) {
			rows.set(key, { track: record.track, model1: record.model1, model2: record.model2,
				wins: 0, losses: 0, unfinished: 0, censored: 0, spendUsd: 0 });
		}

		const row = rows.get(key);
		const seat = record.outcome === 'resolved' ? winnerSeat(record.winner) : null;
		if (seat === 1) row.wins++;
		else if (seat === 2) row.losses++;
		else if (record.outcome === 'infrastructure-censored') row.censored++;
		else row.unfinished++;
		if (Number.isFinite(record.spendUsd)) {
			row.spendUsd += record.spendUsd;
		}
	}

	const trackRank = track => { const rank = tracks.indexOf(track); return rank === -1 ? tracks.length : rank; };
	const lines = [...rows.values()]
		.sort((a, b) => trackRank(a.track) - trackRank(b.track) ||
			(a.model1 < b.model1 ? -1 : a.model1 > b.model1 ? 1 : 0) ||
			(a.model2 < b.model2 ? -1 : a.model2 > b.model2 ? 1 : 0))
		.map(row => ({
			track: row.track,
			pairing: `${row.model1} vs ${row.model2}`,
			tally: `${row.wins}-${row.losses}-${row.unfinished}-${row.censored}`,
			spend: `$${row.spendUsd.toFixed(2)}`
		}));

	console.log('');
	console.log('[ladder] summary (W-L-unfinished-censored is from the seat-1 model\'s perspective):');
	const width = (key, header) => Math.max(header.length, ...lines.map(line => line[key].length));
	const trackWidth = width('track', 'track');
	const pairingWidth = width('pairing', 'pairing');
	const tallyWidth = width('tally', 'W-L-U-C');
	console.log(`  ${'track'.padEnd(trackWidth)}  ${'pairing'.padEnd(pairingWidth)}  ${'W-L-U-C'.padEnd(tallyWidth)}  spend`);
	for (const line of lines) {
		console.log(`  ${line.track.padEnd(trackWidth)}  ${line.pairing.padEnd(pairingWidth)}  ${line.tally.padEnd(tallyWidth)}  ${line.spend}`);
	}

	const totals = { resolved: 0, unfinished: 0, 'infrastructure-censored': 0 };
	for (const record of records) {
		totals[record.outcome] = (totals[record.outcome] ?? 0) + 1;
	}

	console.log(`  total: ${records.length} games recorded (${totals.resolved} resolved, ${totals.unfinished} unfinished, ` +
		`${totals['infrastructure-censored']} censored) — spend $${ledgerSpend().toFixed(2)} of $${budgetTotalUsd.toFixed(2)} budget`);
}

mkdirSync(resultsRoot, { recursive: true });
const appendRecord = record => {
	records.push(record);
	writeLedger(records);
};

// Budget accounting: the ledger holds parsed per-game spend; a launched game
// whose terminal line could not be parsed is assumed to have spent the full
// cap (conservative — the ladder may stop early, never overspend).
let spentUsd = ledgerSpend();
let consecutiveCensored = 0;
let consecutiveUnhealthyPreflights = 0;
let stop = null;

console.log(`[ladder] ${era}: ${schedule.length} games scheduled, ${schedule.length - runnable.length} already recorded, ` +
	`${runnable.length} to run. Budget $${budgetTotalUsd.toFixed(2)}, spent so far $${spentUsd.toFixed(2)}.`);

for (let index = 0; index < runnable.length && stop == null; index++) {
	const game = runnable[index];

	if (spentUsd + capUsd > budgetTotalUsd + 1e-9) {
		stop = { reason: 'budget', detail: `spent $${spentUsd.toFixed(2)}; the next game could add $${capUsd.toFixed(2)} ` +
			`and exceed the $${budgetTotalUsd.toFixed(2)} budget` };
		break;
	}

	console.log(`[ladder] game ${game.seq}/${schedule.length} (${index + 1}/${runnable.length} this session): ${game.label}`);

	const problem = await preflight();
	if (problem != null) {
		console.error(`[ladder] preflight failed — ${problem}; censoring ${game.label} without launching.`);
		const now = new Date().toISOString();
		appendRecord({ label: game.label, track: game.track, model1: game.model1, model2: game.model2,
			game: game.game, outcome: 'infrastructure-censored', winner: null, spendUsd: 0,
			startedAt: now, finishedAt: now, exitCode: null, note: problem });
		consecutiveCensored++;
		consecutiveUnhealthyPreflights++;
		if (consecutiveUnhealthyPreflights >= 2) {
			stop = { reason: 'infrastructure', detail: '2 consecutive unhealthy preflights' };
			break;
		}

		if (consecutiveCensored >= 3) {
			stop = { reason: 'infrastructure', detail: '3 consecutive infrastructure-censored games' };
			break;
		}

		await delay(cooldownSeconds * 1000);
		continue;
	}

	consecutiveUnhealthyPreflights = 0;

	// A censored earlier attempt may have left artifacts under this label: a
	// stale outcome.json would resurrect as this game's result if the runner
	// dies early, and a stale log.jsonl would pollute the re-run's metrics
	// (match-runner appends). Keep the log aside instead of deleting evidence.
	const matchDir = path.join(resultsRoot, game.label);
	const outcomePath = path.join(matchDir, 'outcome.json');
	try { unlinkSync(outcomePath); } catch { }
	try { renameSync(path.join(matchDir, 'log.jsonl'), path.join(matchDir, `log-superseded-${Date.now()}.jsonl`)); } catch { }

	const startedAt = new Date().toISOString();
	const run = await runMatch(game);
	const finishedAt = new Date().toISOString();
	const terminal = parseTerminal(run.stdout, game.label);
	let outcome = null;
	try {
		outcome = JSON.parse(readFileSync(outcomePath, 'utf8'));
	} catch {
		outcome = null;
	}

	// BENCHMARK.md taxonomy: a clean runner exit with outcome.json is a played
	// game — resolved when a winner was detected, otherwise unfinished (spend
	// cap or wall clock ran out; never counted as a win, never re-run). A
	// provider-terminal outcome, nonzero exit, or missing outcome.json measured
	// our plumbing, not the models: infrastructure-censored, excluded from skill
	// stats and retried on --resume.
	const outcomeInfrastructureCensored = outcome?.infrastructureCensored === true;
	const insufficientCredit = outcome?.terminalKind === 'insufficient-credit';
	const classification = !outcomeInfrastructureCensored && run.exitCode === 0 && outcome != null
		? (outcome.winner != null ? 'resolved' : 'unfinished')
		: 'infrastructure-censored';
	const note = run.timedOut ? 'watchdog killed a hung runner'
		: insufficientCredit ? 'OpenRouter reported insufficient credit; intervention required'
		: outcomeInfrastructureCensored ? (outcome.censorReason ?? 'provider-terminal failure')
		: run.exitCode !== 0 ? `runner exited ${run.exitCode}`
		: outcome == null ? 'runner exited 0 but wrote no outcome.json'
		: outcome.winner != null ? (outcome.how ?? null)
		: `terminal state ${terminal.state ?? 'unknown'}`;

	await runTool('a2a-metrics', [path.join(testsDir, 'a2a-metrics.mjs'), matchDir]);
	await runTool('leaderboard', [path.join(testsDir, 'leaderboard.mjs'), resultsRoot]);

	// A provider-terminal stop can abort another seat's request before its billed
	// cost reaches the page. Never turn the DOM's temporary zero into final spend:
	// null keeps the ledger honest and makes the budget counter reserve the cap.
	const recordedSpendUsd = outcome?.spendFinal === false ? null
		: typeof outcome?.totalSpendUsd === 'number' && Number.isFinite(outcome.totalSpendUsd)
			? outcome.totalSpendUsd : terminal.spendUsd;
	appendRecord({ label: game.label, track: game.track, model1: game.model1, model2: game.model2,
		game: game.game, outcome: classification, winner: outcome?.winner ?? null,
		spendUsd: recordedSpendUsd, startedAt, finishedAt, exitCode: run.exitCode,
		terminalKind: outcome?.terminalKind ?? null,
		zeroSpendZeroOpportunity: outcome?.zeroSpendZeroOpportunity === true,
		note });
	spentUsd += recordedSpendUsd ?? capUsd;
	console.log(`[ladder] ${game.label}: ${classification}` +
		`${outcome?.winner != null ? ` (winner ${outcome.winner})` : ''} — ` +
		`spend ${recordedSpendUsd != null ? `$${recordedSpendUsd.toFixed(2)}` : 'unknown'}, ` +
		`cumulative $${spentUsd.toFixed(2)} of $${budgetTotalUsd.toFixed(2)}.`);
	if (insufficientCredit) {
		stop = { reason: 'infrastructure', detail: 'OpenRouter insufficient credit; no further schedule slots launched' };
		break;
	}

	if (classification === 'infrastructure-censored') {
		consecutiveCensored++;
		if (consecutiveCensored >= 3) {
			stop = { reason: 'infrastructure', detail: '3 consecutive infrastructure-censored games' };
			break;
		}
	} else {
		consecutiveCensored = 0;
	}

	if (index < runnable.length - 1) {
		await delay(cooldownSeconds * 1000);
	}
}

printSummary();
if (stop == null)
	console.log('[ladder] schedule complete.');
else
	console.log(`[ladder] stopped early: ${stop.reason} — ${stop.detail}.`);
// exitCode (not process.exit) lets piped stdout drain the summary; nothing
// else keeps the event loop alive here. Budget stops are a clean 0: the
// ladder did its job. Infrastructure stops are a 1: someone must intervene.
process.exitCode = stop != null && stop.reason === 'infrastructure' ? 1 : 0;
