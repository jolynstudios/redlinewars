// Typed protocol constants for the web UI (T1.0, §4.7/L27). This module imports the
// node's protocol.json by relative path so a close code, limit, port or beacon value
// changes in exactly one place; vite inlines the JSON at build time
// (tsconfig resolveJsonModule + moduleResolution "bundler"). No runtime I/O here.
import protocol from '../../../engine/steelseed-host/tools/protocol.json';

export const MP_PROTOCOL_VERSION: number = protocol.proto;

export const MP_PORTS = protocol.ports;
export const MP_LIMITS = protocol.limits;
export const MP_TIMEOUTS = protocol.timeouts;
export const MP_TUNNEL = protocol.tunnel;
export const MP_RECONNECT = protocol.reconnect;
export const MP_LAN_BEACON = protocol.lanBeacon;

/** Room lifecycle states on the node (§5.4). */
export type MpRoomState = 'booting' | 'reserved' | 'lobby' | 'playing' | 'ended';
/** Node operating modes (L25). */
export type MpNodeMode = 'own' | 'standing' | 'donate';

// resolveJsonModule widens JSON arrays to string[], so a compile-time drift check
// against these unions is not possible; the values are pinned by protocol.json alone.
export const MP_ROOM_STATES = protocol.roomStates as readonly MpRoomState[];
export const MP_NODE_MODES = protocol.nodeModes as readonly MpNodeMode[];

/** Close codes the relay sends when dropping a node tunnel (§5.5). */
export const MP_RELAY_CLOSE_CODES = protocol.relayCloseCodes;
/** Close codes the relay sends when refusing a player socket upgrade (§5.6). */
export const MP_PLAYER_CLOSE_CODES = protocol.playerCloseCodes;

/** Player-socket close code → §5.10 client string id. */
export const closeCodeToStringId: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(protocol.playerCloseCodes).map(([code, entry]) => [Number(code), entry.clientString]),
  ),
);
/**
 * Hostname classes a room endpoint may name on a local directory (T2.3): loopback,
 * private (RFC 1918 / IPv6 unique-local) or link-local. `URL.hostname` keeps IPv6
 * literals bracketed, so both spellings are accepted. Names that are not IP
 * literals (other than `localhost`) are never local.
 */
export function mpIsLocalHostname(hostname: string): boolean {
  const host = hostname.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (host.includes(':')) {
    const first = Number.parseInt(host.split(':')[0] ?? '', 16);
    if (Number.isNaN(first)) return false;
    return (first & 0xfe00) === 0xfe80 || (first & 0xfc00) === 0xfc00; // link-local / unique-local
  }
  return false;
}
