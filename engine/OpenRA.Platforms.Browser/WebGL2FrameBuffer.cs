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

namespace OpenRA.Platforms.Browser
{
	sealed class WebGL2FrameBuffer : IFrameBuffer
	{
		readonly WebGL2GraphicsContext context;
		readonly WebGL2Texture texture;
		readonly Color clearColor;
		readonly int frameBuffer;
		bool scissored;
		bool disposed;

		public WebGL2FrameBuffer(WebGL2GraphicsContext context, Size size, Color clearColor)
		{
			if (!Exts.IsPowerOf2(size.Width) || !Exts.IsPowerOf2(size.Height))
				throw new InvalidDataException($"Frame buffer size ({size.Width}x{size.Height}) must be a power of two");

			this.context = context;
			this.clearColor = clearColor;
			texture = new WebGL2Texture(context);
			texture.SetEmpty(size.Width, size.Height);
			frameBuffer = BrowserGL.CreateFrameBuffer(context.Handle, ((IWebGL2Texture)texture).Handle, size.Width, size.Height);
		}

		public ITexture Texture
		{
			get
			{
				VerifyNotDisposed();
				return texture;
			}
		}

		public void Bind()
		{
			VerifyNotDisposed();
			BrowserGL.BindFrameBuffer(
				context.Handle, frameBuffer,
				clearColor.R / 255f, clearColor.G / 255f, clearColor.B / 255f, clearColor.A / 255f);
		}

		public void Unbind()
		{
			VerifyNotDisposed();
			if (scissored)
				throw new InvalidOperationException("Attempting to unbind FrameBuffer with an active scissor region.");

			BrowserGL.UnbindFrameBuffer(context.Handle, frameBuffer);
		}

		public void EnableScissor(Rectangle rect)
		{
			VerifyNotDisposed();
			BrowserGL.EnableScissor(context.Handle, rect.X, rect.Y, rect.Width, rect.Height);
			scissored = true;
		}

		public void DisableScissor()
		{
			VerifyNotDisposed();
			BrowserGL.DisableScissor(context.Handle);
			scissored = false;
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
			BrowserGL.DeleteFrameBuffer(context.Handle, frameBuffer);
			texture.Dispose();
		}
	}
}
