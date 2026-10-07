// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

const contexts = [];
const freeContexts = [];
const buffers = [];
const freeBuffers = [];
const programs = [];
const freePrograms = [];
const textures = [];
const freeTextures = [];
const frameBuffers = [];
const freeFrameBuffers = [];
const probeFrameBuffers = new URLSearchParams(location.search).has('glprobe');

function allocate(slots, free, value) {
	if (free.length !== 0) {
		const handle = free.pop();
		slots[handle] = value;
		return handle;
	}

	slots.push(value);
	return slots.length - 1;
}

function release(slots, free, handle) {
	if (!Number.isInteger(handle) || handle < 0 || handle >= slots.length || slots[handle] === null) {
		throw new Error(`Invalid or disposed WebGL handle ${handle}.`);
	}

	slots[handle] = null;
	free.push(handle);
}

function getContext(handle) {
	const context = contexts[handle];
	if (!context) {
		throw new Error(`Invalid or disposed WebGL context ${handle}.`);
	}

	if (context.lost || context.gl.isContextLost()) {
		throw new Error('WebGL2 context is lost. Reload the page to continue.');
	}

	return context;
}

function getResource(slots, handle, contextHandle, kind) {
	const resource = slots[handle];
	if (!resource || resource.context !== contextHandle) {
		throw new Error(`Invalid, disposed, or foreign ${kind} handle ${handle}.`);
	}

	return resource;
}

function getBuffer(handle, contextHandle) {
	return getResource(buffers, handle, contextHandle, 'buffer');
}

function getProgram(handle, contextHandle) {
	return getResource(programs, handle, contextHandle, 'program');
}

function getTexture(handle, contextHandle) {
	return getResource(textures, handle, contextHandle, 'texture');
}

function getFrameBuffer(handle, contextHandle) {
	return getResource(frameBuffers, handle, contextHandle, 'frame buffer');
}

function prepareTexture(gl, texture) {
	gl.bindTexture(gl.TEXTURE_2D, texture.texture);
	const filter = texture.linear ? gl.LINEAR : gl.NEAREST;
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
}

function bufferTarget(gl, target) {
	switch (target) {
		case 0: return gl.ARRAY_BUFFER;
		case 1: return gl.ELEMENT_ARRAY_BUFFER;
		default: throw new Error(`Unsupported buffer target ${target}.`);
	}
}

function compileShader(gl, type, code, name) {
	const shader = gl.createShader(type);
	if (!shader) {
		throw new Error(`Could not create shader '${name}'.`);
	}

	gl.shaderSource(shader, code);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		const log = gl.getShaderInfoLog(shader) || 'No compiler log was returned.';
		gl.deleteShader(shader);
		throw new Error(`Compile error in shader '${name}':\n${log}`);
	}

	return shader;
}

function uniformLocation(gl, programRecord, name) {
	if (programRecord.uniforms.has(name)) {
		return programRecord.uniforms.get(name);
	}

	const location = gl.getUniformLocation(programRecord.program, name);
	if (location === null) {
		throw new Error(`Shader uniform '${name}' is inactive or missing.`);
	}

	programRecord.uniforms.set(name, location);
	return location;
}

function useProgram(contextHandle, programHandle) {
	const context = getContext(contextHandle);
	const { gl } = context;
	const program = getProgram(programHandle, contextHandle);
	gl.useProgram(program.program);
	context.activeProgram = programHandle;
	return { gl, program };
}

function traceFrameBufferSampling(contextHandle, context) {
	if (!probeFrameBuffers || context.activeProgram === undefined) {
		return;
	}

	const program = getProgram(context.activeProgram, contextHandle);
	const sampledFrameBuffers = [];
	for (const textureHandle of program.textures.values()) {
		const texture = textures[textureHandle];
		if (texture?.frameBufferHandle !== undefined) {
			sampledFrameBuffers.push(texture.frameBufferHandle);
		}
	}

	if (sampledFrameBuffers.length === 0) {
		return;
	}

	const key = `${context.activeFrameBuffer ?? "default"}:${context.activeProgram}:${sampledFrameBuffers.join(",")}`;
	if (context.lastSamplingTrace === key) {
		return;
	}

	context.lastSamplingTrace = key;
	const viewport = context.gl.getParameter(context.gl.VIEWPORT);
	console.log(
		`[WEBGL2] composite target=${context.activeFrameBuffer ?? "default"} program=${context.activeProgram} ` +
		`sampledFBOs=${sampledFrameBuffers.join(",")} viewport=${Array.from(viewport).join(",")}`);
}

