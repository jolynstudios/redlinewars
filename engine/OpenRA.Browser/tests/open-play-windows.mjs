// Open twee zichtbare browservenster op de sessie-UI voor handmatig spelen.
// Jij klikt zelf: venster 1 = Host, venster 2 = Join (room-URL uit venster 1).
import { chromium } from '@playwright/test';

const gpu = await chromium.launch({
	headless: false,
	args: [
		'--use-angle=metal', '--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer',
		'--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-gpu-sandbox',
		'--window-position=0,0', '--window-size=1280,860',
	],
});
const gpu2 = await chromium.launch({
	headless: false,
	args: [
		'--use-angle=metal', '--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer',
		'--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-gpu-sandbox',
		'--window-position=1290,0', '--window-size=1280,860',
	],
});
const url = 'http://127.0.0.1:13550/steelseed/index.html?mode=game&platform=null&mp=1&Player.Name=';
const p1 = await gpu.newPage({ viewport: { width: 1280, height: 860 } });
await p1.goto(url + 'Speler-A', { timeout: 60_000 });
const p2 = await gpu2.newPage({ viewport: { width: 1280, height: 860 } });
await p2.goto(url + 'Speler-B', { timeout: 60_000 });
console.log('TWO_WINDOWS_OPEN');
// Keep alive — Ctrl+C in the terminal closes everything.
setInterval(() => {}, 60_000);
