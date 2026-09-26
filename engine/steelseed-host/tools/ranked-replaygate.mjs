#!/usr/bin/env node
// T6.12/T6.13 executable gate. The configured verifier must be the native
// OpenRA same-engine verifier; this command only signs its checked receipt.
import fs from 'node:fs';
import { verifyRankedReplay } from './ranked-replay.mjs';

const args = process.argv.slice(2);
const value = name => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : null;
};
const replay = value('--replay');
const claimFile = value('--claim');
if (!replay || !claimFile) {
	console.error('usage: ranked-replaygate.mjs --replay FILE --claim FILE [--receipt FILE]');
	process.exit(2);
}

const result = await verifyRankedReplay({ replayFile: replay, claim: JSON.parse(fs.readFileSync(claimFile, 'utf8')) });
const receiptFile = value('--receipt');
if (receiptFile) fs.writeFileSync(receiptFile, `${JSON.stringify(result)}\n`, { mode: 0o600 });
console.log(JSON.stringify(result));
process.exit(result.receipt.status === 'settled' && typeof result.signature === 'string' ? 0 : 1);
