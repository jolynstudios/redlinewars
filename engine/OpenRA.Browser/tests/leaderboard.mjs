// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

// Aggregates every match-results/<label>/metrics.json into LEADERBOARD.md,
// enforcing the BENCHMARK.md integrity rules:
//   - results are partitioned by the era lock the runner stamps into
//     outcome.json (eraLock.lockHash); eras are never pooled or compared,
//     and matches without a stamp land in a trailing "pre-era (research
//     preview)" section that is excluded from all rankings;
//   - only engine-resolved winners reach W-L: unfinished (winner null) and
//     infrastructure-censored games never touch W-L, win-rate, or Elo;
//   - W-L, the 95% Wilson interval, and n are always displayed; Elo
//     (start 1200, K=32, chronological) is displayed only for models with
//     >= 10 finished games inside a single era partition;
//   - mirror matches (outcome.mirror) are self-play calibration: listed,
//     never ranked, never rated.
// Usage: node leaderboard.mjs [match-results-dir]
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Strict argv contract: at most one positional; every flag is unknown.
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg.startsWith('-'))) {
	console.error('usage: node leaderboard.mjs [match-results-dir]');
	process.exit(2);
}

const root = args[0] ?? 'match-results';
if (!existsSync(root)) {
	console.error(`usage: node leaderboard.mjs [match-results-dir] (missing: ${root})`);
	process.exit(2);
}

const EloGateGames = 10;
const EloInitial = 1200;
const EloK = 32;
const LockPrefixChars = 12;
const WinStatus = /win states resolved/i;
const CensoredStatus = /authentication|credential|sidecar returned/i;

const readJson = file => {
	if (!existsSync(file)) {
		return null;
	}

	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
};

// Chronological Elo needs a stable order and the first log.jsonl event holds
// the only wall-clock stamp a match directory has. The read is bounded:
// match logs run to megabytes and only the head line is needed.
const startedAtOf = dir => {
	const file = path.join(dir, 'log.jsonl');
	if (!existsSync(file)) {
		return null;
	}

	let fd = null;
	try {
		fd = openSync(file, 'r');
		const buffer = Buffer.alloc(4096);
		const bytes = readSync(fd, buffer, 0, buffer.length, 0);
		const head = buffer.toString('utf8', 0, bytes);
		const end = head.indexOf('\n');
		const stamp = Date.parse(JSON.parse(head.slice(0, end < 0 ? head.length : end)).t);
		return Number.isFinite(stamp) ? stamp : null;
	} catch {
		return null;
	} finally {
		if (fd != null) {
			closeSync(fd);
		}
	}
};

// Infrastructure censoring measures our plumbing, not the model: desyncs,
// harness failures, and provider/auth faults are excluded from skill
// statistics entirely, even when a winner happened to be recorded.
const censoredOf = (match, outcome) => match.infrastructureCensored === true
	|| outcome?.infrastructureCensored === true
	|| match.desync === true
	|| match.terminalState === 'failed'
	|| CensoredStatus.test(match.terminalStatus ?? '');

// Only engine-resolved winners count toward skill. outcome.json is the
// runner's winner contract and metrics.json passes it through; the legacy
// manual `winner.txt` predates outcome.json and is trusted only when the
// terminal status proves the engine actually resolved win states, and only
// for the two model seats — spend-cap or wall-clock stops stay unfinished
// no matter what a sidecar file claims.
const winnerOf = (dir, metrics, outcome) => {
	const resolved = metrics.match.winner ?? outcome?.winner ?? null;
	if (resolved != null) {
		return resolved;
	}

	if (!WinStatus.test(metrics.match.terminalStatus ?? '')) {
		return null;
	}

	const winnerFile = path.join(dir, 'winner.txt');
	if (!existsSync(winnerFile)) {
		return null;
	}

	const manual = readFileSync(winnerFile, 'utf8').trim();
	return manual === 'agent1' || manual === 'agent2' ? manual : null;
};

// A directory without a parseable metrics.json cannot attribute stats to a
// model; it is named in the output rather than silently dropped.
const records = [];
const skipped = [];
for (const entry of readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
	const dir = path.join(root, entry.name);
	const metrics = readJson(path.join(dir, 'metrics.json'));
	if (metrics == null || typeof metrics.match !== 'object' || metrics.match == null || !Array.isArray(metrics.agents)) {
		skipped.push(`${entry.name} (${metrics === undefined ? 'unreadable' : 'no'} metrics.json)`);
		continue;
	}

	const outcome = readJson(path.join(dir, 'outcome.json')) ?? null;
	// The era stamp is only trusted in its contract shape; a malformed lock
	// must not smuggle a match into a ranked era, so it falls to pre-era.
	const lock = outcome?.eraLock;
	const eraLock = lock != null && typeof lock.lockHash === 'string' && lock.lockHash.length > 0 ? lock : null;
	const censored = censoredOf(metrics.match, outcome);
	const winner = winnerOf(dir, metrics, outcome);
	records.push({
		label: entry.name,
		startedAt: startedAtOf(dir),
		metrics,
		eraLock,
		mirror: (outcome?.mirror ?? metrics.mirror) === true,
		censored,
		winner,
		finished: !censored && winner != null
	});
}

