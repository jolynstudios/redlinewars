#!/usr/bin/env node
// Test-only verifier fixture. Production always points REDLINE_RANKED_VERIFIER
// at the native same-engine verifier.
const mode = process.env.STEELSEED_FIXTURE_RESULT ?? 'settled';
const settled = mode === 'settled' || mode === 'surrender' || mode === 'disconnect-forfeit';
const pascal = process.env.STEELSEED_FIXTURE_SCHEMA === 'pascal';
const result = settled
	? pascal ? { Status: 'settled', FinalTick: 42, TerminationReason: mode === 'settled' ? 'gameover' : mode, Players: [
		{ ClientIndex: 1, Outcome: 'won', DisconnectFrame: null, Surrendered: false },
		{ ClientIndex: 2, Outcome: 'lost', DisconnectFrame: null, Surrendered: false },
	] } : { status: 'settled', finalTick: 42, terminationReason: mode === 'settled' ? 'gameover' : mode, players: [
		{ clientIndex: 1, outcome: 'won', disconnectFrame: null, surrendered: false },
		{ clientIndex: 2, outcome: 'lost', disconnectFrame: null, surrendered: false },
	] }
	: pascal ? { Status: 'void', Reason: mode } : { status: 'void', reason: mode };
console.log(JSON.stringify(result));
