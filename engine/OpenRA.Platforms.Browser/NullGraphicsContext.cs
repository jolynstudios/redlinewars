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

using OpenRA.Primitives;

namespace OpenRA.Platforms.Browser
{
	sealed class NullGraphicsContext : IGraphicsContext
	{
		public IVertexBuffer<T> CreateEmptyVertexBuffer<T>(int size) where T : struct
		{
			return new NullVertexBuffer<T>();
		}

		public IVertexBuffer<T> CreateVertexBuffer<T>(T[] data, bool dynamic = true) where T : struct
		{
			return new NullVertexBuffer<T>();
		}

		public T[] CreateVertices<T>(int size) where T : struct
		{
			return new T[size];
		}

		public IIndexBuffer CreateIndexBuffer(uint[] indices)
		{
			return new NullIndexBuffer();
		}

		public ITexture CreateTexture()
		{
			return new NullTexture();
		}

		public IFrameBuffer CreateFrameBuffer(Size s)
		{
			return new NullFrameBuffer(s);
		}

		public IFrameBuffer CreateFrameBuffer(Size s, Color clearColor)
		{
			return new NullFrameBuffer(s);
		}

		public IShader CreateShader(IShaderBindings shaderBindings)
		{
			return new NullShader();
		}

		public void EnableScissor(int x, int y, int width, int height) { }
		public void DisableScissor() { }
		public void Present() { }
		public void DrawPrimitives(PrimitiveType pt, int firstVertex, int numVertices) { }
		public void DrawElements(int numIndices, int offset) { }
		public void Clear() { }
		public void EnableDepthBuffer() { }
		public void DisableDepthBuffer() { }
		public void ClearDepthBuffer() { }
		public void SetBlendMode(BlendMode mode) { }
		public void SetVSyncEnabled(bool enabled) { }
		public string GLVersion => "Null";

		public void Dispose() { }
	}

	sealed class NullVertexBuffer<T> : IVertexBuffer<T> where T : struct
	{
		public void Bind() { }
		public void SetData(T[] vertices, int length) { }
		public void SetData(ref T[] vertices, int length) { }
		public void SetData(T[] vertices, int offset, int start, int length) { }
		public void Dispose() { }
	}

	sealed class NullIndexBuffer : IIndexBuffer
	{
		public void Bind() { }
		public void Dispose() { }
	}

	sealed class NullTexture : ITexture
	{
		public Size Size { get; private set; } = new(1, 1);
		public TextureScaleFilter ScaleFilter { get; set; }

		public void SetData(byte[] colors, int width, int height)
		{
			Size = new Size(width, height);
		}

		public void SetFloatData(float[] data, int width, int height)
		{
			Size = new Size(width, height);
		}

		public void SetDataFromReadBuffer(Rectangle rect)
		{
			Size = new Size(rect.Width, rect.Height);
		}

		public byte[] GetData()
		{
			return new byte[4 * Size.Width * Size.Height];
		}

		public void Dispose() { }
	}

	sealed class NullFrameBuffer : IFrameBuffer
	{
		public NullFrameBuffer(Size size)
		{
			var texture = new NullTexture();
			texture.SetData(null, size.Width, size.Height);
			Texture = texture;
		}

		public ITexture Texture { get; }

		public void Bind() { }
		public void Unbind() { }
		public void EnableScissor(Rectangle rect) { }
		public void DisableScissor() { }
		public void Dispose() { }
	}

	sealed class NullShader : IShader
	{
		public void SetBool(string name, bool value) { }
		public void SetVec(string name, float x) { }
		public void SetVec(string name, float x, float y) { }
		public void SetVec(string name, float x, float y, float z) { }
		public void SetVec(string name, System.ReadOnlyMemory<float> vec, int length) { }
		public void SetTexture(string param, ITexture texture) { }
		public void SetMatrix(string param, float[] mtx) { }
		public void PrepareRender() { }
		public void Bind() { }
	}
}