const eras = new Map();
const preEra = [];
for (const match of records) {
	if (match.eraLock == null) {
		preEra.push(match);
		continue;
	}

	const key = match.eraLock.lockHash;
	if (!eras.has(key)) {
		eras.set(key, { era: match.eraLock.era ?? 'unnamed-era', lockHash: key, matches: [] });
	}

	eras.get(key).matches.push(match);
}

// W-L invariant: a censored game counts only as censored and an unfinished
// game only as unfinished — neither may ever reach wins/losses, and Wilson n
// is derived from wins+losses alone.
const aggregate = matches => {
	const models = new Map();
	const modelOf = id => {
		if (!models.has(id)) {
			models.set(id, {
				model: id, wins: 0, losses: 0, unfinished: 0, censored: 0,
				matches: 0, decisions: 0, accepted: 0, actions: 0, noOps: 0,
				spendUsd: 0, latencies: []
			});
		}

		return models.get(id);
	};

	for (const match of matches) {
		const ids = [match.metrics.match.model1, match.metrics.match.model2];
		match.metrics.agents.forEach((agent, index) => {
			const row = modelOf(ids[index] ?? agent.agent);
			row.matches++;
			row.decisions += agent.decisions ?? 0;
			row.accepted += Math.round((agent.acceptanceRate ?? 0) / 100 * (agent.actions ?? 0));
			row.actions += agent.actions ?? 0;
			row.noOps += agent.noOps ?? 0;
			row.spendUsd += agent.spendUsd ?? 0;
			if (agent.decisionLatencyMsP50 != null) {
				row.latencies.push(agent.decisionLatencyMsP50);
			}

			if (match.censored) {
				row.censored++;
			} else if (!match.finished) {
				row.unfinished++;
			} else if (match.winner === agent.agent) {
				row.wins++;
			} else {
				// A resolved winner that is not this seat (the other model or a
				// baseline bot) is a genuine loss for this model.
				row.losses++;
			}
		});
	}

	return models;
};

// Elo is display-gated, not computation-gated: ratings replay every finished
// model-vs-model game of the era in start order, so the number is identical
// whenever a model crosses the gate. Self-play (same model in both seats)
// and bot-baseline games carry no pairwise rating information.
const eloOf = matches => {
	const ratings = new Map();
	const rated = matches
		.filter(match => match.finished && (match.winner === 'agent1' || match.winner === 'agent2'))
		.filter(match => match.metrics.match.model1 != null && match.metrics.match.model2 != null)
		.filter(match => match.metrics.match.model1 !== match.metrics.match.model2)
		.sort((a, b) => ((a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER))
			|| a.label.localeCompare(b.label));
	for (const match of rated) {
		const model1 = match.metrics.match.model1;
		const model2 = match.metrics.match.model2;
		const rating1 = ratings.get(model1) ?? EloInitial;
		const rating2 = ratings.get(model2) ?? EloInitial;
		const expected1 = 1 / (1 + 10 ** ((rating2 - rating1) / 400));
		const score1 = match.winner === 'agent1' ? 1 : 0;
		ratings.set(model1, rating1 + EloK * (score1 - expected1));
		ratings.set(model2, rating2 + EloK * ((1 - score1) - (1 - expected1)));
	}

	return ratings;
};

// Sample size is always disclosed, even (especially) when it is zero.
const wilson = (wins, games) => {
	if (games === 0) {
		return `— (n=0)`;
	}

	const z = 1.96;
	const p = wins / games;
	const denominator = 1 + z * z / games;
	const center = (p + z * z / (2 * games)) / denominator;
	const margin = z * Math.sqrt(p * (1 - p) / games + z * z / (4 * games * games)) / denominator;
	return `${(center * 100).toFixed(0)}±${(margin * 100).toFixed(0)}% (n=${games})`;
};

const tableOf = (rows, { withElo = false, ratings = new Map() } = {}) => {
	const columns = ['model', 'W-L (unf/cens)', 'win% (95% Wilson)', ...(withElo ? ['Elo'] : []),
		'acceptance', 'no-ops', 'decision p50', '$/decision', 'total $'];
	return [
		`| ${columns.join(' | ')} |`,
		`|${columns.map(() => '---').join('|')}|`,
		...rows.map(row => {
			const games = row.wins + row.losses;
			const acceptance = row.actions > 0 ? `${(row.accepted / row.actions * 100).toFixed(1)}%` : '—';
			const p50 = row.latencies.length > 0
				? `${Math.round(row.latencies.reduce((a, b) => a + b, 0) / row.latencies.length)}ms`
				: '—';
			const perDecision = row.decisions > 0 ? `$${(row.spendUsd / row.decisions).toFixed(5)}` : '—';
			const elo = games >= EloGateGames ? `${Math.round(ratings.get(row.model) ?? EloInitial)}` : '—';
			const cells = [
				row.model,
				`${row.wins}-${row.losses} (${row.unfinished}/${row.censored})`,
				wilson(row.wins, games),
				...(withElo ? [elo] : []),
				acceptance, `${row.noOps}`, p50, perDecision, `$${row.spendUsd.toFixed(2)}`
			];
			return `| ${cells.join(' | ')} |`;
		})
	];
};

