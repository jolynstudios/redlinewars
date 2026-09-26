using System;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using OpenRA;
using OpenRA.FileFormats;
using OpenRA.Network;
using OpenRA.Platforms.Browser;
using OpenRA.Mods.Common.Traits;

namespace OpenRA.Steelseed.RankedReplayVerifier;

public static class Program
{
	static readonly FieldInfo OrderManagerField = typeof(Game).GetField("OrderManager", BindingFlags.NonPublic | BindingFlags.Static);
	static readonly MethodInfo LogicTickMethod = typeof(Game).GetMethod("LogicTick", BindingFlags.NonPublic | BindingFlags.Static);

	public static int Main(string[] args)
	{
		var inspectionRequested = args.Contains("--inspect");
		try
		{
			var options = Parse(args);
			if (options.Inspect)
				return EmitAndExit(Inspect(options), 0);
			var result = Verify(options);
			return EmitAndExit(result, result.Status == "settled" ? 0 : 2);
		}
		catch (Exception e)
		{
			// Inspection is an explicit local release-tool mode and may expose a
			// diagnostic stack. Production verification remains type-only.
			var detail = inspectionRequested ? e.ToString() : e.GetType().Name;
			return EmitAndExit(new ReceiptResult { Status = "void", Reason = "verifier-error", Detail = detail }, 2);
		}
	}

	// The OpenRA hosted runtime owns background services whose graceful game-client
	// disconnect path can wait indefinitely after a replay has already produced its
	// result.  This verifier is a one-shot subprocess, so flush the sole contract
	// output and terminate it deterministically.  The parent also enforces a hard
	// timeout, but successful verification must not consume that failure budget.
	static int EmitAndExit<T>(T value, int code)
	{
		Console.WriteLine(JsonSerializer.Serialize(value));
		Console.Out.Flush();
		Environment.Exit(code);
		return code;
	}

	static Options Parse(string[] args)
	{
		string Value(string name)
		{
			var index = Array.IndexOf(args, name);
			if (index < 0 || index + 1 >= args.Length || string.IsNullOrWhiteSpace(args[index + 1]))
				throw new ArgumentException($"missing {name}");
			return args[index + 1];
		}

		var inspect = args.Contains("--inspect");
		return new Options(Value("--replay"), inspect ? null : Value("--claim"), args.Contains("--engine-dir") ? Value("--engine-dir") : null,
			args.Contains("--support-dir") ? Value("--support-dir") : Path.Combine(Path.GetTempPath(), "steelseed-ranked-verifier"), inspect);
	}

