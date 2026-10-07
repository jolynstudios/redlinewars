// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

const MinSampleRate = 8000;
const MaxSampleRate = 96000;

// Handle zero is reserved for one-shots intentionally dropped before the
// browser audio context has been unlocked by a user gesture.
const buffers = [null];
const freeBuffers = [];
const sounds = [null];
const freeSounds = [];
const completedSounds = [];

let context;
let masterGain;
let startedVoiceCount = 0;
let unlocked = false;

function allocate(slots, free, value) {
	if (free.length !== 0) {
		const handle = free.pop();
		slots[handle] = value;
		return handle;
	}

	slots.push(value);
	return slots.length - 1;
}

function release(slots, free, handle, kind) {
	if (!Number.isInteger(handle) || handle <= 0 || handle >= slots.length || slots[handle] === null) {
		throw new Error(`Invalid or disposed Web Audio ${kind} handle ${handle}.`);
	}

	slots[handle] = null;
	free.push(handle);
}

function getBuffer(handle) {
	const buffer = buffers[handle];
	if (!buffer) {
		throw new Error(`Invalid or disposed Web Audio buffer handle ${handle}.`);
	}

	return buffer;
}

function getSound(handle) {
	const sound = sounds[handle];
	if (!sound) {
		throw new Error(`Invalid or disposed Web Audio sound handle ${handle}.`);
	}

	return sound;
}

function setPosition(target, x, y, z) {
	if (target.positionX) {
		target.positionX.value = x;
		target.positionY.value = y;
		target.positionZ.value = z;
	} else {
		target.setPosition(x, y, z);
	}
}

function setListenerOrientation(listener) {
	if (listener.forwardX) {
		listener.forwardX.value = 0;
		listener.forwardY.value = 0;
		listener.forwardZ.value = 1;
		listener.upX.value = 0;
		listener.upY.value = -1;
		listener.upZ.value = 0;
	} else {
		listener.setOrientation(0, 0, 1, 0, -1, 0);
	}
}

function normalizedOffset(sound, offset) {
	if (sound.buffer.duration <= 0) {
		return 0;
	}

	return sound.looping
		? ((offset % sound.buffer.duration) + sound.buffer.duration) % sound.buffer.duration
		: Math.max(0, Math.min(offset, sound.buffer.duration));
}

function seek(sound) {
	if (sound.state === 'playing') {
		return normalizedOffset(sound, context.currentTime - sound.startedAt);
	}

	return normalizedOffset(sound, sound.offset);
}

function stopSource(sound) {
	if (!sound.source) {
		return;
	}

	const source = sound.source;
	sound.source = null;
	sound.generation++;
	try {
		source.stop();
	} catch {
		// A naturally completed source may already be stopped.
	}

	source.disconnect();
}

function markComplete(sound) {
	if (sound.state === 'complete') {
		return;
	}

	sound.state = 'complete';
	sound.offset = sound.buffer.duration;
	completedSounds.push(sound.handle);
}

function startSound(sound) {
	if (!context || !unlocked || context.state !== 'running' || sound.state === 'complete') {
		return false;
	}

	const offset = normalizedOffset(sound, sound.offset);
	if (!sound.looping && offset >= sound.buffer.duration) {
		markComplete(sound);
		return false;
	}

	const source = context.createBufferSource();
	source.buffer = sound.buffer;
	source.loop = sound.looping;
	source.connect(sound.panner ?? sound.gain);
	const generation = ++sound.generation;
	source.addEventListener('ended', () => {
		if (sound.generation !== generation || sound.source !== source) {
			return;
		}

		sound.source = null;
		if (!sound.looping) {
			markComplete(sound);
		}
	}, { once: true });

	sound.source = source;
	sound.offset = offset;
	sound.startedAt = context.currentTime - offset;
	sound.state = 'playing';
	startedVoiceCount++;
	source.start(0, offset);
	return true;
}

function startPendingSounds() {
	for (let handle = 1; handle < sounds.length; handle++) {
		const sound = sounds[handle];
		if (sound?.state === 'pending') {
			startSound(sound);
		}
	}
}

function pause(sound, paused) {
	if (sound.state === 'complete') {
		return;
	}

	if (paused) {
		if (sound.state === 'playing') {
			sound.offset = seek(sound);
			stopSource(sound);
		}

		if (sound.state === 'playing' || sound.state === 'pending') {
			sound.state = 'paused';
		}
	} else if (sound.state === 'paused') {
		if (context.state === 'running') {
			startSound(sound);
		} else {
			sound.state = 'pending';
		}
	}
}

export function init() {
	if (context && context.state !== 'closed') {
		return;
	}

	const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
	if (!AudioContext) {
		throw new Error('Web Audio is not supported by this browser.');
	}

	context = new AudioContext({ latencyHint: 'interactive' });
	unlocked = false;
	if (context.state === 'running') {
		context.suspend().catch(() => { });
	}

	masterGain = context.createGain();
	masterGain.gain.value = 1;
	masterGain.connect(context.destination);
	setListenerOrientation(context.listener);
}

export async function unlock() {
	init();
	unlocked = true;
	try {
		// This call must be made before the first await so it remains in the browser's
		// user-gesture call stack, even when init queued a defensive suspend above.
		await context.resume();
	} catch {
		unlocked = false;
		return false;
	}

	if (context.state === 'running') {
		startPendingSounds();
		return true;
	}

	return false;
}

