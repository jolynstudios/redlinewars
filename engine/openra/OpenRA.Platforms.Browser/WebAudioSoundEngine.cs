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
using System.Collections.Generic;
using System.IO;

namespace OpenRA.Platforms.Browser
{
	sealed class WebAudioSoundEngine : ISoundEngine
	{
		sealed class PoolSlot
		{
			public bool IsActive;
			public int FrameStarted;
			public WPos Pos;
			public bool IsRelative;
			public WebAudioSoundSource SoundSource;
			public WebAudioSound Sound;
		}

		const int MaxInstancesPerFrame = 3;
		const int GroupDistance = 2730;
		const int GroupDistanceSqr = GroupDistance * GroupDistance;

		// Match OpenAL Soft's default source limit and the desktop backend pool.
		const int PoolSize = 256;

		readonly PoolSlot[] sourcePool = new PoolSlot[PoolSize];
		readonly Dictionary<int, WebAudioSound> liveSounds = new(PoolSize);
		readonly int[] completedSounds = new int[PoolSize];
		float volume = 1f;
		bool disposed;

		public bool Dummy => false;

		public WebAudioSoundEngine()
		{
			BrowserAudio.Init();
			for (var i = 0; i < PoolSize; i++)
				sourcePool[i] = new PoolSlot();
		}

		public SoundDevice[] AvailableDevices()
		{
			return [new SoundDevice(null, "Default Output")];
		}

		void PumpCompletedSounds()
		{
			var count = BrowserAudio.DrainCompleted(completedSounds);
			for (var i = 0; i < count; i++)
				if (liveSounds.TryGetValue(completedSounds[i], out var sound))
					sound.MarkComplete();
		}

		void Register(WebAudioSound sound)
		{
			if (sound.Handle != 0)
				liveSounds.Add(sound.Handle, sound);
		}

		internal void Unregister(WebAudioSound sound)
		{
			if (sound.Handle != 0)
				liveSounds.Remove(sound.Handle);
		}

		bool TryGetSourceFromPool(out PoolSlot slot)
		{
			foreach (var candidate in sourcePool)
				if (!candidate.IsActive)
				{
					candidate.IsActive = true;
					slot = candidate;
					return true;
				}

			PumpCompletedSounds();
			PoolSlot firstFree = null;
			foreach (var candidate in sourcePool)
			{
				if (candidate.Sound == null || !candidate.Sound.Complete)
					continue;

				candidate.Sound.UnbindSource();
				candidate.SoundSource = null;
				candidate.Sound = null;
				candidate.IsActive = false;
				firstFree ??= candidate;
			}

			if (firstFree == null)
			{
				slot = null;
				return false;
			}

			firstFree.IsActive = true;
			slot = firstFree;
			return true;
		}

		public ISoundSource AddSoundSourceFromMemory(byte[] data, int channels, int sampleBits, int sampleRate)
		{
			return new WebAudioSoundSource(data, channels, sampleBits, sampleRate);
		}

		public ISound Play2D(ISoundSource soundSource, bool loop, bool relative, WPos pos, float volume, bool attenuateVolume)
		{
			if (soundSource == null)
			{
				Log.Write("sound", "Attempt to Play2D a null `ISoundSource`");
				return null;
			}

			var webAudioSoundSource = (WebAudioSoundSource)soundSource;
			var currFrame = Game.LocalTick;
			var atten = 1f;

			// Keep the desktop backend's same-source/location burst cap and active-source attenuation.
			if (attenuateVolume)
			{
				int instances = 0, activeCount = 0;
				foreach (var active in sourcePool)
				{
					if (!active.IsActive)
						continue;
					if (active.IsRelative != relative)
						continue;

					++activeCount;
					if (active.SoundSource != webAudioSoundSource)
						continue;
					if (currFrame - active.FrameStarted >= 5)
						continue;

					var lensqr = (active.Pos - pos).LengthSquared;
					if (lensqr >= GroupDistanceSqr)
						continue;

					if (++instances == MaxInstancesPerFrame)
						return null;
				}

				atten = 0.66f * ((PoolSize - activeCount * 0.5f) / PoolSize);
			}

			if (!TryGetSourceFromPool(out var slot))
				return null;

			slot.Pos = pos;
			slot.FrameStarted = currFrame;
			slot.IsRelative = relative;
			slot.SoundSource = webAudioSoundSource;
			var handle = BrowserAudio.Play(
				webAudioSoundSource.Handle, loop, relative, pos.X, pos.Y, pos.Z, volume * atten, false);
			slot.Sound = new WebAudioSound(this, handle);
			Register(slot.Sound);
			return slot.Sound;
		}