	// Development/release gate helper: derive the canonical effective lobby
	// settings hash from a real replay. Production verification never calls
	// this path and still requires an independently pinned claim/hash.
	static InspectionResult Inspect(Options options)
	{
		var metadata = ReplayMetadata.Read(options.Replay);
		if (metadata?.GameInfo == null)
			throw new InvalidDataException("invalid replay");

		Directory.CreateDirectory(options.SupportDir);
		Game.PlatformFactory = _ => new NullPlatform();
		ObjectCreator.RegisterAssembly(typeof(OpenRA.Mods.Common.Traits.Mobile).Assembly);
		ObjectCreator.RegisterAssembly(Assembly.Load(new AssemblyName("OpenRA.Mods.Cnc")));
		ObjectCreator.RegisterAssembly(typeof(OpenRA.Mods.Steelseed.SteelseedLoadScreen).Assembly);
		var engineDir = options.EngineDir ?? Environment.GetEnvironmentVariable("REDLINE_ENGINE_DIR") ?? Directory.GetCurrentDirectory();
		var generatedMods = Path.Combine(engineDir, "steelseed-host", "generated", "mods");
		var modSearchPaths = Directory.Exists(generatedMods) ? generatedMods : Path.Combine(engineDir, "mods");
		var stepper = Game.InitializeHosted([
			$"Engine.EngineDir={engineDir}", $"Engine.ModSearchPaths={modSearchPaths}", $"Engine.SupportDir={options.SupportDir}", "Game.Mod=ra",
			$"Launch.Replay={Path.GetFullPath(options.Replay)}", "Graphics.DisableHardwareCursors=True",
			"Graphics.WindowedSize=640,480", "Game.EnableDiscordService=false", "Server.DiscoverNatDevices=false"]);

		var initializedOrderManager = (OrderManager)OrderManagerField.GetValue(null);
		ReplayConnection replay = initializedOrderManager?.Connection as ReplayConnection;
		for (var i = 0; i < 10000; i++)
		{
			if (replay?.LobbyInfo != null)
				break;
			var orderManager = (OrderManager)OrderManagerField.GetValue(null);
			if (orderManager?.LastTickTime != null)
				orderManager.LastTickTime.Value = Game.RunTime - 1000;
			stepper.StepUntilIdle(() => Game.RunTime, 4);
			orderManager = (OrderManager)OrderManagerField.GetValue(null);
			if (orderManager?.Connection is ReplayConnection ready && ready.LobbyInfo != null)
				replay = ready;
		}
		if (replay?.LobbyInfo == null)
			throw new InvalidDataException("replay lobby is unavailable");

		return new InspectionResult
		{
			MapUid = metadata.GameInfo.MapUid,
			Version = metadata.GameInfo.Version,
			RulesHash = EffectiveSettingsHash(replay.LobbyInfo),
			Clients = replay.LobbyInfo.Clients.Where(c => c.Slot != null && c.Bot == null)
				.OrderBy(c => c.Index).Select(c => new InspectionClient
				{
					ClientIndex = c.Index, Seat = SeatFromSlot(c.Slot), Team = c.Team,
					Slot = c.Slot, SpawnPoint = c.SpawnPoint, Handicap = c.Handicap,
				}).ToArray(),
		};
	}

