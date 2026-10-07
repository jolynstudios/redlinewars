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
using System.Security.Cryptography;
using OpenRA.Platforms.Default;
using StbTrueTypeSharp;

namespace OpenRA.FontMetrics
{
	static class Program
	{
		const int BenchmarkRounds = 5;
		static readonly int[] Sizes = [12, 14, 16, 24];
		static readonly (string Name, string Path)[] Fonts =
		[
			("FreeSans", "mods/common/FreeSans.ttf"),
			("FreeSansBold", "mods/common/FreeSansBold.ttf"),
			("ZoodRangmah", "mods/ra/ZoodRangmah.ttf")
		];

		readonly record struct GlyphSample(int Advance, int OffsetX, int OffsetY, int Width, int Height, byte[] Data)
		{
			public static GlyphSample FromFreeType(FontGlyph glyph)
			{
				return new(
					(int)glyph.Advance,
					glyph.Offset.X,
					glyph.Offset.Y,
					glyph.Size.Width,
					glyph.Size.Height,
					glyph.Data ?? []);
			}
		}

		readonly record struct RasterLine(string Label, int Width, int Height, byte[] Data);

		sealed class MetricDifference
		{
			public int Count;
			public int AdvanceMatches;
			public int OffsetMatches;
			public int SizeMatches;
			public int AllMetricMatches;
			public int BitmapMatches;
			public long AdvanceAbsoluteError;
			public long OffsetAbsoluteError;
			public long SizeAbsoluteError;
			public long ComparableBitmapPixels;
			public long BitmapAbsoluteError;
			public long FreeTypeCoverage;
			public long StbCoverage;

			public void Add(in GlyphSample freeType, in GlyphSample stb)
			{
				Count++;
				var advanceMatch = freeType.Advance == stb.Advance;
				var offsetMatch = freeType.OffsetX == stb.OffsetX && freeType.OffsetY == stb.OffsetY;
				var sizeMatch = freeType.Width == stb.Width && freeType.Height == stb.Height;
				if (advanceMatch)
					AdvanceMatches++;
				if (offsetMatch)
					OffsetMatches++;
				if (sizeMatch)
					SizeMatches++;
				if (advanceMatch && offsetMatch && sizeMatch)
					AllMetricMatches++;

				AdvanceAbsoluteError += Math.Abs(freeType.Advance - stb.Advance);
				OffsetAbsoluteError += Math.Abs(freeType.OffsetX - stb.OffsetX) + Math.Abs(freeType.OffsetY - stb.OffsetY);
				SizeAbsoluteError += Math.Abs(freeType.Width - stb.Width) + Math.Abs(freeType.Height - stb.Height);
				FreeTypeCoverage += freeType.Data.Sum(p => (long)p);
				StbCoverage += stb.Data.Sum(p => (long)p);

				if (!sizeMatch)
					return;

				ComparableBitmapPixels += freeType.Data.Length;
				if (freeType.Data.AsSpan().SequenceEqual(stb.Data))
					BitmapMatches++;

				for (var i = 0; i < freeType.Data.Length; i++)
					BitmapAbsoluteError += Math.Abs(freeType.Data[i] - stb.Data[i]);
			}
		}

		static IEnumerable<char> GlyphCorpus()
		{
			// Stable UI-focused coverage: printable ASCII, Latin-1, Greek, Cyrillic,
			// and General Punctuation. IFont accepts UTF-16 chars, so keep this corpus in the BMP.
			foreach (var (start, end) in new[]
			{
				(0x20, 0x7E),
				(0xA0, 0xFF),
				(0x370, 0x3FF),
				(0x400, 0x4FF),
				(0x2000, 0x206F)
			})
				for (var codepoint = start; codepoint <= end; codepoint++)
					yield return (char)codepoint;
		}

		static string FindRepositoryRoot()
		{
			var directory = new DirectoryInfo(Directory.GetCurrentDirectory());
			while (directory != null)
			{
				if (File.Exists(Path.Combine(directory.FullName, "mods", "ra", "mod.yaml")))
					return directory.FullName;

				directory = directory.Parent;
			}

			throw new DirectoryNotFoundException("Could not locate the OpenRA repository root.");
		}

