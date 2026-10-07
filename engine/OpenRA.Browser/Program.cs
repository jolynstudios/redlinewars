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
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using OpenRA.Browser;
using OpenRA.Network;
using OpenRA.Platforms.Browser;
using StbTrueTypeSharp;

namespace OpenRA
{
	[SupportedOSPlatform("browser")]
	public static partial class Program
	{
		static GameStepper stepper;
		static bool exploreMap;
		static string hostBaseUrl;
		static readonly List<long> TickDurations = [];

		readonly record struct FontSmokeExpectation(
			string FontName,
			string FontPath,
			int Size,
			string MetricsSha256,
			string RasterSha256);

		readonly record struct FontSmokeGlyph(
			int Advance,
			int OffsetX,
			int OffsetY,
			int Width,
			int Height,
			byte[] Data);

		static readonly int[] FontSmokeCodepoints =
		[
			.. Enumerable.Range(0x20, 0x7F - 0x20),
			.. Enumerable.Range(0xA0, 0xE0 - 0xA0),
			.. Enumerable.Range(0x391, 0x3AA - 0x391),
			.. Enumerable.Range(0x410, 0x420 - 0x410)
		];

		static readonly FontSmokeExpectation[] FontSmokeExpectations =
		[
			new("FreeSans", "/openra/engine/mods/common/FreeSans.ttf", 12,
				"14ac23bfed6405796eb7194e43a4833bf4d17b7c73879f58e1038a393d10a954",
				"e60ee55c8068b2aa56fe445d55312077123e914ef03af4ea33b6b23b68d1ca13"),
			new("FreeSans", "/openra/engine/mods/common/FreeSans.ttf", 16,
				"4f9d52e6f717017dd59f049588ecaf6d3349aa226d0d7a16c50571e3afcaa124",
				"0ee668c56e52173280e826fc39827251185a000d38697950d97f05fba18229a2"),
			new("FreeSans", "/openra/engine/mods/common/FreeSans.ttf", 24,
				"ca0fad3c0b22b08c1ec96f56473af1a33e242c2dcca3624a180674887567bebb",
				"17d0b6d044fdc5b9926fff00e8ffb35ded027a4eab7d75142a295f427cbf18f3"),
			new("FreeSansBold", "/openra/engine/mods/common/FreeSansBold.ttf", 12,
				"31c79661c8b12712b37bc512b241635b4a555c2008517bad145864e45b47775e",
				"d160b047a6a21810b048c2b6e2c68ac5024bd41c10c6f6a2e9664defdf51b669"),
			new("FreeSansBold", "/openra/engine/mods/common/FreeSansBold.ttf", 16,
				"0176587513e5ea9dfed0da5bbfa5e73e3860dc8af520abce50bc1fe17583bb32",
				"17bb4f37ee0036ef56818705e077fea95ce5cf4598cce7d5e0160bfc70c7bb47"),
			new("FreeSansBold", "/openra/engine/mods/common/FreeSansBold.ttf", 24,
				"4dfd97cec273e880eee8fcca33ab5ab8c21161226afbedc2383d6f83e7f02d84",
				"fe9413881dffa8b084ba361a830c97b5a6f209890c877f577038996eda28ca2a"),
			new("ZoodRangmah", "/openra/engine/mods/ra/ZoodRangmah.ttf", 12,
				"9070537acdb3ef1d9b1ecd62ec21cc9b0af217a5ba097e9582abc0fe636fce18",
				"1def11a286ee608a98b72127b0583681dbe721274a46b80992d83406a9bba959"),
			new("ZoodRangmah", "/openra/engine/mods/ra/ZoodRangmah.ttf", 16,
				"568c0c39295ab74a459efee501413c60b62d17f07b32d0db2c22d4f2441a02c4",
				"64b7aed63cfb9661261a1230d06288c2c6d77cecc3e9ed098f67afe70c6d219d"),
			new("ZoodRangmah", "/openra/engine/mods/ra/ZoodRangmah.ttf", 24,
				"cec3b3bfbd5509bdc8885b95dedbfbdc17612758cf3c429bff59eca62e39ba3d",
				"3b64aa942f3ee29cff6d82302ed4c0f359e53454c4e61a619d9de4b69779090d")
		];

