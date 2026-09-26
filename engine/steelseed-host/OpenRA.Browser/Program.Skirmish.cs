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

using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using OpenRA.Mods.Common.Traits;
using OpenRA.Network;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA
{
	[SupportedOSPlatform("browser")]
	public static partial class Program
	{
		const int SkirmishSchemaVersion = 1;

		static SessionStatus sessionStatus = new("idle", "not-started", "No skirmish has been started.");
		// Bumped per StartSkirmish so a stale lobby-wait handler can never issue orders.
		static int startGeneration;

		sealed record SessionStatus(string Status, string Code, string UserMessage);

		[JSExport]
		internal static string GetSkirmishCatalog()
		{
			try
			{
				if (Game.ModData == null)
					return ErrorJson("not-initialized", "The Red Alert runtime is not initialized.");

				var speeds = Game.ModData.GetOrCreate<GameSpeeds>();
				var maps = Game.ModData.MapCache
					.Where(m => m.Status == MapStatus.Available)
					.OrderBy(m => m.Title, StringComparer.Ordinal)
					.ThenBy(m => m.Uid, StringComparer.Ordinal)
					.Select(MapCatalogEntry)
					.ToArray();

				var catalog = new SkirmishCatalogDto(
					SkirmishSchemaVersion,
					new EngineDto("ra", "7eabcfe1c9fc3ad5f510227496cfc2766c07f5fb"),
					new SessionTransportsDto(
						new TransportSupportDto(true),
						new TransportSupportDto(true, "available", "directory:/rooms")),
					speeds.DefaultSpeed,
					speeds.Speeds.Select(pair => new GameSpeedDto(
						pair.Key,
						FluentProvider.GetMessage(pair.Value.Name),
						pair.Value.Timestep,
						pair.Value.OrderLatency)).ToArray(),
					maps);
				return JsonSerializer.Serialize(catalog, SkirmishJsonContext.Default.SkirmishCatalogDto);
			}
			catch (Exception e)
			{
				return ErrorJson("catalog-failed", $"Could not load the skirmish catalog: {e.Message}");
			}
		}

		static MapCatalogDto MapCatalogEntry(MapPreview map)
		{
			var factions = map.WorldActorInfo.TraitInfos<FactionInfo>()
				.Where(f => f.Selectable)
				.Select(f => new FactionDto(
					f.InternalName,
					map.GetMessage(f.Name),
					f.Side,
					f.Description == null ? null : map.GetMessage(f.Description)))
				.ToArray();

			var bots = map.PlayerActorInfo.TraitInfos<IBotInfo>()
				.Select(b => new BotDto(b.Type, map.GetMessage(b.Name)))
				.ToArray();

			var options = MapOptions(map).Values
				.OrderBy(o => o.DisplayOrder)
				.ThenBy(o => o.Id, StringComparer.Ordinal)
				.Select(o => new LobbyOptionDto(
					o.Id,
					o.Name,
					o.Description,
					o.Values.Select(v => new OptionValueDto(v.Key, v.Value)).ToArray(),
					o.DefaultValue,
					o.IsLocked,
					o.IsVisible,
					o.DisplayOrder))
				.ToArray();

			var colorManager = map.WorldActorInfo.TraitInfo<IColorPickerManagerInfo>();
			var colors = colorManager.PresetColors.Select(ColorHex).ToArray();

			return new MapCatalogDto(
				map.Uid,
				map.Title,
				map.Author,
				map.TileSet,
				new MapBoundsDto(map.Bounds.X, map.Bounds.Y, map.Bounds.Width, map.Bounds.Height),
				map.SpawnPoints.Select((p, i) => new SpawnPointDto(i + 1, p.X, p.Y)).ToArray(),
				map.Players.Players
					.Where(p => p.Value.Playable)
					.Select(p => new SlotCatalogDto(
						p.Key,
						p.Value.Required,
						p.Value.AllowBots,
						new SlotLocksDto(
							p.Value.LockFaction,
							p.Value.LockColor,
							p.Value.LockTeam,
							p.Value.LockSpawn),
						new SlotDefaultsDto(
							p.Value.Faction,
							ColorHex(p.Value.Color),
							p.Value.Team,
							p.Value.Spawn)))
					.ToArray(),
				factions,
				bots,
				colors,
				options);
		}

		static Dictionary<string, LobbyOption> MapOptions(MapPreview map)
		{
			var result = new Dictionary<string, LobbyOption>(StringComparer.Ordinal);
			foreach (var option in map.PlayerActorInfo.TraitInfos<ILobbyOptions>()
				.Concat(map.WorldActorInfo.TraitInfos<ILobbyOptions>())
				.SelectMany(t => t.LobbyOptions(map)))
				result[option.Id] = option;

			return result;
		}

		[JSExport]
		internal static string ValidateSkirmish(string configJson)
		{
			try
			{
				var config = JsonSerializer.Deserialize(configJson, SkirmishJsonContext.Default.StartConfig)
					?? throw new StartError("invalid-json", "The skirmish configuration is empty.");
				var (map, normalizedSlots) = ValidateStartConfig(config);
				_ = BuildPlayerOrders(config, map, normalizedSlots, _ => 0).ToArray();
				return SerializeStatus("valid", "valid", $"Configuration for {map.Title} is valid.");
			}
			catch (StartError e)
			{
				return ErrorJson(e.Code, e.Message);
			}
			catch (JsonException e)
			{
				return ErrorJson("invalid-json", $"The skirmish configuration is invalid: {e.Message}");
			}
			catch (Exception e)
			{
				return ErrorJson("validation-failed", $"The skirmish configuration could not be validated: {e.Message}");
			}
		}

		[JSExport]
		internal static string StartSkirmish(string configJson)
		{
			try
			{
				var config = JsonSerializer.Deserialize(configJson, SkirmishJsonContext.Default.StartConfig)
					?? throw new StartError("invalid-json", "The skirmish configuration is empty.");
				var (map, normalizedSlots) = ValidateStartConfig(config);
				var slotOrders = BuildSlotOrders(config, map, normalizedSlots);

				if (Game.OrderManager?.World != null)
					Game.Disconnect();

				sessionStatus = new("loading", "starting", $"Loading {map.Title}.");
				Game.Settings.Debug.ServerRandomSeed = config.RandomSeed;
				// CreateAndStartLocalServer subscribes its own LobbyInfoChanged handler
				// that issues slotOrders on the FIRST lobby sync. Subscribing ours AFTER
				// it (both in subscription order and in time) guarantees stage-1 is in
				// the server queue before our handler can ever issue stage-2 — otherwise
				// `state Ready` outruns the `option` commands and the match starts with
				// every lobby option at its default.
				Game.CreateAndStartLocalServer(map.Uid, slotOrders);
				IssuePlayerOrdersWhenBotsFill(config, map, normalizedSlots);
				return SessionStatusJson();
			}
			catch (StartError e)
			{
				sessionStatus = new("error", e.Code, e.Message);
				return SessionStatusJson();
			}
			catch (JsonException e)
			{
				sessionStatus = new("error", "invalid-json", $"The skirmish configuration is invalid: {e.Message}");
				return SessionStatusJson();
			}
			catch (Exception e)
			{
				sessionStatus = new("error", "start-failed", $"The skirmish could not start: {e.Message}");
				return SessionStatusJson();
			}
		}


		// Client indexes come from the server, not from us: ChooseFreePlayerIndex is a
		// monotonic counter over every client the server process ever admitted, so on a
		// reused lobby process a predicted 1..N mapping addresses the wrong bots and
		// team/faction orders silently drop (multi-bot matches collapse to one enemy).
		// Wait until the lobby reports a client in every bot slot, then address each
		// slot by the index the server actually assigned.
		static void IssuePlayerOrdersWhenBotsFill(StartConfig config, MapPreview map, Dictionary<string, SlotConfig> slots)
		{
			var botSlots = slots.Values.Where(s => s.Kind == "bot").Select(s => s.Slot).ToHashSet(StringComparer.Ordinal);
			var generation = ++startGeneration;
			var startedAt = DateTime.UtcNow;

			void LobbyBotsReady()
			{
				if (generation != startGeneration)
				{
					Game.LobbyInfoChanged -= LobbyBotsReady;
					return;
				}
				try
				{
					var om = Game.OrderManager;
					if (om?.LobbyInfo == null)
						return;
					// The LOCAL slot must be claimed too: this handler fires on the same lobby
					// sync that carries the slot orders we just issued, and a botless match
					// passes the bot check on that first sync while the local client is
					// still not in its slot — ClientInSlot would throw and kill the start.
					if (om.LobbyInfo.ClientInSlot(config.Local.Slot) == null ||
						botSlots.Any(slot => om.LobbyInfo.ClientInSlot(slot) == null))
					{
						if (DateTime.UtcNow - startedAt > TimeSpan.FromSeconds(15))
						{
							Game.LobbyInfoChanged -= LobbyBotsReady;
							sessionStatus = new("error", "lobby-bots-timeout", "Lobby slots never appeared.");
						}
						return;
					}
					Game.LobbyInfoChanged -= LobbyBotsReady;
					int ClientIndexForSlot(string slot) => om.LobbyInfo.ClientInSlot(slot).Index;
					foreach (var order in BuildPlayerOrders(config, map, slots, ClientIndexForSlot))
						om.IssueOrder(order);
				}
				catch (Exception e)
				{
					Game.LobbyInfoChanged -= LobbyBotsReady;
					sessionStatus = new("error", "start-failed", $"The skirmish could not start: {e.Message}");
				}
			}

			Game.LobbyInfoChanged += LobbyBotsReady;
		}

		[JSExport]
		internal static string GetSessionStatus()
		{
			if (sessionStatus.Status == "loading" && Game.OrderManager?.World != null)
				sessionStatus = new("running", "running", "Skirmish is running.");

			return SessionStatusJson();
		}

		static (MapPreview Map, Dictionary<string, SlotConfig> Slots) ValidateStartConfig(StartConfig config)
		{
			if (config.SchemaVersion != SkirmishSchemaVersion)
				throw new StartError("unsupported-schema", $"Expected schemaVersion {SkirmishSchemaVersion}.");
			if (!string.Equals(config.Transport, "local", StringComparison.Ordinal))
				throw new StartError("unsupported-transport", "Only the local skirmish transport is available in this release.");
			if (string.IsNullOrWhiteSpace(config.MapUid))
				throw new StartError("missing-map", "Choose a skirmish map.");

			var map = Game.ModData?.MapCache.FirstOrDefault(m => m.Status == MapStatus.Available && m.Uid == config.MapUid)
				?? throw new StartError("unknown-map", "The selected skirmish map is not available.");
			var playable = map.Players.Players.Where(p => p.Value.Playable).ToDictionary(p => p.Key, p => p.Value, StringComparer.Ordinal);
			if (config.Local == null || !playable.TryGetValue(config.Local.Slot, out _))
				throw new StartError("invalid-human-slot", "Choose one playable slot for the local player.");

			var slots = new Dictionary<string, SlotConfig>(StringComparer.Ordinal);
			foreach (var entry in config.Slots ?? [])
			{
				if (entry == null || !playable.ContainsKey(entry.Slot))
					throw new StartError("invalid-slot", $"Unknown skirmish slot '{entry?.Slot}'.");
				if (!slots.TryAdd(entry.Slot, entry))
					throw new StartError("duplicate-slot", $"Slot '{entry.Slot}' is configured more than once.");
				if (entry.Slot == config.Local.Slot && entry.Kind != "human")
					throw new StartError("human-slot-conflict", $"Slot '{entry.Slot}' must be configured as human.");
				if (entry.Kind is not ("human" or "bot" or "open" or "closed"))
					throw new StartError("invalid-slot-kind", $"Slot '{entry.Slot}' has invalid kind '{entry.Kind}'.");
			}

			if (!slots.TryGetValue(config.Local.Slot, out var humanSlot))
				slots.Add(config.Local.Slot, new SlotConfig { Slot = config.Local.Slot, Kind = "human" });
			else if (humanSlot.Kind != "human")
				throw new StartError("human-slot-conflict", $"Slot '{config.Local.Slot}' must be configured as human.");

			foreach (var slot in playable.Keys)
				if (!slots.ContainsKey(slot))
					slots.Add(slot, new SlotConfig { Slot = slot, Kind = "open" });

			if (slots.Values.Count(s => s.Kind == "human") != 1)
				throw new StartError("human-count", "A local skirmish requires exactly one human slot.");

			var factions = map.WorldActorInfo.TraitInfos<FactionInfo>().Where(f => f.Selectable).Select(f => f.InternalName).ToHashSet(StringComparer.Ordinal);
			var bots = map.PlayerActorInfo.TraitInfos<IBotInfo>().Select(b => b.Type).ToHashSet(StringComparer.Ordinal);
			ValidatePlayerFields(config.Local.Slot, config.Local.Faction, config.Local.Color,
				config.Local.Team, config.Local.Spawn, playable, factions, map.SpawnPoints.Length);
			foreach (var slot in slots.Values.Where(s => s.Kind == "bot"))
			{
				if (!playable[slot.Slot].AllowBots)
					throw new StartError("bot-not-allowed", $"Slot '{slot.Slot}' does not allow bots.");
				if (string.IsNullOrEmpty(slot.BotType) || !bots.Contains(slot.BotType))
					throw new StartError("unknown-bot", $"Slot '{slot.Slot}' has an unknown bot type.");
				ValidatePlayerFields(slot.Slot, slot.Faction, slot.Color, slot.Team, slot.Spawn,
					playable, factions, map.SpawnPoints.Length);
			}

			foreach (var required in playable.Where(p => p.Value.Required))
				if (slots[required.Key].Kind is "open" or "closed")
					throw new StartError("required-slot-empty", $"Required slot '{required.Key}' must be occupied.");

			var selectedSpawns = new HashSet<int>();
			void AddSpawn(int spawn, string slot)
			{
				if (spawn != 0 && !selectedSpawns.Add(spawn))
					throw new StartError("duplicate-spawn", $"Spawn {spawn} is selected by more than one player (including '{slot}').");
			}

			var localReference = playable[config.Local.Slot];
			AddSpawn(localReference.LockSpawn ? localReference.Spawn : config.Local.Spawn, config.Local.Slot);
			foreach (var slot in slots.Values.Where(s => s.Kind == "bot"))
			{
				var reference = playable[slot.Slot];
				AddSpawn(reference.LockSpawn ? reference.Spawn : slot.Spawn, slot.Slot);
			}

			var speeds = Game.ModData.GetOrCreate<GameSpeeds>();
			config.GameSpeed ??= speeds.DefaultSpeed;
			if (!speeds.Speeds.ContainsKey(config.GameSpeed))
				throw new StartError("invalid-game-speed", $"Unknown game speed '{config.GameSpeed}'.");

			var options = MapOptions(map);
			foreach (var option in config.Options ?? [])
			{
				if (!options.TryGetValue(option.Key, out var descriptor))
					throw new StartError("unknown-option", $"Unknown lobby option '{option.Key}'.");
				if (descriptor.IsLocked && option.Value != descriptor.DefaultValue)
					throw new StartError("locked-option", $"Lobby option '{option.Key}' is locked.");
				if (!descriptor.Values.ContainsKey(option.Value))
					throw new StartError("invalid-option-value", $"Invalid value '{option.Value}' for lobby option '{option.Key}'.");
			}

			return (map, slots);
		}

		static void ValidatePlayerFields(string slot, string faction, string color, int team, int spawn,
			Dictionary<string, PlayerReference> playable, HashSet<string> factions, int spawnCount)
		{
			var pr = playable[slot];
			if (!pr.LockFaction && (string.IsNullOrEmpty(faction) || !factions.Contains(faction)))
				throw new StartError("invalid-faction", $"Slot '{slot}' has an invalid faction.");
			if (!pr.LockColor && color != null && !Color.TryParse(NormalizeColorToken(color), out _))
				throw new StartError("invalid-color", $"Slot '{slot}' has an invalid color.");
			if (!pr.LockTeam && (team < 0 || team > MapPlayers.MaximumPlayerCount))
				throw new StartError("invalid-team", $"Slot '{slot}' has an invalid team.");
			if (!pr.LockSpawn && (spawn < 0 || spawn > spawnCount))
				throw new StartError("invalid-spawn", $"Slot '{slot}' has an invalid spawn.");
		}

		/// <summary>
		/// Lobby-structure commands only: claim the local slot, create/close/open bot
		/// slots and set lobby options. Client indexes are assigned by the server
		/// (Session.ServerSettings lobby, monotonic ChooseFreePlayerIndex) and are NOT
		/// predictable on a reused server process, so player-field orders are built
		/// separately in <see cref="BuildPlayerOrders"/> once the lobby reports the
		/// clients the server actually created.
		/// </summary>
		static IEnumerable<Order> BuildSlotOrders(StartConfig config, MapPreview map, Dictionary<string, SlotConfig> slots)
		{
			var result = new List<Order> { Order.Command($"slot {config.Local.Slot}") };
			if (!string.IsNullOrWhiteSpace(config.Local.Name))
				result.Add(Order.Command($"name {SafeCommandText(config.Local.Name, "player name")}"));

			foreach (var slot in map.Players.Players.Keys.Where(slots.ContainsKey))
			{
				var entry = slots[slot];
				switch (entry.Kind)
				{
					case "bot":
						result.Add(Order.Command($"slot_bot {entry.Slot} 0 {entry.BotType}"));
						break;
					case "closed":
						result.Add(Order.Command($"slot_close {entry.Slot}"));
						break;
					case "open":
						result.Add(Order.Command($"slot_open {entry.Slot}"));
						break;
				}
			}

			foreach (var option in config.Options ?? [])
				result.Add(Order.Command($"option {SafeToken(option.Key)} {SafeToken(option.Value)}"));
			result.Add(Order.Command($"option gamespeed {SafeToken(config.GameSpeed)}"));
			return result;
		}

		static List<Order> BuildPlayerOrders(StartConfig config, MapPreview map, Dictionary<string, SlotConfig> slots,
			Func<string, int> clientIndexForSlot)
		{
			var result = new List<Order>();
			AddPlayerOrders(result, clientIndexForSlot(config.Local.Slot), config.Local.Slot, config.Local.Faction, config.Local.Color,
				config.Local.Team, config.Local.Spawn, map.Players.Players[config.Local.Slot]);
			foreach (var entry in slots.Values.Where(s => s.Kind == "bot"))
				AddPlayerOrders(result, clientIndexForSlot(entry.Slot), entry.Slot, entry.Faction, entry.Color,
					entry.Team, entry.Spawn, map.Players.Players[entry.Slot]);

			result.Add(Order.Command($"state {Session.ClientState.Ready}"));
			return result;
		}

		static void AddPlayerOrders(List<Order> orders, int clientIndex, string slot, string faction,
			string color, int team, int spawn, PlayerReference reference)
		{
			if (!reference.LockFaction)
				orders.Add(Order.Command($"faction {clientIndex} {SafeToken(faction)}"));
			if (!reference.LockColor && color != null)
				orders.Add(Order.Command($"color {clientIndex} {SafeToken(NormalizeColorToken(color))}"));
			if (!reference.LockTeam)
				orders.Add(Order.Command($"team {clientIndex} {team}"));
			if (!reference.LockSpawn)
				orders.Add(Order.Command($"spawn {clientIndex} {spawn}"));
		}

		static string SafeToken(string value)
		{
			if (string.IsNullOrEmpty(value) || value.Any(char.IsWhiteSpace))
				throw new StartError("invalid-command-token", "A skirmish option contains invalid whitespace.");

			return value;
		}

		static string SafeCommandText(string value, string label)
		{
			if (value.Contains('\n') || value.Contains('\r'))
				throw new StartError("invalid-command-text", $"The {label} contains a line break.");

			return value;
		}

		static string NormalizeColorToken(string value) => value?.StartsWith('#') == true ? value[1..] : value;

		static string ColorHex(Color color) => $"#{color.R:X2}{color.G:X2}{color.B:X2}{color.A:X2}";

		static string SessionStatusJson() => SerializeStatus(
			sessionStatus.Status, sessionStatus.Code, sessionStatus.UserMessage);

		static string ErrorJson(string code, string message) => SerializeStatus("error", code, message);

		static string SerializeStatus(string status, string code, string userMessage) => JsonSerializer.Serialize(
			new SessionStatusDto(SkirmishSchemaVersion, status, code, userMessage),
			SkirmishJsonContext.Default.SessionStatusDto);

		public sealed class StartError : Exception
		{
			public string Code { get; }

			public StartError(string code, string message)
				: base(message)
			{
				Code = code;
			}
		}
	}
}
