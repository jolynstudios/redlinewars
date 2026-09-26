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

// Network session exports for the shipping host, ported from the legacy
// browser host (engine/OpenRA.Browser) so drivers and the session UI can join
// an authoritative OpenRA server through the WebSocket relay. The simulation,
// lobby, slot validation, order serialization, and sync hashing all stay on
// the OpenRA server side (MULTIPLAYER-BOUNDARY.md): these exports only drive
// the connection lifecycle and read back probe strings.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using OpenRA.Network;

namespace OpenRA
{
	[SupportedOSPlatform("browser")]
	public static partial class Program
	{
		static string wsEndpoint;
		static string wsScheme = "ws";

		// Monotonic per-process join counter. Every join stamps its own epoch into
		// the connection probe, so a UI can discard probes that outlive the
		// connection they described (the 250 ms cache can still hold the previous
		// room's probe when a second join starts on the same page).
		static int joinEpoch;

		// Called from Main for the Host.WsEndpoint launch argument; SetWsEndpoint
		// is the runtime path.
		internal static void SetWsEndpointFields(string endpoint, string scheme)
		{
			wsEndpoint = endpoint;
			wsScheme = scheme;
		}


		/// <summary>
		/// Runtime counterpart of the Host.WsEndpoint launch argument: point
		/// future JoinServer calls at an absolute ws/wss URI (typically the
		/// relay mux path for a room). Rebinds Game.ConnectionFactory
		/// immediately so the next join uses the new endpoint.
		/// </summary>
		[JSExport]
		internal static string SetWsEndpoint(string endpoint)
		{
			try
			{
				if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) ||
					(uri.Scheme != Uri.UriSchemeWs && uri.Scheme != Uri.UriSchemeWss))
					return $"invalid endpoint: {endpoint}";

