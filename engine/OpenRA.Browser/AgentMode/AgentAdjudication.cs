#region Copyright & License Information
/*
 * Copyright (c) The OpenRA Developers and Contributors
 * This file is part of OpenRA, which is free software. It is made
 * available under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. For more information, see COPYING.
 */
#endregion

using System;

namespace OpenRA.Browser
{
	/// <summary>
	/// Pure, symmetric adjudication for unresolved benchmark-lockstep games. Telemetry collection and
	/// calibrated component floors live outside this class; callers provide only frozen raw values and floors.
	/// </summary>
	static class AgentAdjudication
	{
		internal const double DrawBand = 0.10;

		const double LivePowerWeight = 0.25;
		const double StructuresWeight = 0.20;
		const double EconomyWeight = 0.20;
		const double UnitValueWeight = 0.15;
		const double TechWeight = 0.10;
		const double RegionControlWeight = 0.10;

		internal enum TerminalOutcome
		{
			Unresolved,
			SideAWin,
			SideBWin
		}

		internal enum Verdict
		{
			SideA,
			Draw,
			SideB
		}

		internal readonly record struct Components(
			double LiveHpAdjustedPower,
			double StructuresByValue,
			double Economy,
			double UnitReplacementValue,
			double Tech,
			double RegionControl);

		internal readonly record struct ComponentFloors(
			double LiveHpAdjustedPower,
			double StructuresByValue,
			double Economy,
			double UnitReplacementValue,
			double Tech,
			double RegionControl);

		internal readonly record struct Result(double Score, Verdict Verdict, bool TerminalOverride);

		internal static Result Evaluate(Components sideA, Components sideB, ComponentFloors floors,
			TerminalOutcome terminalOutcome = TerminalOutcome.Unresolved)
		{
			if (terminalOutcome == TerminalOutcome.SideAWin)
				return new Result(1.0, Verdict.SideA, true);
			if (terminalOutcome == TerminalOutcome.SideBWin)
				return new Result(-1.0, Verdict.SideB, true);
			if (terminalOutcome != TerminalOutcome.Unresolved)
				throw new ArgumentOutOfRangeException(nameof(terminalOutcome), terminalOutcome, "unknown terminal outcome");

			ValidateComponents(sideA, nameof(sideA));
			ValidateComponents(sideB, nameof(sideB));
			ValidateFloors(floors);

			var score =
				LivePowerWeight * Margin(sideA.LiveHpAdjustedPower, sideB.LiveHpAdjustedPower,
					floors.LiveHpAdjustedPower) +
				StructuresWeight * Margin(sideA.StructuresByValue, sideB.StructuresByValue,
					floors.StructuresByValue) +
				EconomyWeight * Margin(sideA.Economy, sideB.Economy, floors.Economy) +
				UnitValueWeight * Margin(sideA.UnitReplacementValue, sideB.UnitReplacementValue,
					floors.UnitReplacementValue) +
				TechWeight * Margin(sideA.Tech, sideB.Tech, floors.Tech) +
				RegionControlWeight * Margin(sideA.RegionControl, sideB.RegionControl, floors.RegionControl);

			score = Math.Clamp(score, -1.0, 1.0);
			var verdict = Math.Abs(score) < DrawBand ? Verdict.Draw : score > 0 ? Verdict.SideA : Verdict.SideB;
			return new Result(score, verdict, false);
		}

		static double Margin(double sideA, double sideB, double floor)
		{
			var denominator = Math.Max(sideA + sideB, floor);
			return Math.Clamp((sideA - sideB) / denominator, -1.0, 1.0);
		}

		static void ValidateComponents(Components components, string parameterName)
		{
			ValidateComponent(components.LiveHpAdjustedPower, parameterName);
			ValidateComponent(components.StructuresByValue, parameterName);
			ValidateComponent(components.Economy, parameterName);
			ValidateComponent(components.UnitReplacementValue, parameterName);
			ValidateComponent(components.Tech, parameterName);
			ValidateComponent(components.RegionControl, parameterName);
		}

		static void ValidateComponent(double value, string parameterName)
		{
			if (!double.IsFinite(value) || value < 0)
				throw new ArgumentOutOfRangeException(parameterName, value,
					"adjudication component values must be finite and non-negative");
		}

		static void ValidateFloors(ComponentFloors floors)
		{
			ValidateFloor(floors.LiveHpAdjustedPower);
			ValidateFloor(floors.StructuresByValue);
			ValidateFloor(floors.Economy);
			ValidateFloor(floors.UnitReplacementValue);
			ValidateFloor(floors.Tech);
			ValidateFloor(floors.RegionControl);
		}

		static void ValidateFloor(double floor)
		{
			if (!double.IsFinite(floor) || floor <= 0)
				throw new ArgumentOutOfRangeException(nameof(floor), floor,
					"adjudication component floors must be finite and positive");
		}
	}
}
