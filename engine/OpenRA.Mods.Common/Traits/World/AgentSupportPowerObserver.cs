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
using System.Linq;
using OpenRA.Network;
using OpenRA.Traits;

namespace OpenRA.Mods.Common.Traits
{
	[TraitLocation(SystemActors.World)]
	[Desc("Records accepted support-power orders for the browser agent situation feed.")]
	public sealed class AgentSupportPowerObserverInfo : TraitInfo<AgentSupportPowerObserver> { }

	public sealed class AgentSupportPowerObserver : IValidateOrder
	{
		const int MaxEvents = 64;

		public sealed class Launch
		{
			public long Sequence { get; init; }
			public int WorldTick { get; init; }
			public int OwnerClientIndex { get; init; }
			public string OrderName { get; init; }
			public CPos TargetCell { get; init; }
		}

		readonly Queue<Launch> launches = [];
		long nextSequence;

		public bool OrderValidation(OrderManager orderManager, World world, int clientId, Order order)
		{
			var owner = order.Subject?.Owner;
			var manager = order.Subject?.TraitOrDefault<SupportPowerManager>();
			var ownerClient = owner == null ? null : orderManager.LobbyInfo.ClientWithIndex(owner.ClientIndex);
			var authorized = ownerClient != null && (clientId == owner.ClientIndex ||
				(ownerClient.Bot != null && clientId == ownerClient.BotControllerClientIndex));
			if (!authorized || manager == null || order.Target.Type == TargetType.Invalid ||
				!manager.Powers.TryGetValue(order.OrderString, out var power) || !power.Ready)
				return true;

			launches.Enqueue(new Launch
			{
				Sequence = ++nextSequence,
				WorldTick = world.WorldTick,
				OwnerClientIndex = owner.ClientIndex,
				OrderName = order.OrderString,
				TargetCell = world.Map.CellContaining(order.Target.CenterPosition)
			});
			while (launches.Count > MaxEvents)
				launches.Dequeue();

			return true;
		}

		public IReadOnlyList<Launch> Since(long sequence)
		{
			return launches.Where(launch => launch.Sequence > sequence)
				.OrderBy(launch => launch.Sequence).ToArray();
		}
	}
}
