// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

const DatabaseName = 'openra';
const DatabaseVersion = 1;
const StoreName = 'files';
const MaxFileSize = 256 * 1024 * 1024;

const entries = new Map();
const pendingPuts = new Map();
const pendingDeletes = new Set();
const activeFlushes = new Set();

let database;
let preloadPromise;

function normalizePath(path) {
	if (typeof path !== 'string') {
		throw new Error('OpenRA storage paths must be strings.');
	}

	const normalized = path.replaceAll('\\', '/');
	const segments = normalized.split('/');
	if (normalized.length === 0 || normalized.startsWith('/') ||
		segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
		throw new Error(`Invalid OpenRA storage path '${path}'.`);
	}

	return normalized;
}

function validateEntry(path, entry) {
	if (!entry || !(entry.data instanceof ArrayBuffer) ||
		!Number.isFinite(entry.mtimeMs) || !Number.isInteger(entry.size) || entry.size < 0) {
		throw new Error(`Invalid IndexedDB record for '${path}'.`);
	}

	if (entry.size !== entry.data.byteLength) {
		throw new Error(
			`IndexedDB size mismatch for '${path}': metadata=${entry.size}, data=${entry.data.byteLength}.`);
	}

	if (entry.size > MaxFileSize) {
		throw new Error(`IndexedDB record '${path}' exceeds the 256MB file limit.`);
	}
}

function openDatabase() {
	if (database) {
		return Promise.resolve(database);
	}

	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DatabaseName, DatabaseVersion);
		request.addEventListener('upgradeneeded', () => {
			if (!request.result.objectStoreNames.contains(StoreName)) {
				request.result.createObjectStore(StoreName);
			}
		});
		request.addEventListener('success', () => {
			database = request.result;
			database.addEventListener('versionchange', () => {
				database.close();
				database = undefined;
			});
			resolve(database);
		});
		request.addEventListener('error', () => reject(request.error));
		request.addEventListener('blocked', () => reject(new Error('OpenRA IndexedDB upgrade was blocked.')));
	});
}

function transactionComplete(transaction) {
	return new Promise((resolve, reject) => {
		transaction.addEventListener('complete', resolve, { once: true });
		transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
		transaction.addEventListener('error', () => reject(transaction.error), { once: true });
	});
}

export function preload() {
	if (preloadPromise) {
		return preloadPromise;
	}

	preloadPromise = (async () => {
		const db = await openDatabase();
		const transaction = db.transaction(StoreName, 'readonly');
		const store = transaction.objectStore(StoreName);
		const keysRequest = store.getAllKeys();
		const valuesRequest = store.getAll();
		await transactionComplete(transaction);

		entries.clear();
		for (let i = 0; i < keysRequest.result.length; i++) {
			const path = normalizePath(keysRequest.result[i]);
			const entry = valuesRequest.result[i];
			validateEntry(path, entry);
			entries.set(path, entry);
		}
	})();

	return preloadPromise;
}

export function listEntries() {
	return Array.from(entries.keys()).sort();
}

export function readEntry(path) {
	const normalized = normalizePath(path);
	const entry = entries.get(normalized);
	if (!entry) {
		throw new Error(`OpenRA storage entry '${normalized}' does not exist.`);
	}

	validateEntry(normalized, entry);
	return new Uint8Array(entry.data.slice(0));
}

export function writeEntry(path, mtimeMs, data) {
	const normalized = normalizePath(path);
	if (!Number.isFinite(mtimeMs)) {
		throw new Error(`Invalid modification time for '${normalized}'.`);
	}

	const copied = data.slice();
	const bytes = copied instanceof Uint8Array
		? copied
		: new Uint8Array(copied.buffer ?? copied);
	if (bytes.byteLength > MaxFileSize) {
		throw new Error(`OpenRA storage entry '${normalized}' exceeds the 256MB file limit.`);
	}

	const exactData = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	const entry = { data: exactData, mtimeMs, size: exactData.byteLength };
	entries.set(normalized, entry);
	pendingPuts.set(normalized, entry);
	pendingDeletes.delete(normalized);
}

export function deleteEntry(path) {
	const normalized = normalizePath(path);
	entries.delete(normalized);
	pendingPuts.delete(normalized);
	pendingDeletes.add(normalized);
}

export function flush() {
	if (!database) {
		throw new Error('OpenRA IndexedDB has not been preloaded.');
	}

	if (pendingPuts.size === 0 && pendingDeletes.size === 0) {
		return 0;
	}

	const puts = new Map(pendingPuts);
	const deletes = new Set(pendingDeletes);
	pendingPuts.clear();
	pendingDeletes.clear();

	const transaction = database.transaction(StoreName, 'readwrite');
	const store = transaction.objectStore(StoreName);
	for (const [path, entry] of puts) {
		store.put(entry, path);
	}

	for (const path of deletes) {
		store.delete(path);
	}

	transaction.addEventListener('abort', () => {
		// Preserve newer mutations that may have been staged while this transaction was active.
		for (const [path, entry] of puts) {
			if (!pendingPuts.has(path) && !pendingDeletes.has(path)) {
				pendingPuts.set(path, entry);
			}
		}

		for (const path of deletes) {
			if (!pendingPuts.has(path) && !pendingDeletes.has(path)) {
				pendingDeletes.add(path);
			}
		}

		console.error(`OpenRA IndexedDB transaction failed: ${transaction.error ?? 'unknown error'}`);
	}, { once: true });

	const completion = transactionComplete(transaction);
	activeFlushes.add(completion);
	completion.finally(() => activeFlushes.delete(completion)).catch(() => {});

	return puts.size + deletes.size;
}

export async function flushAndWait() {
	while (pendingPuts.size !== 0 || pendingDeletes.size !== 0 || activeFlushes.size !== 0) {
		flush();
		if (activeFlushes.size !== 0) {
			await Promise.all(Array.from(activeFlushes));
		}
	}
}