export function createContext(canvasSelector) {
	if (typeof document === 'undefined') return 0;
	const canvas = document.querySelector(canvasSelector);
	if (!(canvas instanceof HTMLCanvasElement)) {
		throw new Error(`Canvas '${canvasSelector}' was not found.`);
	}

	// The drawing buffer follows the canvas's on-screen CSS size so the page
	// controls the game resolution (fullscreen by default). The 1280x720
	// fallback covers a hidden or unstyled canvas (e.g. headless probes).
	canvas.width = Math.round(canvas.clientWidth) || 1280;
	canvas.height = Math.round(canvas.clientHeight) || 720;
	const gl = canvas.getContext('webgl2', {
		alpha: false,
		antialias: false,
		depth: true,
		stencil: false,
		premultipliedAlpha: false,
		preserveDrawingBuffer: false
	});
	if (!gl) {
		throw new Error('WebGL2 is unavailable.');
	}

	const record = {
		canvas,
		gl,
		lost: false,
		rootVao: gl.createVertexArray(),
		activeFrameBuffer: null,
		activeProgram: undefined,
		lastSamplingTrace: null
	};
	if (!record.rootVao) {
		throw new Error('Could not create the root WebGL2 vertex array.');
	}

	gl.bindVertexArray(record.rootVao);
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
	gl.viewport(0, 0, canvas.width, canvas.height);
	gl.clearColor(0.04, 0.06, 0.08, 1);
	gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

	canvas.addEventListener('webglcontextlost', event => {
		event.preventDefault();
		record.lost = true;
		console.error('[WEBGL2] CONTEXT LOST — reload required');
	});

	return allocate(contexts, freeContexts, record);
}

export function destroyContext(handle) {
	const context = getContext(handle);
	context.gl.deleteVertexArray(context.rootVao);
	release(contexts, freeContexts, handle);
}

export function getDrawingWidth(handle) {
	return getContext(handle).canvas.width;
}

export function getDrawingHeight(handle) {
	return getContext(handle).canvas.height;
}

export function isContextLost(handle) {
	const context = contexts[handle];
	return !context || context.lost || context.gl.isContextLost();
}

export function getGlVersion(handle) {
	const { gl } = getContext(handle);
	return gl.getParameter(gl.VERSION);
}

export function clear(handle) {
	const { gl } = getContext(handle);
	gl.clearColor(0, 0, 0, 1);
	gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
}

export function enableScissor(handle, x, y, width, height) {
	const { gl } = getContext(handle);
	gl.scissor(x, y, Math.max(width, 0), Math.max(height, 0));
	gl.enable(gl.SCISSOR_TEST);
}

export function disableScissor(handle) {
	const { gl } = getContext(handle);
	gl.disable(gl.SCISSOR_TEST);
}

