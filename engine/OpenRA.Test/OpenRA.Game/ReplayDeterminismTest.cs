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
using System.Globalization;
using System.IO;
using NUnit.Framework;
using OpenRA.FileFormats;
using OpenRA.Network;

namespace OpenRA.Test
{
	[TestFixture]
	sealed class ReplayDeterminismTest
	{
		const string TcpReplayEnvironmentVariable = "OPENRA_TCP_REPLAY";
		const string InMemoryReplayEnvironmentVariable = "OPENRA_INMEMORY_REPLAY";
		const string DesktopReplayEnvironmentVariable = "OPENRA_DESKTOP_REPLAY";
		const string BrowserReplayEnvironmentVariable = "OPENRA_BROWSER_REPLAY";
		const string RandomSeedEnvironmentVariable = "OPENRA_RANDOM_SEED";
		const string FramesEnvironmentVariable = "OPENRA_DETERMINISM_FRAMES";

		sealed class ReplayData
		{
			public int? RandomSeed;
			public readonly Dictionary<int, List<byte[]>> Orders = [];
			public readonly Dictionary<int, byte[]> SyncHashes = [];
		}

		static ReplayData ReadReplay(string path)
		{
			var replay = new ReplayData();
			using var stream = File.OpenRead(path);
			while (stream.Length - stream.Position >= 8)
			{
				var client = stream.ReadInt32();
				if (client == ReplayMetadata.MetaStartMarker)
					break;

				var packetLength = stream.ReadInt32();
				if (packetLength < 4 || packetLength > stream.Length - stream.Position)
					break;

				var packet = stream.ReadBytes(packetLength);
				var frame = BitConverter.ToInt32(packet, 0);
				if (frame == 0 && OrderIO.TryParseOrderPacket(packet, out var immediateOrders))
				{
					foreach (var order in immediateOrders.Orders.GetOrders(null))
						if (order.OrderString == "SyncInfo")
							replay.RandomSeed = Session.Deserialize(order.TargetString, order.OrderString).GlobalSettings.RandomSeed;

					continue;
				}

				if (OrderIO.TryParseSync(packet, out var sync))
				{
					replay.SyncHashes.Add(sync.Frame, packet);
					continue;
				}

				if (frame > 0)
					replay.Orders.GetOrAdd(frame).Add(packet);
			}

			return replay;
		}

		static string RequiredEnvironmentVariable(string name)
		{
			var value = Environment.GetEnvironmentVariable(name);
			if (string.IsNullOrEmpty(value))
				Assert.Fail($"Set {name} before running this explicit determinism test.");

			return value;
		}

		[Test]
		[Explicit("Requires fixed-seed TCP and in-memory replay files from the desktop integration harness.")]
		public void TcpAndInMemoryReplaysHaveIdenticalOrdersAndSyncHashes()
		{
			CompareReplays(
				RequiredEnvironmentVariable(TcpReplayEnvironmentVariable), "TCP",
				RequiredEnvironmentVariable(InMemoryReplayEnvironmentVariable), "in-memory");
		}

		[Test]
		[Explicit("Requires fixed-seed desktop and browser replay files (see BROWSER-PORT.md determinism oracle).")]
		public void DesktopAndBrowserReplaysHaveIdenticalOrdersAndSyncHashes()
		{
			CompareReplays(
				RequiredEnvironmentVariable(DesktopReplayEnvironmentVariable), "desktop",
				RequiredEnvironmentVariable(BrowserReplayEnvironmentVariable), "browser");
		}

		static void CompareReplays(string basePath, string baseName, string candidatePath, string candidateName)
		{
			var baseReplay = ReadReplay(basePath);
			var candidateReplay = ReadReplay(candidatePath);
			var expectedRandomSeed = int.Parse(RequiredEnvironmentVariable(RandomSeedEnvironmentVariable), CultureInfo.InvariantCulture);
			var framesValue = Environment.GetEnvironmentVariable(FramesEnvironmentVariable);
			var frames = string.IsNullOrEmpty(framesValue) ? 128 : int.Parse(framesValue, CultureInfo.InvariantCulture);

			Assert.Multiple(() =>
			{
				Assert.That(baseReplay.RandomSeed, Is.EqualTo(expectedRandomSeed), $"{baseName} replay seed");
				Assert.That(candidateReplay.RandomSeed, Is.EqualTo(expectedRandomSeed), $"{candidateName} replay seed");
				Assert.That(baseReplay.SyncHashes.Count, Is.GreaterThanOrEqualTo(frames), $"{baseName} sync frames");
				Assert.That(candidateReplay.SyncHashes.Count, Is.GreaterThanOrEqualTo(frames), $"{candidateName} sync frames");
			});

			for (var frame = 1; frame <= frames; frame++)
			{
				Assert.Multiple(() =>
				{
					Assert.That(baseReplay.Orders, Does.ContainKey(frame), $"{baseName} orders frame {frame}");
					Assert.That(candidateReplay.Orders, Does.ContainKey(frame), $"{candidateName} orders frame {frame}");
					Assert.That(baseReplay.SyncHashes, Does.ContainKey(frame), $"{baseName} sync frame {frame}");
					Assert.That(candidateReplay.SyncHashes, Does.ContainKey(frame), $"{candidateName} sync frame {frame}");
				});

				Assert.Multiple(() =>
				{
					Assert.That(candidateReplay.Orders[frame], Is.EqualTo(baseReplay.Orders[frame]), $"orders frame {frame}");
					Assert.That(candidateReplay.SyncHashes[frame], Is.EqualTo(baseReplay.SyncHashes[frame]), $"sync frame {frame}");
				});
			}
		}
	}
}
