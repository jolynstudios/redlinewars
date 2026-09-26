// STEELSEED — inert stub shader. NOT the legacy sprite pipeline.
// See combined.vert for why this file must exist. Summary: ShaderBindings reads it
// unconditionally from a frozen assembly, NullGraphicsContext discards it, and the real
// renderer is WGSL in web/src/render/.

#version 300 es

precision highp float;

in vec4 vTexCoord;
in vec4 vTint;
flat in uint vAttributes;

out vec4 fragColor;

void main()
{
	// Fully transparent. Combined with the degenerate vertex position, a stray bind
	// contributes nothing to the framebuffer.
	fragColor = vec4(0.0);
	discard;
}
