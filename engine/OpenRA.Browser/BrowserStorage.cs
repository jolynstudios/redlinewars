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
using System.Runtime.InteropServices.JavaScript;

namespace OpenRA
{
	public static partial class BrowserStorage
	{
		readonly record struct FileStamp(long Size, long LastWriteTicks);

		const string SupportDir = "/openra/user";
		const long MaxFileSize = 256L * 1024 * 1024;

		static readonly Dictionary<string, FileStamp> Baseline = new(StringComparer.Ordinal);

		[JSImport("listEntries", "openra-fs")]
		[return: JSMarshalAs<JSType.Array<JSType.String>>]
		private static partial string[] ListEntries();

		[JSImport("readEntry", "openra-fs")]
		[return: JSMarshalAs<JSType.Array<JSType.Number>>]
		private static partial byte[] ReadEntry(string path);

		[JSImport("writeEntry", "openra-fs")]
		private static partial void WriteEntry(
			string path,
			double mtimeMs,
			[JSMarshalAs<JSType.MemoryView>] Span<byte> data);

		[JSImport("deleteEntry", "openra-fs")]
		private static partial void DeleteEntry(string path);

		[JSImport("flush", "openra-fs")]
		private static partial int Commit();

		static bool IsExcluded(string relativePath)
		{
			return relativePath.StartsWith("Logs/", StringComparison.Ordinal);
		}

		static string ResolvePath(string relativePath)
		{
			var normalized = relativePath.Replace('\\', '/');
			if (string.IsNullOrEmpty(normalized) || normalized.StartsWith('/'))
				throw new InvalidDataException($"Invalid browser storage path '{relativePath}'.");

			foreach (var segment in normalized.Split('/'))
				if (string.IsNullOrEmpty(segment) || segment == "." || segment == "..")
					throw new InvalidDataException($"Invalid browser storage path '{relativePath}'.");

			var fullPath = Path.GetFullPath(Path.Combine(SupportDir, normalized));
			if (!fullPath.StartsWith(SupportDir + Path.DirectorySeparatorChar, StringComparison.Ordinal))
				throw new InvalidDataException($"Browser storage path escapes the support directory: '{relativePath}'.");

			return fullPath;
		}

		static string RelativePath(string fullPath)
		{
			return Path.GetRelativePath(SupportDir, fullPath).Replace('\\', '/');
		}

		static FileStamp GetStamp(string path)
		{
			var info = new FileInfo(path);
			return new FileStamp(info.Length, info.LastWriteTimeUtc.Ticks);
		}

		static double ToUnixMilliseconds(FileStamp stamp)
		{
			return new DateTimeOffset(new DateTime(stamp.LastWriteTicks, DateTimeKind.Utc)).ToUnixTimeMilliseconds();
		}

		public static void RestoreSupportDir()
		{
			Baseline.Clear();
			var removedExcludedEntry = false;
			foreach (var relativePath in ListEntries())
			{
				if (IsExcluded(relativePath))
				{
					DeleteEntry(relativePath);
					removedExcludedEntry = true;
					continue;
				}

				var path = ResolvePath(relativePath);
				var data = ReadEntry(relativePath);
				if (data == null || data.LongLength > MaxFileSize)
					throw new InvalidDataException($"Browser storage entry '{relativePath}' exceeds the 256MB file limit.");

				Directory.CreateDirectory(Path.GetDirectoryName(path));
				File.WriteAllBytes(path, data);
				Baseline[relativePath] = GetStamp(path);
			}

			if (removedExcludedEntry)
				Commit();
		}

		public static int FlushSupportDir()
		{
			var changed = 0;
			var currentPaths = new HashSet<string>(StringComparer.Ordinal);
			foreach (var path in Directory.EnumerateFiles(SupportDir, "*", SearchOption.AllDirectories))
			{
				var relativePath = RelativePath(path);
				if (IsExcluded(relativePath))
					continue;

				currentPaths.Add(relativePath);
				var stamp = GetStamp(path);
				if (Baseline.TryGetValue(relativePath, out var previous) && previous == stamp)
					continue;

				if (stamp.Size > MaxFileSize)
				{
					Console.WriteLine($"[storage] skipping '{relativePath}': file exceeds the 256MB limit");
					DeleteEntry(relativePath);
					Baseline[relativePath] = stamp;
					changed++;
					continue;
				}

				var data = File.ReadAllBytes(path);
				stamp = GetStamp(path);
				if (data.LongLength != stamp.Size)
					throw new IOException($"File '{relativePath}' changed while it was being persisted.");

				WriteEntry(relativePath, ToUnixMilliseconds(stamp), data);
				Baseline[relativePath] = stamp;
				changed++;
			}

			var vanished = new List<string>();
			foreach (var relativePath in Baseline.Keys)
				if (!currentPaths.Contains(relativePath))
					vanished.Add(relativePath);

			foreach (var relativePath in vanished)
			{
				DeleteEntry(relativePath);
				Baseline.Remove(relativePath);
				changed++;
			}

			Commit();
			return changed;
		}
	}
}
