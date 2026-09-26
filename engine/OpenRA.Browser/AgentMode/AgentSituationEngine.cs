#region Copyright & License Information
/*
 * Copyright (c) The OpenRA Developers and Contributors
 * This file is part of OpenRA, which is free software. It is made
 * available to you under the terms of the GNU General Public License
 * as published by the Free Software Foundation, either version 3 of
 * the License, or (at your option) any later version. For more
 * information, see COPYING.
 */
#endregion

using System;
using System.Collections.Generic;
using System.Linq;

namespace OpenRA.Browser
{
	/// <summary>
	/// Maintains bounded, factual situation state from per-seat fog-safe scans.
	/// It never ranks responses or issues orders: transitions only wake the model.
	/// </summary>
	static class AgentSituationEngine
	{
		const int DefaultExitGraceTicks = 100;
		const int SituationWakeCooldownTicks = 250;
		const int EcoExposureDebounceScans = 5;
		const int MaxSituations = 5;
		const int MaxCandidatesPerScan = 16;
		const int MaxActiveRecords = 24;

		internal sealed class State
		{
			internal Dictionary<string, Record> Active { get; } = new(StringComparer.Ordinal);
			internal Dictionary<uint, int> StructureHealth { get; } = [];
			internal Dictionary<uint, int> EcoExposureScans { get; } = [];
		}

		internal sealed class Scan
		{
			public int WorldTick { get; init; }
			public string PowerState { get; init; }
			public int Funds { get; init; }
			public bool WaterAdjacent { get; init; }
			public int ExploredPercent { get; init; }
			public int ActiveSweepMissions { get; init; }
			public ThreatSnapshot BaseThreat { get; init; }
			public IReadOnlyList<ContactSnapshot> AirContacts { get; init; } = [];
			public IReadOnlyList<ContactSnapshot> NavalContacts { get; init; } = [];
			public IReadOnlyList<HarvesterThreatSnapshot> HarvesterThreats { get; init; } = [];
			public IReadOnlyList<StructureSnapshot> Structures { get; init; } = [];
			public IReadOnlyList<EcoExposureSnapshot> EcoExposures { get; init; } = [];
			public IReadOnlyList<AgentKnownEnemyStructureObservation> KnownEnemyStructures { get; init; } = [];
			public IReadOnlyList<SupportPowerLaunchSnapshot> EnemySupportPowerLaunches { get; init; } = [];
			public IReadOnlyList<AgentAlertObservation> Alerts { get; init; } = [];
		}

		internal sealed class ThreatSnapshot
		{
			public CPos Cell { get; init; }
			public int VisibleEnemyCount { get; init; }
			public int VisibleEnemyValue { get; init; }
			public int DefenderCount { get; init; }
			public int DefenderValue { get; init; }
			public string Verdict { get; init; }
			public string AttackerClass { get; init; }
			public AgentSituationClassCountsObservation ClassCounts { get; init; }
			public bool DogRush { get; init; }
		}

		internal sealed class ContactSnapshot
		{
			public uint ActorId { get; init; }
			public string Type { get; init; }
			public CPos Cell { get; init; }
			public int Value { get; init; }
			public bool NearBase { get; init; }
			public bool ThreatensOwnedAsset { get; init; }
		}

		internal sealed class HarvesterThreatSnapshot
		{
			public uint HarvesterId { get; init; }
			public CPos Cell { get; init; }
			public int HpPercent { get; init; }
			public int VisibleEnemyCount { get; init; }
			public int VisibleEnemyValue { get; init; }
			public bool CrushableAll { get; init; }
			public int CanDamageCount { get; init; }
			public bool UnderAttack { get; init; }
			public string AttackerClass { get; init; }
			public AgentSituationClassCountsObservation ClassCounts { get; init; }
		}

		internal sealed class StructureSnapshot
		{
			public uint ActorId { get; init; }
			public string Type { get; init; }
			public CPos Cell { get; init; }
			public int Health { get; init; }
			public int MaxHealth { get; init; }
			public bool Critical { get; init; }
			public int RepairCostEstimate { get; init; }
			public int SellRefundEstimate { get; init; }
		}

