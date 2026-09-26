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
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using OpenRA.Network;
using OpenRA.Platforms.Browser;

namespace OpenRA
{
	[SupportedOSPlatform("browser")]
	public static partial class Program
	{
		const string ModAssemblyName = "OpenRA.Mods.Steelseed";
#if STEELSEED_PARITY_REFERENCE
		const string ModId = "ra-reference";
#else
		const string ModId = "ra";
#endif
		static GameStepper stepper;
		static bool hostRunning;
		static string fatalError;

		static int Main(string[] args)
		{
			try
			{
				var arguments = new Arguments(args);
				var wsEndpoint = arguments.GetValue("Host.WsEndpoint", null);
				var wsScheme = arguments.GetValue("Host.WsScheme", "ws");
				var handshakeModOverride = arguments.GetValue("Host.ModId", null);
				var handshakeVersionOverride = arguments.GetValue("Host.ModVersion", null);
				// X7: the page query string must not be able to rewrite the client's
				// handshake identity. Host.ModId/Host.ModVersion are honoured only
				// when the launch arguments explicitly carry Host.DevOverrides=1
				// (gates and the desktop shell opt in on purpose).
				var devOverrides = arguments.GetValue("Host.DevOverrides", null) == "1";

				ObjectCreator.RegisterAssembly(typeof(Mods.Common.Traits.Mobile).Assembly);
				ObjectCreator.RegisterAssembly(Assembly.Load(new AssemblyName("OpenRA.Mods.Cnc")));
				ObjectCreator.RegisterAssembly(Assembly.Load(new AssemblyName(ModAssemblyName)));
				Game.PlatformFactory = _ => new NullPlatform();
				Directory.CreateDirectory("/openra/user");

				// The browser-wasm runtime has no raw TCP sockets, so every remote
				// join must go through the browser WebSocket transport. With no
				// Host.WsEndpoint the transport derives ws://host:port from the
				// join target (legacy driver contract).
				Game.ConnectionFactory = target => new BrowserWebSocketConnection(BuildWsUri(target, wsEndpoint, wsScheme));

				if (!string.IsNullOrEmpty(wsEndpoint))
					SetWsEndpointFields(wsEndpoint, wsScheme);

				// These switches change only the identity presented during the handshake.
				// A playable match still requires a client build whose rules and simulation
				// match the server; a mismatch is detected by OpenRA's normal sync hashes.
				Game.HandshakeModOverride = devOverrides ? handshakeModOverride : null;
				Game.HandshakeVersionOverride = devOverrides ? handshakeVersionOverride : null;

				var gameArgs = new List<string>
				{
					"Engine.EngineDir=/openra/engine",
					"Engine.SupportDir=/openra/user",
					$"Game.Mod={ModId}",
					"Game.EnableDiscordService=false",
					"Server.DiscoverNatDevices=false",
					"Debug.CheckVersion=false",
					"Graphics.DisableHardwareCursors=true",
					"Graphics.WindowedSize=1280,720"
				};

				gameArgs.AddRange(args.Where(a => !a.StartsWith("Host.", StringComparison.Ordinal)));
				stepper = Game.InitializeHosted(gameArgs.ToArray());
				hostRunning = true;
				Console.WriteLine($"[steelseed-host] {ModId} Red Alert runtime initialized");
				return 0;
			}
			catch (Exception e)
			{
				fatalError = e.ToString();
				Console.WriteLine($"[steelseed-host] fatal: {e}");
				return 1;
			}
		}

		[JSExport]
		internal static bool Frame(double _)
		{
			if (!hostRunning || stepper == null)
				return false;

			try
			{
				// Tick-cost evidence for the movement-stall investigation: a single
				// long tick names its own cost when it happens, on every build, in
				// every gate log. 50 ms is one dropped frame; the ~12 s first-move
		// stall this hunts dwarfs it.
				var stopwatch = System.Diagnostics.Stopwatch.StartNew();
				stepper.StepUntilIdle(() => Game.RunTime);
				stopwatch.Stop();
				if (stopwatch.ElapsedMilliseconds >= 50)
					Console.WriteLine($"[steelseed-host] tick {stopwatch.ElapsedMilliseconds} ms at {Game.RunTime} ms");
				return true;
			}
			catch (Exception e)
			{
				fatalError = e.ToString();
				hostRunning = false;
				Console.WriteLine($"[steelseed-host] frame failed: {e}");
				return false;
			}
		}

		[JSExport]
		internal static string HostStatus()
		{
			if (fatalError != null)
				return $"error:{fatalError}";

			return hostRunning ? "running" : "stopped";
		}
	}
}
