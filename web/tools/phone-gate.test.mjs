// The game page sends phones to phone.html before any engine or presentation module loads;
// tablets and desktops play. Runs the exact inline script from index.html against fake devices.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const source = /<script id="phone-gate">([\s\S]*?)<\/script>/.exec(html)?.[1]
assert.ok(source, 'index.html must carry the phone-gate script')
assert.ok(html.indexOf('id="phone-gate"') < html.indexOf('<script type="module"'),
	'the gate must run before any module script')

function visit({ width, height, coarse, fine, mobile, ua = '', search = '' }) {
	let target = null
	const sandbox = {
		location: { search, replace: url => { target = url } },
		screen: { width, height },
		matchMedia: query => ({ matches: query === '(pointer: coarse)' ? coarse : query === '(any-pointer: fine)' ? fine : false }),
		navigator: { userAgent: ua, ...(mobile === undefined ? {} : { userAgentData: { mobile } }) },
	}
	vm.runInNewContext(source, sandbox)
	return target
}

test('phones go to phone.html', () => {
	assert.equal(visit({ width: 390, height: 844, coarse: true, fine: false,
		ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }), 'phone.html')
	assert.equal(visit({ width: 412, height: 915, coarse: true, fine: false, mobile: true }), 'phone.html')
})

test('tablets and desktops play', () => {
	// iPadOS reports a desktop Safari user agent.
	assert.equal(visit({ width: 820, height: 1180, coarse: true, fine: false,
		ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' }), null)
	assert.equal(visit({ width: 800, height: 1280, coarse: true, fine: false, mobile: false }), null)
	assert.equal(visit({ width: 1440, height: 900, coarse: false, fine: true, mobile: false }), null)
	// A small laptop screen with a mouse is not a phone.
	assert.equal(visit({ width: 1024, height: 576, coarse: false, fine: true, mobile: false }), null)
})

test('?device=any lets a phone through for testing', () => {
	assert.equal(visit({ width: 390, height: 844, coarse: true, fine: false, mobile: true, search: '?device=any' }), null)
})
