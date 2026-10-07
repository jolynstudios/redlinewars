// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

const EventStride = 8;
const ScancodeMask = 1 << 30;
const Mouse4 = 283 | ScancodeMask;
const Mouse5 = 284 | ScancodeMask;

const EventType = Object.freeze({
	MouseDown: 1,
	MouseUp: 2,
	Move: 3,
	Wheel: 4,
	KeyDown: 5,
	KeyUp: 6,
	Text: 7,
	Focus: 8
});

// Values mirror SDL_Scancode and SDL_Keycode. Printable keys use KeyboardEvent.key
// below so that non-US layouts retain SDL keysym-like behavior.
const keycodes = new Map([
	['Escape', 27],
	['Enter', 13],
	['NumpadEnter', 88 | ScancodeMask],
	['Backspace', 8],
	['Tab', 9],
	['Delete', 127],
	['CapsLock', 57 | ScancodeMask],
	['F1', 58 | ScancodeMask],
	['F2', 59 | ScancodeMask],
	['F3', 60 | ScancodeMask],
	['F4', 61 | ScancodeMask],
	['F5', 62 | ScancodeMask],
	['F6', 63 | ScancodeMask],
	['F7', 64 | ScancodeMask],
	['F8', 65 | ScancodeMask],
	['F9', 66 | ScancodeMask],
	['F10', 67 | ScancodeMask],
	['F11', 68 | ScancodeMask],
	['F12', 69 | ScancodeMask],
	['F13', 104 | ScancodeMask],
	['F14', 105 | ScancodeMask],
	['F15', 106 | ScancodeMask],
	['F16', 107 | ScancodeMask],
	['F17', 108 | ScancodeMask],
	['F18', 109 | ScancodeMask],
	['F19', 110 | ScancodeMask],
	['F20', 111 | ScancodeMask],
	['F21', 112 | ScancodeMask],
	['F22', 113 | ScancodeMask],
	['F23', 114 | ScancodeMask],
	['F24', 115 | ScancodeMask],
	['PrintScreen', 70 | ScancodeMask],
	['ScrollLock', 71 | ScancodeMask],
	['Pause', 72 | ScancodeMask],
	['Insert', 73 | ScancodeMask],
	['Home', 74 | ScancodeMask],
	['PageUp', 75 | ScancodeMask],
	['End', 77 | ScancodeMask],
	['PageDown', 78 | ScancodeMask],
	['ArrowRight', 79 | ScancodeMask],
	['ArrowLeft', 80 | ScancodeMask],
	['ArrowDown', 81 | ScancodeMask],
	['ArrowUp', 82 | ScancodeMask],
	['NumLock', 83 | ScancodeMask],
	['NumpadDivide', 84 | ScancodeMask],
	['NumpadMultiply', 85 | ScancodeMask],
	['NumpadSubtract', 86 | ScancodeMask],
	['NumpadAdd', 87 | ScancodeMask],
	['Numpad1', 89 | ScancodeMask],
	['Numpad2', 90 | ScancodeMask],
	['Numpad3', 91 | ScancodeMask],
	['Numpad4', 92 | ScancodeMask],
	['Numpad5', 93 | ScancodeMask],
	['Numpad6', 94 | ScancodeMask],
	['Numpad7', 95 | ScancodeMask],
	['Numpad8', 96 | ScancodeMask],
	['Numpad9', 97 | ScancodeMask],
	['Numpad0', 98 | ScancodeMask],
	['NumpadDecimal', 99 | ScancodeMask],
	['ContextMenu', 101 | ScancodeMask],
	['Power', 102 | ScancodeMask],
	['NumpadEqual', 103 | ScancodeMask],
	['ControlLeft', 224 | ScancodeMask],
	['ShiftLeft', 225 | ScancodeMask],
	['AltLeft', 226 | ScancodeMask],
	['MetaLeft', 227 | ScancodeMask],
	['ControlRight', 228 | ScancodeMask],
	['ShiftRight', 229 | ScancodeMask],
	['AltRight', 230 | ScancodeMask],
	['MetaRight', 231 | ScancodeMask],
	['MediaTrackNext', 258 | ScancodeMask],
	['MediaTrackPrevious', 259 | ScancodeMask],
	['MediaStop', 260 | ScancodeMask],
	['MediaPlayPause', 261 | ScancodeMask],
	['AudioVolumeMute', 262 | ScancodeMask],
	['BrowserSearch', 268 | ScancodeMask],
	['BrowserHome', 269 | ScancodeMask],
	['BrowserBack', 270 | ScancodeMask],
	['BrowserForward', 271 | ScancodeMask],
	['BrowserStop', 272 | ScancodeMask],
	['BrowserRefresh', 273 | ScancodeMask],
	['BrowserFavorites', 274 | ScancodeMask],
	['BrightnessDown', 275 | ScancodeMask],
	['BrightnessUp', 276 | ScancodeMask],
	['Eject', 281 | ScancodeMask],
	['Sleep', 282 | ScancodeMask]
]);