export function createBuffer(channels, sampleBits, sampleRate, data) {
	init();
	if (!Number.isInteger(channels) || channels <= 0) {
		throw new Error(`Invalid channel count ${channels}.`);
	}

	if (sampleBits !== 8 && sampleBits !== 16) {
		throw new Error(`Unsupported PCM sample size ${sampleBits}.`);
	}

	const copied = data.slice();
	const bytes = copied instanceof Uint8Array
		? copied
		: new Uint8Array(copied.buffer ?? copied);
	const bytesPerSample = sampleBits / 8;
	const frameCount = Math.floor(bytes.byteLength / channels / bytesPerSample);
	const rate = Math.max(MinSampleRate, Math.min(MaxSampleRate, sampleRate));
	const audioBuffer = context.createBuffer(channels, Math.max(1, frameCount), rate);
	const view = sampleBits === 16
		? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		: null;

	for (let channel = 0; channel < channels; channel++) {
		const samples = audioBuffer.getChannelData(channel);
		for (let frame = 0; frame < frameCount; frame++) {
			const sample = frame * channels + channel;
			if (sampleBits === 8) {
				samples[frame] = (bytes[sample] - 128) / 128;
			} else {
				samples[frame] = view.getInt16(sample * bytesPerSample, true) / 32768;
			}
		}
	}

	return allocate(buffers, freeBuffers, audioBuffer);
}

export function deleteBuffer(handle) {
	release(buffers, freeBuffers, handle, 'buffer');
}

export function play(bufferHandle, looping, relative, x, y, z, volume, deferUntilUnlock) {
	init();
	if ((!unlocked || context.state !== 'running') && !looping && !deferUntilUnlock) {
		return 0;
	}

	const buffer = getBuffer(bufferHandle);
	const gain = context.createGain();
	gain.gain.value = volume;
	gain.connect(masterGain);

	let panner = null;
	if (!relative) {
		panner = context.createPanner();
		panner.panningModel = 'equalpower';
		panner.distanceModel = 'inverse';
		panner.refDistance = 6826;
		panner.maxDistance = 136533;
		setPosition(panner, x, y, z);
		panner.connect(gain);
	}

	const sound = {
		handle: 0,
		buffer,
		gain,
		panner,
		source: null,
		looping,
		relative,
		offset: 0,
		startedAt: 0,
		generation: 0,
		state: unlocked && context.state === 'running' ? 'initial' : 'pending'
	};
	const handle = allocate(sounds, freeSounds, sound);
	sound.handle = handle;
	if (unlocked && context.state === 'running') {
		startSound(sound);
	}

	return handle;
}

export function deleteSound(handle) {
	if (handle === 0) {
		return;
	}

	const sound = getSound(handle);
	stopSource(sound);
	sound.panner?.disconnect();
	sound.gain.disconnect();
	for (let i = completedSounds.length - 1; i >= 0; i--) {
		if (completedSounds[i] === handle) {
			completedSounds.splice(i, 1);
		}
	}

	release(sounds, freeSounds, handle, 'sound');
}

export function pauseSound(handle, paused) {
	if (handle !== 0) {
		pause(getSound(handle), paused);
	}
}

export function pauseAll(paused) {
	for (let handle = 1; handle < sounds.length; handle++) {
		const sound = sounds[handle];
		if (sound) {
			pause(sound, paused);
		}
	}
}

export function stopSound(handle) {
	if (handle === 0) {
		return;
	}

	const sound = getSound(handle);
	if (sound.state === 'complete') {
		return;
	}

	stopSource(sound);
	markComplete(sound);
}

export function stopAll() {
	for (let handle = 1; handle < sounds.length; handle++) {
		if (sounds[handle]) {
			stopSound(handle);
		}
	}
}

export function setLooping(handle, looping) {
	if (handle === 0) {
		return;
	}

	const sound = getSound(handle);
	sound.looping = looping;
	if (sound.source) {
		sound.source.loop = looping;
	}
}

export function setSoundPosition(handle, x, y, z) {
	if (handle === 0) {
		return;
	}

	const sound = getSound(handle);
	if (sound.panner) {
		setPosition(sound.panner, x, y, z);
	}
}

export function getSoundVolume(handle) {
	return handle === 0 ? Number.NaN : getSound(handle).gain.gain.value;
}

export function setSoundVolume(handle, volume) {
	if (handle !== 0) {
		getSound(handle).gain.gain.value = volume;
	}
}

export function getSeek(handle) {
	return handle === 0 ? Number.NaN : seek(getSound(handle));
}

export function isComplete(handle) {
	return handle === 0 || getSound(handle).state === 'complete';
}

export function drainCompleted(target) {
	const count = Math.min(Math.floor(target.byteLength / Int32Array.BYTES_PER_ELEMENT), completedSounds.length);
	if (count > 0) {
		target.set(new Int32Array(completedSounds.splice(0, count)));
	}

	return count;
}

export function setListener(x, y, z) {
	init();
	setPosition(context.listener, x, y, z);
	setListenerOrientation(context.listener);
}

export function setMasterVolume(volume) {
	init();
	masterGain.gain.value = volume;
}

export function dispose() {
	if (!context) {
		return;
	}

	stopAll();
	for (let handle = 1; handle < sounds.length; handle++) {
		if (sounds[handle]) {
			deleteSound(handle);
		}
	}

	for (let handle = 1; handle < buffers.length; handle++) {
		if (buffers[handle]) {
			deleteBuffer(handle);
		}
	}

	completedSounds.length = 0;
	masterGain.disconnect();
	context.close().catch(() => { });
	context = null;
	masterGain = null;
	unlocked = false;
}

globalThis.openraAudioDebug = {
	state: () => context ? (unlocked ? context.state : 'suspended') : 'uninitialized',
	get voicesStarted() { return startedVoiceCount; },
	activeVoices: () => sounds.reduce((count, sound) => count + (sound?.state === 'playing' ? 1 : 0), 0),
	unlock
};