export function createEmptyBuffer(contextHandle, target, size, dynamic) {
	const { gl } = getContext(contextHandle);
	const buffer = gl.createBuffer();
	if (!buffer) {
		throw new Error('Could not create a WebGL2 buffer.');
	}

	const glTarget = bufferTarget(gl, target);
	gl.bindBuffer(glTarget, buffer);
	gl.bufferData(glTarget, size, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
	return allocate(buffers, freeBuffers, { context: contextHandle, buffer });
}

export function createBuffer(contextHandle, target, data, dynamic) {
	const { gl } = getContext(contextHandle);
	const buffer = gl.createBuffer();
	if (!buffer) {
		throw new Error('Could not create a WebGL2 buffer.');
	}

	const glTarget = bufferTarget(gl, target);
	const bytes = data.slice();
	gl.bindBuffer(glTarget, buffer);
	gl.bufferData(glTarget, bytes, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
	return allocate(buffers, freeBuffers, { context: contextHandle, buffer });
}

export function uploadBuffer(contextHandle, bufferHandle, target, destinationOffset, sourceOffset, length, data) {
	const { gl } = getContext(contextHandle);
	const buffer = getBuffer(bufferHandle, contextHandle);
	const glTarget = bufferTarget(gl, target);
	const bytes = data.slice(sourceOffset, sourceOffset + length);
	gl.bindBuffer(glTarget, buffer.buffer);
	gl.bufferSubData(glTarget, destinationOffset, bytes);
}

export function bindBuffer(contextHandle, bufferHandle, target) {
	const { gl } = getContext(contextHandle);
	const buffer = getBuffer(bufferHandle, contextHandle);
	gl.bindBuffer(bufferTarget(gl, target), buffer.buffer);
}

export function deleteBuffer(contextHandle, bufferHandle) {
	const { gl } = getContext(contextHandle);
	const buffer = getBuffer(bufferHandle, contextHandle);
	gl.deleteBuffer(buffer.buffer);
	release(buffers, freeBuffers, bufferHandle);
}

export function createProgram(contextHandle, vertexCode, fragmentCode, vertexName, fragmentName, attributesJson, stride) {
	const { gl } = getContext(contextHandle);
	const attributes = JSON.parse(attributesJson);
	const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexCode, vertexName);
	const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentCode, fragmentName);
	const program = gl.createProgram();
	if (!program) {
		gl.deleteShader(vertexShader);
		gl.deleteShader(fragmentShader);
		throw new Error(`Could not create shader program '${vertexName}/${fragmentName}'.`);
	}

	for (let i = 0; i < attributes.length; i++) {
		gl.bindAttribLocation(program, i, attributes[i].Name);
	}

	gl.attachShader(program, vertexShader);
	gl.attachShader(program, fragmentShader);
	gl.linkProgram(program);
	gl.deleteShader(vertexShader);
	gl.deleteShader(fragmentShader);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		const log = gl.getProgramInfoLog(program) || 'No linker log was returned.';
		gl.deleteProgram(program);
		throw new Error(`Link error in shader program '${vertexName}/${fragmentName}':\n${log}`);
	}

	gl.useProgram(program);
	for (let i = 0; i < attributes.length; i++) {
		gl.enableVertexAttribArray(i);
	}

	const handle = allocate(programs, freePrograms, {
		context: contextHandle,
		program,
		label: `${vertexName}/${fragmentName}`,
		attributes,
		stride,
		uniforms: new Map(),
		samplers: new Map(),
		textures: new Map(),
		nextTextureUnit: 0,
		debugUniforms: new Map()
	});
	if (probeFrameBuffers) {
		console.log(`[WEBGL2] program ${handle}=${vertexName}/${fragmentName} stride=${stride}`);
	}

	return handle;
}

export function bindProgramAttributes(contextHandle, programHandle) {
	const { gl } = getContext(contextHandle);
	const program = getProgram(programHandle, contextHandle);
	for (let i = 0; i < program.attributes.length; i++) {
		const attribute = program.attributes[i];
		if (attribute.Type === gl.FLOAT) {
			gl.vertexAttribPointer(i, attribute.Components, attribute.Type, false, program.stride, attribute.Offset);
		} else {
			gl.vertexAttribIPointer(i, attribute.Components, attribute.Type, program.stride, attribute.Offset);
		}
	}
}

export function prepareProgram(contextHandle, programHandle) {
	const { gl, program } = useProgram(contextHandle, programHandle);
	for (const [unit, textureHandle] of program.textures) {
		const texture = textures[textureHandle];
		if (!texture || texture.context !== contextHandle) {
			program.textures.delete(unit);
			continue;
		}

		gl.activeTexture(gl.TEXTURE0 + unit);
		gl.bindTexture(gl.TEXTURE_2D, texture.texture);
	}
}

export function setProgramTexture(contextHandle, programHandle, name, textureHandle) {
	const { gl, program } = useProgram(contextHandle, programHandle);
	getResource(textures, textureHandle, contextHandle, 'texture');
	let unit = program.samplers.get(name);
	if (unit === undefined) {
		const location = gl.getUniformLocation(program.program, name);
		if (location === null) {
			return;
		}

		program.uniforms.set(name, location);
		unit = program.nextTextureUnit++;
		if (unit >= gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)) {
			throw new Error(`Shader '${name}' exceeds available texture units.`);
		}

		program.samplers.set(name, unit);
		gl.uniform1i(location, unit);
	}

	program.textures.set(unit, textureHandle);
}

export function setUniformInt(contextHandle, programHandle, name, value) {
	const { gl, program } = useProgram(contextHandle, programHandle);
	gl.uniform1i(uniformLocation(gl, program, name), value);
}

export function setUniformFloat(contextHandle, programHandle, name, value) {
	const { gl, program } = useProgram(contextHandle, programHandle);
	gl.uniform1f(uniformLocation(gl, program, name), value);
}

