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
using System.Runtime.InteropServices;

namespace OpenRA.Platforms.Browser
{
	sealed class WebGL2VertexBuffer<T> : IVertexBuffer<T> where T : struct
	{
		const int ArrayBuffer = 0;
		static readonly int VertexSize = Marshal.SizeOf<T>();
		readonly WebGL2GraphicsContext context;
		readonly int buffer;
		bool disposed;

		public WebGL2VertexBuffer(WebGL2GraphicsContext context, int size)
		{
			this.context = context;
			buffer = BrowserGL.CreateEmptyBuffer(context.Handle, ArrayBuffer, checked(VertexSize * size), true);
		}

		public WebGL2VertexBuffer(WebGL2GraphicsContext context, T[] data, bool dynamic)
		{
			this.context = context;
			buffer = BrowserGL.CreateBuffer(context.Handle, ArrayBuffer, MemoryMarshal.AsBytes(data.AsSpan()), dynamic);
		}

		public void Bind()
		{
			VerifyNotDisposed();
			BrowserGL.BindBuffer(context.Handle, buffer, ArrayBuffer);
		}

		public void SetData(T[] vertices, int length)
		{
			SetData(vertices, 0, 0, length);
		}

		public void SetData(ref T[] vertices, int length)
		{
			SetData(vertices, 0, 0, length);
		}

		public void SetData(T[] vertices, int offset, int start, int length)
		{
			VerifyNotDisposed();
			vertices.AsSpan(offset, length);
			var data = MemoryMarshal.AsBytes(vertices.AsSpan());
			BrowserGL.UploadBuffer(
				context.Handle,
				buffer,
				ArrayBuffer,
				checked(VertexSize * start),
				checked(VertexSize * offset),
				checked(VertexSize * length),
				data);
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
			BrowserGL.DeleteBuffer(context.Handle, buffer);
		}
	}

	sealed class WebGL2IndexBuffer : IIndexBuffer
	{
		const int ElementArrayBuffer = 1;
		readonly WebGL2GraphicsContext context;
		readonly int buffer;
		bool disposed;

		public WebGL2IndexBuffer(WebGL2GraphicsContext context, uint[] indices)
		{
			this.context = context;
			buffer = BrowserGL.CreateBuffer(context.Handle, ElementArrayBuffer, MemoryMarshal.AsBytes(indices.AsSpan()), false);
		}

		public void Bind()
		{
			VerifyNotDisposed();
			BrowserGL.BindBuffer(context.Handle, buffer, ElementArrayBuffer);
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
			BrowserGL.DeleteBuffer(context.Handle, buffer);
		}
	}
}
