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

using System.Collections.Generic;
using System.IO;
using System.Linq;
using OpenRA.Mods.Common.Traits;

namespace OpenRA.Browser
{
	static class AgentBuildPlanController
	{
		internal const int MaxSteps = 8;
		internal const int MaxPlanIdLength = 32;
		internal const int MaxReserveCash = 1000000;
		internal const int DefaultStallWatchdogTicks = 750;
		internal const int DefaultInternalFailureWatchdogTicks = 250;
		const int MaxEvents = 128;

		internal sealed class State
		{
			public string PlanId { get; set; }
			public int Version { get; set; }
			public int ReserveCash { get; set; }
			public List<AgentBuildPlanStep> Steps { get; set; } = [];
			public int StepIndex { get; set; }
			public string StepState { get; set; }
			public bool Paused { get; set; }
			public string PauseReason { get; set; }
			public uint ProducerId { get; set; }
			public HashSet<uint> BaselineActorIds { get; } = [];
			public HashSet<uint> DeliveredActorIds { get; } = [];
			public int LastOrderTick { get; set; } = -1;
			public int LastEvaluationTick { get; set; } = -1;
			public CPos? PlacementCell { get; set; }
			public int LastProgressTick { get; set; } = -1;
			public string LastProgressReason { get; set; }
			public string BlockedOn { get; set; }
			public string PauseSource { get; set; }
			public int LastObservedCash { get; set; } = -1;
			public int LastObservedQueueRemaining { get; set; } = -1;
			public int LastObservedQueueCount { get; set; } = -1;
			public long NextEventSequence { get; set; } = 1;
			public Queue<AgentBuildPlanEvent> Events { get; } = [];

			public bool HasPlan => PlanId != null;
			public bool Active => HasPlan && StepState is not ("completed" or "cancelled");
			public AgentBuildPlanStep CurrentStep => StepIndex >= 0 && StepIndex < Steps.Count ? Steps[StepIndex] : null;
		}

		internal static void Replace(State state, AgentAction action, World world)
		{
			Validate(state, action, world);

			var steps = action.Steps.ConvertAll(step => new AgentBuildPlanStep
			{
				Item = world.Map.Rules.Actors[step.Item].Name,
				Count = step.Count
			});

			if (state.Active)
				Record(state, world.WorldTick, state.StepState, $"replaced by {action.PlanId} v{action.Version}");

			state.PlanId = action.PlanId;
			state.Version = action.Version;
			state.ReserveCash = action.ReserveCash ?? 0;
			state.Steps = steps;
			state.StepIndex = 0;
			state.StepState = "planned";
			state.Paused = false;
			state.PauseReason = null;
			state.ProducerId = 0;
			state.BaselineActorIds.Clear();
			state.DeliveredActorIds.Clear();
			state.LastOrderTick = -1;
			state.LastEvaluationTick = -1;
			state.PlacementCell = null;
			state.LastProgressTick = world.WorldTick;
			state.LastProgressReason = "plan accepted";
			state.BlockedOn = "prerequisites";
			state.PauseSource = null;
			state.LastObservedCash = -1;
			state.LastObservedQueueRemaining = -1;
			state.LastObservedQueueCount = -1;
			Record(state, world.WorldTick, "planned", $"accepted {steps.Count}-step build plan");
		}

		internal static void Validate(State state, AgentAction action, World world)
		{
			ValidatePlanId(action.PlanId);
			if (action.Version < 1)
				throw new InvalidDataException("build-plan version must be at least 1");
			if (action.ReserveCash is < 0 or > MaxReserveCash)
				throw new InvalidDataException($"reserveCash must be between 0 and {MaxReserveCash}");
			if (action.Steps == null || action.Steps.Count is < 1 or > MaxSteps)
				throw new InvalidDataException($"build plan must contain between 1 and {MaxSteps} steps");
			if (state.HasPlan && state.PlanId == action.PlanId && action.Version <= state.Version)
				throw new InvalidDataException($"build plan '{action.PlanId}' version must be greater than {state.Version}");

			foreach (var step in action.Steps)
			{
				if (step == null || string.IsNullOrWhiteSpace(step.Item) ||
					!world.Map.Rules.Actors.TryGetValue(step.Item, out var actorInfo) ||
					actorInfo.TraitInfoOrDefault<BuildableInfo>() == null)
					throw new InvalidDataException($"unknown build-plan item '{step?.Item}'");
				if (step.Count is < 1 or > 5)
					throw new InvalidDataException("build-plan step count must be between 1 and 5");
				if (step.Count != 1 && actorInfo.HasTraitInfo<BuildingInfo>())
					throw new InvalidDataException($"building step '{step.Item}' must have count 1; repeat the step instead");
			}
		}

