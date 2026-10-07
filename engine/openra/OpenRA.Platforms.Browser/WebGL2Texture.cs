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
using System.Runtime.InteropServices;
using OpenRA.Primitives;

namespace OpenRA.Platforms.Browser
{
	sealed class WebGL2Texture : ITexture, IWebGL2Texture
	{
		readonly WebGL2GraphicsContext context;
		readonly int texture;
		TextureScaleFilter scaleFilter;
		Size size;
		bool disposed;

		public WebGL2Texture(WebGL2GraphicsContext context)
		{
			this.context = context;
			texture = BrowserGL.CreateTexture(context.Handle);
		}

		WebGL2GraphicsContext IWebGL2Texture.Context => context;

		int IWebGL2Texture.Handle
		{
			get
			{
				VerifyNotDisposed();
				return texture;
			}
		}

		public Size Size
		{
			get
			{
				VerifyNotDisposed();
				return size;
			}
		}

		public TextureScaleFilter ScaleFilter
		{
			get
			{
				VerifyNotDisposed();
				return scaleFilter;
			}

			set
			{
				VerifyNotDisposed();
				if (scaleFilter == value)
					return;

				scaleFilter = value;
				BrowserGL.SetTextureScale(context.Handle, texture, value == TextureScaleFilter.Linear);
			}
		}

		public void SetData(byte[] colors, int width, int height)
		{
			VerifyNotDisposed();
			ValidateSize(width, height);
			if (colors == null || colors.Length != checked(4 * width * height))
				throw new ArgumentException("Texture data length does not match its dimensions.", nameof(colors));

			BrowserGL.UploadBgraTexture(context.Handle, texture, width, height, colors.AsSpan());
			size = new Size(width, height);
		}

		public void SetFloatData(float[] data, int width, int height)
		{
			VerifyNotDisposed();
			ValidateSize(width, height);
			if (data == null || data.Length != checked(4 * width * height))
				throw new ArgumentException("Texture data length does not match its dimensions.", nameof(data));

			BrowserGL.UploadFloatTexture(context.Handle, texture, width, height, MemoryMarshal.AsBytes(data.AsSpan()));
			size = new Size(width, height);
		}

		internal void SetEmpty(int width, int height)
		{
			VerifyNotDisposed();
			ValidateSize(width, height);
			BrowserGL.AllocateTexture(context.Handle, texture, width, height);
			size = new Size(width, height);
		}

		public void SetDataFromReadBuffer(Rectangle rect)
		{
			VerifyNotDisposed();
			ValidateSize(rect.Width, rect.Height);
			BrowserGL.CopyTexture(context.Handle, texture, rect.X, rect.Y, rect.Width, rect.Height);
			size = new Size(rect.Width, rect.Height);
		}

		public byte[] GetData()
		{
			VerifyNotDisposed();
			var data = new byte[checked(4 * size.Width * size.Height)];
			BrowserGL.ReadTextureBgra(context.Handle, texture, size.Width, size.Height, data.AsSpan());
			return data;
		}

		static void ValidateSize(int width, int height)
		{
			if (!Exts.IsPowerOf2(width) || !Exts.IsPowerOf2(height))
				throw new InvalidDataException($"Non-power-of-two array {width}x{height}");
		}

		void VerifyNotDisposed()
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			context.VerifyNotDisposed();
		}

		public void Dispose()
		{
			if (disposed)
				return;

			disposed = true;
			context.VerifyNotDisposed();
			BrowserGL.DeleteTexture(context.Handle, texture);
		}
	}
}