const reservedModifiedKeys = new Set(['r', 'l', 't', 'w', 'q', 'n', 'c', 'v', 'x']);
const reservedFunctionKeys = new Set(['F5', 'F11', 'F12']);
const events = [];
const textValues = [];
const freeTextIndices = [];
const firstGestureCallbacks = [];

let canvas;
let canvasRect;
let resizeObserver;
let documentFocused = typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : false;
let pointerOverCanvas = false;
let currentModifiers = 0;
let clipboardText = '';
let lastPointerPosition;

function enqueue(values) {
	if (values.length !== EventStride) {
		throw new Error(`OpenRA input events must contain ${EventStride} integers.`);
	}

	events.push(...values);
}

function modifiers(event) {
	return (event.shiftKey ? 1 : 0)
		| (event.altKey ? 2 : 0)
		| (event.ctrlKey ? 4 : 0)
		| (event.metaKey ? 8 : 0);
}

function refreshCanvasRect() {
	canvasRect = canvas.getBoundingClientRect();
}

function canvasPosition(event) {
	if (!canvasRect || canvasRect.width <= 0 || canvasRect.height <= 0) {
		refreshCanvasRect();
	}

	const x = Math.round((event.clientX - canvasRect.left) * canvas.width / canvasRect.width);
	const y = Math.round((event.clientY - canvasRect.top) * canvas.height / canvasRect.height);
	return {
		x: Math.max(0, Math.min(canvas.width - 1, x)),
		y: Math.max(0, Math.min(canvas.height - 1, y))
	};
}

function mouseButton(button) {
	switch (button) {
		case 0: return 1;
		case 2: return 2;
		case 1: return 4;
		default: return 0;
	}
}

function mouseButtons(buttons) {
	return buttons & 7;
}

function enqueueFocus() {
	enqueue([EventType.Focus, documentFocused ? 1 : 0, pointerOverCanvas ? 1 : 0, 0, 0, 0, 0, 0]);
}

function enqueueText(text) {
	if (!text) {
		return;
	}

	const index = freeTextIndices.length > 0 ? freeTextIndices.pop() : textValues.length;
	textValues[index] = text;
	enqueue([EventType.Text, index, 0, 0, 0, 0, 0, 0]);
}

function keycode(event) {
	const characters = Array.from(event.key);
	if (characters.length === 1) {
		return characters[0].toLowerCase().codePointAt(0);
	}

	return keycodes.get(event.code) ?? 0;
}

function unicodeCodepoint(event) {
	const characters = Array.from(event.key);
	return characters.length === 1 ? characters[0].codePointAt(0) : 0;
}

function shouldHandleKeyboard() {
	return document.activeElement === canvas || pointerOverCanvas;
}

function shouldPreventDefault(event) {
	if (reservedFunctionKeys.has(event.code)) {
		return false;
	}

	const key = event.key.toLowerCase();
	if ((event.ctrlKey || event.metaKey) && reservedModifiedKeys.has(key)) {
		return false;
	}

	return true;
}

function fireFirstGesture() {
	if (firstGestureCallbacks.length === 0) {
		return;
	}

	const callbacks = firstGestureCallbacks.splice(0);
	for (const callback of callbacks) {
		callback();
	}
}

function pointerButtonEvent(event, type) {
	currentModifiers = modifiers(event);
	const position = canvasPosition(event);
	lastPointerPosition = position;

	if (event.button === 3 || event.button === 4) {
		const code = event.button === 3 ? Mouse4 : Mouse5;
		enqueue([type === EventType.MouseDown ? EventType.KeyDown : EventType.KeyUp,
			code, currentModifiers, 0, '?'.codePointAt(0), 0, 0, 0]);
		return;
	}

	const button = mouseButton(event.button);
	if (button !== 0) {
		enqueue([type, button, position.x, position.y, currentModifiers, 0, 0, 0]);
	}
}

function keyEvent(event, type) {
	if (!shouldHandleKeyboard()) {
		return;
	}

	currentModifiers = modifiers(event);
	const code = keycode(event);
	enqueue([type, code, currentModifiers, event.repeat ? 1 : 0, unicodeCodepoint(event), 0, 0, 0]);

	if (type === EventType.KeyDown && !event.isComposing && !(event.ctrlKey || event.metaKey || event.altKey)) {
		const characters = Array.from(event.key);
		if (characters.length === 1) {
			enqueueText(event.key);
		}
	}

	if (shouldPreventDefault(event)) {
		event.preventDefault();
	}
}