		static int Main(string[] args)
		{
			var total = Stopwatch.StartNew();
			try
			{
				var arguments = new Arguments(args);
				var mode = arguments.GetValue("Host.Mode", "rules");
				var hostPlatform = arguments.GetValue("Host.Platform", "null");
				var wsEndpoint = arguments.GetValue("Host.WsEndpoint", null);
				var wsScheme = arguments.GetValue("Host.WsScheme", "ws");
				var handshakeModOverride = arguments.GetValue("Host.ModId", null);
				var handshakeVersionOverride = arguments.GetValue("Host.ModVersion", null);
				var agentModeEnabled = arguments.GetValue("Host.AgentMode", "0") == "1";
				exploreMap = arguments.GetValue("Host.Explored", "0") == "1";
				Console.WriteLine(
					$"[host] mode={mode} platform={hostPlatform} agentMode={agentModeEnabled} " +
					$"IsBrowser={OperatingSystem.IsBrowser()} SupportsThreads={Platform.SupportsThreads}");

				Directory.CreateDirectory("/openra/user");
				BrowserStorage.RestoreSupportDir();
				if (mode == "fontsmoke")
					return RunFontSmoke(total);

				ObjectCreator.RegisterAssembly(typeof(Mods.Common.Traits.Mobile).Assembly);

				// STEELSEED: register the mod assembly the same way. In a WASM publish the
				// assemblies are statically linked rather than present as files, so without
				// this ObjectCreator.LoadAssembly falls through to the filesystem and dies
				// with FileNotFoundException: /OpenRA.Mods.Steelseed.dll while loading the
				// manifest.
				//
				// Loaded by assembly NAME, not typeof(SomeTrait).Assembly, deliberately: the
				// name is fixed by OpenRA.Mods.Steelseed.csproj which the lead owns, whereas
				// every type inside that assembly belongs to the `mod` node and may be renamed
				// freely. Coupling the host to a mod type name would make a legitimate rename
				// in someone else's directory break the boot.
				RegisterSteelseedModAssembly();
				if (agentModeEnabled)
					ObjectCreator.RegisterAssembly(typeof(AgentDamageObserverInfo).Assembly);
				if (agentModeEnabled)
					AgentModeHost.InstallRulesOverlay();

				if (mode == "rules")
					return RunRulesSpike(total);

				hostBaseUrl = arguments.GetValue("Host.BaseUrl", null);

				Game.PlatformFactory = _ => hostPlatform switch
				{
					"null" => new NullPlatform(),
					"webgl2" => new BrowserPlatform(),
					_ => throw new ArgumentException($"Unknown browser host platform '{hostPlatform}'.")
				};
				Game.ConnectionFactory = target => new WebSocketConnection(BuildWsUri(target, wsEndpoint, wsScheme));

				// These switches change only the identity presented during the handshake. A playable match
				// still requires a browser build whose rules and simulation match the target release. A
				// mismatch is detected by OpenRA's normal sync hashes and reported as an out-of-sync game.
				Game.HandshakeModOverride = handshakeModOverride;
				Game.HandshakeVersionOverride = handshakeVersionOverride;

				var gameArgs = new List<string>
				{
					"Engine.EngineDir=/openra/engine",
					"Engine.SupportDir=/openra/user",
					"Game.Mod=steelseed",
					"Game.EnableDiscordService=false",
					"Server.DiscoverNatDevices=false",
					"Debug.CheckVersion=false",
					"Graphics.DisableHardwareCursors=true",
					"Graphics.WindowedSize=1280,720"
				};

				gameArgs.AddRange(args.Where(a => !a.StartsWith("Host.", StringComparison.Ordinal)));

				stepper = Game.InitializeHosted(gameArgs.ToArray());
				stepper.LogicTickCompleted = duration =>
				{
					TickDurations.Add(duration);
					AgentModeHost.TickAfterLogic();
				};
				Console.WriteLine($"[host] game initialized in {total.ElapsedMilliseconds}ms; JS now drives Frame()");
				return 0;
			}
			catch (Exception e)
			{
				Console.WriteLine($"[host] FATAL after {total.ElapsedMilliseconds}ms: {e}");
				return 1;
			}
		}

