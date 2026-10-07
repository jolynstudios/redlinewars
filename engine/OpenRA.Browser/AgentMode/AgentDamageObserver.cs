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

using OpenRA.Mods.Common.Traits;
using OpenRA.Traits;

namespace OpenRA.Browser
{
	[TraitLocation(SystemActors.Player)]
	sealed class AgentDamageObserverInfo : TraitInfo
	{
		public override object Create(ActorInitializer init) { return new AgentDamageObserver(); }
	}

	sealed class AgentDamageObserver : INotifyDamage, INotifyKilled
	{
		void INotifyDamage.Damaged(Actor self, AttackInfo e)
		{
			if (e.Damage.Value > 0)
				AgentModeHost.NotifyDamage(self, e.Attacker);
		}

		void INotifyKilled.Killed(Actor self, AttackInfo e)
		{
			AgentModeHost.NotifyKilled(self);
		}
	}
}
