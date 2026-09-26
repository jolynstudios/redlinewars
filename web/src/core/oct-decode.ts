// STEELSEED — core/oct-decode
// Shared WGSL: octahedral decode for the quantized VERTEX channels (geo/mesh
// toGPUBuffers encodes the mirrored way). Input is the snorm8 pair after the
// vertex fetch normalized it to [-1,1]. Named ...Vertex because render/shaders
// already has an octDecode for rg8 texture normals with a different input
// convention ([0,1] unorm); the two must never collide in a module.
//
// Lives in core (rule 3's one importable subsystem beside geo) because both
// the materials forge and the render shader composer paste it into generated
// shader sources.
export const OCT_DECODE_WGSL = /* wgsl */ `
fn octDecodeVertex(e: vec2<f32>) -> vec3<f32> {
	var n = vec3<f32>(e, 1.0 - abs(e.x) - abs(e.y));
	if (n.z < 0.0) {
		// Reflect into the lower hemisphere (meshopt semantics: x/y fold, z is kept).
		let t = -n.z;
		n = vec3<f32>(n.x + select(t, -t, n.x >= 0.0), n.y + select(t, -t, n.y >= 0.0), n.z);
	}
	return normalize(n);
}
`