				wsEndpoint = endpoint;
				wsScheme = uri.Scheme;
				Game.ConnectionFactory = target => new BrowserWebSocketConnection(BuildWsUri(target, wsEndpoint, wsScheme));
				return $"endpoint {endpoint}";
			}
			catch (Exception e)
			{
				Console.WriteLine($"[mp] SetWsEndpoint failed: {e.GetType().FullName}: {e.Message}");
				return $"failed: {e.Message}";
			}
		}

		// Pump-facing surface for the JS transport bridge (openra-mp-socket.js).
		// These must live on Program: the JS side holds only exports.OpenRA.Program.
		[JSExport]
		internal static bool MpHasWork() => BrowserWebSocketConnection.MpHasWork();

		[JSExport]
		internal static int MpWorkKind() => BrowserWebSocketConnection.MpWorkKind();

		[JSExport]
		internal static int MpWorkId() => BrowserWebSocketConnection.MpWorkId();

		[JSExport]
		internal static int MpSendLen() => BrowserWebSocketConnection.MpSendLen();

		[JSExport]
		internal static string MpWorkUrl() => BrowserWebSocketConnection.MpWorkUrl();

		[JSExport]
		internal static int MpRecvPtr() => BrowserWebSocketConnection.MpRecvPtr();

		[JSExport]
		internal static int MpRecvCap() => BrowserWebSocketConnection.MpRecvCap();

		[JSExport]
		internal static int MpSendPtr() => BrowserWebSocketConnection.MpSendPtr();

		[JSExport]
		internal static int MpSendCap() => BrowserWebSocketConnection.MpSendCap();

		[JSExport]
		internal static void MpWorkDone() => BrowserWebSocketConnection.MpWorkDone();

		// JS-interop entry points for BrowserWebSocketConnection. They must live on
		// Program (the main assembly's export surface the JS side already holds);
		// BrowserWebSocketConnection.WsOn* do the actual work.
		[JSExport]
		internal static void MpWsOnOpen(int id) => BrowserWebSocketConnection.WsOnOpen(id);
		[JSExport]
		internal static void MpWsOnMessage(int id, int length) => BrowserWebSocketConnection.WsOnMessage(id, length);

		[JSExport]
		internal static void MpWsOnError(int id) => BrowserWebSocketConnection.WsOnError(id);

		[JSExport]
		internal static void MpWsOnClose(int id) => BrowserWebSocketConnection.WsOnClose(id);

		static Uri BuildWsUri(ConnectionTarget target, string endpoint, string scheme)
		{
			if (!string.IsNullOrEmpty(endpoint))
				return new Uri(endpoint, UriKind.Absolute);

			if (scheme != Uri.UriSchemeWs && scheme != Uri.UriSchemeWss)
				throw new ArgumentException($"Unsupported WebSocket scheme '{scheme}'.", nameof(scheme));

			var firstEndpoint = target.FirstEndpoint;
			return new UriBuilder(scheme, firstEndpoint.Host, firstEndpoint.Port).Uri;
		}

		[JSExport]
		internal static string JoinMultiplayer(string host, int port, string password)
		{
			try
			{
				if (Game.ModData == null)
					return "not initialized";

				// Game.JoinServer prefers a still-waiting in-process server
				// (local skirmish) over dialing out; shut it down first so a
				// network join can never be hijacked by the local server.
				Game.CloseServer();
				joinEpoch++;
				Game.JoinServer(new ConnectionTarget(host, port), password ?? "");
				return $"joining {host}:{port} epoch={joinEpoch}";
			}
			catch (Exception e)
			{
				Console.WriteLine($"[mp] JoinMultiplayer failed: {e.GetType().FullName}: {e.Message}\ninner={e.InnerException}\n{e.StackTrace}");
				return $"failed: {e.Message}";
			}
		}

		// Rooms are single-use and OpenRA has no reconnect (L9): Leave tears the
		// OrderManager down and returns to the local session. The server frees the
		// slot as soon as the connection drops.
		[JSExport]
		internal static string LeaveMultiplayer()
		{
			try
			{
				Game.Disconnect();
				return "left";
			}
			catch (Exception e)
			{
				return $"failed: {e.Message}";
			}
		}

		[JSExport]
		internal static string LobbyClaimPlayerSlot()
		{
			try
			{
				var orderManager = Game.OrderManager;
				var localClient = orderManager?.LocalClient;
				if (localClient == null)
					return "not connected";

				if (orderManager.GameStarted)
					return "game already started";

				// Fail closed before touching the lobby: claiming a seat on a server
				// whose map this client cannot load would park the player in a lobby
				// that can never start (a build mismatch in practice — the UI maps
				// this answer to the update-required string). Only when the map is
				// available locally does the claim also send `state NotReady`.
				var lobbyMap = orderManager.LobbyInfo?.GlobalSettings?.Map;
				if (string.IsNullOrEmpty(lobbyMap) ||
					Game.ModData.MapCache[lobbyMap].Status != MapStatus.Available)
					return "map unavailable";

				var slot = localClient.Slot;
				var orders = new List<Order>();
				if (slot == null)
				{
					slot = orderManager.LobbyInfo.FirstEmptySlot();
					if (slot == null)
						return "no open player slot";

					orders.Add(Order.Command($"slot {slot}"));
				}

				// LobbyLogic normally performs this transition when the selected map
				// becomes available. Headless browser clients do not construct that UI.
				if (localClient.State == Session.ClientState.Invalid)
					orders.Add(Order.Command($"state {Session.ClientState.NotReady}"));

				if (orders.Count == 0)
					return $"slot {slot}, state {localClient.State}";

				orderManager.IssueOrders(orders.ToArray());
				return $"claiming slot {slot}, state {Session.ClientState.NotReady}";
			}
			catch (Exception e)
			{
				return $"failed: {e.Message}";
			}
		}

		[JSExport]
		internal static void LobbySetReady()
		{
			Game.OrderManager?.IssueOrder(Order.Command($"state {Session.ClientState.Ready}"));
		}

		// The lobby rule (L8): nobody is auto-readied. The Ready toggle drops back
		// out of Ready with the same order the in-game lobby uses.
		[JSExport]
		internal static void LobbySetNotReady()
		{
			Game.OrderManager?.IssueOrder(Order.Command($"state {Session.ClientState.NotReady}"));
		}

		// LobbyCommands (server trait) parses these as "<name> <args>" command orders,
		// exactly like `state` above. The server validates permissions: a client may
		// change only its own faction/team/color/...; `option` is host (admin) only.
		[JSExport]
		internal static string LobbySetFaction(string factionId)
		{
			var orderManager = Game.OrderManager;
			var client = orderManager?.LocalClient;
			if (client == null)
				return "not connected";
			orderManager.IssueOrder(Order.Command($"faction {client.Index} {factionId}"));
			return $"faction {factionId}";
		}

		[JSExport]
		internal static string LobbySetTeam(int team)
		{
			var orderManager = Game.OrderManager;
			var client = orderManager?.LocalClient;
			if (client == null)
				return "not connected";
			orderManager.IssueOrder(Order.Command($"team {client.Index} {team}"));
			return $"team {team}";
		}

		[JSExport]
		internal static string LobbySetColor(string color)
		{
			var orderManager = Game.OrderManager;
			var client = orderManager?.LocalClient;
			if (client == null)
				return "not connected";
			orderManager.IssueOrder(Order.Command($"color {client.Index} {color}"));
			return $"color {color}";
		}

		[JSExport]
		internal static string LobbySetOption(string optionId, string value)
		{
			var orderManager = Game.OrderManager;
			if (orderManager == null)
				return "not connected";
			orderManager.IssueOrder(Order.Command($"option {optionId} {value}"));
			return $"option {optionId} {value}";
		}
		[JSExport]
		internal static string LobbySetSpawn(int point)
		{
			var orderManager = Game.OrderManager;
			var client = orderManager?.LocalClient;
			if (client == null)
				return "not connected";
			orderManager.IssueOrder(Order.Command($"spawn {client.Index} {point}"));
			return $"spawn {point}";
		}

		// Host-side spawn reassignment: LobbyCommands.Spawn accepts `spawn <client> <point>`
		// from the admin for ANY client, and `clear_spawn <point>` for any occupied point.
		[JSExport]
		internal static string LobbySetSpawnFor(int clientIndex, int point)
		{
			var orderManager = Game.OrderManager;
			if (orderManager?.LocalClient == null)
				return "not connected";
			orderManager.IssueOrder(Order.Command($"spawn {clientIndex} {point}"));
			return $"spawn {clientIndex} {point}";
		}

		// Only targets OCCUPIED points: clearing an EMPTY point would disable it
		// (LobbyCommands.ClearPlayerSpawn toggles DisabledSpawnPoints for empty ones).
		[JSExport]
		internal static string LobbyClearSpawns()
		{
			var orderManager = Game.OrderManager;
			if (orderManager?.LocalClient == null)
				return "not connected";

			var issued = 0;
			foreach (var client in orderManager.LobbyInfo.Clients.Where(c => c.SpawnPoint != 0))
			{
				orderManager.IssueOrder(Order.Command($"clear_spawn {client.SpawnPoint}"));
				issued++;
			}
			return $"cleared {issued} spawns";
		}

		/// <summary>
		/// Per-client session/shroud truth for gates: which player the snapshot
		/// emitter resolves for this client (world.RenderPlayer ?? world.LocalPlayer,
		/// exactly what PollSnapshotToken emits), and the owner relationship of every
		/// actor this client can currently see. With fog on and separated spawns the
		/// enemy count must be zero at match start. See mp-shroudgate.mjs.
		/// </summary>
		[JSExport]
		internal static string GetVisibilityProbe()
		{
			try
			{
			var world = Game.OrderManager?.World;
			if (world == null)
				return "world=null";

			var renderPlayer = world.RenderPlayer;
			var localPlayer = world.LocalPlayer;
			var viewer = renderPlayer ?? localPlayer;
			var tick = world.WorldTick;
			if (viewer == null)
				return $"renderPlayer={renderPlayer?.InternalName ?? "null"} localPlayer={localPlayer?.InternalName ?? "null"} viewer=null netframe={tick}";

			int own = 0, allied = 0, neutral = 0, enemy = 0;
			var enemyDetail = new List<string>();
			foreach (var actor in world.Actors)
			{
				try
				{
					if (actor.IsDead || !actor.IsInWorld || actor.Owner == null)
						continue;

					// Player actors are per-player system actors (not sim units); they
					// have no meaningful visibility and their detail fields NRE. OpenRA
					// names them "player" (case-insensitive in practice).
					if (string.Equals(actor.Info?.Name, "player", StringComparison.OrdinalIgnoreCase))
						continue;

					if (world.FogObscures(actor))
						continue;

					if (actor.Owner == viewer || actor.Owner.IsAlliedWith(viewer))
						own++;
					else if (actor.Owner.NonCombatant)
						neutral++;
					else
						{
							enemy++;
							var eOwner = "<nre>";
							var eInfo = "<nre>";
							var ePos = "<nre>";
							try { eOwner = actor.Owner.InternalName; } catch { }
							try { eInfo = actor.Info?.Name ?? "null-info"; } catch { }
							try { ePos = actor.CenterPosition.ToString(); } catch { }
							enemyDetail.Add($"{eOwner}:{eInfo}@{ePos}");
						}
				}
				catch (Exception)
				{
					// A single torn-down actor must not kill the probe; count nothing.
				}
			}

			var enemyInfo = enemyDetail.Count > 0 ? $" enemyList=[{string.Join("; ", enemyDetail)}]" : "";
			return $"renderPlayer={renderPlayer?.InternalName ?? "null"} localPlayer={localPlayer?.InternalName ?? "null"} " +
				$"viewer={viewer?.InternalName ?? "null"} netframe={tick} own={own} allied={allied} neutral={neutral} enemy={enemy}{enemyInfo}";
			}
			catch (Exception e)
			{
				return $"probe failed: {e.GetType().Name}: {e.Message}";
			}
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

		/// <summary>
		/// Admin closes every still-open UNCLAIMED slot. Used by the shroud gate to
		/// force a two-player match: with all remaining slots closed the two humans
		/// are guaranteed distinct spawn points, so fog must hide the opponent at
		/// match start.
		/// </summary>
		[JSExport]
		internal static string LobbyCloseEmptySlots()
		{
			var orderManager = Game.OrderManager;
			if (orderManager == null)
				return "no order manager";

			if (!orderManager.LobbyInfo.Clients.Any(c => c.IsAdmin))
				return "no admin";

			var closed = 0;
			foreach (var slot in orderManager.LobbyInfo.Slots)
			{
				if (slot.Value.Closed || orderManager.LobbyInfo.ClientInSlot(slot.Key) != null)
					continue;

				orderManager.IssueOrder(Order.Command($"slot_close {slot.Key}"));
				closed++;
			}
			return $"closed {closed} slots";
		}

		/// <summary>
		/// Admin closes open UNCLAIMED slots until open + occupied seats equals
		/// <paramref name="seats"/> — the room's advertised seat count. The lobby
		/// rule (L8): when the admin handover happens mid-lobby the room must not
		/// stay bigger than the room browser advertised, so the new admin shrinks
		/// it (same `slot_close` orders as LobbyCloseEmptySlots, counted down).
		/// </summary>
		[JSExport]
		internal static string LobbyCloseSlotsDownTo(int seats)
		{
			var orderManager = Game.OrderManager;
			if (orderManager == null)
				return "no order manager";

			if (!orderManager.LobbyInfo.Clients.Any(c => c.IsAdmin))
				return "no admin";

			var occupied = orderManager.LobbyInfo.Clients.Count(c => c.Slot != null);
			var open = orderManager.LobbyInfo.Slots
				.Where(s => !s.Value.Closed && orderManager.LobbyInfo.ClientInSlot(s.Key) == null)
				.Select(s => s.Key)
				.ToList();
			var excess = open.Count - Math.Max(0, seats - occupied);
			var closed = 0;
			foreach (var slot in open)
			{
				if (closed >= excess)
					break;

				orderManager.IssueOrder(Order.Command($"slot_close {slot}"));
				closed++;
			}
			return $"closed {closed} slots";
		}

		/// <summary>
		/// Per-player list for the bottom-left session HUD: name, connection
		/// quality (Good/Moderate/Poor — the server pings every 5s and broadcasts
		/// SyncConnectionQuality), lobby state (Disconnected marks a dropped
		/// player), bot flag and admin flag. Read-only; drives the player panel.
		/// </summary>
		[JSExport]
		internal static string GetLobbyPlayersProbe()
		{
			try
			{
				var orderManager = Game.OrderManager;
				if (orderManager?.LobbyInfo == null)
					return "lobby=null";

				// Per-client fields beyond the original player-panel format are appended at
				// hex (exactly what OpenRA renders and what LobbyCommands `color` parses
				// back through FieldLoader), team, and spawn point (0 = unassigned/random).
				var entries = orderManager.LobbyInfo.Clients.Select(c =>
					$"{c.Name}|bot:{(c.Bot != null)}|{c.State}|q:{c.ConnectionQuality}|ms:{c.PingMs}|admin:{c.IsAdmin}|slot:{c.Slot ?? "none"}" +
					$"|idx:{c.Index}|faction:{c.Faction}|color:{c.Color}|team:{c.Team}|spawn:{c.SpawnPoint}");
				return $"started={orderManager.GameStarted} clients=[{string.Join(";;", entries)}]";
			}
			catch (Exception e)
			{
				return $"probe failed: {e.GetType().Name}: {e.Message}";
			}
		}

		[JSExport]
		internal static string GetConnectionProbe()
		{
			try
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
				$"clientstate={clientState} admin={isAdmin} slot={slot} faction={faction} epoch={joinEpoch}";
			}
			catch (Exception e)
			{
				return $"probe failed: {e.GetType().Name}: {e.Message}";
			}
		}

		[JSExport]
		internal static string SetPlayerName(string name)
		{
			try
			{
				Game.Settings.Player.Name = name;
				Game.Settings.Save();
				return $"name {Game.Settings.Player.Name}";
			}
			catch (Exception e)
			{
				return $"failed: {e.Message}";
			}
		}

		[JSExport]
		internal static string GetServerErrorProbe()
		{
			return Game.OrderManager?.ServerError ?? "none";
		}

		/// <summary>
		/// World tick and sync hash as one atomic string so tick and hash cannot be
		/// read from either side of a tick boundary. Pairwise equality between two
		/// clients at the same tick is the desync gate.
		/// </summary>
		[JSExport]
		internal static string GetSyncProbe()
		{
			var world = Game.OrderManager?.World;
			if (world == null)
				return "tick=- hash=- world=null";

			return $"tick={world.WorldTick} hash={unchecked((uint)world.SyncHash())}";
		}

		[JSExport]
		internal static bool IsRunning()
		{
			return Game.State == RunStatus.Running;
		}

		[JSExport]
		internal static int GetNetFrame()
		{
			// Game.NetFrameNumber throws before an OrderManager exists.
			try
			{
				return Game.NetFrameNumber;
			}
			catch (NullReferenceException)
			{
				return -1;
			}
		}
	}
}
