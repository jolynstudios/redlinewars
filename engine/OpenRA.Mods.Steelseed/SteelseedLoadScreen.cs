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

using OpenRA.Mods.Common.LoadScreens;
using OpenRA.Widgets;

namespace OpenRA.Mods.Steelseed
{
	/// <summary>
	/// Leaves an ordinary no-argument launch idle until the host supplies a generated
	/// map. Explicit benchmark, connection, map, and replay launches retain the stock
	/// load-screen behavior.
	/// </summary>
	public sealed class SteelseedLoadScreen : BlankLoadScreen
	{
		public override void StartGame(Arguments args)
		{
			var launch = new LaunchArguments(args);
			if (!string.IsNullOrEmpty(launch.Benchmark) ||
				launch.GetConnectEndPoint() != null ||
				!string.IsNullOrEmpty(launch.Map) ||
				!string.IsNullOrEmpty(launch.Replay))
			{
				base.StartGame(args);
				return;
			}

			Launch = launch;
			Ui.ResetAll();
			Game.Settings.Save();
		}
	}
}
