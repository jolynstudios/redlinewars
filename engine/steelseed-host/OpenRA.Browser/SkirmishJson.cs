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
using System.Text.Json.Serialization;

namespace OpenRA
{
	sealed class StartConfig
	{
		public int SchemaVersion { get; set; }
		public string Transport { get; set; } = "local";
		public string MapUid { get; set; }
		public string GameSpeed { get; set; }
		public int? RandomSeed { get; set; }
		public HumanConfig Local { get; set; }
		public List<SlotConfig> Slots { get; set; } = [];
		public Dictionary<string, string> Options { get; set; } = [];
	}

	sealed class HumanConfig
	{
		public string Slot { get; set; }
		public string Name { get; set; } = "Commander";
		public string Faction { get; set; } = "Random";
		public string Color { get; set; }
		public int Team { get; set; }
		public int Spawn { get; set; }
	}

	sealed class SlotConfig
	{
		public string Slot { get; set; }
		public string Kind { get; set; } = "open";
		public string BotType { get; set; }
		public string Faction { get; set; } = "Random";
		public string Color { get; set; }
		public int Team { get; set; }
		public int Spawn { get; set; }
	}

	sealed record EngineDto(string Mod, string UpstreamCommit);
	sealed record TransportSupportDto(bool Supported, string Status = null, string Discovery = null);
	sealed record SessionTransportsDto(TransportSupportDto Local, TransportSupportDto Network);
	sealed record GameSpeedDto(string Id, string Name, int Timestep, int OrderLatency);
	sealed record MapBoundsDto(int X, int Y, int Width, int Height);
	sealed record SpawnPointDto(int Id, int X, int Y);
	sealed record SlotLocksDto(bool Faction, bool Color, bool Team, bool Spawn);
	sealed record SlotDefaultsDto(string Faction, string Color, int Team, int Spawn);
	sealed record SlotCatalogDto(string Id, bool Required, bool AllowBots, SlotLocksDto Locks, SlotDefaultsDto Defaults);
	sealed record FactionDto(string Id, string Name, string Side, string Description);
	sealed record BotDto(string Id, string Name);
	sealed record OptionValueDto(string Id, string Label);
	sealed record LobbyOptionDto(
		string Id,
		string Name,
		string Description,
		OptionValueDto[] Values,
		string DefaultValue,
		bool IsLocked,
		bool IsVisible,
		int DisplayOrder);
	sealed record MapCatalogDto(
		string Uid,
		string Title,
		string Author,
		string TileSet,
		MapBoundsDto Bounds,
		SpawnPointDto[] SpawnPoints,
		SlotCatalogDto[] Slots,
		FactionDto[] Factions,
		BotDto[] Bots,
		string[] Colors,
		LobbyOptionDto[] Options);
	sealed record SkirmishCatalogDto(
		int SchemaVersion,
		EngineDto Engine,
		SessionTransportsDto SessionTransports,
		string DefaultGameSpeed,
		GameSpeedDto[] GameSpeeds,
		MapCatalogDto[] Maps);
	sealed record SessionStatusDto(int SchemaVersion, string Status, string Code, string UserMessage);
	sealed record SupportPowerDto(
		string Key,
		string Title,
		bool Active,
		bool Ready,
		int RemainingTicks,
		int TotalTicks,
		bool NeedsSource,
		int BeaconTicks,
		string BeaconUnit,
		int BeaconRangeCells,
		int EffectTicks);
	sealed record SupportPowerTimerDto(
		string Key,
		string Title,
		int Player,
		string PlayerName,
		string Color,
		bool Allied,
		bool Ready,
		bool Active,
		int RemainingTicks,
		int TotalTicks,
		string LaunchText,
		string IncomingText);
	sealed record SupportLaunchDto(
		int Id,
		string Key,
		int Player,
		bool Allied,
		int Tick,
		string Text,
		int TargetX,
		int TargetY,
		int BeaconTicks);
	sealed record SupportPowersDto(int SchemaVersion, int TimestepMs, int PowerOutageTicks, int PowerOutageTotalTicks,
		SupportPowerDto[] Powers, SupportPowerTimerDto[] Timers, SupportLaunchDto[] Launches, uint[] Revealed);
	[JsonSerializable(typeof(SupportPowersDto))]

	[JsonSourceGenerationOptions(
		PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
		PropertyNameCaseInsensitive = true,
		DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
	[JsonSerializable(typeof(StartConfig))]
	[JsonSerializable(typeof(SkirmishCatalogDto))]
	[JsonSerializable(typeof(SessionStatusDto))]
	internal sealed partial class SkirmishJsonContext : JsonSerializerContext { }
}