export function initInput(canvasSelector) {
	// The simulation worker has no document. Camera and orders live on the page.
	if (typeof document === 'undefined') return;
	const selectedCanvas = document.querySelector(canvasSelector);
	if (!(selectedCanvas instanceof HTMLCanvasElement)) {
		throw new Error(`Canvas '${canvasSelector}' was not found.`);
	}

	if (canvas) {
		if (canvas !== selectedCanvas) {
			throw new Error('OpenRA browser input is already bound to a different canvas.');
		}

		return;
	}

	canvas = selectedCanvas;
	refreshCanvasRect();
	resizeObserver = new ResizeObserver(refreshCanvasRect);
	resizeObserver.observe(canvas);
	window.addEventListener('resize', refreshCanvasRect);
	window.addEventListener('scroll', refreshCanvasRect, true);

	canvas.addEventListener('pointerdown', event => {
		fireFirstGesture();
		canvas.focus({ preventScroll: true });
		canvas.setPointerCapture(event.pointerId);
		pointerButtonEvent(event, EventType.MouseDown);
		event.preventDefault();
	});

	canvas.addEventListener('pointermove', event => {
		currentModifiers = modifiers(event);
		const position = canvasPosition(event);
		const dx = lastPointerPosition ? position.x - lastPointerPosition.x : 0;
		const dy = lastPointerPosition ? position.y - lastPointerPosition.y : 0;
		lastPointerPosition = position;
		enqueue([EventType.Move, mouseButtons(event.buttons), position.x, position.y, dx, dy, currentModifiers, 0]);
	});

	canvas.addEventListener('pointerup', event => {
		pointerButtonEvent(event, EventType.MouseUp);
		if (canvas.hasPointerCapture(event.pointerId)) {
			canvas.releasePointerCapture(event.pointerId);
		}

		event.preventDefault();
	});

	canvas.addEventListener('wheel', event => {
		currentModifiers = modifiers(event);
		const position = canvasPosition(event);
		const deltaSteps = event.deltaY === 0 ? 0 : -Math.sign(event.deltaY);
		enqueue([EventType.Wheel, position.x, position.y, deltaSteps, currentModifiers, 0, 0, 0]);
		event.preventDefault();
	}, { passive: false });

	canvas.addEventListener('contextmenu', event => event.preventDefault());
	canvas.addEventListener('pointerenter', () => {
		pointerOverCanvas = true;
		refreshCanvasRect();
		enqueueFocus();
	});
	canvas.addEventListener('pointerleave', () => {
		pointerOverCanvas = false;
		enqueueFocus();
	});

	window.addEventListener('keydown', event => {
		if (shouldHandleKeyboard()) {
			fireFirstGesture();
		}

		keyEvent(event, EventType.KeyDown);
	});
	window.addEventListener('keyup', event => keyEvent(event, EventType.KeyUp));
	window.addEventListener('focus', () => {
		documentFocused = true;
		enqueueFocus();
	});
	window.addEventListener('blur', () => {
		documentFocused = false;
		currentModifiers = 0;
		enqueueFocus();
	});
	window.addEventListener('paste', event => {
		clipboardText = event.clipboardData?.getData('text/plain') ?? '';
	});
	window.addEventListener('compositionend', event => {
		if (shouldHandleKeyboard()) {
			enqueueText(event.data);
		}
	});

	enqueueFocus();
}

export function drainEvents(target) {
	const capacity = Math.floor(target.byteLength / Int32Array.BYTES_PER_ELEMENT / EventStride);
	const eventCount = Math.min(capacity, Math.floor(events.length / EventStride));
	if (eventCount > 0) {
		const values = new Int32Array(events.splice(0, eventCount * EventStride));
		target.set(values);
	}

	return eventCount | (currentModifiers << 16);
}

export function drainText(index) {
	if (index < 0 || index >= textValues.length || textValues[index] === null) {
		return '';
	}

	const text = textValues[index];
	textValues[index] = null;
	freeTextIndices.push(index);
	return text;
}

export function getClipboardText() {
	return clipboardText;
}

export function setClipboardText(text) {
	clipboardText = text;
	if (navigator.clipboard) {
		navigator.clipboard.writeText(text).catch(() => { });
	}

	return true;
}

export function onFirstGesture(callback) {
	firstGestureCallbacks.push(callback);
}
