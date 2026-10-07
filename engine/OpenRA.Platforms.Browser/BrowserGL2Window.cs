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
	sealed class BrowserGL2Window : IPlatformWindow
	{
		readonly BrowserInput input = new();
		bool disposed;

		public BrowserGL2Window()
		{
			BrowserInput.InitInput("#openra-canvas");
			var context = new WebGL2GraphicsContext("#openra-canvas");
			Context = context;

			// The drawing buffer is sized by the page (fullscreen CSS) when the
			// context is created; mirror whatever it chose.
			CanvasSize = new Size(
				BrowserGL.GetDrawingWidth(context.Handle),
				BrowserGL.GetDrawingHeight(context.Handle));
		}

		Size CanvasSize { get; }

		public IGraphicsContext Context { get; }
		public Size NativeWindowSize => CanvasSize;
		public Size EffectiveWindowSize => CanvasSize;
		public float NativeWindowScale => 1f;
		public float EffectiveWindowScale => 1f;
		public Size SurfaceSize => CanvasSize;
		public int DisplayCount => 1;
		public int CurrentDisplay => 0;
		public bool HasInputFocus => input.HasInputFocus;
		public bool IsSuspended
		{
			get
			{
				if (((WebGL2GraphicsContext)Context).IsContextLost)
					throw new InvalidOperationException("WebGL2 context is lost. Reload the page to continue.");

				return false;
			}
		}

		public event Action<float, float, float, float> OnWindowScaleChanged { add { } remove { } }

		public void PumpInput(IInputHandler inputHandler) { input.Pump(inputHandler); }
		public string GetClipboardText() { return BrowserInput.GetClipboardText(); }
		public bool SetClipboardText(string text) { return BrowserInput.SetClipboardText(text); }
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

		public void Dispose()
		{
			if (disposed)
				return;

			disposed = true;
			Context.Dispose();
		}
	}
}
