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
	public sealed partial class BrowserInput
	{
		const int EventStride = 8;
		const int MaxEventsPerPump = 512;
		const int EventCountMask = 0xFFFF;
		const int ModifierShift = 16;

		const int MouseDown = 1;
		const int MouseUp = 2;
		const int MouseMove = 3;
		const int MouseWheel = 4;
		const int KeyDown = 5;
		const int KeyUp = 6;
		const int TextInput = 7;
		const int Focus = 8;

		readonly int[] eventBuffer = new int[EventStride * MaxEventsPerPump];
		MouseButton lastButtonBits = MouseButton.None;

		public bool DocumentFocused { get; private set; }
		public bool PointerOverCanvas { get; private set; }
		public bool HasInputFocus => DocumentFocused && PointerOverCanvas;

		[JSImport("initInput", "openra-input")]
		internal static partial void InitInput(string canvasSelector);

		[JSImport("drainEvents", "openra-input")]
		private static partial int DrainEvents([JSMarshalAs<JSType.MemoryView>] Span<int> events);

		[JSImport("drainText", "openra-input")]
		private static partial string DrainText(int index);

		[JSImport("getClipboardText", "openra-input")]
		internal static partial string GetClipboardText();

		[JSImport("setClipboardText", "openra-input")]
		internal static partial bool SetClipboardText(string text);

		static Modifiers MakeModifiers(int raw)
		{
			return (Modifiers)(raw & (int)(Modifiers.Shift | Modifiers.Alt | Modifiers.Ctrl | Modifiers.Meta));
		}

		static MouseButton MakeButton(int raw)
		{
			return (MouseButton)(raw & (int)(MouseButton.Left | MouseButton.Right | MouseButton.Middle));
		}

		static void FlushMotion(IInputHandler inputHandler, ref MouseInput? pendingMotion)
		{
			if (pendingMotion == null)
				return;

			inputHandler.OnMouseInput(pendingMotion.Value);
			pendingMotion = null;
		}

		public void Pump(IInputHandler inputHandler)
		{
			var drainResult = DrainEvents(eventBuffer);
			var eventCount = drainResult & EventCountMask;
			inputHandler.ModifierKeys(MakeModifiers(drainResult >> ModifierShift));
			MouseInput? pendingMotion = null;

			for (var eventIndex = 0; eventIndex < eventCount; eventIndex++)
			{
				var offset = eventIndex * EventStride;
				var eventType = eventBuffer[offset];
				switch (eventType)
				{
					case MouseDown:
					case MouseUp:
					{
						FlushMotion(inputHandler, ref pendingMotion);
						var button = MakeButton(eventBuffer[offset + 1]);
						var pos = new int2(eventBuffer[offset + 2], eventBuffer[offset + 3]);
						var mods = MakeModifiers(eventBuffer[offset + 4]);

						if (eventType == MouseDown)
						{
							lastButtonBits |= button;
							inputHandler.OnMouseInput(new MouseInput(
								MouseInputEvent.Down, button, pos, int2.Zero, mods,
								MultiTapDetection.DetectFromMouse((byte)button, pos)));
						}
						else
						{
							lastButtonBits &= ~button;
							inputHandler.OnMouseInput(new MouseInput(
								MouseInputEvent.Up, button, pos, int2.Zero, mods,
								MultiTapDetection.InfoFromMouse((byte)button)));
						}

						break;
					}

					case MouseMove:
					{
						lastButtonBits = MakeButton(eventBuffer[offset + 1]);
						var pos = new int2(eventBuffer[offset + 2], eventBuffer[offset + 3]);
						var delta = new int2(eventBuffer[offset + 4], eventBuffer[offset + 5]);
						var mods = MakeModifiers(eventBuffer[offset + 6]);
						pendingMotion = new MouseInput(
							MouseInputEvent.Move, lastButtonBits, pos, delta, mods, 0);
						break;
					}

					case MouseWheel:
					{
						var pos = new int2(eventBuffer[offset + 1], eventBuffer[offset + 2]);
						var delta = new int2(0, eventBuffer[offset + 3]);
						var mods = MakeModifiers(eventBuffer[offset + 4]);
						inputHandler.OnMouseInput(new MouseInput(
							MouseInputEvent.Scroll, MouseButton.None, pos, delta, mods, 0));
						break;
					}

					case KeyDown:
					case KeyUp:
					{
						var keyCode = (Keycode)eventBuffer[offset + 1];
						if (keyCode == Keycode.MOUSE4 || keyCode == Keycode.MOUSE5)
							FlushMotion(inputHandler, ref pendingMotion);

						var mods = MakeModifiers(eventBuffer[offset + 2]);
						var tapCount = eventType == KeyDown
							? MultiTapDetection.DetectFromKeyboard(keyCode, mods)
							: MultiTapDetection.InfoFromKeyboard(keyCode, mods);
						inputHandler.OnKeyInput(new KeyInput
						{
							Event = eventType == KeyDown ? KeyInputEvent.Down : KeyInputEvent.Up,
							Key = keyCode,
							Modifiers = mods,
							UnicodeChar = keyCode == Keycode.MOUSE4 || keyCode == Keycode.MOUSE5
								? '?' : (char)keyCode,
							MultiTapCount = tapCount,
							IsRepeat = eventBuffer[offset + 3] != 0
						});
						break;
					}

					case TextInput:
					{
						var text = DrainText(eventBuffer[offset + 1]);
						if (!string.IsNullOrEmpty(text))
							inputHandler.OnTextInput(text);

						break;
					}

					case Focus:
						DocumentFocused = eventBuffer[offset + 1] != 0;
						PointerOverCanvas = eventBuffer[offset + 2] != 0;
						break;
				}
			}

			FlushMotion(inputHandler, ref pendingMotion);
		}
	}
}
