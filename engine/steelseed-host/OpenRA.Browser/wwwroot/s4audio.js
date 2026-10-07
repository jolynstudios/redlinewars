// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

const VoiceCount = 64;
const VoiceDuration = 3;

const status = document.getElementById('status');
const log = document.getElementById('log');
const contextState = document.getElementById('context-state');
const activeVoiceMeter = document.getElementById('active-voices');
const peakVoiceMeter = document.getElementById('peak-voices');
const musicState = document.getElementById('music-state');
const buttons = {
	start: document.getElementById('start'),
	pause: document.getElementById('pause'),
	resume: document.getElementById('resume'),
	pan: document.getElementById('pan'),
	stop: document.getElementById('stop')
};

const gates = {
	suspendedBeforeGesture: false,
	voicePool: false,
	musicLoop: false,
	pauseAll: false,
	resumeAll: false,
	positionalPan: false
};

const activeVoices = new Set();
const stateTransitions = [];
let audioContext;
let masterGain;
let musicSource;
let peakVoices = 0;
let hardFailure = false;
let aggregateReported = false;
let previousContextState = 'unavailable';

function print(line) {
	const text = `[AUDIOSMOKE] ${line}`;
	console.log(text);
	log.textContent += text + '\n';
}

function snapshot() {
	return {
		contextState: audioContext?.state ?? 'unavailable',
		activeVoices: activeVoices.size,
		peakVoices,
		musicLooping: musicSource !== undefined,
		gates: { ...gates },
		stateTransitions: [...stateTransitions],
		hardFailure
	};
}

function updateMeters() {
	contextState.textContent = audioContext?.state ?? 'unavailable';
	activeVoiceMeter.textContent = activeVoices.size;
	peakVoiceMeter.textContent = peakVoices;
	musicState.textContent = musicSource ? 'looping' : 'stopped';
	globalThis.__s4audioSnapshot = snapshot();
}

function reportFailure(label, error) {
	hardFailure = true;
	status.textContent = `${label}: FAIL`;
	status.className = 'fail';
	print(`FAIL ${label}: ${error instanceof Error ? error.message : error} ` +
		`active-voices=${activeVoices.size} context=${audioContext?.state ?? 'unavailable'}`);
	updateMeters();
}

function reportAggregateIfComplete() {
	const complete = Object.values(gates).every(Boolean);
	if (!complete || aggregateReported)
		return;

	aggregateReported = true;
	const verdict = hardFailure ? 'FAIL' : 'PASS';
	status.textContent = `S4 AUDIO GATE: ${verdict}`;
	status.className = hardFailure ? 'fail' : 'pass';
	print(`${verdict} aggregate active-voices=${activeVoices.size} peak-voices=${peakVoices} ` +
		`context=${audioContext.state} music=${musicSource ? 'looping' : 'stopped'} ` +
		`transitions=[${stateTransitions.join(', ')}]`);
	updateMeters();
}

function createToneBuffer(frequency, duration, harmonic = 0.15) {
	const frames = Math.ceil(audioContext.sampleRate * duration);
	const buffer = audioContext.createBuffer(1, frames, audioContext.sampleRate);
	const samples = buffer.getChannelData(0);
	const attackFrames = Math.max(1, Math.floor(audioContext.sampleRate * 0.01));
	const releaseFrames = Math.max(1, Math.floor(audioContext.sampleRate * 0.08));
	for (let i = 0; i < samples.length; i++) {
		const attack = Math.min(1, i / attackFrames);
		const release = Math.min(1, (samples.length - i - 1) / releaseFrames);
		const envelope = Math.max(0, Math.min(attack, release));
		const phase = 2 * Math.PI * frequency * i / audioContext.sampleRate;
		samples[i] = envelope * (Math.sin(phase) + harmonic * Math.sin(phase * 2)) / (1 + harmonic);
	}

	return buffer;
}

function trackOneShot(source) {
	activeVoices.add(source);
	peakVoices = Math.max(peakVoices, activeVoices.size);
	source.addEventListener('ended', () => {
		activeVoices.delete(source);
		if (activeVoices.size === 0)
			print(`active-voices=0 context=${audioContext.state}`);
		updateMeters();
	}, { once: true });
	updateMeters();
}

function stopOneShots() {
	for (const source of activeVoices) {
		try { source.stop(); } catch { /* The source may already have ended. */ }
	}

	activeVoices.clear();
	updateMeters();
}

function startMusic() {
	if (musicSource)
		return;

	const source = audioContext.createBufferSource();
	source.buffer = createToneBuffer(110, 2, 0.35);
	source.loop = true;
	const gain = audioContext.createGain();
	gain.gain.value = 0.08;
	source.connect(gain).connect(masterGain);
	source.addEventListener('ended', () => {
		if (musicSource === source)
			musicSource = undefined;
		updateMeters();
	}, { once: true });
	source.start();
	musicSource = source;
	gates.musicLoop = source.loop;
	updateMeters();
}

function stopMusic() {
	if (!musicSource)
		return;

	const source = musicSource;
	musicSource = undefined;
	try { source.stop(); } catch { /* The source may already have ended. */ }
	updateMeters();
}