		static int RunFontSmoke(Stopwatch total)
		{
			const int BenchmarkRounds = 5;
			var passed = true;
			var totalGlyphs = 0;
			var benchmarkGlyphs = 0;
			var benchmarkMilliseconds = 0.0;
			long benchmarkChecksum = 0;
			try
			{
				foreach (var fontGroup in FontSmokeExpectations.GroupBy(e => (e.FontName, e.FontPath)))
				{
					var bytes = File.ReadAllBytes(fontGroup.Key.FontPath);
					using var font = StbTrueType.CreateFont(bytes, 0)
						?? throw new InvalidDataException($"Could not load {fontGroup.Key.FontPath}.");

					Console.WriteLine($"[FONTSMOKE] loaded {fontGroup.Key.FontName} from VFS ({bytes.Length} bytes)");
					foreach (var expectation in fontGroup)
					{
						var metrics = new StringBuilder();
						var rasters = new StringBuilder();
						foreach (var codepoint in FontSmokeCodepoints)
						{
							var glyph = CreateStbGlyph(font, codepoint, expectation.Size);
							var codepointText = $"U+{codepoint:X4}";
							metrics.Append(codepointText).Append(':')
								.Append(glyph.Advance.ToString(CultureInfo.InvariantCulture)).Append(',')
								.Append(glyph.OffsetX.ToString(CultureInfo.InvariantCulture)).Append(',')
								.Append(glyph.OffsetY.ToString(CultureInfo.InvariantCulture)).Append(',')
								.Append(glyph.Width.ToString(CultureInfo.InvariantCulture)).Append(',')
								.Append(glyph.Height.ToString(CultureInfo.InvariantCulture)).Append(';');
							rasters.Append(codepointText).Append(':')
								.Append(Convert.ToHexString(SHA256.HashData(glyph.Data))).Append(';');
						}

						var metricsHash = Sha256(metrics);
						var rasterHash = Sha256(rasters);
						var metricsPassed = metricsHash == expectation.MetricsSha256;
						var rasterPassed = rasterHash == expectation.RasterSha256;
						passed &= metricsPassed && rasterPassed;
						totalGlyphs += FontSmokeCodepoints.Length;

						var stopwatch = Stopwatch.StartNew();
						for (var round = 0; round < BenchmarkRounds; round++)
							foreach (var codepoint in FontSmokeCodepoints)
							{
								var glyph = CreateStbGlyph(font, codepoint, expectation.Size);
								benchmarkChecksum += glyph.Advance + glyph.OffsetX + glyph.OffsetY + glyph.Data.Length;
							}

						stopwatch.Stop();
						var samples = BenchmarkRounds * FontSmokeCodepoints.Length;
						benchmarkGlyphs += samples;
						benchmarkMilliseconds += stopwatch.Elapsed.TotalMilliseconds;
						var microsecondsPerGlyph = stopwatch.Elapsed.TotalMilliseconds * 1000 / samples;
						Console.WriteLine(
							$"[FONTSMOKE] {(metricsPassed && rasterPassed ? "PASS" : "FAIL")} " +
							$"font={expectation.FontName} size={expectation.Size} glyphs={FontSmokeCodepoints.Length} " +
							$"metrics={(metricsPassed ? "PASS" : "FAIL")} raster={(rasterPassed ? "PASS" : "FAIL")} " +
							$"us/glyph={microsecondsPerGlyph:F3}");

						if (!metricsPassed)
							Console.WriteLine($"[FONTSMOKE] metrics expected={expectation.MetricsSha256} actual={metricsHash}");
						if (!rasterPassed)
							Console.WriteLine($"[FONTSMOKE] raster expected={expectation.RasterSha256} actual={rasterHash}");
					}
				}

				Console.WriteLine(
					$"[FONTSMOKE] {(passed ? "PASS" : "FAIL")} total glyphs={totalGlyphs} " +
					$"benchmark glyphs={benchmarkGlyphs} us/glyph={benchmarkMilliseconds * 1000 / benchmarkGlyphs:F3} " +
					$"checksum={benchmarkChecksum} elapsed={total.ElapsedMilliseconds}ms");
				return passed ? 0 : 1;
			}
			catch (Exception e)
			{
				Console.WriteLine($"[FONTSMOKE] FAIL after {total.ElapsedMilliseconds}ms: {e}");
				return 1;
			}
		}