const calibrationOf = mirrors => mirrors.map(match => {
	const model = match.metrics.match.model1 ?? match.metrics.match.model2 ?? 'unknown model';
	const result = match.censored ? 'infrastructure-censored'
		: match.finished ? `winner ${match.winner}` : 'unfinished';
	return `- ${match.label} — ${model} (self-play): ${result}`;
});

const countsLineOf = matches => {
	const mirrors = matches.filter(match => match.mirror).length;
	const ranked = matches.filter(match => !match.mirror);
	const finished = ranked.filter(match => match.finished).length;
	const censored = ranked.filter(match => match.censored).length;
	const unfinished = ranked.length - finished - censored;
	return `Matches: ${matches.length} (finished ${finished}, unfinished ${unfinished}, ` +
		`censored ${censored}, mirror ${mirrors}).`;
};

// Ranked ordering exists only inside one era; pre-era rows are listed
// alphabetically precisely to avoid implying a ranking.
const rankedSort = (a, b) => ((b.wins - b.losses) - (a.wins - a.losses))
	|| (b.wins - a.wins) || a.model.localeCompare(b.model);

const sections = [];
const earliestOf = group => Math.min(...group.matches.map(match => match.startedAt ?? Number.MAX_SAFE_INTEGER));
const eraGroups = [...eras.values()].sort((a, b) => (earliestOf(a) - earliestOf(b))
	|| a.era.localeCompare(b.era) || a.lockHash.localeCompare(b.lockHash));

for (const group of eraGroups) {
	const ranked = group.matches.filter(match => !match.mirror);
	const mirrors = group.matches.filter(match => match.mirror);
	const rows = [...aggregate(ranked).values()].sort(rankedSort);
	const ratings = eloOf(ranked);
	const withElo = rows.some(row => row.wins + row.losses >= EloGateGames);
	sections.push('', `## Era ${group.era} — lock ${group.lockHash.slice(0, LockPrefixChars)}…`, '', countsLineOf(group.matches), '');
	if (rows.length === 0) {
		sections.push('No rankable (non-mirror) matches in this era yet.');
	} else {
		sections.push(...tableOf(rows, { withElo, ratings }));
		sections.push('', withElo
			? `Elo: K=${EloK} from ${EloInitial}, replayed chronologically over this era's finished ` +
				`model-vs-model games; displayed only at n≥${EloGateGames} finished games.`
			: `Elo withheld: no model has ${EloGateGames} finished games in this era yet (BENCHMARK.md gate).`);
	}

	if (mirrors.length > 0) {
		sections.push('', '### Calibration: mirror matches (never ranked)', '');
		sections.push(...calibrationOf(mirrors));
	}
}

if (eraGroups.length === 0) {
	sections.push('', 'No era-locked matches yet: the ranked ladder is empty.');
}

if (preEra.length > 0) {
	const ranked = preEra.filter(match => !match.mirror);
	const mirrors = preEra.filter(match => match.mirror);
	const rows = [...aggregate(ranked).values()].sort((a, b) => a.model.localeCompare(b.model));
	sections.push('', '## Pre-era (research preview) — excluded from rankings', '',
		'These matches carry no eraLock stamp in outcome.json (they predate the era',
		'lock, or their lock was unreadable). They are shown for transparency only',
		'and contribute to no ranking, win-rate comparison, or Elo.', '', countsLineOf(preEra));
	if (rows.length > 0) {
		sections.push('', ...tableOf(rows));
	}

	if (mirrors.length > 0) {
		sections.push('', '### Calibration: mirror matches (never ranked)', '');
		sections.push(...calibrationOf(mirrors));
	}
}

const board = [
	'# Red Alert Benchmark — Leaderboard',
	'',
	`Matches analyzed: ${records.length} (from ${root}). Results are partitioned by`,
	'era lock (outcome.json `eraLock.lockHash`) and never pooled across eras.',
	'Unfinished (no engine-resolved winner) and infrastructure-censored games are',
	'reported but never contribute to W-L, win-rate, or Elo; mirror matches are',
	'self-play calibration and are never ranked (BENCHMARK.md).',
	...sections,
	'',
	...(skipped.length > 0 ? [`Skipped directories: ${skipped.join(', ')}.`, ''] : []),
	'Per-match scorecards live beside each metrics.json.'
].join('\n');

writeFileSync(path.join(root, 'LEADERBOARD.md'), board);
console.log(board);
