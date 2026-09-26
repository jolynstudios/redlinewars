// The desktop update verdict (T3.10, §5.5) as pure functions, testable without Electron.
// The relay's /v2/config lists the builds it accepts; the shell compares its own AppBundle
// build against that list, and the bundled node separately reports a spine 4003.

/**
 * The shell's own verdict. No list (a relay that publishes none) or no own build (a bundle
 * without build.json) means no gate.
 */
export function shellVerdict(own, accepted) {
  return own !== '' && accepted.length > 0 && !accepted.includes(own);
}

/**
 * Whether the bundled node's `update-required` line may raise the "download the new
 * version" modal: only when the shell's own build is refused, or when the relay could not
 * be asked and the node's verdict is the only one there is. With the app's own build
 * accepted, a node refusal is a hosting fault a new download would not fix — the modal
 * once said "download" to owners who already ran the newest installer.
 */
export function nodeRefusalNeedsDownload(state) {
  return state?.required === true || state?.reachable === false;
}