		static string Sha256(StringBuilder value)
		{
			return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value.ToString()))).ToLowerInvariant();
		}

		static unsafe FontSmokeGlyph CreateStbGlyph(StbTrueType.stbtt_fontinfo font, int codepoint, int size)
		{
			var scale = StbTrueType.stbtt_ScaleForMappingEmToPixels(font, size);
			int advance;
			int leftSideBearing;
			StbTrueType.stbtt_GetCodepointHMetrics(font, codepoint, &advance, &leftSideBearing);
			int x0;
			int y0;
			int x1;
			int y1;
			StbTrueType.stbtt_GetCodepointBitmapBox(font, codepoint, scale, scale, &x0, &y0, &x1, &y1);
			var width = x1 - x0;
			var height = y1 - y0;
			var data = new byte[width * height];
			if (data.Length != 0)
				fixed (byte* output = data)
					StbTrueType.stbtt_MakeCodepointBitmap(
						font, output, width, height, width, scale, scale, codepoint);

			return new((int)MathF.Round(advance * scale), x0, y0, width, height, data);
		}

		static int RunRulesSpike(Stopwatch total)
		{
			Platform.OverrideEngineDir("/openra/engine");
			Platform.OverrideSupportDir("/openra/user");

			Log.AddChannel("perf", null);
			Log.AddChannel("debug", null);

			var step = Stopwatch.StartNew();
			Game.InitializeSettings(Arguments.Empty);
			Console.WriteLine($"[S1] Settings initialized in {step.ElapsedMilliseconds}ms");

			step.Restart();
			var mods = new InstalledMods([Path.Combine(Platform.EngineDir, "mods")], []);
			Console.WriteLine($"[S1] InstalledMods found [{string.Join(", ", mods.Keys)}] in {step.ElapsedMilliseconds}ms");

			step.Restart();
			var modData = new ModData(mods["steelseed"], mods);
			Game.ModData = modData;
			Console.WriteLine($"[S1] ModData constructed in {step.ElapsedMilliseconds}ms");

			step.Restart();
			var rules = modData.DefaultRules;
			Console.WriteLine($"[S1] DefaultRules loaded in {step.ElapsedMilliseconds}ms: " +
				$"{rules.Actors.Count} actors, {rules.Weapons.Count} weapons, {rules.Voices.Count} voices");

			step.Restart();
			var terrain = modData.DefaultTerrainInfo;
			Console.WriteLine($"[S1] TerrainInfo loaded in {step.ElapsedMilliseconds}ms: [{string.Join(", ", terrain.Keys)}]");

			Console.WriteLine($"[S1] SUCCESS: boot-to-rules in {total.ElapsedMilliseconds}ms");
			return 0;
		}

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
		internal static int FlushSupportDir()
		{
			return BrowserStorage.FlushSupportDir();
		}

		[JSExport]
		internal static async Task<string> StartReplay(string url)
		{
			try
			{
				if (Game.ModData == null)
					return "not initialized";

				const string ReplayFile = "/openra/user/Replays/oracle.orarep";
				Directory.CreateDirectory(Path.GetDirectoryName(ReplayFile));
				using var client = string.IsNullOrEmpty(hostBaseUrl)
					? new HttpClient()
					: new HttpClient { BaseAddress = new Uri(hostBaseUrl) };
				var bytes = await client.GetByteArrayAsync(url);
				await File.WriteAllBytesAsync(ReplayFile, bytes);
				Game.CloseServer();
				Game.JoinReplay(ReplayFile);
				return $"replaying {ReplayFile}";
			}
			catch (Exception e)
			{
				return $"failed: {e.Message}";
			}
		}

		[JSExport]
		internal static string JoinMultiplayer(string host, int port)
		{
			try
			{
				if (Game.ModData == null)
					return "not initialized";

				Game.JoinServer(new ConnectionTarget(host, port), "");
				return $"joining {host}:{port}";
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
		internal static bool Frame(double _)
		{
			if (stepper == null)
				return false;

			try
			{
				stepper.StepUntilIdle(() => Game.RunTime);
				if (!AgentModeHost.UsesBenchmarkLockstep())
					AgentModeHost.Tick();
				return true;
			}
			catch (Exception e)
			{
				Console.WriteLine($"[host] Frame crashed: {e}");
				for (var inner = e.InnerException; inner != null; inner = inner.InnerException)
					Console.WriteLine($"[host] Frame crash inner: {inner.GetType().FullName}: {inner.Message}");

				stepper = null;
				return false;
			}
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

		[JSExport]
		internal static string GetTickStats()
		{
			if (TickDurations.Count == 0)
				return "no ticks";

			var sorted = TickDurations.Order().ToArray();

			// World creation produces one multi-second tick; report it separately
			// from warm gameplay so it can't hide (or be hidden by) steady-state stats.
			var warm = sorted.Where(t => t < 1000).ToArray();
			var spikes = sorted.Where(t => t >= 100).ToArray();
			if (warm.Length == 0)
				return $"ticks={sorted.Length}, none warm yet";

			return $"ticks={sorted.Length} (exhaustive) warm: median={warm[warm.Length / 2]}ms " +
				$"p95={warm[(int)(warm.Length * 0.95)]}ms p99={warm[(int)(warm.Length * 0.99)]}ms warmMax={warm[^1]}ms | " +
				$"spikes>=100ms: [{string.Join(", ", spikes)}]";
		}

		[JSExport]
		internal static void ResetTickStats()
		{
			TickDurations.Clear();
		}

		[JSExport]
		internal static string GetWorldProbe()
		{
			var world = Game.OrderManager?.World;
			if (world == null)
				return "no world";

			var players = string.Join(", ", world.Players
				.Where(p => p.Playable)
				.Select(p => $"{p.PlayerName}{(p.IsBot ? " (bot)" : "")}"));

			return $"type={world.Type} tick={world.WorldTick} actors={world.Actors.Count()} players=[{players}]";
		}

		[JSExport]
		internal static string ListMaps()
		{
			if (Game.ModData == null)
				return "not initialized";

			return string.Join("\n", Game.ModData.MapCache
				.Where(m => m.Status == MapStatus.Available)
				.Select(m => $"{m.Uid} | {m.Title}"));
		}

		[JSExport]
		internal static string StartSkirmish(string mapUid, int botCount)
		{
			try
			{
				var map = Game.ModData.MapCache
					.FirstOrDefault(m => m.Status == MapStatus.Available
						&& (string.IsNullOrEmpty(mapUid) ? m.PlayerCount > botCount : m.Uid == mapUid));
				if (map == null)
					return $"map not found: uid={mapUid} bots={botCount}";

				var orders = new List<Order> { Order.Command("option gamespeed default") };
				if (exploreMap)
				{
					orders.Add(Order.Command("option explored True"));
					orders.Add(Order.Command("option fog False"));
				}

				for (var i = 0; i < botCount; i++)
					orders.Add(Order.Command($"slot_bot Multi{i + 1} 0 normal"));

				orders.Add(Order.Command($"state {Session.ClientState.Ready}"));

				// This export may be invoked from the browser shellmap or over an
				// already-loaded launch map. Tear down that local world before creating
				// the skirmish server, matching the agent-mode start path.
				if (Game.OrderManager?.World != null)
					Game.Disconnect();

				Game.CreateAndStartLocalServer(map.Uid, orders);
				return $"starting {map.Title} ({map.Uid}) with {botCount} bots";
			}
			catch (Exception e)
			{
				return $"failed: {e}";
			}
		}
	}
}
