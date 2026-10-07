// Archive this public edition only. Unknown paths, build output and excluded features fail closed.
const ROOTS = new Set(['web', 'engine', 'desktop', 'release', 'tools', 'compliance', 'licenses', 'art'])
const FILES = new Set(['.gitignore', '.gitattributes', 'LICENSE', 'NOTICE.md', 'README.md',
 'ARCHITECTURE.md', 'AUTHORS', 'CONTRIBUTION.md', 'THIRD_PARTY_NOTICES.md', 'RELEASE-SOURCE.json', 'global.json'])
const OUTPUT = new Set(['node_modules', 'bin', 'obj', 'bin-browser', 'bin-browser-legacy',
 'bin-browser-reference', 'bin-browser-aot', 'bin-standalone', 'generated', 'dist',
 'test-results', 'playwright-report', '.artifacts', 'shots', '.forge'])
export function createExportPolicy() {
 return { decide(path) {
  const parts = path.split('/')
  if (parts.some(part => OUTPUT.has(part))) return { publish: false, why: 'build output' }
  if (/^(web\/src\/(hud|companion|core\/tactical)\/|desktop\/shell\/|brand\/|landing\/|deploy\/)/.test(path)
    || /(?:^|\/)[^/]*(?:freehop|companion|joa)[^/]*$/i.test(path)
    || /^art\/(?!sources\.lock\.json$|supplied-inputs\.lock\.json$|content-provenance\.json$)/.test(path))
   return { publish: false, why: 'outside the public edition' }
  if (parts.length === 1 ? FILES.has(path) : ROOTS.has(parts[0])) return { publish: true, why: 'public edition source' }
  return null
 } }
}