		internal static void Control(State state, AgentAction action, int worldTick)
		{
			ValidateControl(state, action);

			switch (action.Command)
			{
				case "pause":
					if (!state.Active)
						throw new InvalidDataException($"build plan '{action.PlanId}' is not running");
					if (!state.Paused)
					{
						state.Paused = true;
						state.PauseReason = "paused by commander";
						state.PauseSource = "commander";
						Record(state, worldTick, state.StepState, state.PauseReason);
					}

					break;
				case "resume":
					if (!state.Active)
						throw new InvalidDataException($"build plan '{action.PlanId}' is not running");
					if (!state.Paused)
						throw new InvalidDataException($"build plan '{action.PlanId}' is not paused");
					state.Paused = false;
					state.PauseReason = null;
					state.PauseSource = null;
					MarkProgress(state, worldTick, "resumed by commander");
					Record(state, worldTick, state.StepState, "resumed by commander");
					break;
				case "cancel":
					if (!state.Active)
						throw new InvalidDataException($"build plan '{action.PlanId}' is not running");
					state.Paused = false;
					state.PauseReason = null;
					state.PauseSource = null;
					state.StepState = "cancelled";
					Record(state, worldTick, "cancelled", "cancelled by commander");
					break;
				default:
					throw new InvalidDataException("build-plan command must be pause, resume, or cancel");
			}
		}

		internal static void ValidateControl(State state, AgentAction action)
		{
			ValidatePlanId(action.PlanId);
			if (!state.HasPlan || state.PlanId != action.PlanId || state.Version != action.Version)
				throw new InvalidDataException($"build plan '{action.PlanId}' version {action.Version} is not active");
			if (action.Command is not ("pause" or "resume" or "cancel"))
				throw new InvalidDataException("build-plan command must be pause, resume, or cancel");
		}

		internal static bool AutoPause(State state, int worldTick, string alertKind)
		{
			if (!state.Active || state.Paused)
				return false;

			state.Paused = true;
			state.PauseReason = $"auto-paused by critical alert '{alertKind}'";
			state.PauseSource = "criticalAlert";
			Record(state, worldTick, state.StepState, state.PauseReason);
			return true;
		}

		internal static void Transition(State state, int worldTick, string nextState, string reason)
		{
			if (state.StepState == nextState)
				return;

			state.StepState = nextState;
			MarkProgress(state, worldTick, reason);
			Record(state, worldTick, nextState, reason);
		}

		internal static void Advance(State state, int worldTick)
		{
			state.StepIndex++;
			state.ProducerId = 0;
			state.BaselineActorIds.Clear();
			state.DeliveredActorIds.Clear();
			state.LastOrderTick = -1;
			state.PlacementCell = null;
			state.LastObservedCash = -1;
			state.LastObservedQueueRemaining = -1;
			state.LastObservedQueueCount = -1;
			if (state.StepIndex >= state.Steps.Count)
				Transition(state, worldTick, "completed", "all build-plan steps confirmed");
			else
				Transition(state, worldTick, "planned", $"starting step {state.StepIndex + 1}/{state.Steps.Count}");
		}

		internal static void PauseForFailure(State state, int worldTick, string reason)
		{
			if (!state.Active || state.Paused)
				return;

			state.Paused = true;
			state.PauseReason = reason;
			state.PauseSource = "internalFailure";
			state.BlockedOn = "internalFailure";
			MarkProgress(state, worldTick, "internal failure pause");
			Record(state, worldTick, state.StepState, reason);
		}

		internal static void MarkProgress(State state, int worldTick, string reason)
		{
			state.LastProgressTick = worldTick;
			state.LastProgressReason = reason;
		}

