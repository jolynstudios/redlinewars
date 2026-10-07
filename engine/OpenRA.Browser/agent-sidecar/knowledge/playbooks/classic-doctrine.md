PLAYBOOK: CLASSIC DOCTRINE [Tactic: classic_ai]

This doctrine is adapted from the configuration of OpenRA's built-in
"Normal AI" — its real priorities and thresholds, plus a few marked
ADAPTED adjustments where LLM decision tempo differs from a bot that
re-evaluates every few ticks. It has beaten countless humans through
consistency alone. Execute it with judgment and you start from a
proven floor.

0. STANDING ORDERS (set once at match start)
{"type":"setPolicy","autoReturnFire":true,"harvesterFlee":true,
"rallyNewUnitsToDefense":true,"defendCriticalAssets":true,
"autoRepairBuildings":false,"retreatBelowHpPercent":25}
The classic AI never lets damaged squads die pointlessly and always
defends its economy. Neither do you.

1. IDENTITY & GOAL
You are the machine: relentless, patient, never idle. You win not by
brilliance but by never wasting a turn — economy always growing, army
always building, attacks on a steady drumbeat. memo each phase change.

2. STANDING PRIORITIES (the classic build ladder, in strict order)
1) Power first, always: the classic AI grows its power reserve with
   its base — roughly +40 spare power per 4 buildings, capped at +200.
   If the next building would push reserve below that target, build
   powr before it.
2) Once production exists, keep at least 2 proc (economy before
   everything); each new proc justifies more harvesters.
3) No barr: build barr. No weap and cash allows: build weap.
4) Ore stored at 80% of silo capacity: build a silo.
5) Otherwise expand by the classic weights — production first
   (barr 3, weap 4), then defenses toward their target share of the
   base: pbox 9%, gun 9%, ftur 10%, tsla 5% of your structures.
Never hoard: when cash piles above 8000, the classic AI converts
surplus into another production building about half the time —
you should convert EVERY time (ADAPTED: you get fewer decisions,
so make each one count). Surplus money must become capacity.

3. ARMY COMPOSITION (the classic build weights)
e1 rifle weight 65 · e2 grenadier weight 15 · harvesters to ~8 total ·
light vehicles (ftrk) weight 30 but HARD CAP 4 alive. Translation:
stream infantry constantly from the moment barr exists — mostly e1
with e2 support; keep harvester count growing toward 8 with every new
proc; keep up to 4 fast vehicles for scouting and response once weap
stands, then shift vehicle production to tanks. Never let the infantry
queue idle — the classic AI's most feared trait is that units never
stop coming.

4. SQUAD DOCTRINE (attack timing)
- Keep 1-3 cheap units in a continuous "scouts" sweep from the opening;
  replace losses and requeue while fog or last-known structures remain.
- Classic AI launches at 40-69. ADAPTED: assign "mainArmy" and queue a
  strike mission at 15-25, staged on a safe visible approach; raid the
  economy first. NEVER trickle units into the enemy base.
- With two sound approaches, split 16-24 attackers into two distinct
  8-12-unit leg squads and queue one pincer with separate via cells.
  Do not directly order/release either leg; let the barrier sync them.
- While the squad gathers, units defend the base (rally policy on).
- Attack target priority: enemy harvesters and refineries first, then
  power, then production. Retreat the squad if it drops below half
  strength and regather.
- Re-scout the enemy base before each attack wave.

5. PROTECTION LIST (what you drop everything to defend)
Harvesters, MCV, refineries, War Factory, Construction Yard, power.
If any of these is attacked (alerts tell you), respond with nearby
combat units immediately — the reflex layer starts the defense; follow
through with your squad if the threat estimate is even or strong.

6. REACTION RULES
- ALERT criticalAssetAttacked, threat weak → let reflexes handle it;
  do not break the attack squad.
- ALERT criticalAssetAttacked, threat even/strong → recall mainArmy to
  defend; economy outranks any attack in progress.
- ALERT lowPower/criticalPower → next build is powr, no exceptions.
- Enemy tanks sighted and you have none → weap then a 3tnk stream
  before the next attack wave.
- SITUATION enemyRetreating → pursue its reported cell with an
  uncommitted fast group, or higher-version replace its attack mission.
- SITUATION reinforcementNeeded → reinforce from an uncommitted reserve
  to the named squad, or to the reported cell if no squad is named.
- EVENT missionAborted → rebuild to launch strength, then re-strike via
  a new mission or higher version on an alternate staging axis.
- cancelProduction accepts count up to 5 — clean a clogged queue with
  two batched cancels, never with a dozen single actions.

7. ABORT & COMMITMENT
This doctrine has no abort — it is the baseline. If an attack fails,
regather at 15-20 and go again; the drumbeat is the strategy. Keep
memo updated: phase, squad size, harvester count, next ladder item.

8. WIN CONDITION & PUSH
Victory requires every enemy production building dead. Grind their
economy first (harvesters die to your waves), then production. Sweep
the fog for rebuilt structures — trust knownEnemyStructures and
re-scout before declaring anything dead.
