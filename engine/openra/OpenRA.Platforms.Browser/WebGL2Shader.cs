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
using System.Text.Json;

namespace OpenRA.Platforms.Browser
{
	sealed class WebGL2Shader : IShader
	{
		readonly WebGL2GraphicsContext context;
		readonly int program;

		public WebGL2Shader(WebGL2GraphicsContext context, IShaderBindings bindings)
		{
			this.context = context;
			var vertexCode = bindings.VertexShaderCode.Replace("{VERSION}", "300 es");
			var fragmentCode = bindings.FragmentShaderCode.Replace("{VERSION}", "300 es");
			var attributes = JsonSerializer.Serialize(bindings.Attributes);
			program = BrowserGL.CreateProgram(
				context.Handle, vertexCode, fragmentCode,
				bindings.VertexShaderName, bindings.FragmentShaderName, attributes, bindings.Stride);
		}

		public void Bind()
		{
			context.VerifyNotDisposed();
			BrowserGL.BindProgramAttributes(context.Handle, program);
		}

		public void PrepareRender()
		{
			context.VerifyNotDisposed();
			BrowserGL.PrepareProgram(context.Handle, program);
		}

		public void SetTexture(string name, ITexture texture)
		{
			context.VerifyNotDisposed();
			if (texture == null)
				return;

			if (texture is not IWebGL2Texture webTexture || webTexture.Context != context)
				throw new ArgumentException("Texture belongs to another graphics context.", nameof(texture));

			BrowserGL.SetProgramTexture(context.Handle, program, name, webTexture.Handle);
		}

		public void SetBool(string name, bool value)
		{
			context.VerifyNotDisposed();
			BrowserGL.SetUniformInt(context.Handle, program, name, value ? 1 : 0);
		}

		public void SetVec(string name, float x)
		{
			context.VerifyNotDisposed();
			BrowserGL.SetUniformFloat(context.Handle, program, name, x);
		}

		public void SetVec(string name, float x, float y)
		{
			context.VerifyNotDisposed();
			BrowserGL.SetUniformVec2(context.Handle, program, name, x, y);
		}

		public void SetVec(string name, float x, float y, float z)
		{
			context.VerifyNotDisposed();
			BrowserGL.SetUniformVec3(context.Handle, program, name, x, y, z);
		}

		public void SetVec(string name, ReadOnlyMemory<float> vec, int length)
		{
			context.VerifyNotDisposed();
			if (length is < 1 or > 4 || vec.Length < length)
				throw new InvalidDataException("Invalid vector length");

			var value = vec.Span;
			switch (length)
			{
				case 1: BrowserGL.SetUniformFloat(context.Handle, program, name, value[0]); break;
				case 2: BrowserGL.SetUniformVec2(context.Handle, program, name, value[0], value[1]); break;
				case 3: BrowserGL.SetUniformVec3(context.Handle, program, name, value[0], value[1], value[2]); break;
				case 4: BrowserGL.SetUniformVec4(context.Handle, program, name, value[0], value[1], value[2], value[3]); break;
			}
		}

		public void SetMatrix(string name, float[] mtx)
		{
			context.VerifyNotDisposed();
			if (mtx.Length != 16)
				throw new InvalidDataException("Invalid 4x4 matrix");

			BrowserGL.SetUniformMatrix(
				context.Handle, program, name,
				mtx[0], mtx[1], mtx[2], mtx[3],
				mtx[4], mtx[5], mtx[6], mtx[7],
				mtx[8], mtx[9], mtx[10], mtx[11],
				mtx[12], mtx[13], mtx[14], mtx[15]);
		}
	}

	interface IWebGL2Texture
	{
		WebGL2GraphicsContext Context { get; }
		int Handle { get; }
	}
}