export function setUniformVec2(contextHandle, programHandle, name, x, y) {
	const { gl, program } = useProgram(contextHandle, programHandle);
	gl.uniform2f(uniformLocation(gl, program, name), x, y);
}

export function setUniformVec3(contextHandle, programHandle, name, x, y, z) {
	const { gl, program } = useProgram(contextHandle, programHandle);
	gl.uniform3f(uniformLocation(gl, program, name), x, y, z);
	if (probeFrameBuffers && (name === 'Scroll' || name === 'p1' || name === 'p2')) {
		const value = `${x},${y},${z}`;
		if (program.debugUniforms.get(name) !== value) {
			program.debugUniforms.set(name, value);
			console.log(`[WEBGL2] program ${programHandle} ${name}=${value}`);
		}
	}
}

export function setUniformVec4(contextHandle, programHandle, name, x, y, z, w) {
	const { gl, program } = useProgram(contextHandle, programHandle);
	gl.uniform4f(uniformLocation(gl, program, name), x, y, z, w);
}

export function setUniformMatrix(
	contextHandle, programHandle, name,
	m0, m1, m2, m3, m4, m5, m6, m7,
	m8, m9, m10, m11, m12, m13, m14, m15) {
	const { gl, program } = useProgram(contextHandle, programHandle);
	gl.uniformMatrix4fv(uniformLocation(gl, program, name), false, new Float32Array([
		m0, m1, m2, m3, m4, m5, m6, m7,
		m8, m9, m10, m11, m12, m13, m14, m15
	]));
}

export function drawArrays(contextHandle, primitiveType, firstVertex, numVertices) {
	const context = getContext(contextHandle);
	const { gl } = context;
	const modes = [gl.POINTS, gl.LINES, gl.TRIANGLES];
	if (modes[primitiveType] === undefined) {
		throw new Error(`Unsupported primitive type ${primitiveType}.`);
	}

	gl.drawArrays(modes[primitiveType], firstVertex, numVertices);
	traceFrameBufferSampling(contextHandle, context);
	if (probeFrameBuffers && context.activeFrameBuffer !== null) {
		const frameBuffer = getFrameBuffer(context.activeFrameBuffer, contextHandle);
		frameBuffer.drawCalls++;
		frameBuffer.drawVertices += numVertices;
	}
}

export function drawElements(contextHandle, numIndices, offset) {
	const context = getContext(contextHandle);
	const { gl } = context;
	gl.drawElements(gl.TRIANGLES, numIndices, gl.UNSIGNED_INT, offset);
	traceFrameBufferSampling(contextHandle, context);
	if (probeFrameBuffers && context.activeFrameBuffer !== null) {
		const frameBuffer = getFrameBuffer(context.activeFrameBuffer, contextHandle);
		frameBuffer.drawCalls++;
		frameBuffer.drawVertices += numIndices;
	}
}

export function enableDepth(contextHandle) {
	const { gl } = getContext(contextHandle);
	gl.clear(gl.DEPTH_BUFFER_BIT);
	gl.enable(gl.DEPTH_TEST);
	gl.depthFunc(gl.LEQUAL);
}

export function disableDepth(contextHandle) {
	const { gl } = getContext(contextHandle);
	gl.disable(gl.DEPTH_TEST);
}

export function clearDepth(contextHandle) {
	const { gl } = getContext(contextHandle);
	gl.clear(gl.DEPTH_BUFFER_BIT);
}

export function setBlendMode(contextHandle, mode) {
	const { gl } = getContext(contextHandle);
	gl.blendEquation(gl.FUNC_ADD);
	switch (mode) {
		case 0:
			gl.disable(gl.BLEND);
			break;
		case 1:
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
			break;
		case 2:
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.ONE, gl.ONE);
			break;
		case 3:
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.ONE, gl.ONE);
			gl.blendEquationSeparate(gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_ADD);
			break;
		case 4:
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
			break;
		case 5:
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
			break;
		case 6:
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.DST_COLOR, gl.SRC_COLOR);
			break;
		case 7:
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.DST_COLOR, gl.ONE);
			break;
		case 8:
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR);
			break;
		case 9:
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_DST_COLOR);
			break;
		default:
			throw new Error(`Unsupported blend mode ${mode}.`);
	}
}