		internal sealed class EcoExposureSnapshot
		{
			public uint ActorId { get; init; }
			public string Type { get; init; }
			public CPos Cell { get; init; }
		}

		internal sealed class SupportPowerLaunchSnapshot
		{
			public long Sequence { get; init; }
			public string OrderName { get; init; }
			public CPos AlertCell { get; init; }
		}

		internal sealed class Transition
		{
			public string Key { get; init; }
			public string AlertKind { get; init; }
			public string Severity { get; init; }
			public CPos Cell { get; init; }
			public string Detail { get; init; }
			public bool BypassKeyCooldown { get; init; }
		}

		internal sealed class UpdateResult
		{
			public IReadOnlyList<AgentSituationObservation> Situations { get; init; } = [];
			public IReadOnlyList<Transition> Transitions { get; init; } = [];
		}

		internal sealed class Candidate
		{
			public string Id { get; init; }
			public string Key { get; init; }
			public string Severity { get; init; }
			public CPos? Cell { get; init; }
			public AgentSituationEvidenceObservation Evidence { get; init; }
			public string[] FromAlerts { get; init; } = [];
			public string AlertKind { get; init; }
			public string Detail { get; init; }
			public int ExitGraceTicks { get; init; } = DefaultExitGraceTicks;

			// Wake pacing for re-notifications of one persisting situation.
			// Slow-moving state rows override the default so an informational
			// nudge never becomes a drumbeat.
			public int WakeCooldownTicks { get; init; } = SituationWakeCooldownTicks;
		}

		internal sealed class Record
		{
			public Candidate Candidate;
			public int SinceTick;
			public int LastObservedTick;
			public int NextWakeTick;
		}

		internal static UpdateResult Update(State state, Scan scan)
		{
			ArgumentNullException.ThrowIfNull(state);
			ArgumentNullException.ThrowIfNull(scan);

			var candidates = BuildCandidates(state, scan)
				.GroupBy(candidate => candidate.Key, StringComparer.Ordinal)
				.Select(group => group.OrderByDescending(candidate => SeverityRank(candidate.Severity)).First())
				.OrderByDescending(candidate => SeverityRank(candidate.Severity))
				.ThenBy(candidate => candidate.Id, StringComparer.Ordinal)
				.ThenBy(candidate => candidate.Key, StringComparer.Ordinal)
				.Take(MaxCandidatesPerScan)
				.OrderBy(candidate => candidate.Key, StringComparer.Ordinal)
				.ToArray();
			var observed = candidates.Select(candidate => candidate.Key).ToHashSet(StringComparer.Ordinal);
			var transitions = new List<Transition>();

			foreach (var candidate in candidates)
			{
				if (!state.Active.TryGetValue(candidate.Key, out var record))
				{
					record = new Record
					{
						Candidate = candidate,
						SinceTick = scan.WorldTick,
						LastObservedTick = scan.WorldTick,
						NextWakeTick = scan.WorldTick + candidate.WakeCooldownTicks
					};
					state.Active.Add(candidate.Key, record);
					AddTransition(transitions, candidate, false);
					continue;
				}

				var previousCandidate = record.Candidate;
				var escalated = SeverityRank(candidate.Severity) > SeverityRank(previousCandidate.Severity);
				record.Candidate = candidate;
				record.LastObservedTick = scan.WorldTick;
				if (escalated || (candidate.AlertKind != null && scan.WorldTick >= record.NextWakeTick &&
					MateriallyChanged(previousCandidate.Evidence, candidate.Evidence)))
				{
					AddTransition(transitions, candidate, escalated);
					record.NextWakeTick = scan.WorldTick + candidate.WakeCooldownTicks;
				}
			}

			foreach (var key in state.Active.Keys.Where(key => !observed.Contains(key)).ToArray())
			{
				var record = state.Active[key];
				if (scan.WorldTick - record.LastObservedTick > record.Candidate.ExitGraceTicks)
					state.Active.Remove(key);
			}

			foreach (var key in state.Active.Values
				.OrderByDescending(record => SeverityRank(record.Candidate.Severity))
				.ThenByDescending(record => record.LastObservedTick)
				.ThenBy(record => record.Candidate.Key, StringComparer.Ordinal)
				.Skip(MaxActiveRecords)
				.Select(record => record.Candidate.Key)
				.ToArray())
				state.Active.Remove(key);

			return new UpdateResult
			{
				Situations = state.Active.Values
					.OrderByDescending(record => SeverityRank(record.Candidate.Severity))
					.ThenBy(record => record.Candidate.Id, StringComparer.Ordinal)
					.ThenBy(record => record.Candidate.Key, StringComparer.Ordinal)
					.Take(MaxSituations)
					.Select(Observe)
					.ToArray(),
				Transitions = transitions
			};
		}

