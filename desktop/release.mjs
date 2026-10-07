// The desktop shell embeds its stage; the release gate compares it with
// release/game-version.json before any site or desktop build can ship.
export const RELEASE_STAGE = 'alpha'

export function gameVersionLabel(version, stage = RELEASE_STAGE) {
	const prefix = stage === 'stable' ? '' : `${stage[0].toUpperCase()}${stage.slice(1)} `
	return `${prefix}v${version}`
}