export function createTexture(contextHandle) {
	const { gl } = getContext(contextHandle);
	const texture = gl.createTexture();
	if (!texture) {
		throw new Error('Could not create a WebGL2 texture.');
	}

	const record = { context: contextHandle, texture, linear: false };
	prepareTexture(gl, record);
	return allocate(textures, freeTextures, record);
}

export function deleteTexture(contextHandle, textureHandle) {
	const { gl } = getContext(contextHandle);
	const texture = getTexture(textureHandle, contextHandle);
	gl.deleteTexture(texture.texture);
	release(textures, freeTextures, textureHandle);
}

export function setTextureScale(contextHandle, textureHandle, linear) {
	const { gl } = getContext(contextHandle);
	const texture = getTexture(textureHandle, contextHandle);
	texture.linear = linear;
	prepareTexture(gl, texture);
}

export function uploadBgraTexture(contextHandle, textureHandle, width, height, data) {
	const context = getContext(contextHandle);
	const { gl } = context;
	const texture = getTexture(textureHandle, contextHandle);
	prepareTexture(gl, texture);
	const bgra = data.slice();

	if (!context.bgraScratch || context.bgraScratch.length < bgra.length) {
		context.bgraScratch = new Uint8Array(bgra.length);
	}

	const rgba = context.bgraScratch;
	for (let i = 0; i < bgra.length; i += 4) {
		rgba[i] = bgra[i + 2];
		rgba[i + 1] = bgra[i + 1];
		rgba[i + 2] = bgra[i];
		rgba[i + 3] = bgra[i + 3];
	}

	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba.subarray(0, bgra.length));
}

export function uploadFloatTexture(contextHandle, textureHandle, width, height, data) {
	const { gl } = getContext(contextHandle);
	const texture = getTexture(textureHandle, contextHandle);
	prepareTexture(gl, texture);
	const bytes = data.slice();
	const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, floats);
}

export function allocateTexture(contextHandle, textureHandle, width, height) {
	const { gl } = getContext(contextHandle);
	const texture = getTexture(textureHandle, contextHandle);
	prepareTexture(gl, texture);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
}

export function copyTexture(contextHandle, textureHandle, x, y, width, height) {
	const { gl } = getContext(contextHandle);
	const texture = getTexture(textureHandle, contextHandle);
	prepareTexture(gl, texture);
	gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, x, y, width, height, 0);
}

export function readTextureBgra(contextHandle, textureHandle, width, height, data) {
	const { gl } = getContext(contextHandle);
	const texture = getTexture(textureHandle, contextHandle);
	const result = new Uint8Array(width * height * 4);
	const previousFrameBuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
	const readFrameBuffer = gl.createFramebuffer();
	if (!readFrameBuffer) {
		throw new Error('Could not create the texture readback frame buffer.');
	}

	try {
		gl.bindFramebuffer(gl.FRAMEBUFFER, readFrameBuffer);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.texture, 0);
		const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
		if (status !== gl.FRAMEBUFFER_COMPLETE) {
			throw new Error(`Texture readback frame buffer is incomplete: 0x${status.toString(16)}.`);
		}

		gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, result);
		for (let i = 0; i < result.length; i += 4) {
			const red = result[i];
			result[i] = result[i + 2];
			result[i + 2] = red;
		}

		data.set(result);
	} finally {
		gl.bindFramebuffer(gl.FRAMEBUFFER, previousFrameBuffer);
		gl.deleteFramebuffer(readFrameBuffer);
	}
}

export function createFrameBuffer(contextHandle, textureHandle, width, height) {
	const { gl } = getContext(contextHandle);
	const texture = getTexture(textureHandle, contextHandle);
	const previousFrameBuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
	const previousRenderBuffer = gl.getParameter(gl.RENDERBUFFER_BINDING);
	const frameBuffer = gl.createFramebuffer();
	const depth = gl.createRenderbuffer();
	if (!frameBuffer || !depth) {
		if (frameBuffer) {
			gl.deleteFramebuffer(frameBuffer);
		}
		if (depth) {
			gl.deleteRenderbuffer(depth);
		}
		throw new Error('Could not create a WebGL2 frame buffer.');
	}

	try {
		gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuffer);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.texture, 0);
		gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
		gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
		const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
		if (status !== gl.FRAMEBUFFER_COMPLETE) {
			throw new Error(`WebGL2 frame buffer is incomplete: 0x${status.toString(16)}.`);
		}
	} catch (error) {
		gl.deleteFramebuffer(frameBuffer);
		gl.deleteRenderbuffer(depth);
		throw error;
	} finally {
		gl.bindFramebuffer(gl.FRAMEBUFFER, previousFrameBuffer);
		gl.bindRenderbuffer(gl.RENDERBUFFER, previousRenderBuffer);
	}

	const handle = allocate(frameBuffers, freeFrameBuffers, {
		context: contextHandle,
		frameBuffer,
		depth,
		width,
		height,
		previousFrameBuffer: null,
		previousViewport: null,
		probeCount: 0,
		drawCalls: 0,
		drawVertices: 0
	});
	texture.frameBufferHandle = handle;
	return handle;
}

