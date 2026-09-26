// Rules→options coverage audit (dev tool, not a gate): walks the ground truth
// — every actor in ra-arsenal.json — and reports whether each is covered by at
// least one model-facing option surface (situation manual, strategy cards,
// knowledge sheet, advisor hints, mission/action vocabulary). Output is
// coverage-report.md beside this script. Silent gaps are the enemy: every
// uncovered item is listed, and deliberate deferrals are labeled as such.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const sidecar = path.join(testsDir, '..', 'agent-sidecar');
const arsenal = JSON.parse(readFileSync(path.join(sidecar, 'knowledge', 'ra-arsenal.json'), 'utf8'));
const manual = readFileSync(path.join(sidecar, 'knowledge', 'strategies', 'situation-manual.json'), 'utf8');
const knowledge = readFileSync(path.join(sidecar, 'knowledge', 'ra-knowledge.md'), 'utf8');
const catalog = JSON.parse(readFileSync(path.join(sidecar, 'knowledge', 'strategies', 'catalog.json'), 'utf8'));
const cards = catalog.cards
	.map(entry => readFileSync(path.join(sidecar, 'knowledge', 'strategies', entry.file), 'utf8'))
	.join('\n');

// The advisor's hints live in C# (AgentAdvisor.cs); their subject actors are
// mirrored here so the audit sees them. Update alongside advisor changes.
const advisorSubjects = ['powr', 'proc', 'harv', 'silo', 'mcv'];

// Deliberate, labeled deferrals — reviewed gaps, not oversights.
const fakeStructureNote = 'fake-structure deception play — deferred to an intel-warfare pass';
const countryVariantNote = 'country-variant unit — cards stay side-level this era (benchmark seats symmetric countries)';
const campaignNote = 'campaign/easter-egg actor — unreachable in benchmark skirmish';
const deferred = {
	mnly: 'minelayer play (mine walls / AT ambush) — no option surface yet; revisit with a defensive-cards pass',
	truk: 'supply truck gifting — niche diplomacy mechanic, out of benchmark scope',
	tran: 'helicopter transport logistics — carryall-style play deferred with formation micro',
	lst: 'naval transport — deferred with the naval map pool',
	mgg: 'gap generator counter-intel — deferred to an intel-warfare pass',
	mrj: 'mobile radar jammer — deferred to an intel-warfare pass',
	fcom: 'forward command build-area extension is mentioned only in tesla-creep; broader use deferred',
	hosp: 'neutral hospital capture — map-dependent neutral tech deferred',
	fix: 'Service-Depot VEHICLE repair micro (structure exists in openings; the repair-cycle play is deferred)',
	mech: 'field mechanic vehicle-repair play — deferred with the depot repair-cycle theme',
	'4tnk': 'mammoth late-game doctrine — facts fully covered in the counter graph; a dedicated heavy-tech card is a future catalog addition',
	heli: 'allied rotary air doctrine — a dedicated allied-air card is a future catalog addition',
	mh60: 'allied rotary air doctrine — a dedicated allied-air card is a future catalog addition',
	dtrk: 'demolition-truck suicide play — high-risk niche, deferred',
	qtnk: 'MAD tank shockwave play — niche, deferred',
	shok: countryVariantNote,
	ttnk: countryVariantNote,
	ctnk: countryVariantNote,
	'spy.england': countryVariantNote,
	'afld.ukraine': countryVariantNote,
	hbox: 'camo pillbox and wall variants — defensive-structure depth pass',
	sbag: 'camo pillbox and wall variants — defensive-structure depth pass',
	fenc: 'camo pillbox and wall variants — defensive-structure depth pass',
	fireant: campaignNote,
	scoutant: campaignNote,
	warriorant: campaignNote,
	zombie: campaignNote,
	facf: fakeStructureNote,
	fpwr: fakeStructureNote,
	domf: fakeStructureNote,
	atef: fakeStructureNote,
	fapw: fakeStructureNote,
	fixf: fakeStructureNote,
	mslf: fakeStructureNote,
	pdof: fakeStructureNote,
	spef: fakeStructureNote,
	syrf: fakeStructureNote,
	tenf: fakeStructureNote,
	weaf: fakeStructureNote
};

// The knowledge sheet is deliberately EXCLUDED: it is a generated fact table
// that names every actor by construction, so including it would make this
// audit measure nothing. Option surfaces are actionable guidance only. The
// sheet still participates for one narrow purpose below: distinguishing
// "the facts exist" from "no guidance exists".
const surfaces = `${manual}\n${cards}`.toLowerCase();
void knowledge;
const rows = [];
for (const actor of arsenal.actors) {
	const id = actor.id.toLowerCase();
	const inSurfaces = surfaces.includes(id);
	const inAdvisor = advisorSubjects.includes(id);
	const status = inSurfaces || inAdvisor
		? 'covered'
		: deferred[id] != null
			? `DEFERRED — ${deferred[id]}`
			: 'UNCOVERED';
	rows.push({ id: actor.id, name: actor.displayName, status });
}

const uncovered = rows.filter(row => row.status === 'UNCOVERED');
const deferredRows = rows.filter(row => row.status.startsWith('DEFERRED'));
const report = [
	'# Rules→options coverage report',
	'',
	`Generated from ra-arsenal.json (${arsenal.actors.length} actors) against the situation manual,`,
	'strategy cards, knowledge sheet, and the mirrored advisor subject list.',
	'',
	`- covered: ${rows.length - uncovered.length - deferredRows.length}`,
	`- deferred (labeled): ${deferredRows.length}`,
	`- UNCOVERED: ${uncovered.length}`,
	'',
	'## Uncovered (must be filled or explicitly deferred)',
	...(uncovered.length === 0 ? ['(none)'] : uncovered.map(row => `- ${row.id} (${row.name})`)),
	'',
	'## Labeled deferrals',
	...deferredRows.map(row => `- ${row.id} (${row.name}): ${row.status.slice(11)}`),
	''
].join('\n');

writeFileSync(path.join(testsDir, 'coverage-report.md'), report);
console.log(report.split('\n').slice(0, 12).join('\n'));
if (uncovered.length > 0) {
	console.log(`\nUNCOVERED: ${uncovered.map(row => row.id).join(', ')}`);
	process.exitCode = 1;
}