		internal static void ValidateDeterministicContract()
		{
			var mixed = Update(new State(), new Scan
			{
				WorldTick = 100,
				PowerState = "Normal",
				Funds = 3000,
				BaseThreat = new ThreatSnapshot
				{
					Cell = new CPos(20, 20),
					VisibleEnemyCount = 21,
					VisibleEnemyValue = 5000,
					DefenderCount = 5,
					DefenderValue = 1000,
					Verdict = "strong",
					AttackerClass = "armor",
					ClassCounts = new AgentSituationClassCountsObservation { Armor = 20, Air = 1 }
				},
				AirContacts = [new ContactSnapshot { ActorId = 1, Cell = new CPos(21, 20), NearBase = true }]
			});
			if (!mixed.Situations.Any(situation => situation.Id == "T1.base") ||
				mixed.Situations.Any(situation => situation.Id == "T1.air"))
				throw new InvalidOperationException("mixed base-threat coalescing is invalid");
			var harmlessNaval = Update(new State(), new Scan
			{
				WorldTick = 125,
				PowerState = "Normal",
				Funds = 3000,
				BaseThreat = new ThreatSnapshot { VisibleEnemyCount = 1 },
				NavalContacts = [new ContactSnapshot { ActorId = 2, Cell = new CPos(22, 20), NearBase = true }]
			});
			if (!harmlessNaval.Situations.Any(situation => situation.Id == "T1.naval" && situation.Severity == "warning"))
				throw new InvalidOperationException("non-threatening naval proximity was classified critical");

			var harvesterState = new State();
			var warning = Update(harvesterState, new Scan
			{
				WorldTick = 200,
				PowerState = "Normal",
				Funds = 3000,
				HarvesterThreats =
				[
					new HarvesterThreatSnapshot
					{
						HarvesterId = 7,
						Cell = new CPos(30, 30),
						HpPercent = 100,
						VisibleEnemyCount = 1,
						AttackerClass = "infantry",
						ClassCounts = new AgentSituationClassCountsObservation { Infantry = 1 }
					}
				]
			});
			if (!warning.Situations.Any(situation => situation.Id == "T3.harv" && situation.Severity == "warning"))
				throw new InvalidOperationException("harvester proximity situation is missing");

			var attacked = Update(harvesterState, new Scan
			{
				WorldTick = 225,
				PowerState = "Normal",
				Funds = 3000,
				HarvesterThreats =
				[
					new HarvesterThreatSnapshot
					{
						HarvesterId = 7,
						Cell = new CPos(30, 30),
						HpPercent = 90,
						UnderAttack = true,
						ClassCounts = new AgentSituationClassCountsObservation()
					}
				]
			});
			if (!attacked.Situations.Any(situation => situation.Id == "T3.harv" && situation.Severity == "critical"))
				throw new InvalidOperationException("harvester attack escalation is missing");

			var navalState = new State();
			Update(navalState, new Scan
			{
				WorldTick = 250,
				PowerState = "Normal",
				Funds = 3000,
				NavalContacts = [new ContactSnapshot { ActorId = 8, Cell = new CPos(40, 40) }]
			});
			var navalEscalation = Update(navalState, new Scan
			{
				WorldTick = 275,
				PowerState = "Normal",
				Funds = 3000,
				NavalContacts =
				[
					new ContactSnapshot { ActorId = 8, Cell = new CPos(40, 40), ThreatensOwnedAsset = true }
				]
			});
			if (!navalEscalation.Transitions.Any(transition => transition.BypassKeyCooldown))
				throw new InvalidOperationException("situation severity escalation remains cooldown-bound");

			var structures = new State();
			Update(structures, new Scan
			{
				WorldTick = 300,
				PowerState = "Normal",
				Funds = 3000,
				Structures = [new StructureSnapshot { ActorId = 9, Type = "powr", Health = 400, MaxHealth = 400 }]
			});
			var damaged = Update(structures, new Scan
			{
				WorldTick = 325,
				PowerState = "Normal",
				Funds = 3000,
				Structures =
				[
					new StructureSnapshot
					{
						ActorId = 9,
						Type = "powr",
						Health = 300,
						MaxHealth = 400,
						RepairCostEstimate = 75,
						SellRefundEstimate = 150
					}
				]
			});
			if (!damaged.Situations.Any(situation => situation.Id == "T4" &&
				situation.Evidence.RepairCostEstimate == 75 && situation.Evidence.SellRefundEstimate == 150))
				throw new InvalidOperationException("structure-damage situation or estimates are missing");
			var stillDamaged = Update(structures, new Scan
			{
				WorldTick = 350,
				PowerState = "Normal",
				Funds = 3000,
				Structures =
				[
					new StructureSnapshot { ActorId = 9, Type = "powr", Health = 300, MaxHealth = 400 }
				]
			});
			if (!stillDamaged.Situations.Any(situation => situation.Id == "T4") || stillDamaged.Transitions.Count != 0)
				throw new InvalidOperationException("damaged structure state is not persistent and edge-triggered");

			var signals = Update(new State(), new Scan
			{
				WorldTick = 400,
				PowerState = "Normal",
				Funds = 3000,
				Alerts =
				[
					new AgentAlertObservation { Kind = "enemyRetreating", Severity = "info", Detail = "stable cohort" },
					new AgentAlertObservation { Kind = "reinforcementNeeded", Severity = "critical", Detail = "squad-alpha" }
				]
			});
			if (!signals.Situations.Any(situation => situation.Id == "O1.retreat") ||
				!signals.Situations.Any(situation => situation.Id == "T2.reinforcement" &&
					situation.Severity == "critical"))
				throw new InvalidOperationException("same-scan retreat or critical reinforcement situation is missing");
		}

