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

using System.IO;
using System.Linq;
using System.Runtime.InteropServices.JavaScript;
using OpenRA.Network;

namespace OpenRA
{
	// Test-only introspection exports for the Playwright harness. These surface
	// on globalThis.ora next to the product exports in Program.cs and must never
	// mutate game state beyond what a player could do through the UI.
	public static partial class Program
	{
		[JSExport]
		internal static string GetSelectionProbe()
		{
			var world = Game.OrderManager?.World;
			if (world == null)
				return "no world";

			var actors = world.Selection.Actors.Where(a => !a.IsDead).ToArray();
			var types = string.Join(",", actors.Select(a => a.Info.Name).Distinct().Order());
			return $"count={actors.Length} types=[{types}]";
		}

		[JSExport]
		internal static string GetOwnedActorScreenPos(string actorType)
		{
			var world = Game.OrderManager?.World;
			var worldRenderer = Game.WorldRenderer;
			if (world == null || worldRenderer == null)
				return "no world";

			if (world.LocalPlayer == null)
				return "no local player";

			var actor = world.Actors.FirstOrDefault(a =>
				a.Owner == world.LocalPlayer && a.Info.Name == actorType && a.IsInWorld && !a.IsDead);
			if (actor == null)
				return $"no actor: {actorType}";

			var viewPx = worldRenderer.Viewport.WorldToViewPx(worldRenderer.ScreenPxPosition(actor.CenterPosition));
			return $"{viewPx.X},{viewPx.Y}";
		}

		[JSExport]
		internal static bool HasReplayFile()
		{
			var replays = Path.Combine(Platform.SupportDir, "Replays");
			return Directory.Exists(replays)
				&& Directory.EnumerateFiles(replays, "*.orarep", SearchOption.AllDirectories).Any();
		}

		[JSExport]
		internal static string GetReplayProbe()
		{
			var orderManager = Game.OrderManager;
			if (orderManager == null)
				return "no order manager";

			// During replay playback the recorded sync hashes are compared against
			// the local simulation each frame; IsOutOfSync latches on any mismatch.
			return $"netframe={orderManager.NetFrameNumber} outofsync={orderManager.IsOutOfSync} " +
				$"started={orderManager.GameStarted}";
		}

		[JSExport]
		internal static string GetConnectionProbe()
		{
			var orderManager = Game.OrderManager;
			if (orderManager?.Connection == null)
				return "no connection";

			var state = orderManager.Connection is NetworkConnection network
				? network.ConnectionState.ToString()
				: "local";

			var localClient = orderManager.LocalClient;
			var clientState = localClient?.State.ToString() ?? "none";
			var isAdmin = localClient?.IsAdmin ?? false;

			var slot = localClient?.Slot ?? "observer";
			var faction = localClient?.Faction ?? "none";

			return $"state={state} clientid={orderManager.Connection.LocalClientId} " +
				$"clients={orderManager.LobbyInfo.Clients.Count} netframe={orderManager.NetFrameNumber} " +
				$"started={orderManager.GameStarted} outofsync={orderManager.IsOutOfSync} " +
				$"clientstate={clientState} admin={isAdmin} slot={slot} faction={faction}";
		}

		[JSExport]
		internal static string GetServerErrorProbe()
		{
			return Game.OrderManager?.ServerError ?? "none";
		}

		[JSExport]
		internal static void LobbySetReady()
		{
			Game.OrderManager?.IssueOrder(Order.Command($"state {Session.ClientState.Ready}"));
		}

		[JSExport]
		internal static void LobbyStartGame()
		{
			Game.OrderManager?.IssueOrder(Order.Command("startgame"));
		}

		[JSExport]
		internal static string LobbyAddBots()
		{
			var orderManager = Game.OrderManager;
			if (orderManager == null)
				return "no order manager";

			var admin = orderManager.LobbyInfo.Clients.FirstOrDefault(c => c.IsAdmin);
			if (admin == null)
				return "no admin";

			var added = 0;
			foreach (var slot in orderManager.LobbyInfo.Slots)
			{
				if (slot.Value.Closed || !slot.Value.AllowBots || orderManager.LobbyInfo.ClientInSlot(slot.Key) != null)
					continue;

				orderManager.IssueOrder(Order.Command($"slot_bot {slot.Key} {admin.Index} normal"));
				added++;
			}

			return $"added {added} bots";
		}

		[JSExport]
		internal static string GetPlayerNameProbe()
		{
			return Game.Settings?.Player.Name ?? "no settings";
		}

		[JSExport]
		internal static string SetPlayerNameProbe(string name)
		{
			if (Game.Settings == null)
				return "no settings";

			Game.Settings.Player.Name = name;
			Game.Settings.Save();
			return Game.Settings.Player.Name;
		}

		[JSExport]
		internal static string GetViewportProbe()
		{
			var worldRenderer = Game.WorldRenderer;
			if (worldRenderer == null)
				return "no world";

			var center = worldRenderer.Viewport.CenterLocation;
			var zoom = worldRenderer.Viewport.Zoom;
			return $"center={(int)center.X},{(int)center.Y} zoom={zoom:0.###}";
		}
	}
}
