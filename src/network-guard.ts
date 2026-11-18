import { isIP } from 'node:net';

function isPrivateIPv4Octets(a: number, b: number, c: number): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||        // carrier-grade NAT
    (a === 169 && b === 254) ||                  // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||     // benchmarking
    (a === 198 && b === 51 && c === 100) ||      // documentation
    (a === 203 && b === 0 && c === 113);         // documentation
}

function expandIPv6(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  // Convert a trailing dotted IPv4 (e.g. ::ffff:127.0.0.1) into two hextets.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const [o1, o2, o3, o4] = octets as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((o1 << 8) | o2).toString(16)}:${((o3 << 8) | o4).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array<string>(missing).fill('0'), ...rest];
  const parsed = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN));
  return parsed.length === 8 && parsed.every((n) => Number.isInteger(n)) ? parsed : null;
}

/**
 * True for any address a user-supplied stream URL must never be allowed to reach:
 * loopback, private, link-local, carrier-grade NAT, multicast, reserved, documentation
 * ranges, and IPv6 forms that embed those IPv4 ranges. Unknown or unparsable input is treated as private.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === undefined || b === undefined || c === undefined) return true;
    return isPrivateIPv4Octets(a, b, c);
  }
  if (family === 6) {
    const h = expandIPv6(address);
    if (!h) return true;
    const [h0, h1, h2, h3, h4, h5, h6, h7] = h as [number, number, number, number, number, number, number, number];
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0) {
      if (h5 === 0xffff) return isPrivateIPv4Octets(h6 >> 8, h6 & 255, h7 >> 8);   // ::ffff:a.b.c.d
      if (h5 === 0) return true;                                                  // ::, ::1, IPv4-compatible
    }
    if (h0 === 0x64 && h1 === 0xff9b) return isPrivateIPv4Octets(h6 >> 8, h6 & 255, h7 >> 8); // NAT64
    if ((h0 & 0xfe00) === 0xfc00) return true;   // unique local fc00::/7
    if ((h0 & 0xffc0) === 0xfe80) return true;   // link-local fe80::/10
    if ((h0 & 0xffc0) === 0xfec0) return true;   // deprecated site-local
    if ((h0 & 0xff00) === 0xff00) return true;   // multicast
    if (h0 === 0x2001 && h1 === 0x0db8) return true; // documentation
    if (h0 === 0x2002) return true;              // 6to4 can embed private IPv4
    return false;
  }
  return true;
}
