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

using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using OpenRA.Browser;

namespace OpenRA
{
	[SupportedOSPlatform("browser")]
	public static partial class Program
	{
		[JSExport]
		internal static string StartAgentMatch(string mapUid, string configJson)
		{
			return AgentModeHost.StartMatch(mapUid, configJson);
		}

		[JSExport]
		internal static string PrepareAgentMatch(string mapUid, string configJson)
		{
			return AgentModeHost.PrepareMatch(mapUid, configJson);
		}

		[JSExport]
		internal static string LaunchPreparedAgentMatch(string matchId)
		{
			return AgentModeHost.LaunchPreparedMatch(matchId);
		}

		[JSExport]
		internal static string GetAgentObservation(string agentId, int sinceSequence)
		{
			return AgentModeHost.GetObservation(agentId, sinceSequence);
		}

		[JSExport]
		internal static string GetAgentDecisionDue(string agentId)
		{
			return AgentModeHost.GetDecisionDue(agentId);
		}

		[JSExport]
		internal static string SubmitAgentActions(string agentId, string actionsJson)
		{
			return AgentModeHost.SubmitActions(agentId, actionsJson);
		}

		[JSExport]
		internal static string SetAgentDecisionRequestState(string agentId, int decisionId, bool inFlight)
		{
			return AgentModeHost.SetDecisionRequestState(agentId, decisionId, inFlight);
		}

		[JSExport]
		internal static string RecordAgentDecisionFailure(string agentId, string requestJson)
		{
			return AgentModeHost.RecordDecisionFailure(agentId, requestJson);
		}

		[JSExport]
		internal static string StageAgentPlanningActions(string agentId, string batchJson)
		{
			return AgentModeHost.StagePlanningActions(agentId, batchJson);
		}

		[JSExport]
		internal static string SubmitAgentFallback(string agentId, string requestJson)
		{
			return AgentModeHost.SubmitFallback(agentId, requestJson);
		}

		[JSExport]
		internal static string GetAgentLockstepBarrier()
		{
			return AgentModeHost.GetLockstepBarrier();
		}

		[JSExport]
		internal static string CommitAgentLockstepBarrier(string requestJson)
		{
			return AgentModeHost.CommitLockstepBarrier(requestJson);
		}

		[JSExport]
		internal static string AbortAgentLockstepBarrier(string requestJson)
		{
			return AgentModeHost.AbortLockstepBarrier(requestJson);
		}

		[JSExport]
		internal static string GetAgentReflexEvents(string agentId, int sinceSequence)
		{
			return AgentModeHost.GetReflexEvents(agentId, sinceSequence);
		}

		[JSExport]
		internal static string GetAgentBuildPlanEvents(string agentId, int sinceSequence)
		{
			return AgentModeHost.GetBuildPlanEvents(agentId, sinceSequence);
		}

		[JSExport]
		internal static string GetAgentMissionEvents(string agentId, int sinceSequence)
		{
			return AgentModeHost.GetMissionEvents(agentId, sinceSequence);
		}

		[JSExport]
		internal static string GetAgentStrategyEvents(string agentId, int sinceSequence)
		{
			return AgentModeHost.GetStrategyEvents(agentId, sinceSequence);
		}

		[JSExport]
		internal static string GetAgentMatchState()
		{
			return AgentModeHost.GetMatchState();
		}

		[JSExport]
		internal static string RecordAgentSpend(string agentId, double spentUsd, double spendCapUsd)
		{
			return AgentModeHost.RecordSpend(agentId, spentUsd, spendCapUsd);
		}

		[JSExport]
		internal static string StopAgentMatch()
		{
			return AgentModeHost.StopMatch();
		}

		[JSExport]
		internal static string GetAgentActionSchema()
		{
			return AgentModeHost.GetActionSchema();
		}

		[JSExport]
		internal static string GetAgentContractManifest()
		{
			return AgentModeHost.GetContractManifest();
		}

		[JSExport]
		internal static string RecordAgentTelemetry(string telemetryJson)
		{
			return AgentModeHost.RecordReplayTelemetry(telemetryJson);
		}
	}
}