	static ReceiptResult Verify(Options options)
	{
		var claim = JsonDocument.Parse(File.ReadAllText(options.Claim)).RootElement;
		if (!claim.TryGetProperty("simBuild", out var simBuildElement) || !claim.TryGetProperty("mapUid", out var mapElement) ||
			!claim.TryGetProperty("rulesHash", out var rulesElement))
			return Void("invalid-claim");
		var simBuild = simBuildElement.GetString();
		var mapUid = mapElement.GetString();
		var rulesHash = rulesElement.GetString();
		if (string.IsNullOrWhiteSpace(simBuild) || string.IsNullOrWhiteSpace(mapUid) || string.IsNullOrWhiteSpace(rulesHash))
			return Void("invalid-claim");

		var metadata = ReplayMetadata.Read(options.Replay);
		if (metadata?.GameInfo == null)
			return Void("invalid-replay");
		if (!string.Equals(metadata.GameInfo.MapUid, mapUid, StringComparison.Ordinal))
			return Void("wrong-map");
		if (!metadata.GameInfo.Version.EndsWith("-" + simBuild, StringComparison.Ordinal))
			return Void("wrong-build");
		if (!string.Equals(Environment.GetEnvironmentVariable("REDLINE_RANKED_RULES_HASH"), rulesHash, StringComparison.Ordinal))
			return Void("wrong-rules");

		var facts = ReplayFacts.Read(options.Replay);
		if (facts.Corrupt)
			return Void("invalid-replay");

		Directory.CreateDirectory(options.SupportDir);
		Game.PlatformFactory = _ => new NullPlatform();
		ObjectCreator.RegisterAssembly(typeof(OpenRA.Mods.Common.Traits.Mobile).Assembly);
		ObjectCreator.RegisterAssembly(Assembly.Load(new AssemblyName("OpenRA.Mods.Cnc")));
		ObjectCreator.RegisterAssembly(typeof(OpenRA.Mods.Steelseed.SteelseedLoadScreen).Assembly);
		var engineDir = options.EngineDir ?? Environment.GetEnvironmentVariable("REDLINE_ENGINE_DIR") ?? Directory.GetCurrentDirectory();
		var generatedMods = Path.Combine(engineDir, "steelseed-host", "generated", "mods");
		var modSearchPaths = Directory.Exists(generatedMods) ? generatedMods : Path.Combine(engineDir, "mods");
		var stepper = Game.InitializeHosted([
			$"Engine.EngineDir={engineDir}", $"Engine.ModSearchPaths={modSearchPaths}", $"Engine.SupportDir={options.SupportDir}", "Game.Mod=ra",
			$"Launch.Replay={Path.GetFullPath(options.Replay)}", "Graphics.DisableHardwareCursors=True",
			"Graphics.WindowedSize=640,480", "Game.EnableDiscordService=false", "Server.DiscoverNatDevices=false"]);

		var finalTick = metadata.GameInfo.FinalGameTick;
		World world = null;
		OrderManager orderManager = null;
		var maxTicks = Math.Max(10000, finalTick + 10000);
		var replayClock = Game.RunTime;
		for (var i = 0; i < maxTicks; i++)
		{
			orderManager = (OrderManager)OrderManagerField.GetValue(null);
			if (orderManager?.LastTickTime != null)
				orderManager.LastTickTime.Value = Game.RunTime - 1000;
			// Hosted replay verification has no desktop/browser event loop to move
			// the scheduler clock forward.  Drive exactly the normal GameStepper
			// logic with a monotonic synthetic clock. Both scheduler layers must
			// advance: mutating LastTickTime alone previously replayed only one tick.
			replayClock += 1000;
			stepper.StepUntilIdle(() => replayClock, 4);
			world = orderManager?.World;
			if (orderManager?.IsOutOfSync == true)
				return Void("desync");
			if (world != null && PlayablePlayers(world).Length >= 2 &&
				PlayablePlayers(world).All(p => p.WinState is WinState.Won or WinState.Lost))
				break;
			// Older/abnormally finalized server replays can carry FinalGameTick=0.
			// Never treat that sentinel as an authoritative playback bound: the
			// retained order stream is still the source of truth for termination.
			if (finalTick > 0 && world != null && orderManager.LocalFrameNumber > finalTick + 100)
				break;
		}

		var players = world == null ? [] : PlayablePlayers(world);
		if (world == null || players.Length < 2 || players.Any(p => p.WinState is not (WinState.Won or WinState.Lost)) ||
			orderManager?.IsOutOfSync == true)
		{
			if (Environment.GetEnvironmentVariable("REDLINE_RANKED_DIAGNOSTICS") == "1")
				Console.Error.WriteLine($"incomplete: state={Game.State} metadataFinal={finalTick} local={orderManager?.LocalFrameNumber} net={orderManager?.NetFrameNumber} world={world?.WorldTick} players={string.Join(',', players.Select(p => $"{p.ClientIndex}:{p.WinState}"))} factsExpected={facts.ExpectedPlayerCount} surrender={facts.SurrenderFrame} disconnects={string.Join(',', facts.DisconnectFrames.Select(p => $"{p.Key}:{p.Value}"))}");
			return Void("incomplete");
		}
		if (orderManager.Connection is not ReplayConnection replay || replay.LobbyInfo == null)
			return Void("invalid-replay");
		if (!string.Equals(EffectiveSettingsHash(replay.LobbyInfo), rulesHash, StringComparison.Ordinal))
			return Void("wrong-rules");
		if (replay.LobbyInfo.GlobalSettings.OptionOrDefault("cheats", false))
			return Void("wrong-rules");
		if (!ClaimsBindLobby(claim, replay.LobbyInfo))
			return Void("roster-unbound");
		// A surrender order determines the terminal outcome when the engine replay
		// subsequently reaches matching Won/Lost states. GameOver itself is delayed,
		// so clients leaving after that order but before the UI delay expires must not
		// be misclassified as a double-disconnect. Without surrender, retain the
		// engine's terminal world tick as the causality boundary.
		var decisiveFrame = facts.SurrenderFrame ?? world.WorldTick;
		var preTerminalDisconnects = facts.DisconnectFrames.Where(pair => pair.Value <= decisiveFrame).Select(pair => pair.Key).Distinct().Count();
		if (preTerminalDisconnects >= 2)
			return Void("both-disconnected");
		if (players.Length != facts.ExpectedPlayerCount)
			return Void("roster-unbound");
		return new ReceiptResult
		{
			Status = "settled",
			TerminationReason = facts.SurrenderFrame is int surrenderFrame && surrenderFrame <= world.WorldTick ? "surrender" :
				preTerminalDisconnects == 1 ? "disconnect-forfeit" : "gameover",
			FinalTick = world.WorldTick,
			Players = players.Select(p => new ReceiptPlayer { ClientIndex = p.ClientIndex, Outcome = p.WinState == WinState.Won ? "won" : "lost", DisconnectFrame = facts.DisconnectFrames.TryGetValue(p.ClientIndex, out var frame) ? frame : null, Surrendered = facts.SurrenderClients.Contains(p.ClientIndex) }).ToArray(),
		};
	}

