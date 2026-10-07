// STEELSEED — inert stub shader. NOT the legacy sprite pipeline.
//
// Why this file exists at all:
// OpenRA.Game/Graphics/ShaderBindings.cs:52 does an unconditional
//   File.ReadAllText(Path.Combine(Platform.EngineDir, "glsl", name))
// in its constructor, before any graphics context is consulted. That runs even under
// NullPlatform, where NullGraphicsContext discards the shader source entirely. Because
// OpenRA.Game is frozen under hard rule 2, the read cannot be made conditional — so the
// file has to exist.
//
// STEELSEED deleted the inherited glsl/ tree: the 2D sprite layer is replaced wholesale
// (ARCHITECTURE.md §2, and the brief's §2 boundary list). Restoring the original shaders
// would reinstate the very pipeline this project exists to remove. Instead this is a
// deliberately minimal, STEELSEED-authored stub that satisfies the loader and nothing else.
//
// The real renderer is WebGPU/WGSL in web/src/render/ and never touches this path. If a
// draw call ever reaches this shader, something is wrong: the sprite renderer is supposed
// to be inert and issue no draw calls, and the `bridge` gate proves it.

#version 300 es

precision highp float;

// Attribute layout must match CombinedShaderBindings (OpenRA.Game/Graphics/Vertex.cs:56).
in vec3 aVertexPosition;
in vec4 aVertexTexCoord;
in uint aVertexAttributes;
in vec4 aVertexTint;

out vec4 vTexCoord;
out vec4 vTint;
flat out uint vAttributes;

void main()
{
	vTexCoord = aVertexTexCoord;
	vTint = aVertexTint;
	vAttributes = aVertexAttributes;

	// Collapse to a degenerate point outside the clip volume. If this stub is ever bound
	// on a real context by mistake, it draws nothing rather than drawing garbage over
	// the scene — a blank result is diagnosable, corrupt output is not.
	gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
	gl_PointSize = 0.0;
}