		static IEnumerable<Candidate> BuildCandidates(State state, Scan scan)
		{
			var nearAir = scan.AirContacts.Where(contact => contact.NearBase).ToArray();
			var nearNaval = scan.NavalContacts.Where(contact => contact.NearBase).ToArray();
			var nearBaseCount = scan.BaseThreat?.VisibleEnemyCount ?? 0;
			if (nearBaseCount != 0)
			{
				if (nearAir.Length == nearBaseCount)
					yield return ContactCandidate("T1.air", "T1:air", "critical", nearAir,
						"enemyAirSighted", "visible enemy air near base");
				else if (nearNaval.Length == nearBaseCount)
				{
					var threatensAsset = nearNaval.Any(contact => contact.ThreatensOwnedAsset);
					yield return ContactCandidate("T1.naval", "T1:naval", threatensAsset ? "critical" : "warning",
						nearNaval, "navalThreat", threatensAsset ? "visible naval force can threaten an owned asset" :
						"visible naval contact near base");
				}
				else
					yield return ThreatCandidate("T1.base", "T1:base", "critical", scan.BaseThreat,
						"enemyNearBase", "visible mixed or ground enemy force entered the base radius");
			}

			if (nearAir.Length == 0 && scan.AirContacts.Count != 0)
				yield return ContactCandidate("T1.air", "T1:air", "warning", scan.AirContacts,
					"enemyAirSighted", "visible enemy air contact");

			if (nearNaval.Length == 0 && scan.NavalContacts.Count != 0)
			{
				var threatensAsset = scan.NavalContacts.Any(contact => contact.ThreatensOwnedAsset);
				yield return ContactCandidate("T1.naval", "T1:naval", threatensAsset ? "critical" : "warning",
					scan.NavalContacts, "navalThreat",
					threatensAsset ? "visible naval force can threaten an owned asset" : "visible naval contact");
			}

			foreach (var threat in scan.HarvesterThreats
				.OrderByDescending(threat => threat.UnderAttack)
				.ThenBy(threat => threat.HpPercent)
				.ThenBy(threat => threat.HarvesterId)
				.Take(2))
				yield return new Candidate
				{
					Id = "T3.harv",
					Key = $"T3:harv:{threat.HarvesterId}",
					Severity = threat.UnderAttack ? "critical" : "warning",
					Cell = threat.Cell,
					AlertKind = threat.UnderAttack ? null : "oreLineContested",
					Detail = threat.UnderAttack ? "harvester is under visible attack" :
						"visible enemies are contesting a harvester",
					FromAlerts = threat.UnderAttack ? ["criticalAssetAttacked"] : [],
					Evidence = new AgentSituationEvidenceObservation
					{
						AssetId = threat.HarvesterId,
						AssetType = "harvester",
						HpPercent = threat.HpPercent,
						VisibleEnemyCount = threat.VisibleEnemyCount,
						VisibleEnemyValue = threat.VisibleEnemyValue,
						CrushableAll = threat.CrushableAll,
						CanDamageCount = threat.CanDamageCount,
						UnderAttack = threat.UnderAttack,
						AttackerClass = threat.AttackerClass,
						ClassCounts = threat.ClassCounts,
						HarvesterIds = [threat.HarvesterId]
					}
				};

			var currentStructures = scan.Structures.Select(structure => structure.ActorId).ToHashSet();
			foreach (var structure in scan.Structures.OrderBy(structure => structure.ActorId).Take(64))
			{
				var observedBefore = state.StructureHealth.TryGetValue(structure.ActorId, out var previous);
				var tookDamage = observedBefore && structure.Health < previous;
				if (structure.MaxHealth > 0 && structure.Health < structure.MaxHealth)
					yield return new Candidate
					{
						Id = "T4",
						Key = $"T4:{structure.ActorId}",
						Severity = "warning",
						Cell = structure.Cell,
						AlertKind = tookDamage && !structure.Critical ? "structureAttacked" : null,
						Detail = tookDamage ? $"{structure.Type} took damage" : $"{structure.Type} remains damaged",
						FromAlerts = tookDamage && structure.Critical ? ["criticalAssetAttacked"] : [],
						Evidence = new AgentSituationEvidenceObservation
						{
							AssetId = structure.ActorId,
							AssetType = structure.Type,
							HpPercent = Percent(structure.Health, structure.MaxHealth),
							RepairCostEstimate = structure.RepairCostEstimate,
							SellRefundEstimate = structure.SellRefundEstimate
						}
					};

				state.StructureHealth[structure.ActorId] = structure.Health;
			}

			foreach (var stale in state.StructureHealth.Keys.Where(id => !currentStructures.Contains(id)).ToArray())
				state.StructureHealth.Remove(stale);

			var selectedExposures = scan.EcoExposures.OrderBy(exposure => exposure.ActorId).Take(2).ToArray();
			var exposureIds = selectedExposures.Select(exposure => exposure.ActorId).ToHashSet();
			foreach (var exposure in selectedExposures)
			{
				state.EcoExposureScans.TryGetValue(exposure.ActorId, out var scans);
				state.EcoExposureScans[exposure.ActorId] = ++scans;
				if (scans < EcoExposureDebounceScans)
					continue;
				yield return new Candidate
				{
					Id = "O2",
					Key = $"O2:eco:{exposure.ActorId}",
					Severity = "info",
					Cell = exposure.Cell,
					AlertKind = "enemyEcoExposed",
					Detail = $"visible {exposure.Type} has no visible combat cover",
					ExitGraceTicks = 50,
					Evidence = new AgentSituationEvidenceObservation
					{
						TargetType = exposure.Type,
						VisibleOnly = true
					}
				};
			}

			foreach (var stale in state.EcoExposureScans.Keys.Where(id => !exposureIds.Contains(id)).ToArray())
				state.EcoExposureScans.Remove(stale);

			foreach (var structure in scan.KnownEnemyStructures
				.Where(structure => structure.Type is "mslo" or "iron" or "pdox")
				.OrderBy(structure => structure.Type, StringComparer.Ordinal)
				.ThenBy(structure => structure.Cell.X).ThenBy(structure => structure.Cell.Y)
				.Take(2))
				yield return new Candidate
				{
					Id = "T1.sw",
					Key = $"T1:sw:{structure.Type}:{structure.Cell.X}:{structure.Cell.Y}",
					Severity = "warning",
					Cell = new CPos(structure.Cell.X, structure.Cell.Y),
					AlertKind = "superweaponSighted",
					Detail = $"known enemy {structure.Type} at an observed cell",
					ExitGraceTicks = 0,
					Evidence = new AgentSituationEvidenceObservation
					{
						SuperweaponType = structure.Type,
						Status = structure.Status
					}
				};

			foreach (var launch in scan.EnemySupportPowerLaunches.OrderBy(launch => launch.Sequence).TakeLast(2))
				yield return new Candidate
				{
					Id = "T1.sw",
					Key = $"T1:sw-launch:{launch.Sequence}",
					Severity = "critical",
					Cell = launch.AlertCell,
					AlertKind = "superweaponLaunched",
					Detail = $"enemy support power {launch.OrderName} launched",
					ExitGraceTicks = 100,
					Evidence = new AgentSituationEvidenceObservation
					{
						SuperweaponType = launch.OrderName,
						Status = "launched"
					}
				};

			if (scan.PowerState is "Low" or "Critical")
				yield return new Candidate
				{
					Id = "E1.power",
					Key = "E1:power",
					Severity = scan.PowerState == "Critical" ? "critical" : "warning",
					AlertKind = null,
					Detail = "power state is factual host state",
					ExitGraceTicks = 0,
					Evidence = new AgentSituationEvidenceObservation { PowerState = scan.PowerState }
				};

			var funding = scan.Funds < 500 ? "broke" : scan.Funds < 2000 ? "reserve-only" :
				scan.Funds >= 8000 ? "floating-cash" : "healthy";
			yield return new Candidate
			{
				Id = "E1.funding",
				Key = "E1:funding",
				Severity = "info",
				ExitGraceTicks = 0,
				Evidence = new AgentSituationEvidenceObservation { Funding = funding, Funds = scan.Funds }
			};

			if (scan.WaterAdjacent)
				yield return new Candidate
				{
					Id = "S1.water",
					Key = "S1:waterAdjacent",
					Severity = "info",
					ExitGraceTicks = 0,
					Evidence = new AgentSituationEvidenceObservation { WaterAdjacent = true }
				};

			// Absence never wakes anyone by itself: most of the map dark with
			// no reconnaissance running is a fact worth one slow nudge. The
			// model chooses sweep, spy plane, or knowing blindness.
			if (scan.WorldTick > 3000 && scan.ExploredPercent < 60 && scan.ActiveSweepMissions == 0)
				yield return new Candidate
				{
					Id = "S2.recon",
					Key = "S2:recon",
					Severity = "info",
					AlertKind = "reconnaissanceStale",
					Detail = "most of the map is unexplored and no sweep mission is running",
					WakeCooldownTicks = 1500,
					ExitGraceTicks = 0,
					Evidence = new AgentSituationEvidenceObservation
					{
						ExploredPercent = scan.ExploredPercent,
						ActiveSweepMissions = scan.ActiveSweepMissions
					}
				};

			foreach (var alert in scan.Alerts
				.Where(alert => alert.Kind is "enemyRetreating" or "reinforcementNeeded")
				.OrderByDescending(alert => alert.FirstSeenTick).ThenBy(alert => alert.Kind, StringComparer.Ordinal)
				.Take(2))
				yield return new Candidate
				{
					Id = alert.Kind == "enemyRetreating" ? "O1.retreat" : "T2.reinforcement",
					Key = $"{alert.Kind}:{alert.Detail}",
					Severity = alert.Severity,
					Cell = alert.Cell == null ? null : new CPos(alert.Cell.X, alert.Cell.Y),
					ExitGraceTicks = DefaultExitGraceTicks,
					Evidence = new AgentSituationEvidenceObservation(),
					FromAlerts = [alert.Kind]
				};
		}

