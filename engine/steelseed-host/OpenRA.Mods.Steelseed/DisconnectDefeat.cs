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

namespace OpenRA.Mods.Steelseed
{
	[TraitLocation(SystemActors.World)]
	public sealed class DisconnectDefeatInfo : TraitInfo<DisconnectDefeat> { }

	/// <summary>
	/// A player whose connection drops mid-match is defeated outright, in 1v1 as
	/// well as 1vN: their objectives fail exactly like a surrender, no bot takes
	/// the slot over, and the remaining players keep playing under the normal
	/// win/objective conditions (the last player standing wins).
	/// </summary>
	public sealed class DisconnectDefeat : INotifyPlayerDisconnected
	{
		void INotifyPlayerDisconnected.PlayerDisconnected(Actor self, Player p)
		{
			// Already decided players (defeated or victorious) and objective-less
			// spectators must not be touched; ForceDefeat is idempotent but the
			// guard keeps the announcement feed honest.
			if (p.WinState != WinState.Undefined || !p.HasObjectives)
				return;

			p.PlayerActor.TraitOrDefault<MissionObjectives>()?.ForceDefeat(p);
		}
	}
}
