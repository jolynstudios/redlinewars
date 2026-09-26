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
using OpenRA.Primitives;

namespace OpenRA.Platforms.Browser
{
	sealed class WebGL2GraphicsContext : IGraphicsContext
	{
		readonly int context;
		bool disposed;
		internal int Handle
		{
			get
			{
				VerifyNotDisposed();
				return context;
			}
		}

		public WebGL2GraphicsContext(string canvasSelector)
		{
			context = BrowserGL.CreateContext(canvasSelector);
		}

		internal bool IsContextLost
		{
			get
			{
				VerifyNotDisposed();
				return BrowserGL.IsContextLost(context);
			}
		}

		public string GLVersion
		{
			get
			{
				VerifyNotDisposed();
				return BrowserGL.GetGlVersion(context);
			}
		}

		public IVertexBuffer<T> CreateEmptyVertexBuffer<T>(int size) where T : struct
		{
			VerifyNotDisposed();
			return new WebGL2VertexBuffer<T>(this, size);
		}

		public IVertexBuffer<T> CreateVertexBuffer<T>(T[] data, bool dynamic = true) where T : struct
		{
			VerifyNotDisposed();
			return new WebGL2VertexBuffer<T>(this, data, dynamic);
		}

		public T[] CreateVertices<T>(int size) where T : struct
		{
			VerifyNotDisposed();
			return new T[size];
		}

		public IIndexBuffer CreateIndexBuffer(uint[] indices)
		{
			VerifyNotDisposed();
			return new WebGL2IndexBuffer(this, indices);
		}

		public ITexture CreateTexture()
		{
			VerifyNotDisposed();
			return new WebGL2Texture(this);
		}

		public IFrameBuffer CreateFrameBuffer(Size s)
		{
			VerifyNotDisposed();
			return new WebGL2FrameBuffer(this, s, Color.FromArgb(0));
		}

		public IFrameBuffer CreateFrameBuffer(Size s, Color clearColor)
		{
			VerifyNotDisposed();
			return new WebGL2FrameBuffer(this, s, clearColor);
		}

		public IShader CreateShader(IShaderBindings shaderBindings)
		{
			VerifyNotDisposed();
			return new WebGL2Shader(this, shaderBindings);
		}

		public void EnableScissor(int x, int y, int width, int height)
		{
			VerifyNotDisposed();
			BrowserGL.EnableScissor(context, x, y, width, height);
		}

		public void DisableScissor()
		{
			VerifyNotDisposed();
			BrowserGL.DisableScissor(context);
		}

		public void Present()
		{
			VerifyNotDisposed();
		}

		public void DrawPrimitives(PrimitiveType pt, int firstVertex, int numVertices)
		{
			VerifyNotDisposed();
			BrowserGL.DrawArrays(context, (int)pt, firstVertex, numVertices);
		}

		public void DrawElements(int numIndices, int offset)
		{
			VerifyNotDisposed();
			BrowserGL.DrawElements(context, numIndices, offset);
		}

		public void Clear()
		{
			VerifyNotDisposed();
			BrowserGL.Clear(context);
		}

		public void EnableDepthBuffer()
		{
			VerifyNotDisposed();
			BrowserGL.EnableDepth(context);
		}

		public void DisableDepthBuffer()
		{
			VerifyNotDisposed();
			BrowserGL.DisableDepth(context);
		}

		public void ClearDepthBuffer()
		{
			VerifyNotDisposed();
			BrowserGL.ClearDepth(context);
		}

		public void SetBlendMode(BlendMode mode)
		{
			VerifyNotDisposed();
			BrowserGL.SetBlendMode(context, (int)mode);
		}

		public void SetVSyncEnabled(bool enabled) { VerifyNotDisposed(); }

		internal void VerifyNotDisposed()
		{
			ObjectDisposedException.ThrowIf(disposed, this);
		}

		public void Dispose()
		{
			if (disposed)
				return;

			disposed = true;
			BrowserGL.DestroyContext(context);
		}
	}
}
