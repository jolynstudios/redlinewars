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
using OpenRA.FileSystem;
using OpenRA.Network;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA
{
	/// <summary>
	/// STEELSEED host seam: start a skirmish on a map that is GENERATED, not loaded.
	///
	/// Why this lives in OpenRA.Browser (lead-owned) and not in the mod assembly or the
	/// bridge node — three independent reasons, all binding:
	///
	/// 1. Accessibility. OpenRA.Game declares [InternalsVisibleTo("OpenRA.Browser")].
	///    Game.StartGame and the World constructor are internal, so no other assembly in
	///    this solution can reach them. OpenRA.Mods.Steelseed never will.
	/// 2. Dependency direction. The build graph is mod -> bridge. The `mod` node's gate
	///    needs a headless skirmish, so putting that seam in `bridge` would make `mod`
	///    depend on `bridge` and invert tier 0 into a cycle.
	/// 3. Shared consumers. synccheck.mjs, playtest.mjs and the `mod` gate all need it.
	///    It is harness infrastructure, not any one node's code.
	///
	/// Nothing here touches disk. The generated map is serialised into an in-memory
	/// ReadWriteZipFile purely to derive its content-hash Uid, which is what MapCache and
	/// the lobby key off. Hard rule 13 is intact: no binary artifact is ever written or
	/// committed. See ARCHITECTURE.md §1.5.
	/// </summary>
	[SupportedOSPlatform("browser")]
	public static partial class Program
	{
		/// <summary>
		/// Generate a map from a named generator preset, register it, and start a bot
		/// skirmish on it. Returns "ok: ..." or a diagnostic string; never throws across
		/// the interop boundary, because an exception marshalled through [JSExport]
		/// surfaces on the JS side with the C# stack discarded.
		/// </summary>
		/// <param name="generatorType">IMapGeneratorInfo.Type, e.g. "seedline".</param>
		/// <param name="optionId">Generator option id holding the preset, e.g. "Preset".</param>
		/// <param name="presetChoice">Choice id, e.g. "amber-crossing".</param>
		/// <param name="tileset">Tileset id, e.g. "STEELWORKS".</param>
		/// <param name="botCount">Bots to seat. 1 gives a 1v1 against the player slot.</param>
		/// <param name="botType">
		/// Bot type from the mod's ModularBot definitions. Passed through rather than
		/// hardcoded: the mod owns which bots exist, and a host that assumes "normal"
		/// silently seats nothing if the mod names its bots differently.
		/// </param>
		/// <remarks>
		/// There is deliberately NO width/height parameter. The named preset owns map size
		/// (ARCHITECTURE.md §1.5: a preset is seed plus parameters, size among them), and
		/// SteelseedMapGenerator treats the preset's MapWidth/MapHeight as authoritative,
		/// ignoring MapGenerationArgs.Size. An earlier revision took width/height here and
		/// echoed them back, which meant the harness would cheerfully report a size the
		/// preset had overridden. The actual generated size is read back from the map and
		/// reported instead — a tool must never claim an input the callee discarded.
		/// </remarks>
		[JSExport]
		internal static string StartGeneratedSkirmish(
			string generatorType, string optionId, string presetChoice,
			string tileset, int botCount, string botType)
		{
			try
			{
				var modData = Game.ModData;
				if (modData == null)
					return "failed: mod data not initialised";

				var generator = modData.DefaultRules.Actors[SystemActors.EditorWorld]
					.TraitInfos<IMapGeneratorInfo>()
					.FirstOrDefault(g => g.Type == generatorType);

				if (generator == null)
				{
					var known = string.Join(", ", modData.DefaultRules.Actors[SystemActors.EditorWorld]
						.TraitInfos<IMapGeneratorInfo>().Select(g => g.Type));
					return $"failed: no map generator '{generatorType}'. known: [{known}]";
				}

				var args = new MapGenerationArgs
				{
					Generator = generatorType,
					Tileset = tileset,

					// MapGenerationArgs.Size is [FieldLoader.Require] so it must be set, but
					// SteelseedMapGenerator overrides it from the preset. A nominal value goes
					// in; the real size is read back from the generated map below.
					Size = new Size(1, 1),
					Title = $"{presetChoice}",
					Author = "STEELSEED",
				};

				if (!string.IsNullOrEmpty(optionId))
					args.Options[optionId] = presetChoice;

				// Generate synchronously. MapPreview.Generate() would also work but runs on
				// a Task and completes via Game.RunAfterTick, which a headless gate cannot
				// await deterministically. FuzzMapGeneratorCommand sets the precedent for
				// calling the generator directly.
				var map = generator.Generate(modData, args);
				if (map == null)
					return $"failed: generator '{generatorType}' returned no map";

				// Save into an in-memory package: this is what computes map.Uid, and the
				// lobby resolves maps by Uid. No file is created.
				map.Save(new ZipFileLoader.ReadWriteZipFile());

				var preview = modData.MapCache[map.Uid];
				preview.UpdateFromMap(map.Package, MapClassification.Generated);

				if (preview.PlayerCount <= botCount)
					return $"failed: map has {preview.PlayerCount} player slot(s), need > {botCount} for {botCount} bot(s)";

				var orders = new List<Order> { Order.Command("option gamespeed default") };
				if (exploreMap)
				{
					orders.Add(Order.Command("option explored True"));
					orders.Add(Order.Command("option fog False"));
				}

				var bot = string.IsNullOrEmpty(botType) ? "normal" : botType;
				for (var i = 0; i < botCount; i++)
					orders.Add(Order.Command($"slot_bot Multi{i + 1} 0 {bot}"));

				orders.Add(Order.Command($"state {Session.ClientState.Ready}"));

				// Tear down any existing world first, matching StartSkirmish.
				if (Game.OrderManager?.World != null)
					Game.Disconnect();

				Game.CreateAndStartLocalServer(map.Uid, orders);

				// Report the size the generator actually produced, never a caller-supplied one.
				return $"ok: generated '{presetChoice}' via {generatorType} " +
					$"({map.MapSize.Width}x{map.MapSize.Height}, {preview.PlayerCount} slots, uid={map.Uid}), " +
					$"{botCount} bot(s) type={bot}";
			}
			catch (Exception e)
			{
				return $"failed: {e}";
			}
		}

		/// <summary>
		/// Assembly name of the STEELSEED mod assembly. Fixed by
		/// OpenRA.Mods.Steelseed.csproj, which the lead owns.
		/// </summary>
		const string ModAssemblyName = "OpenRA.Mods.Steelseed";

		/// <summary>
		/// Register the mod assembly with ObjectCreator so manifest type resolution finds
		/// its traits and map generators.
		///
		/// Necessary because a WASM publish links assemblies statically instead of shipping
		/// them as files: ObjectCreator.LoadAssembly would otherwise fall back to reading
		/// /OpenRA.Mods.Steelseed.dll off a filesystem that has no such file.
		///
		/// The assembly is a TrimmerRootAssembly (see the csproj), so trimming keeps it whole
		/// and Assembly.Load by name resolves against the statically linked set.
		/// </summary>
		static void RegisterSteelseedModAssembly()
		{
			try
			{
				var asm = System.Reflection.Assembly.Load(new System.Reflection.AssemblyName(ModAssemblyName));
				ObjectCreator.RegisterAssembly(asm);
			}
			catch (Exception e)
			{
				// Fatal in practice — the mod manifest names this assembly, so nothing will
				// load without it. Fail loudly here rather than letting it surface later as
				// an unresolved trait, which is far harder to attribute.
				Log.Write("debug", $"STEELSEED: could not register {ModAssemblyName}: {e}");
				throw new InvalidOperationException(
					$"STEELSEED: failed to register the mod assembly '{ModAssemblyName}'. " +
					"It must be referenced by OpenRA.Browser.csproj and listed as a TrimmerRootAssembly.", e);
			}
		}

		/// <summary>
		/// Match state for the headless gate. The gate must PROVE victory, not infer it
		/// from a tick count or a timeout — an inferred victory passes just as happily
		/// when the bot never built anything and the match stalled.
		///
		/// Returns one line of `key=value` pairs, then one line per player:
		///   tick=N gameover=true|false
		///   player|&lt;name&gt;|&lt;faction&gt;|&lt;winstate&gt;|&lt;isBot&gt;|&lt;hasObjectives&gt;
		/// </summary>
		[JSExport]
		internal static string GetMatchState()
		{
			try
			{
				var world = Game.OrderManager?.World;
				if (world == null)
					return "no world";

				var sb = new List<string>
				{
					$"tick={world.WorldTick} gameover={world.IsGameOver.ToString().ToLowerInvariant()}",
				};

				foreach (var p in world.Players)
				{
					// Skip the internal non-combatant players the engine always creates;
					// reporting them makes the gate's output unreadable.
					if (p.NonCombatant && !p.IsBot)
						continue;

					sb.Add($"player|{p.PlayerName}|{p.Faction?.InternalName ?? "?"}|" +
						$"{p.WinState}|{p.IsBot.ToString().ToLowerInvariant()}|" +
						$"{p.Spectating.ToString().ToLowerInvariant()}");
				}

				return string.Join("\n", sb);
			}
			catch (Exception e)
			{
				return $"failed: {e}";
			}
		}

		/// <summary>
		/// List the generators and option choices the loaded mod declares. Lets the
		/// harness discover presets instead of hardcoding them, so adding a preset in
		/// MiniYAML does not require a tools change.
		/// </summary>
		[JSExport]
		internal static string ListMapGenerators()
		{
			try
			{
				var modData = Game.ModData;
				if (modData == null)
					return "not initialized";

				var lines = new List<string>();
				foreach (var g in modData.DefaultRules.Actors[SystemActors.EditorWorld].TraitInfos<IMapGeneratorInfo>())
					lines.Add($"{g.Type} | {g.Name} | {g.MapTitle}");

				return lines.Count > 0 ? string.Join("\n", lines) : "(no map generators declared)";
			}
			catch (Exception e)
			{
				return $"failed: {e}";
			}
		}
	}
}