async function runVoicePool() {
	await audioContext.resume();
	if (audioContext.state !== 'running')
		throw new Error(`resume from user gesture left context ${audioContext.state}`);

	stopOneShots();
	startMusic();
	const sources = [];
	for (let i = 0; i < VoiceCount; i++) {
		const source = audioContext.createBufferSource();
		source.buffer = createToneBuffer(180 + i * 7, VoiceDuration, 0.1 + (i % 4) * 0.04);
		const gain = audioContext.createGain();
		gain.gain.value = 0.012;
		source.connect(gain).connect(masterGain);
		trackOneShot(source);
		sources.push(source);
	}

	// Synthesize every buffer first, then schedule all sources against one future
	// timestamp so slow devices cannot turn the loop into staggered playback.
	const startTime = audioContext.currentTime + 0.05;
	for (const source of sources)
		source.start(startTime);

	gates.voicePool = activeVoices.size === VoiceCount;
	const passed = gates.suspendedBeforeGesture && gates.voicePool && gates.musicLoop && audioContext.state === 'running';
	print(`${passed ? 'PASS' : 'FAIL'} voice-pool active-voices=${activeVoices.size} peak-voices=${peakVoices} ` +
		`context=${audioContext.state} music=${musicSource ? 'looping' : 'stopped'}`);
	if (!passed)
		hardFailure = true;
	status.textContent = passed ? '64 PCM one-shots + looping music: PASS' : 'Voice pool: FAIL';
	status.className = passed ? 'pass' : 'fail';
	buttons.pause.disabled = false;
	buttons.resume.disabled = false;
	buttons.pan.disabled = false;
	buttons.stop.disabled = false;
	reportAggregateIfComplete();
}

async function pauseAll() {
	await audioContext.suspend();
	gates.pauseAll = audioContext.state === 'suspended';
	print(`${gates.pauseAll ? 'PASS' : 'FAIL'} pause-all active-voices=${activeVoices.size} ` +
		`context=${audioContext.state} music=${musicSource ? 'looping' : 'stopped'}`);
	if (!gates.pauseAll)
		hardFailure = true;
	reportAggregateIfComplete();
}

async function resumeAll() {
	await audioContext.resume();
	gates.resumeAll = audioContext.state === 'running';
	print(`${gates.resumeAll ? 'PASS' : 'FAIL'} resume-all active-voices=${activeVoices.size} ` +
		`context=${audioContext.state} music=${musicSource ? 'looping' : 'stopped'}`);
	if (!gates.resumeAll)
		hardFailure = true;
	reportAggregateIfComplete();
}

async function runPositionalPan() {
	if (audioContext.state !== 'running')
		throw new Error('context must be resumed before the positional pan test');

	const source = audioContext.createBufferSource();
	source.buffer = createToneBuffer(440, 1.25, 0.05);
	const gain = audioContext.createGain();
	gain.gain.value = 0.2;
	const panner = new PannerNode(audioContext, {
		panningModel: 'HRTF',
		distanceModel: 'inverse',
		positionX: -2,
		positionY: 0,
		positionZ: -1,
		refDistance: 1,
		maxDistance: 100,
		rolloffFactor: 0.25
	});
	source.connect(gain).connect(panner).connect(masterGain);
	const startTime = audioContext.currentTime + 0.05;
	panner.positionX.setValueAtTime(-2, startTime);
	panner.positionX.linearRampToValueAtTime(2, startTime + 1.2);
	trackOneShot(source);
	source.addEventListener('ended', () => {
		gates.positionalPan = true;
		print(`PASS positional-pan active-voices=${activeVoices.size} context=${audioContext.state} ` +
			`model=${panner.panningModel} path=-2..2`);
		reportAggregateIfComplete();
	}, { once: true });
	source.start(startTime);
	print(`positional-pan started active-voices=${activeVoices.size} context=${audioContext.state} path=-2..2`);
}

function bind(button, label, action) {
	button.addEventListener('click', async () => {
		button.disabled = true;
		try {
			await action();
		} catch (error) {
			reportFailure(label, error);
		} finally {
			button.disabled = false;
		}
	});
}

async function initialize() {
	const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
	if (!AudioContext)
		throw new Error('Web Audio API is unavailable');

	audioContext = new AudioContext({ latencyHint: 'interactive' });
	previousContextState = audioContext.state;
	stateTransitions.push(audioContext.state);
	audioContext.addEventListener('statechange', () => {
		const next = audioContext.state;
		print(`STATE ${previousContextState} -> ${next} active-voices=${activeVoices.size}`);
		stateTransitions.push(next);
		previousContextState = next;
		updateMeters();
	});

	// Autoplay policy normally creates this suspended. Explicitly suspend if the
	// browser grants autoplay so no sound can start before the required click.
	if (audioContext.state !== 'suspended')
		await audioContext.suspend();
	gates.suspendedBeforeGesture = audioContext.state === 'suspended';

	masterGain = audioContext.createGain();
	masterGain.gain.value = 0.5;
	masterGain.connect(audioContext.destination);
	print(`${gates.suspendedBeforeGesture ? 'PASS' : 'FAIL'} created-before-gesture context=${audioContext.state} ` +
		`sample-rate=${audioContext.sampleRate}`);
	if (!gates.suspendedBeforeGesture)
		hardFailure = true;

	buttons.start.disabled = false;
	buttons.stop.disabled = false;
	status.textContent = 'AudioContext suspended — click “Resume + play 64 voices”';
	updateMeters();

	globalThis.__s4audio = {
		context: audioContext,
		gates,
		snapshot,
		runVoicePool,
		pauseAll,
		resumeAll,
		runPositionalPan
	};
}

bind(buttons.start, 'voice-pool', runVoicePool);
bind(buttons.pause, 'pause-all', pauseAll);
bind(buttons.resume, 'resume-all', resumeAll);
bind(buttons.pan, 'positional-pan', runPositionalPan);
bind(buttons.stop, 'stop', async () => {
	stopOneShots();
	stopMusic();
	print(`stopped active-voices=${activeVoices.size} context=${audioContext.state} music=stopped`);
});

initialize().catch(error => reportFailure('initialization', error));