		static unsafe GlyphSample CreateStbGlyph(StbTrueType.stbtt_fontinfo font, char c, int size, bool mapEmToPixels)
		{
			var scale = mapEmToPixels
				? StbTrueType.stbtt_ScaleForMappingEmToPixels(font, size)
				: StbTrueType.stbtt_ScaleForPixelHeight(font, size);
			int advance;
			int leftSideBearing;
			StbTrueType.stbtt_GetCodepointHMetrics(font, c, &advance, &leftSideBearing);
			int x0;
			int y0;
			int x1;
			int y1;
			StbTrueType.stbtt_GetCodepointBitmapBox(font, c, scale, scale, &x0, &y0, &x1, &y1);
			var width = x1 - x0;
			var height = y1 - y0;
			var data = new byte[width * height];
			if (data.Length != 0)
				fixed (byte* output = data)
					StbTrueType.stbtt_MakeCodepointBitmap(font, output, width, height, width, scale, scale, c);

			return new((int)MathF.Round(advance * scale), x0, y0, width, height, data);
		}

		static void WriteMetric(StreamWriter writer, string fontName, int size, char c, in GlyphSample glyph)
		{
			var nonzeroPixels = glyph.Data.Count(p => p != 0);
			var bitmapHash = Convert.ToHexString(SHA256.HashData(glyph.Data));
			writer.WriteLine(string.Join(',',
				fontName,
				size.ToString(CultureInfo.InvariantCulture),
				"1",
				$"U+{(int)c:X4}",
				glyph.Advance.ToString(CultureInfo.InvariantCulture),
				glyph.OffsetX.ToString(CultureInfo.InvariantCulture),
				glyph.OffsetY.ToString(CultureInfo.InvariantCulture),
				glyph.Width.ToString(CultureInfo.InvariantCulture),
				glyph.Height.ToString(CultureInfo.InvariantCulture),
				nonzeroPixels.ToString(CultureInfo.InvariantCulture),
				bitmapHash));
		}

		static void WriteDifference(
			StreamWriter writer, string fontName, int size, string scaleMode, MetricDifference difference)
		{
			writer.WriteLine(string.Join(',',
				fontName,
				size.ToString(CultureInfo.InvariantCulture),
				scaleMode,
				difference.Count.ToString(CultureInfo.InvariantCulture),
				Percent(difference.AdvanceMatches, difference.Count),
				Percent(difference.OffsetMatches, difference.Count),
				Percent(difference.SizeMatches, difference.Count),
				Percent(difference.AllMetricMatches, difference.Count),
				Percent(difference.BitmapMatches, difference.SizeMatches),
				Average(difference.AdvanceAbsoluteError, difference.Count),
				Average(difference.OffsetAbsoluteError, difference.Count),
				Average(difference.SizeAbsoluteError, difference.Count),
				Average(difference.BitmapAbsoluteError, difference.ComparableBitmapPixels),
				Ratio(difference.StbCoverage, difference.FreeTypeCoverage)));
		}

		static string Percent(long numerator, long denominator)
		{
			return denominator == 0
				? "0"
				: (100.0 * numerator / denominator).ToString("F2", CultureInfo.InvariantCulture);
		}

		static string Average(long total, long count)
		{
			return count == 0 ? "0" : ((double)total / count).ToString("F3", CultureInfo.InvariantCulture);
		}

		static string Ratio(long numerator, long denominator)
		{
			return denominator == 0 ? "0" : ((double)numerator / denominator).ToString("F3", CultureInfo.InvariantCulture);
		}

		static RasterLine RenderLine(string label, int size, IEnumerable<GlyphSample> glyphs)
		{
			var samples = glyphs.ToArray();
			var pen = 0;
			var minX = 0;
			var maxX = 0;
			foreach (var glyph in samples)
			{
				minX = Math.Min(minX, pen + glyph.OffsetX);
				maxX = Math.Max(maxX, pen + glyph.OffsetX + glyph.Width);
				pen += glyph.Advance;
			}

			const int Margin = 4;
			var width = Math.Max(pen, maxX) - minX + 2 * Margin;
			var height = 2 * size + 2 * Margin;
			var baseline = size + Margin;
			var data = Enumerable.Repeat((byte)255, width * height).ToArray();
			pen = Margin - minX;
			foreach (var glyph in samples)
			{
				for (var y = 0; y < glyph.Height; y++)
					for (var x = 0; x < glyph.Width; x++)
					{
						var targetX = pen + glyph.OffsetX + x;
						var targetY = baseline + glyph.OffsetY + y;
						if (targetX < 0 || targetX >= width || targetY < 0 || targetY >= height)
							continue;

						var target = targetY * width + targetX;
						data[target] = Math.Min(data[target], (byte)(255 - glyph.Data[y * glyph.Width + x]));
					}

				pen += glyph.Advance;
			}

			return new(label, width, height, data);
		}