		internal static bool IsProducerReserved(bool active, uint reservedProducerId, uint requestedProducerId)
		{
			return active && reservedProducerId != 0 && reservedProducerId == requestedProducerId;
		}

		internal static bool IsExecutorCancelFirstBatch(bool executorEnabled, IReadOnlyList<AgentAction> actions)
		{
			return executorEnabled && actions != null && actions.Count > 1 &&
				actions[0].Type == "controlBuildPlan" && actions[0].Command == "cancel";
		}

		internal static bool DirectSpendLeavesPlanFloor(int cash, int directSpend, int currentStepCost,
			int reserveCash)
		{
			return (long)cash - directSpend >= (long)currentStepCost + reserveCash;
		}

		internal static bool EmergencyHarvesterAllowed(int requestedCount, bool hasUsableHarvester,
			bool hasQueuedHarvester)
		{
			return requestedCount == 1 && !hasUsableHarvester && !hasQueuedHarvester;
		}

		internal static bool ShouldWatchdogRelease(State state, int worldTick, int stallTicks,
			int internalFailureTicks, out string cause)
		{
			cause = null;
			if (!state.Active || state.PauseSource is "commander" or "criticalAlert")
				return false;

			if (state.Paused)
			{
				if (state.PauseSource != "internalFailure" || state.LastProgressTick < 0 ||
					worldTick - state.LastProgressTick < internalFailureTicks)
					return false;
				cause = "internalFailure";
				return true;
			}

			if (state.LastProgressTick < 0 || worldTick - state.LastProgressTick < stallTicks)
				return false;
			cause = state.BlockedOn ?? "internalFailure";
			return true;
		}

		internal static void WatchdogRelease(State state, int worldTick, string cause)
		{
			if (!state.Active)
				return;

			state.Paused = false;
			state.PauseReason = null;
			state.PauseSource = null;
			state.StepState = "cancelled";
			state.BlockedOn = cause;
			Record(state, worldTick, "cancelled", $"watchdogRelease: {cause}");
		}

		internal static AgentBuildPlanObservation GetObservation(State state)
		{
			if (!state.HasPlan)
				return null;

			var step = state.CurrentStep;
			return new AgentBuildPlanObservation
			{
				Active = state.Active,
				PlanId = state.PlanId,
				Version = state.Version,
				StepIndex = DisplayStepIndex(state),
				TotalSteps = state.Steps.Count,
				CurrentStep = step == null ? null : new AgentBuildPlanStep { Item = step.Item, Count = step.Count },
				State = state.StepState,
				ReserveCash = state.ReserveCash,
				Paused = state.Paused,
				PauseReason = state.PauseReason,
				LastProgressTick = state.LastProgressTick,
				BlockedOn = state.BlockedOn
			};
		}

		internal static AgentBuildPlanEventBatch GetEvents(State state, long sinceSequence)
		{
			return new AgentBuildPlanEventBatch
			{
				LatestSequence = state.NextEventSequence - 1,
				Events = state.Events.Where(e => e.Sequence > sinceSequence).ToList()
			};
		}

		static void ValidatePlanId(string planId)
		{
			if (string.IsNullOrEmpty(planId) || planId.Length > MaxPlanIdLength ||
				planId.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('-' or '_')))
				throw new InvalidDataException($"planId must be 1-{MaxPlanIdLength} ASCII letters, digits, '-' or '_'");
		}

		static void Record(State state, int worldTick, string eventState, string reason)
		{
			var step = state.CurrentStep;
			state.Events.Enqueue(new AgentBuildPlanEvent
			{
				Sequence = state.NextEventSequence++,
				WorldTick = worldTick,
				PlanId = state.PlanId,
				Version = state.Version,
				StepIndex = DisplayStepIndex(state),
				TotalSteps = state.Steps.Count,
				Item = step?.Item,
				State = eventState,
				Reason = reason
			});
			while (state.Events.Count > MaxEvents)
				state.Events.Dequeue();
		}

		static int DisplayStepIndex(State state)
		{
			return state.Steps.Count == 0 ? 0 : System.Math.Min(state.StepIndex + 1, state.Steps.Count);
		}
	}
}
