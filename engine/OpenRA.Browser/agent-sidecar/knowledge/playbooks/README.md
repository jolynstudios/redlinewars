# Agent strategy playbooks

Paste one playbook into an agent's commander-prompt box in the setup panel
(alongside or instead of the default personality line). The sidecar's static
primer instructs agents to follow a PLAYBOOK section's build order and
reaction rules and to adapt through its abort conditions.

Format: the doctrine template validated by the LLM-plays-RTS literature
(state-gated re-entrant build steps, composition-defined mid-game,
observable IF/THEN reactions, explicit abort + commitment, spelled-out win
condition), extended with a standing-orders section 0 placed right after
IDENTITY & GOAL. Every cost, prerequisite, and timing was verified against
this repo's `mods/ra/rules/*.yaml`; classic-1996 lore that OpenRA changed
is excluded or adapted (see the research dossiers in the session record).

Agent-capability conventions shared by all playbooks:

- Section 0 issues the doctrine's full six-field setPolicy statement once
  at match start; the policy persists until restated, and playbooks flip
  rally/retreat at LAUNCH or conversion where the doctrine changes phase.
- Build steps and abort checks trust the authoritative hostTruth ledger
  (buildingCounts, economy) over memory or the memo.
- Literal memo journal templates at each phase transition (opening
  complete, GO/LAUNCH, abort/conversion) keep the re-entrant plan alive
  between decisions.
- ALERT rules in section 6 key off the real alert kinds (enemyNearBase,
  criticalAssetAttacked/Lost, firstContact, materialEnemyForce, lowPower/
  criticalPower, productionReady/productionIdleAffordable) and their
  weak/even/strong threat verdicts; alert wakes are trimmed fast tactical
  turns (fastPathNote), so these rules prescribe the immediate action,
  never a replan.

- `allied-meta.md` — the ladder-standard Allied double-refinery macro game.
- `soviet-armor.md` — Soviet heavy-tank spine into V2s and Mammoths.
- `soviet-grenadier-rush.md` — early Soviet infantry pressure (cheese) with a
  built-in transition back to the standard game.
- `soviet-engineer-strike.md` — the APC engineer capture play (requires the
  `capture` action; lands with WP2.5).

Sizing: each playbook is ≤ ~5,000 chars so it fits the 8,000-char commander
prompt cap with room for user personality text. Regenerate/edit freely —
these are text artifacts, and match replays embed the prompt used.
