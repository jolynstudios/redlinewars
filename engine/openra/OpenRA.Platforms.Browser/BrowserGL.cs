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
using System.Runtime.InteropServices.JavaScript;

namespace OpenRA.Platforms.Browser
{
	public static partial class BrowserGL
	{
		[JSImport("createContext", "openra-gl")]
		internal static partial int CreateContext(string canvasSelector);

		[JSImport("destroyContext", "openra-gl")]
		internal static partial void DestroyContext(int context);

		[JSImport("isContextLost", "openra-gl")]
		internal static partial bool IsContextLost(int context);

		[JSImport("getDrawingWidth", "openra-gl")]
		internal static partial int GetDrawingWidth(int context);

		[JSImport("getDrawingHeight", "openra-gl")]
		internal static partial int GetDrawingHeight(int context);

		[JSImport("getGlVersion", "openra-gl")]
		internal static partial string GetGlVersion(int context);

		[JSImport("clear", "openra-gl")]
		internal static partial void Clear(int context);

		[JSImport("enableScissor", "openra-gl")]
		internal static partial void EnableScissor(int context, int x, int y, int width, int height);

		[JSImport("disableScissor", "openra-gl")]
		internal static partial void DisableScissor(int context);

		[JSImport("createEmptyBuffer", "openra-gl")]
		internal static partial int CreateEmptyBuffer(int context, int target, int size, bool dynamic);

		[JSImport("createBuffer", "openra-gl")]
		internal static partial int CreateBuffer(
			int context,
			int target,
			[JSMarshalAs<JSType.MemoryView>] Span<byte> data,
			bool dynamic);

		[JSImport("uploadBuffer", "openra-gl")]
		internal static partial void UploadBuffer(
			int context,
			int buffer,
			int target,
			int destinationOffset,
			int sourceOffset,
			int length,
			[JSMarshalAs<JSType.MemoryView>] Span<byte> data);

		[JSImport("bindBuffer", "openra-gl")]
		internal static partial void BindBuffer(int context, int buffer, int target);

		[JSImport("deleteBuffer", "openra-gl")]
		internal static partial void DeleteBuffer(int context, int buffer);

		[JSImport("createProgram", "openra-gl")]
		internal static partial int CreateProgram(
			int context,
			string vertexCode,
			string fragmentCode,
			string vertexName,
			string fragmentName,
			string attributes,
			int stride);

		[JSImport("bindProgramAttributes", "openra-gl")]
		internal static partial void BindProgramAttributes(int context, int program);

		[JSImport("prepareProgram", "openra-gl")]
		internal static partial void PrepareProgram(int context, int program);

		[JSImport("setProgramTexture", "openra-gl")]
		internal static partial void SetProgramTexture(int context, int program, string name, int texture);

		[JSImport("setUniformInt", "openra-gl")]
		internal static partial void SetUniformInt(int context, int program, string name, int value);

		[JSImport("setUniformFloat", "openra-gl")]
		internal static partial void SetUniformFloat(int context, int program, string name, float value);

		[JSImport("setUniformVec2", "openra-gl")]
		internal static partial void SetUniformVec2(int context, int program, string name, float x, float y);

		[JSImport("setUniformVec3", "openra-gl")]
		internal static partial void SetUniformVec3(int context, int program, string name, float x, float y, float z);

		[JSImport("setUniformVec4", "openra-gl")]
		internal static partial void SetUniformVec4(int context, int program, string name, float x, float y, float z, float w);

		[JSImport("setUniformMatrix", "openra-gl")]
		internal static partial void SetUniformMatrix(
			int context,
			int program,
			string name,
			float m0, float m1, float m2, float m3,
			float m4, float m5, float m6, float m7,
			float m8, float m9, float m10, float m11,
			float m12, float m13, float m14, float m15);

		[JSImport("drawArrays", "openra-gl")]
		internal static partial void DrawArrays(int context, int primitiveType, int firstVertex, int numVertices);

		[JSImport("drawElements", "openra-gl")]
		internal static partial void DrawElements(int context, int numIndices, int offset);

		[JSImport("enableDepth", "openra-gl")]
		internal static partial void EnableDepth(int context);

		[JSImport("disableDepth", "openra-gl")]
		internal static partial void DisableDepth(int context);

		[JSImport("clearDepth", "openra-gl")]
		internal static partial void ClearDepth(int context);

		[JSImport("setBlendMode", "openra-gl")]
		internal static partial void SetBlendMode(int context, int mode);

		[JSImport("createTexture", "openra-gl")]
		internal static partial int CreateTexture(int context);

		[JSImport("deleteTexture", "openra-gl")]
		internal static partial void DeleteTexture(int context, int texture);

		[JSImport("setTextureScale", "openra-gl")]
		internal static partial void SetTextureScale(int context, int texture, bool linear);

		[JSImport("uploadBgraTexture", "openra-gl")]
		internal static partial void UploadBgraTexture(
			int context,
			int texture,
			int width,
			int height,
			[JSMarshalAs<JSType.MemoryView>] Span<byte> data);

		[JSImport("uploadFloatTexture", "openra-gl")]
		internal static partial void UploadFloatTexture(
			int context,
			int texture,
			int width,
			int height,
			[JSMarshalAs<JSType.MemoryView>] Span<byte> data);

		[JSImport("allocateTexture", "openra-gl")]
		internal static partial void AllocateTexture(int context, int texture, int width, int height);

		[JSImport("copyTexture", "openra-gl")]
		internal static partial void CopyTexture(int context, int texture, int x, int y, int width, int height);

		[JSImport("readTextureBgra", "openra-gl")]
		internal static partial void ReadTextureBgra(
			int context,
			int texture,
			int width,
			int height,
			[JSMarshalAs<JSType.MemoryView>] Span<byte> data);

		[JSImport("createFrameBuffer", "openra-gl")]
		internal static partial int CreateFrameBuffer(int context, int texture, int width, int height);

		[JSImport("deleteFrameBuffer", "openra-gl")]
		internal static partial void DeleteFrameBuffer(int context, int frameBuffer);

		[JSImport("bindFrameBuffer", "openra-gl")]
		internal static partial void BindFrameBuffer(
			int context,
			int frameBuffer,
			float red,
			float green,
			float blue,
			float alpha);

		[JSImport("unbindFrameBuffer", "openra-gl")]
		internal static partial void UnbindFrameBuffer(int context, int frameBuffer);
	}
}