	static Player[] PlayablePlayers(World world) => world.Players.Where(p => p.Playable && !p.NonCombatant).ToArray();

	static string EffectiveSettingsHash(Session lobby)
	{
		var options = lobby.GlobalSettings.LobbyOptions.OrderBy(k => k.Key, StringComparer.Ordinal)
			.ToDictionary(k => k.Key, v => new { Value = v.Value.Value ?? "", v.Value.IsLocked }, StringComparer.Ordinal);
		// ClientIndex is transport-assigned and deliberately excluded: the claim
		// binds it separately after the server handshake. RandomSeed is likewise
		// generated for the room and recorded in the replay, not a lobby rule that
		// can be pre-issued by the account service.
		var clients = lobby.Clients.Where(c => c.Slot != null && c.Bot == null)
			.OrderBy(c => c.Slot, StringComparer.Ordinal).ThenBy(c => c.Team).ThenBy(c => c.SpawnPoint)
			.Select(c => new { c.Slot, c.Team, c.SpawnPoint, c.Handicap, c.Faction }).ToArray();
		var effective = new
		{
			map = lobby.GlobalSettings.Map,
			mapStatus = lobby.GlobalSettings.MapStatus,
			gameTimestep = lobby.GlobalSettings.GameTimestep,
			netFrameInterval = lobby.GlobalSettings.NetFrameInterval,
			allowSpectators = lobby.GlobalSettings.AllowSpectators,
			enableSingleplayer = lobby.GlobalSettings.EnableSingleplayer,
			enableMapGeneration = lobby.GlobalSettings.EnableMapGeneration,
			enableGameSaves = lobby.GlobalSettings.EnableGameSaves,
			enableSyncReports = lobby.GlobalSettings.EnableSyncReports,
			options,
			clients,
			disabledSpawnPoints = lobby.DisabledSpawnPoints.OrderBy(i => i).ToArray(),
		};
		var json = JsonSerializer.Serialize(effective);
		return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json))).ToLowerInvariant();
	}

	static int? SeatFromSlot(string slot)
	{
		if (string.IsNullOrWhiteSpace(slot))
			return null;

		var prefix = slot.StartsWith("Multi", StringComparison.OrdinalIgnoreCase) ||
			slot.StartsWith("Player", StringComparison.OrdinalIgnoreCase) ||
			slot.StartsWith("Slot", StringComparison.OrdinalIgnoreCase);
		var digit = slot.IndexOfAny(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
		if (!prefix || digit < 0 || !int.TryParse(slot.AsSpan(digit), out var zeroBased))
			return null;

		return zeroBased + 1;
	}

	static bool ClaimsBindLobby(JsonElement claim, Session lobby)
	{
		if (!claim.TryGetProperty("participants", out var participants) || participants.ValueKind != JsonValueKind.Array)
			return false;

		var expected = new Dictionary<int, (int Seat, int Team)>();
		foreach (var participant in participants.EnumerateArray())
		{
			if (!participant.TryGetProperty("clientIndex", out var index) || !participant.TryGetProperty("seat", out var seat) ||
				!participant.TryGetProperty("team", out var team) || !index.TryGetInt32(out var clientIndex) ||
				!seat.TryGetInt32(out var claimedSeat) || !team.TryGetInt32(out var claimedTeam) ||
				!expected.TryAdd(clientIndex, (claimedSeat, claimedTeam)))
				return false;
		}

		var playable = lobby.Clients.Where(c => c.Slot != null && c.Bot == null).ToArray();
		if (playable.Length < 2 || playable.Length != expected.Count || lobby.Clients.Any(c => c.Bot != null))
			return false;

		foreach (var client in playable)
		{
			if (!expected.TryGetValue(client.Index, out var claimBinding) || SeatFromSlot(client.Slot) != claimBinding.Seat || client.Team != claimBinding.Team)
				return false;
		}

		return true;
	}

	static ReceiptResult Void(string reason) => new() { Status = "void", Reason = reason };

	sealed record Options(string Replay, string Claim, string EngineDir, string SupportDir, bool Inspect);

	sealed class InspectionResult
	{
		public string MapUid { get; init; }
		public string Version { get; init; }
		public string RulesHash { get; init; }
		public InspectionClient[] Clients { get; init; } = [];
	}

	sealed class InspectionClient
	{
		public int ClientIndex { get; init; }
		public int? Seat { get; init; }
		public int Team { get; init; }
		public string Slot { get; init; }
		public int SpawnPoint { get; init; }
		public int Handicap { get; init; }
	}

	sealed class ReceiptResult
	{
		public string Status { get; init; }
		public string Reason { get; init; }
		public string Detail { get; init; }
		public string TerminationReason { get; init; }
		public int FinalTick { get; init; }
		public ReceiptPlayer[] Players { get; init; } = [];
	}

	sealed class ReceiptPlayer
	{
		public int ClientIndex { get; init; }
		public string Outcome { get; init; }
		public int? DisconnectFrame { get; init; }
		public bool Surrendered { get; init; }
	}

	sealed class ReplayFacts
	{
		public bool Corrupt { get; private set; }
		public bool Surrender { get; private set; }
		public int? SurrenderFrame { get; private set; }
		public int ExpectedPlayerCount { get; private set; }
		public HashSet<int> DisconnectClients { get; } = [];
		public Dictionary<int, int> DisconnectFrames { get; } = [];
		public HashSet<int> SurrenderClients { get; } = [];

		public static ReplayFacts Read(string path)
		{
			var facts = new ReplayFacts();
			var meta = ReplayMetadata.Read(path);
			facts.ExpectedPlayerCount = meta?.GameInfo.Players.Count(p => p.IsHuman || p.IsBot) ?? 0;
			try
			{
				using var stream = File.OpenRead(path);
				using var reader = new BinaryReader(stream);
				while (stream.Position < stream.Length)
				{
					var client = reader.ReadInt32();
					if (client == ReplayMetadata.MetaStartMarker) break;
					var length = reader.ReadInt32();
					if (length < 4 || length > 16 * 1024 * 1024 || stream.Position + length > stream.Length) throw new InvalidDataException();
					var packet = reader.ReadBytes(length);
					if (packet.Length != length) throw new EndOfStreamException();
					if (OrderIO.TryParseDisconnect((client, packet), out var disconnect))
					{
						facts.DisconnectClients.Add(disconnect.ClientId);
						facts.DisconnectFrames[disconnect.ClientId] = disconnect.Frame;
					}
					else if (OrderIO.TryParseOrderPacket(packet, out var parsed))
						foreach (var order in parsed.Orders.GetOrders(null))
							if (order.OrderString == "Surrender")
							{
								facts.Surrender = true;
								facts.SurrenderFrame = facts.SurrenderFrame is int existing ? Math.Min(existing, parsed.Frame) : parsed.Frame;
								if (client != 0) facts.SurrenderClients.Add(client);
							}
				}
			}
			catch { facts.Corrupt = true; }
			return facts;
		}
	}
}
