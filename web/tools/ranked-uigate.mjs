import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Ranked UI uses the account queue, participant claim join, and read-only settlement path', () => {
	const ranked = read('src/core/ranked.ts');
	const ui = read('src/ui/index.ts');
	const html = read('index.html');
	const broker = fs.readFileSync(path.resolve(root, '../desktop/account-broker.mjs'), 'utf8');
	assert.match(ranked, /method: 'POST'/);
	assert.match(ranked, /method: 'DELETE'/);
	assert.match(ranked, /rankedQueueStatus/);
	assert.match(ranked, /\/api\/ranked\/queue/);
	assert.match(ranked, /\/api\/ranked\/settlement\?matchId=\$\{encodeURIComponent\(matchId\)\}/);
	assert.match(ranked, /state: 'pending' \| 'settled' \| 'void'/);
	assert.match(ui, /searchParams\.set\('claim', admission\.claim\)/);
	assert.match(html, /id="session-ranked-identity"/);
	assert.match(html, /id="session-ranked-avatar"/);
	assert.match(ui, /renderRankedIdentity\(auth\.user\)/);
	assert.match(ui, /mpJoinCommon\(rankedEndpoint\.toString\(\), '', auth\.user\.callsign\)/);
	assert.match(ui, /No unauthenticated join was attempted/);
	assert.match(ui, /if \(!auth\.online\)/);
	assert.match(ui, /No unranked fallback was used/);
	assert.match(ui, /this\.rankedUiGateOpen\(\)/);
	assert.match(ui, /startRankedSettlementPolling/);
	assert.match(html, /id="session-mp-ranked"/);
	assert.match(html, /Find ranked match/);
	assert.match(html, /Skirmish · rating eligible/);
	assert.match(html, /Unranked network play · results do not change rating/);
	assert.match(ui, /Ranked multiplayer · server adjudication/);
	assert.match(ui, /settlementDelta/);
	assert.match(ui, /rating \$\{room\.settlementRating\}/);
	assert.match(broker, /\/api\/ranked\/queue/);
	assert.match(broker, /RANKED_SETTLEMENT_PATH/);
});

test('Ranked UI keeps production-off hidden and names every queue state', () => {
	const ui = read('src/ui/index.ts');
	assert.match(ui, /this\.rankedQueueRoot\) this\.rankedQueueRoot\.hidden = !this\.rankedUiGateOpen\(\)/);
	assert.match(ui, /Waiting for an opponent/);
	assert.match(ui, /Opponent found\. Joining the ranked room/);
	assert.match(ui, /Ranked search expired/);
	assert.match(ui, /Ranked search cancelled/);
	assert.match(ui, /Settlement unavailable — no rating change/);
	assert.match(ui, /Match void — no rating change/);
});
