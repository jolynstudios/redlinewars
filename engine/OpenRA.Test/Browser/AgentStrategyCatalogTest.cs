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

using NUnit.Framework;
using OpenRA.Browser;

namespace OpenRA.Test
{
	// R4 dead-strategies honesty invariant: the advertised/selectable catalog must
	// match the implemented doctrine programs one-for-one, and no card may abort into
	// a card that has no program. These are compile-time constants, so no World is needed.
	[TestFixture]
	sealed class AgentStrategyCatalogTest
	{
		[Test]
		public void EveryAdvertisedCardIsBound()
		{
			foreach (var strategyId in AgentStrategyCatalog.StrategyIds)
				Assert.That(AgentDoctrineProgram.TryGet(strategyId, out _), Is.True,
					$"advertised card '{strategyId}' has no compiled doctrine program (would Bind to Bound=false)");
		}

		[Test]
		public void EveryProgramIsAdvertised()
		{
			foreach (var programId in AgentDoctrineProgram.ProgramIds)
				Assert.That(AgentStrategyCatalog.Entries.ContainsKey(programId), Is.True,
					$"doctrine program '{programId}' is not advertised in the catalog");
		}

		[Test]
		public void NoAbortSuggestionDangles()
		{
			foreach (var programId in AgentDoctrineProgram.ProgramIds)
			{
				Assert.That(AgentDoctrineProgram.TryGet(programId, out var program), Is.True);
				var abort = program.AbortSuggestStrategyId;
				if (string.IsNullOrEmpty(abort))
					continue;

				Assert.That(abort, Is.Not.EqualTo(programId),
					$"program '{programId}' aborts into itself");
				Assert.That(AgentDoctrineProgram.TryGet(abort, out _), Is.True,
					$"program '{programId}' aborts into unbound card '{abort}'");
			}
		}
	}
}
