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
	/// <summary>
	/// A platform backend that renders nothing and plays nothing. Used to run the
	/// full game loop headless (benchmarks, CI, and browser bring-up before the
	/// WebGL2 backend exists).
	/// </summary>
	public sealed class NullPlatform : IPlatform
	{
		public IPlatformWindow CreateWindow(
			Size size, WindowMode windowMode, float scaleModifier, int vertexBatchSize, int indexBatchSize, int videoDisplay, GLProfile profile)
		{
			return new NullPlatformWindow(size);
		}

		public ISoundEngine CreateSound(string device)
		{
			return new NullSoundEngine();
		}

		public IFont CreateFont(byte[] data)
		{
			return new NullFont();
		}
	}

	sealed class NullPlatformWindow : IPlatformWindow
	{
		public NullPlatformWindow(Size size)
		{
			NativeWindowSize = size;
			Context = new NullGraphicsContext();
		}

		public IGraphicsContext Context { get; }

		public Size NativeWindowSize { get; }
		public Size EffectiveWindowSize => NativeWindowSize;
		public float NativeWindowScale => 1f;
		public float EffectiveWindowScale => 1f;
		public Size SurfaceSize => NativeWindowSize;
		public int DisplayCount => 1;
		public int CurrentDisplay => 0;
		public bool HasInputFocus => true;
		public bool IsSuspended => false;

		public event Action<float, float, float, float> OnWindowScaleChanged { add { } remove { } }

		public void PumpInput(IInputHandler inputHandler) { }
		public string GetClipboardText() { return ""; }
		public bool SetClipboardText(string text) { return false; }
		public bool TryOpenUrl(string url) { return false; }
		public void GrabWindowMouseFocus() { }
		public void ReleaseWindowMouseFocus() { }

		public IHardwareCursor CreateHardwareCursor(string name, Size size, byte[] data, int2 hotspot, bool pixelDouble)
		{
			return null;
		}

		public void SetHardwareCursor(IHardwareCursor cursor) { }
		public void SetWindowTitle(string title) { }
		public void SetRelativeMouseMode(bool mode) { }
		public void SetScaleModifier(float scale) { }

		public GLProfile GLProfile => GLProfile.Embedded;
		public GLProfile[] SupportedGLProfiles => [GLProfile.Embedded];

		public void Dispose() { }
	}

	sealed class NullFont : IFont
	{
		public FontGlyph CreateGlyph(char c, int size, float deviceScale)
		{
			// Nonzero advance keeps text layout code (line wrapping, widget
			// measurement) behaving sensibly without rendering anything.
			return new FontGlyph
			{
				Offset = new int2(0, 0),
				Size = new Size(1, 1),
				Advance = size / 2f,
				Data = new byte[1]
			};
		}

		public void Dispose() { }
	}
}