export function deleteFrameBuffer(contextHandle, frameBufferHandle) {
	const { gl } = getContext(contextHandle);
	const frameBuffer = getFrameBuffer(frameBufferHandle, contextHandle);
	gl.deleteFramebuffer(frameBuffer.frameBuffer);
	gl.deleteRenderbuffer(frameBuffer.depth);
	release(frameBuffers, freeFrameBuffers, frameBufferHandle);
}

export function bindFrameBuffer(contextHandle, frameBufferHandle, red, green, blue, alpha) {
	const context = getContext(contextHandle);
	const { gl } = context;
	const frameBuffer = getFrameBuffer(frameBufferHandle, contextHandle);
	frameBuffer.previousFrameBuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
	frameBuffer.previousViewport = gl.getParameter(gl.VIEWPORT);
	gl.flush();
	gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuffer.frameBuffer);
	gl.viewport(0, 0, frameBuffer.width, frameBuffer.height);
	if (probeFrameBuffers && frameBuffer.probeCount < 2) {
		const viewport = gl.getParameter(gl.VIEWPORT);
		console.log(`[WEBGL2] bind FBO ${frameBufferHandle} viewport=${Array.from(viewport).join(",")}`);
	}

	gl.clearColor(red, green, blue, alpha);
	gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
	frameBuffer.drawCalls = 0;
	frameBuffer.drawVertices = 0;
	context.activeFrameBuffer = frameBufferHandle;
}

export function unbindFrameBuffer(contextHandle, frameBufferHandle) {
	const context = getContext(contextHandle);
	const { gl } = context;
	const frameBuffer = getFrameBuffer(frameBufferHandle, contextHandle);
	if (!frameBuffer.previousViewport) {
		throw new Error('Attempting to unbind a frame buffer that is not bound.');
	}

	gl.flush();
	if (probeFrameBuffers && frameBuffer.probeCount++ < 2) {
		const width = Math.min(frameBuffer.width, 1280);
		const height = Math.min(frameBuffer.height, 720);
		const pixels = new Uint8Array(width * height * 4);
		gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
		let transparent = 0;
		let black = 0;
		let colored = 0;
		let minX = width;
		let minY = height;
		let maxX = -1;
		let maxY = -1;
		for (let i = 0; i < pixels.length; i += 4) {
			if (pixels[i + 3] === 0) {
				transparent++;
			} else if (pixels[i] === 0 && pixels[i + 1] === 0 && pixels[i + 2] === 0) {
				black++;
			} else {
				colored++;
				const pixel = i / 4;
				const x = pixel % width;
				const y = Math.floor(pixel / width);
				minX = Math.min(minX, x);
				minY = Math.min(minY, y);
				maxX = Math.max(maxX, x);
				maxY = Math.max(maxY, y);
			}
		}

		const bounds = colored === 0 ? "none" : `${minX},${minY}..${maxX},${maxY}`;
		console.log(
			`[WEBGL2] FBO ${frameBufferHandle} ${frameBuffer.width}x${frameBuffer.height} ` +
			`probe=${width}x${height} transparent=${transparent} black=${black} colored=${colored} ` +
			`bounds=${bounds} draws=${frameBuffer.drawCalls} vertices=${frameBuffer.drawVertices}`);
	}

	gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuffer.previousFrameBuffer);
	gl.viewport(
		frameBuffer.previousViewport[0], frameBuffer.previousViewport[1],
		frameBuffer.previousViewport[2], frameBuffer.previousViewport[3]);
	frameBuffer.previousFrameBuffer = null;
	frameBuffer.previousViewport = null;
	context.activeFrameBuffer = null;
}
