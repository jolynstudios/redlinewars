// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.
//
// S3 spike: representative OpenRA frame on raw WebGL2 using the real
// combined shaders, plus the TerrainSpriteLayer dirty-row update pattern
// (Rosebud's unsolved shroud corruption case). Determinism check: two
// identical seeded passes must produce byte-identical framebuffer hashes.

const status = document.getElementById('status');
const log = document.getElementById('log');
const print = (l) => { console.log(l); log.textContent += l + '\n'; };

const SPRITES = 10000;          // CPU-batched quads per frame
const SHROUD_COLS = 128;        // shroud grid (POT-ish workload)
const SHROUD_ROWS = 128;
const DIRTY_ROWS_PER_FRAME = 6; // rows invalidated per frame
const PASS_FRAMES = 500;        // frames per determinism pass
const FLOATS_PER_VERTEX = 12;   // vec3 pos + vec4 texcoord + uint attrib + vec4 tint
const BYTES_PER_VERTEX = FLOATS_PER_VERTEX * 4;

// Deterministic PRNG (mulberry32) so both passes replay identical updates.
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0; a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function fnv1a(bytes) {
	let h = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i += 16) {  // stride 16 for speed; still catches corruption
		h ^= bytes[i];
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

async function fetchShader(name) {
	const r = await fetch(`glsl/${name}`);
	if (!r.ok) throw new Error(`fetch ${name}: ${r.status}`);
	return (await r.text()).replace('{VERSION}', '300 es');
}

function compile(gl, type, src, name) {
	const s = gl.createShader(type);
	gl.shaderSource(s, src);
	gl.compileShader(s);
	if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
		throw new Error(`${name}: ${gl.getShaderInfoLog(s)}`);
	return s;
}

async function main() {
	const canvas = document.getElementById('canvas');
	const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
	if (!gl) { status.textContent = 'NO WEBGL2'; return; }
	print(`[s3] ${gl.getParameter(gl.VERSION)} | ${gl.getParameter(gl.RENDERER)}`);

	// --- Real OpenRA shaders ---
	const vertSrc = await fetchShader('combined.vert');
	const fragSrc = await fetchShader('combined.frag');
	const prog = gl.createProgram();
	gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vertSrc, 'combined.vert'));
	gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragSrc, 'combined.frag'));

	// Bind attribute locations before linking, mirroring Shader.cs
	gl.bindAttribLocation(prog, 0, 'aVertexPosition');
	gl.bindAttribLocation(prog, 1, 'aVertexTexCoord');
	gl.bindAttribLocation(prog, 2, 'aVertexAttributes');
	gl.bindAttribLocation(prog, 3, 'aVertexTint');
	gl.linkProgram(prog);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
		throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
	gl.useProgram(prog);
	print('[s3] combined shaders compiled+linked as 300 es ✓');

	const u = (n) => gl.getUniformLocation(prog, n);

	// --- Textures: sprite atlas (RGBA8, like SheetBuilder sheets after swizzle) ---
	const atlasSize = 1024;
	const atlas = gl.createTexture();
	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, atlas);
	const atlasData = new Uint8Array(atlasSize * atlasSize * 4);
	const ar = rng(1234);
	for (let i = 0; i < atlasData.length; i++) atlasData[i] = (ar() * 256) | 0;
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, atlasSize, atlasSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, atlasData);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

	// --- Palette + ColorShifts: RGBA16F float textures (HardwarePalette path) ---
	const makeFloatTex = (unit, rows) => {
		const t = gl.createTexture();
		gl.activeTexture(gl.TEXTURE0 + unit);
		gl.bindTexture(gl.TEXTURE_2D, t);
		const data = new Float32Array(256 * rows * 4);
		const pr = rng(99 + unit);
		for (let i = 0; i < data.length; i++) data[i] = pr();
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 256, rows, 0, gl.RGBA, gl.FLOAT, data);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		return t;
	};
	makeFloatTex(8, 64);   // Palette
	makeFloatTex(9, 64);   // ColorShifts

	// --- Uniforms ---
	for (let i = 0; i < 8; i++) gl.uniform1i(u(`Texture${i}`), 0);  // all sprite samplers -> atlas
	gl.uniform1i(u('Palette'), 8);
	gl.uniform1i(u('ColorShifts'), 9);
	gl.uniform1f(u('PaletteRows'), 64);
	gl.uniform3f(u('Scroll'), 0, 0, 0);
	gl.uniform3f(u('p1'), 2.0 / canvas.width, -2.0 / canvas.height, 1.0 / 4096);
	gl.uniform3f(u('p2'), -1, 1, 0);
	gl.uniform1i(u('EnableDepthPreview'), 0);
	gl.uniform1f(u('DepthTextureScale'), 0);
	gl.uniform1i(u('EnablePixelArtScaling'), 0);

	// --- Shared quad index buffer (engine: StaticIndexBuffer over quads) ---
	const maxQuads = Math.max(SPRITES, SHROUD_COLS * SHROUD_ROWS);
	const indices = new Uint32Array(maxQuads * 6);
	for (let q = 0; q < maxQuads; q++) {
		const v = q * 4, i = q * 6;
		indices[i] = v; indices[i + 1] = v + 1; indices[i + 2] = v + 2;
		indices[i + 3] = v + 2; indices[i + 4] = v + 3; indices[i + 5] = v;
	}
	const ibo = gl.createBuffer();
	gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
	gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

	const setupVao = (vbo) => {
		const vao = gl.createVertexArray();
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 3, gl.FLOAT, false, BYTES_PER_VERTEX, 0);
		gl.enableVertexAttribArray(1);
		gl.vertexAttribPointer(1, 4, gl.FLOAT, false, BYTES_PER_VERTEX, 12);
		gl.enableVertexAttribArray(2);
		gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, BYTES_PER_VERTEX, 28);
		gl.enableVertexAttribArray(3);
		gl.vertexAttribPointer(3, 4, gl.FLOAT, false, BYTES_PER_VERTEX, 32);
		return vao;
	};

	// --- Dynamic sprite batch buffer (SpriteRenderer path: full re-upload per frame) ---
	const spriteVbo = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, spriteVbo);
	gl.bufferData(gl.ARRAY_BUFFER, SPRITES * 4 * BYTES_PER_VERTEX, gl.DYNAMIC_DRAW);
	const spriteVao = setupVao(spriteVbo);
	const spriteData = new Float32Array(SPRITES * 4 * FLOATS_PER_VERTEX);
	const spriteDataU32 = new Uint32Array(spriteData.buffer);

	// --- Shroud layer: PERSISTENT buffer + dirty-row partial updates (TerrainSpriteLayer) ---
	const shroudVbo = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, shroudVbo);
	const shroudFloats = SHROUD_ROWS * SHROUD_COLS * 4 * FLOATS_PER_VERTEX;
	const shroudData = new Float32Array(shroudFloats);
	const shroudDataU32 = new Uint32Array(shroudData.buffer);
	const cellW = canvas.width / SHROUD_COLS, cellH = canvas.height / SHROUD_ROWS;

	const writeQuad = (arr, arrU32, base, x, y, w, h, attrib, tintA) => {
		const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
		for (let c = 0; c < 4; c++) {
			const o = base + c * FLOATS_PER_VERTEX;
			arr[o] = corners[c][0]; arr[o + 1] = corners[c][1]; arr[o + 2] = 0;
			arr[o + 3] = (c === 1 || c === 2) ? 1 : 0; arr[o + 4] = (c >= 2) ? 1 : 0; arr[o + 5] = 0; arr[o + 6] = 0;
			arrU32[o + 7] = attrib;
			arr[o + 8] = 1; arr[o + 9] = 1; arr[o + 10] = 1; arr[o + 11] = tintA;
		}
	};

	const writeShroudRow = (row, visible) => {
		for (let col = 0; col < SHROUD_COLS; col++) {
			const base = (row * SHROUD_COLS + col) * 4 * FLOATS_PER_VERTEX;
			// attrib 2 = RGBA sprite from all channels; alpha tint encodes shroud state
			writeQuad(shroudData, shroudDataU32, base, col * cellW, row * cellH, cellW, cellH, 2, visible ? 0.0 : 0.8);
		}
	};
	for (let r = 0; r < SHROUD_ROWS; r++) writeShroudRow(r, false);
	gl.bufferData(gl.ARRAY_BUFFER, shroudData, gl.DYNAMIC_DRAW);
	const shroudVao = setupVao(shroudVbo);
	const rowBytes = SHROUD_COLS * 4 * BYTES_PER_VERTEX;

	// --- World framebuffer (POT, like FrameBuffer.cs) + composite ---
	const fboSize = 1024;
	const fboTex = gl.createTexture();
	gl.activeTexture(gl.TEXTURE10);
	gl.bindTexture(gl.TEXTURE_2D, fboTex);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, fboSize, fboSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	const fbo = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
	const depthRb = gl.createRenderbuffer();
	gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
	gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, fboSize, fboSize);
	gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
	if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
		throw new Error('FBO incomplete');
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	print('[s3] POT FBO + DEPTH_COMPONENT16 complete ✓');

	// copyTexImage2D target (Renderer snapshot path)
	const snapTex = gl.createTexture();
	gl.activeTexture(gl.TEXTURE11);
	gl.bindTexture(gl.TEXTURE_2D, snapTex);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 512, 512, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

	gl.enable(gl.BLEND);
	gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

	const readback = new Uint8Array(canvas.width * canvas.height * 4);

	// --- One frame: sprites -> FBO, shroud dirty rows interleaved, composite, snapshot ---
	const renderFrame = (frame, random, hashes, times) => {
		const t0 = performance.now();

		// CPU-batch 10k sprites (deterministic positions)
		for (let i = 0; i < SPRITES; i++) {
			const x = random() * (canvas.width - 16), y = random() * (canvas.height - 16);
			const attrib = (i % 3 === 0) ? 2 : 1 | ((i % 4) << 16 << 0); // mix RGBA + paletted
			writeQuad(spriteData, spriteDataU32, i * 4 * FLOATS_PER_VERTEX, x, y, 16, 16, attrib, 1.0);
		}

		// World pass into FBO
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.viewport(0, 0, fboSize, fboSize);
		gl.clearColor(0, 0, 0, 1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

		gl.bindVertexArray(spriteVao);
		gl.bindBuffer(gl.ARRAY_BUFFER, spriteVbo);
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, spriteData);            // ~1.9MB dynamic upload
		gl.drawElements(gl.TRIANGLES, SPRITES * 6, gl.UNSIGNED_INT, 0);

		// Shroud: dirty-row partial uploads INTERLEAVED with draws (TerrainSpriteLayer.Draw)
		gl.bindVertexArray(shroudVao);
		gl.bindBuffer(gl.ARRAY_BUFFER, shroudVbo);
		for (let d = 0; d < DIRTY_ROWS_PER_FRAME; d++) {
			const row = (random() * SHROUD_ROWS) | 0;
			writeShroudRow(row, random() > 0.5);
			gl.bufferSubData(gl.ARRAY_BUFFER, row * rowBytes, shroudData.subarray(
				row * SHROUD_COLS * 4 * FLOATS_PER_VERTEX, (row + 1) * SHROUD_COLS * 4 * FLOATS_PER_VERTEX));
			if (d === (DIRTY_ROWS_PER_FRAME >> 1))
				gl.drawElements(gl.TRIANGLES, SHROUD_ROWS * SHROUD_COLS * 6, gl.UNSIGNED_INT, 0); // adversarial mid-update draw
		}

		gl.drawElements(gl.TRIANGLES, SHROUD_ROWS * SHROUD_COLS * 6, gl.UNSIGNED_INT, 0);

		// Snapshot path (menufade/screenshot): copyTexImage2D from the FBO
		if (frame % 60 === 0) {
			gl.activeTexture(gl.TEXTURE11);
			gl.bindTexture(gl.TEXTURE_2D, snapTex);
			gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 0, 0, 512, 512, 0);
		}

		// Composite to default framebuffer (screen pass reuses the sprite program w/ FBO texture)
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, canvas.width, canvas.height);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, fboTex);
		gl.bindVertexArray(spriteVao);
		gl.drawElements(gl.TRIANGLES, SPRITES * 6, gl.UNSIGNED_INT, 0);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, atlas);

		// Hash the visible output every 10th frame (readPixels = sync, so sparse)
		if (frame % 10 === 0) {
			gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, readback);
			hashes.push(fnv1a(readback));
		}

		times.push(performance.now() - t0);
	};

	const runPass = (label, seed) => new Promise((resolve) => {
		// Reset persistent shroud state so both passes start identically
		for (let r = 0; r < SHROUD_ROWS; r++) writeShroudRow(r, false);
		gl.bindVertexArray(shroudVao);
		gl.bindBuffer(gl.ARRAY_BUFFER, shroudVbo);
		gl.bufferData(gl.ARRAY_BUFFER, shroudData, gl.DYNAMIC_DRAW);

		const random = rng(seed);
		const hashes = [];
		const times = [];
		let frame = 0;
		const tick = () => {
			renderFrame(frame, random, hashes, times);
			if (++frame < PASS_FRAMES) { requestAnimationFrame(tick); return; }
			const sorted = [...times].sort((a, b) => a - b);
			print(`[s3] ${label}: ${PASS_FRAMES} frames, cpu median=${sorted[(sorted.length / 2) | 0].toFixed(2)}ms ` +
				`p95=${sorted[(sorted.length * 0.95) | 0].toFixed(2)}ms max=${sorted[sorted.length - 1].toFixed(2)}ms, ${hashes.length} hashes`);
			resolve(hashes);
		};
		requestAnimationFrame(tick);
	});

	status.textContent = 'pass 1…';
	const h1 = await runPass('pass1', 42);
	status.textContent = 'pass 2…';
	const h2 = await runPass('pass2', 42);

	let mismatches = 0;
	for (let i = 0; i < h1.length; i++) if (h1[i] !== h2[i]) mismatches++;
	const err = gl.getError();
	const verdict = mismatches === 0 && err === 0 ? 'S3 SHROUD GATE: PASS' : `S3 SHROUD GATE: FAIL (mismatches=${mismatches}, glError=${err})`;
	print(`[s3] hash comparison: ${h1.length} checkpoints, mismatches=${mismatches}, final glError=${err}`);
	print(`[s3] ${verdict}`);
	status.textContent = verdict;
	globalThis.__s3 = { verdict, mismatches, checkpoints: h1.length };
}

main().catch(e => { console.error(e); status.textContent = 'S3 crashed: ' + e.message; print('[s3] FATAL: ' + e); });