		public ISound Play2DStream(
			Stream stream, int channels, int sampleBits, int sampleRate, bool loop, bool relative, WPos pos, float volume)
		{
			if (!TryGetSourceFromPool(out var slot))
				return null;

			byte[] data;
			using (stream)
				data = stream.ReadAllBytes();

			using var soundSource = new WebAudioSoundSource(data, channels, sampleBits, sampleRate);
			var handle = BrowserAudio.Play(
				soundSource.Handle, loop, relative, pos.X, pos.Y, pos.Z, volume, true);
			slot.Pos = pos;
			slot.FrameStarted = Game.LocalTick;
			slot.IsRelative = relative;
			slot.SoundSource = null;
			slot.Sound = new WebAudioSound(this, handle);
			Register(slot.Sound);
			return slot.Sound;
		}

		public float Volume
		{
			get => volume;
			set => BrowserAudio.SetMasterVolume(volume = value);
		}

		public void PauseSound(ISound sound, bool paused)
		{
			if (sound == null || sound.Complete)
				return;

			((WebAudioSound)sound).Pause(paused);
		}

		public void SetAllSoundsPaused(bool paused)
		{
			BrowserAudio.PauseAll(paused);
		}

		public void SetSoundVolume(float newVolume, ISound music, ISound video)
		{
			PumpCompletedSounds();
			foreach (var slot in sourcePool)
				if (slot.IsActive && slot.Sound != null && !slot.Sound.Complete &&
					!ReferenceEquals(slot.Sound, music) && !ReferenceEquals(slot.Sound, video))
					slot.Sound.Volume = newVolume;
		}

		public void StopSound(ISound sound)
		{
			(sound as WebAudioSound)?.Stop();
		}

		public void StopAllSounds()
		{
			BrowserAudio.StopAll();
			foreach (var slot in sourcePool)
				slot.Sound?.MarkComplete();
		}

		public void SetListenerPosition(WPos position)
		{
			BrowserAudio.SetListener(position.X, position.Y, position.Z + 2133);
		}

		public void SetSoundLooping(bool looping, ISound sound)
		{
			(sound as WebAudioSound)?.SetLooping(looping);
		}

		public void SetSoundPosition(ISound sound, WPos position)
		{
			(sound as WebAudioSound)?.SetPosition(position);
		}

		public void Dispose()
		{
			if (disposed)
				return;

			disposed = true;
			StopAllSounds();
			foreach (var slot in sourcePool)
			{
				slot.Sound?.UnbindSource();
				slot.SoundSource = null;
				slot.Sound = null;
				slot.IsActive = false;
			}

			liveSounds.Clear();
			BrowserAudio.Dispose();
		}
	}

	sealed class WebAudioSoundSource : ISoundSource
	{
		int handle;
		bool disposed;

		internal int Handle
		{
			get
			{
				ObjectDisposedException.ThrowIf(disposed, this);
				return handle;
			}
		}

		public WebAudioSoundSource(byte[] data, int channels, int sampleBits, int sampleRate)
		{
			handle = BrowserAudio.CreateBuffer(channels, sampleBits, sampleRate, data);
		}

		public void Dispose()
		{
			if (disposed)
				return;

			BrowserAudio.DeleteBuffer(handle);
			handle = 0;
			disposed = true;
		}
	}

	sealed class WebAudioSound : ISound
	{
		readonly WebAudioSoundEngine engine;
		bool complete;
		bool done;

		internal int Handle { get; private set; }

		public WebAudioSound(WebAudioSoundEngine engine, int handle)
		{
			this.engine = engine;
			Handle = handle;
			complete = handle == 0;
		}

		internal void MarkComplete()
		{
			complete = true;
		}

		internal void UnbindSource()
		{
			if (done)
				return;

			engine.Unregister(this);
			BrowserAudio.DeleteSound(Handle);
			Handle = 0;
			done = true;
			complete = true;
		}

		public float Volume
		{
			get => done ? float.NaN : BrowserAudio.GetSoundVolume(Handle);
			set
			{
				if (!done)
					BrowserAudio.SetSoundVolume(Handle, value);
			}
		}

		public float SeekPosition => done ? float.NaN : BrowserAudio.GetSeek(Handle);

		public bool Complete
		{
			get
			{
				if (done || complete)
					return true;

				return complete = BrowserAudio.IsComplete(Handle);
			}
		}

		public void SetPosition(WPos pos)
		{
			if (!done)
				BrowserAudio.SetSoundPosition(Handle, pos.X, pos.Y, pos.Z);
		}

		internal void Pause(bool paused)
		{
			if (!done)
				BrowserAudio.PauseSound(Handle, paused);
		}

		internal void Stop()
		{
			if (done || complete)
				return;

			BrowserAudio.StopSound(Handle);
			complete = true;
		}

		internal void SetLooping(bool looping)
		{
			if (!done)
				BrowserAudio.SetLooping(Handle, looping);
		}
	}
}
