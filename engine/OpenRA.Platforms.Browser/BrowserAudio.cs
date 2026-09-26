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
	public static partial class BrowserAudio
	{
		[JSImport("init", "openra-audio")]
		internal static partial void Init();

		[JSImport("createBuffer", "openra-audio")]
		internal static partial int CreateBuffer(
			int channels,
			int sampleBits,
			int sampleRate,
			[JSMarshalAs<JSType.MemoryView>] Span<byte> data);

		[JSImport("deleteBuffer", "openra-audio")]
		internal static partial void DeleteBuffer(int buffer);

		[JSImport("play", "openra-audio")]
		internal static partial int Play(
			int buffer,
			bool looping,
			bool relative,
			float x,
			float y,
			float z,
			float volume,
			bool deferUntilUnlock);

		[JSImport("deleteSound", "openra-audio")]
		internal static partial void DeleteSound(int sound);

		[JSImport("pauseSound", "openra-audio")]
		internal static partial void PauseSound(int sound, bool paused);

		[JSImport("pauseAll", "openra-audio")]
		internal static partial void PauseAll(bool paused);

		[JSImport("stopSound", "openra-audio")]
		internal static partial void StopSound(int sound);

		[JSImport("stopAll", "openra-audio")]
		internal static partial void StopAll();

		[JSImport("setLooping", "openra-audio")]
		internal static partial void SetLooping(int sound, bool looping);

		[JSImport("setSoundPosition", "openra-audio")]
		internal static partial void SetSoundPosition(int sound, float x, float y, float z);

		[JSImport("getSoundVolume", "openra-audio")]
		internal static partial float GetSoundVolume(int sound);

		[JSImport("setSoundVolume", "openra-audio")]
		internal static partial void SetSoundVolume(int sound, float volume);

		[JSImport("getSeek", "openra-audio")]
		internal static partial float GetSeek(int sound);

		[JSImport("isComplete", "openra-audio")]
		internal static partial bool IsComplete(int sound);

		[JSImport("drainCompleted", "openra-audio")]
		internal static partial int DrainCompleted([JSMarshalAs<JSType.MemoryView>] Span<int> sounds);

		[JSImport("setListener", "openra-audio")]
		internal static partial void SetListener(float x, float y, float z);

		[JSImport("setMasterVolume", "openra-audio")]
		internal static partial void SetMasterVolume(float volume);

		[JSImport("dispose", "openra-audio")]
		internal static partial void Dispose();
	}
}