		static void WriteRasterPreview(string path, IReadOnlyList<RasterLine> lines)
		{
			const int SeparatorHeight = 2;
			var width = lines.Max(l => l.Width);
			var height = lines.Sum(l => l.Height) + SeparatorHeight * (lines.Count - 1);
			var pixels = Enumerable.Repeat((byte)255, width * height).ToArray();
			var targetY = 0;
			foreach (var line in lines)
			{
				for (var y = 0; y < line.Height; y++)
					line.Data.AsSpan(y * line.Width, line.Width).CopyTo(pixels.AsSpan((targetY + y) * width, line.Width));

				targetY += line.Height;
				if (targetY < height)
				{
					pixels.AsSpan(targetY * width, SeparatorHeight * width).Fill(224);
					targetY += SeparatorHeight;
				}
			}

			using var output = new FileStream(path, FileMode.Create, FileAccess.Write);
			using var header = new StreamWriter(output, leaveOpen: true);
			header.Write($"P5\n{width} {height}\n255\n");
			header.Flush();
			output.Write(pixels);
		}

		static void Main(string[] args)
		{
			var repositoryRoot = args.Length > 0 ? Path.GetFullPath(args[0]) : FindRepositoryRoot();
			var outputDirectory = args.Length > 1
				? Path.GetFullPath(args[1])
				: Path.Combine(repositoryRoot, "OpenRA.Test", "Artifacts", "FontMetrics");
			Directory.CreateDirectory(outputDirectory);

			var glyphs = GlyphCorpus().ToArray();
			var freeTypeMetricsPath = Path.Combine(outputDirectory, "ra-freetype-metrics.csv");
			var stbMetricsPath = Path.Combine(outputDirectory, "ra-stb-metrics.csv");
			var timingsPath = Path.Combine(outputDirectory, "ra-font-timings.csv");
			var differencesPath = Path.Combine(outputDirectory, "ra-font-differences.csv");
			using var freeTypeMetrics = new StreamWriter(freeTypeMetricsPath, false);
			using var stbMetrics = new StreamWriter(stbMetricsPath, false);
			using var timings = new StreamWriter(timingsPath, false);
			using var differences = new StreamWriter(differencesPath, false);
			var previewLines = new List<RasterLine>();
			const string PreviewText = "OpenRA 0123456789 ABC xyz";
			const string MetricsHeader = "font,size,device_scale,codepoint,advance,offset_x,offset_y,width,height,nonzero_pixels,bitmap_sha256";
			freeTypeMetrics.WriteLine(MetricsHeader);
			stbMetrics.WriteLine(MetricsHeader);
			timings.WriteLine("rasterizer,font,size,glyphs,rounds,elapsed_ms,microseconds_per_glyph,allocated_bytes_per_glyph,checksum");
			differences.WriteLine(string.Join(',',
				"font",
				"size",
				"stb_scale_mode",
				"supported_glyphs",
				"advance_match_percent",
				"offset_match_percent",
				"size_match_percent",
				"all_metrics_match_percent",
				"bitmap_match_percent_for_equal_size",
				"mean_advance_abs_error",
				"mean_offset_abs_error",
				"mean_size_abs_error",
				"mean_bitmap_abs_error_for_equal_size",
				"coverage_ratio_stb_to_freetype"));

			IPlatform platform = new DefaultPlatform();
			foreach (var (fontName, relativePath) in Fonts)
			{
				var fontPath = Path.Combine(repositoryRoot, relativePath);
				var fontData = File.ReadAllBytes(fontPath);
				using var freeTypeFont = platform.CreateFont(fontData);
				using var stbFont = StbTrueType.CreateFont(fontData, 0)
					?? throw new InvalidDataException($"StbTrueTypeSharp could not load {relativePath}.");

				foreach (var size in Sizes)
				{
					var emDifference = new MetricDifference();
					var pixelHeightDifference = new MetricDifference();
					foreach (var c in glyphs)
					{
						var freeType = GlyphSample.FromFreeType(freeTypeFont.CreateGlyph(c, size, 1f));
						var stbEm = CreateStbGlyph(stbFont, c, size, true);
						var stbPixelHeight = CreateStbGlyph(stbFont, c, size, false);
						WriteMetric(freeTypeMetrics, fontName, size, c, freeType);
						WriteMetric(stbMetrics, fontName, size, c, stbEm);
						if (StbTrueType.stbtt_FindGlyphIndex(stbFont, c) != 0)
						{
							emDifference.Add(freeType, stbEm);
							pixelHeightDifference.Add(freeType, stbPixelHeight);
						}
					}

					WriteDifference(differences, fontName, size, "mapping_em_to_pixels", emDifference);
					WriteDifference(differences, fontName, size, "pixel_height", pixelHeightDifference);
					Benchmark(timings, "FreeType", fontName, size, glyphs,
						c => GlyphSample.FromFreeType(freeTypeFont.CreateGlyph(c, size, 1f)));
					Benchmark(timings, "StbTrueTypeSharp", fontName, size, glyphs,
						c => CreateStbGlyph(stbFont, c, size, true));

					if (size is 14 or 24)
					{
						previewLines.Add(RenderLine(
							$"{fontName} {size} FreeType", size,
							PreviewText.Select(c => GlyphSample.FromFreeType(freeTypeFont.CreateGlyph(c, size, 1f)))));
						previewLines.Add(RenderLine(
							$"{fontName} {size} StbTrueTypeSharp", size,
							PreviewText.Select(c => CreateStbGlyph(stbFont, c, size, true))));
					}
				}
			}

			var previewPath = Path.Combine(outputDirectory, "ra-font-raster-preview.pgm");
			WriteRasterPreview(previewPath, previewLines);
			File.WriteAllLines(
				Path.Combine(outputDirectory, "ra-font-raster-preview-order.txt"),
				previewLines.Select((line, index) => $"{index + 1}: {line.Label}"));

			Console.WriteLine($"Wrote {glyphs.Length * Fonts.Length * Sizes.Length} glyph rows per rasterizer.");
			Console.WriteLine($"FreeType metrics: {freeTypeMetricsPath}");
			Console.WriteLine($"StbTrueTypeSharp metrics: {stbMetricsPath}");
			Console.WriteLine($"Metric and raster differences: {differencesPath}");
			Console.WriteLine($"Timings: {timingsPath}");
			Console.WriteLine($"Paired raster preview: {previewPath}");
		}