		static Candidate ThreatCandidate(string id, string key, string severity, ThreatSnapshot threat,
			string alertKind, string detail)
		{
			return new Candidate
			{
				Id = id,
				Key = key,
				Severity = severity,
				Cell = threat.Cell,
				AlertKind = alertKind,
				Detail = detail,
				Evidence = new AgentSituationEvidenceObservation
				{
					VisibleEnemyCount = threat.VisibleEnemyCount,
					VisibleEnemyValue = threat.VisibleEnemyValue,
					DefenderCount = threat.DefenderCount,
					DefenderValue = threat.DefenderValue,
					ThreatVerdict = threat.Verdict,
					AttackerClass = threat.AttackerClass,
					ClassCounts = threat.ClassCounts,
					DogRush = threat.DogRush
				}
			};
		}

		static Candidate ContactCandidate(string id, string key, string severity,
			IReadOnlyList<ContactSnapshot> contacts, string alertKind, string detail)
		{
			return new Candidate
			{
				Id = id,
				Key = key,
				Severity = severity,
				Cell = contacts.OrderBy(contact => contact.ActorId).First().Cell,
				AlertKind = alertKind,
				Detail = detail,
				Evidence = new AgentSituationEvidenceObservation
				{
					VisibleEnemyCount = contacts.Count,
					VisibleEnemyValue = contacts.Sum(contact => contact.Value),
					TargetType = string.Join(",", contacts.Select(contact => contact.Type)
						.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).Take(5))
				}
			};
		}

