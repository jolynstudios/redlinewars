/** Fixed QR version 5/L, byte mode, mask 0. One RS block; URLs up to 106 UTF-8 bytes. Query param, not a fragment: camera apps commonly drop fragments when opening a scanned URL. */
export function qrMatrix(text: string): boolean[][] {
	const bytes = new TextEncoder().encode(text); if (bytes.length > 106) throw new Error('Pairing URL is too long for this QR code')
	const bits: number[] = [], append = (value: number, length: number): void => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1) }
	append(4, 4); append(bytes.length, 8); bytes.forEach(b => append(b, 8)); append(0, Math.min(4, 864 - bits.length)); while (bits.length % 8) bits.push(0)
	const data: number[] = []; for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((v, bit) => (v << 1) | bit, 0)); while (data.length < 108) data.push(data.length % 2 === Math.ceil(bits.length / 8) % 2 ? 0xec : 0x11)
	const mul = (a: number, b: number): number => { let value = 0; for (let i = 7; i >= 0; i--) { value = (value << 1) ^ ((value >>> 7) * 0x11d); value ^= ((b >>> i) & 1) * a } return value }
	let generator = [1], root = 1
	for (let i = 0; i < 26; i++) { const next = new Array<number>(generator.length + 1).fill(0); generator.forEach((v, k) => { next[k] ^= v; next[k + 1] ^= mul(v, root) }); generator = next; root = mul(root, 2) }
	const remainder = [...data, ...new Array<number>(26).fill(0)]
	for (let i = 0; i < data.length; i++) { const factor = remainder[i]; for (let j = 0; j < generator.length; j++) remainder[i + j] ^= mul(generator[j], factor) }
	const codewords = [...data, ...remainder.slice(-26)], size = 37, modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false)), reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
	const set = (x: number, y: number, value: boolean): void => { if (x >= 0 && y >= 0 && x < size && y < size) { modules[y][x] = value; reserved[y][x] = true } }
	for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); set(cx + dx, cy + dy, d !== 2 && d !== 4) }
	for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0) }
	for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(30 + dx, 30 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
	// Error correction L=01, mask=000; BCH(15,5), mandatory XOR mask.
	let format = 8 << 10; for (let i = 14; i >= 10; i--) if (((format >>> i) & 1) !== 0) format ^= 0x537 << (i - 10); format = ((8 << 10) | format) ^ 0x5412
	const f = (i: number): boolean => ((format >>> i) & 1) !== 0
	for (let i = 0; i <= 5; i++) set(8, i, f(i)); set(8, 7, f(6)); set(8, 8, f(7)); set(7, 8, f(8)); for (let i = 9; i < 15; i++) set(14 - i, 8, f(i))
	for (let i = 0; i < 8; i++) set(size - 1 - i, 8, f(i)); for (let i = 8; i < 15; i++) set(8, size - 15 + i, f(i)); set(8, size - 8, true)
	let bit = 0
	for (let right = size - 1; right >= 1; right -= 2) { if (right === 6) right = 5; for (let vertical = 0; vertical < size; vertical++) { const y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical; for (let j = 0; j < 2; j++) { const x = right - j; if (reserved[y][x]) continue; const value = bit < codewords.length * 8 && ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) !== 0; modules[y][x] = value !== ((x + y) % 2 === 0); bit++ } } }
	return modules
}
export function drawQr(canvas: HTMLCanvasElement, text: string): void {
	const modules = qrMatrix(text), cell = 6, border = 4, size = (modules.length + border * 2) * cell
	canvas.width = size; canvas.height = size; const g = canvas.getContext('2d'); if (!g) return
	g.fillStyle = '#ffffff'; g.fillRect(0, 0, size, size); g.fillStyle = '#090D11'
	modules.forEach((row, y) => row.forEach((value, x) => { if (value) g.fillRect((x + border) * cell, (y + border) * cell, cell, cell) }))
}