		static void Benchmark(
			StreamWriter writer, string rasterizer, string fontName, int size, char[] glyphs, Func<char, GlyphSample> createGlyph)
		{
			var allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
			var stopwatch = Stopwatch.StartNew();
			long checksum = 0;
			for (var round = 0; round < BenchmarkRounds; round++)
				foreach (var c in glyphs)
				{
					var glyph = createGlyph(c);
					checksum += glyph.Advance + glyph.OffsetX + glyph.OffsetY + glyph.Data.Length;
				}

			stopwatch.Stop();
			var allocatedBytes = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
			var samples = glyphs.Length * BenchmarkRounds;
			writer.WriteLine(string.Join(',',
				rasterizer,
				fontName,
				size.ToString(CultureInfo.InvariantCulture),
				glyphs.Length.ToString(CultureInfo.InvariantCulture),
				BenchmarkRounds.ToString(CultureInfo.InvariantCulture),
				stopwatch.Elapsed.TotalMilliseconds.ToString("F3", CultureInfo.InvariantCulture),
				(stopwatch.Elapsed.TotalMilliseconds * 1000 / samples).ToString("F3", CultureInfo.InvariantCulture),
				((double)allocatedBytes / samples).ToString("F1", CultureInfo.InvariantCulture),
				checksum.ToString(CultureInfo.InvariantCulture)));
		}
	}
}
