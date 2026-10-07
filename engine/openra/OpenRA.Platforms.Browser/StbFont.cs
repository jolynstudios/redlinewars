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
using System.IO;
using OpenRA.Primitives;
using StbTrueTypeSharp;

namespace OpenRA.Platforms.Browser
{
	sealed class StbFont : IFont
	{
		readonly StbTrueType.stbtt_fontinfo font;
		bool disposed;

		public StbFont(byte[] data)
		{
			font = StbTrueType.CreateFont(data, 0) ?? throw new InvalidDataException("Failed to initialize font");
		}

		public unsafe FontGlyph CreateGlyph(char c, int size, float deviceScale)
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			var scaledSize = (int)(size * deviceScale);
			if (scaledSize <= 0)
				return default;

			// FreeType's pixel size maps to the font EM square. ScaleForMappingEmToPixels
			// preserves that contract; ScaleForPixelHeight produces visibly different UI metrics.
			var scale = StbTrueType.stbtt_ScaleForMappingEmToPixels(font, scaledSize);
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
			var glyphData = new byte[width * height];
			if (glyphData.Length != 0)
				fixed (byte* output = glyphData)
					StbTrueType.stbtt_MakeCodepointBitmap(font, output, width, height, width, scale, scale, c);

			return new FontGlyph
			{
				Advance = MathF.Round(advance * scale),
				Offset = new int2(x0, y0),
				Size = new Size(width, height),
				Data = glyphData
			};
		}

		public void Dispose()
		{
			if (disposed)
				return;

			disposed = true;
			font.Dispose();
		}
	}
}