		static AgentSituationObservation Observe(Record record)
		{
			return new AgentSituationObservation
			{
				Id = record.Candidate.Id,
				Key = record.Candidate.Key,
				Severity = record.Candidate.Severity,
				SinceTick = record.SinceTick,
				LastUpdatedTick = record.LastObservedTick,
				Cell = ObserveCell(record.Candidate.Cell),
				Evidence = record.Candidate.Evidence,
				FromAlerts = record.Candidate.FromAlerts.Order(StringComparer.Ordinal).Take(3).ToList()
			};
		}

		static AgentCellObservation ObserveCell(CPos? cell)
		{
			return cell.HasValue ? new AgentCellObservation { X = cell.Value.X, Y = cell.Value.Y } : null;
		}

		static void AddTransition(List<Transition> transitions, Candidate candidate, bool bypassKeyCooldown)
		{
			if (candidate.AlertKind == null)
				return;
			transitions.Add(new Transition
			{
				Key = candidate.Key,
				AlertKind = candidate.AlertKind,
				Severity = candidate.Severity,
				Cell = candidate.Cell ?? CPos.Zero,
				Detail = candidate.Detail,
				BypassKeyCooldown = bypassKeyCooldown
			});
		}

		static bool MateriallyChanged(AgentSituationEvidenceObservation previous,
			AgentSituationEvidenceObservation current)
		{
			return Math.Abs(previous.VisibleEnemyCount - current.VisibleEnemyCount) >= 3 ||
				Math.Abs(previous.VisibleEnemyValue - current.VisibleEnemyValue) >=
					Math.Max(500, previous.VisibleEnemyValue / 2) ||
				!string.Equals(previous.AttackerClass, current.AttackerClass, StringComparison.Ordinal);
		}

		static int SeverityRank(string severity)
		{
			return severity switch
			{
				"critical" => 3,
				"warning" => 2,
				_ => 1
			};
		}

		static int Percent(int value, int maximum)
		{
			return maximum <= 0 ? 0 : Math.Clamp((int)(100L * value / maximum), 0, 100);
		}
	}
}
