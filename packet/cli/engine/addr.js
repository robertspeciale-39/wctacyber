// addr.js — IPv4/IPv6/MAC address math.
// No dependencies. Used by the engine, the shells and the grader.

/* ---------------------------------------------------------------- IPv4 --- */

export function isIpv4(s) {
  return typeof s === 'string' && /^(\d{1,3}\.){3}\d{1,3}$/.test(s) &&
    s.split('.').every(o => { const n = +o; return n >= 0 && n <= 255 && String(n) === String(+o); });
}

export function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

export function intToIp(n) {
  n = n >>> 0;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** A dotted-decimal mask is valid only if it is a run of ones then a run of zeros. */
export function isValidMask(mask) {
  if (!isIpv4(mask)) return false;
  const n = ipToInt(mask);
  const inverted = (~n) >>> 0;
  return ((inverted + 1) & inverted) === 0;
}

export function maskToCidr(mask) {
  let n = ipToInt(mask), bits = 0;
  while (n) { bits += n & 1; n >>>= 1; }
  return bits;
}

export function cidrToMask(bits) {
  return intToIp(bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0);
}

export function networkOf(ip, mask) {
  return intToIp((ipToInt(ip) & ipToInt(mask)) >>> 0);
}

export function broadcastOf(ip, mask) {
  return intToIp((ipToInt(ip) | (~ipToInt(mask) >>> 0)) >>> 0);
}

export function sameNetwork(a, b, mask) {
  return networkOf(a, mask) === networkOf(b, mask);
}

/** Does `ip` fall inside prefix/mask? */
export function inPrefix(ip, prefix, mask) {
  return ((ipToInt(ip) & ipToInt(mask)) >>> 0) === ((ipToInt(prefix) & ipToInt(mask)) >>> 0);
}

export function isLoopback(ip)  { return isIpv4(ip) && ip.startsWith('127.'); }
export function isApipa(ip)     { return isIpv4(ip) && ip.startsWith('169.254.'); }
export function isMulticast(ip) { const f = +ip.split('.')[0]; return f >= 224 && f <= 239; }

export function isPrivate(ip) {
  if (!isIpv4(ip)) return false;
  const n = ipToInt(ip);
  return (n >= ipToInt('10.0.0.0')    && n <= ipToInt('10.255.255.255')) ||
         (n >= ipToInt('172.16.0.0')  && n <= ipToInt('172.31.255.255')) ||
         (n >= ipToInt('192.168.0.0') && n <= ipToInt('192.168.255.255'));
}

/** Usable host range for a network, or null for /31 and /32. */
export function hostRange(ip, mask) {
  const bits = maskToCidr(mask);
  if (bits >= 31) return null;
  const net = ipToInt(networkOf(ip, mask));
  const bc = ipToInt(broadcastOf(ip, mask));
  return { first: intToIp(net + 1), last: intToIp(bc - 1), count: bc - net - 1 };
}

export function toBinaryOctets(ip) {
  return ip.split('.').map(o => (+o).toString(2).padStart(8, '0')).join('.');
}

/* ---------------------------------------------------------------- IPv6 --- */

/** Expand to eight 4-digit hextets. Returns null if not parseable. */
export function expandIpv6(addr) {
  if (typeof addr !== 'string' || !addr.includes(':')) return null;
  let a = addr.trim().toLowerCase();
  if ((a.match(/::/g) || []).length > 1) return null;
  let head = [], tail = [];
  if (a.includes('::')) {
    const [h, t] = a.split('::');
    head = h ? h.split(':') : [];
    tail = t ? t.split(':') : [];
    if (head.length + tail.length > 7) return null;
  } else {
    head = a.split(':');
    if (head.length !== 8) return null;
  }
  const fill = 8 - head.length - tail.length;
  const parts = [...head, ...Array(fill).fill('0'), ...tail];
  if (parts.some(p => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map(p => p.padStart(4, '0')).join(':');
}

/** RFC 5952 canonical short form. */
export function compressIpv6(addr) {
  const full = expandIpv6(addr);
  if (!full) return null;
  const parts = full.split(':').map(p => p.replace(/^0+(?=.)/, ''));
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  parts.forEach((p, i) => {
    if (p === '0') {
      if (curStart < 0) { curStart = i; curLen = 0; }
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else { curStart = -1; curLen = 0; }
  });
  if (bestLen < 2) return parts.join(':');
  const before = parts.slice(0, bestStart).join(':');
  const after = parts.slice(bestStart + bestLen).join(':');
  return `${before}::${after}`;
}

export function ipv6Type(addr) {
  const full = expandIpv6(addr);
  if (!full) return 'invalid';
  if (full === '0000:0000:0000:0000:0000:0000:0000:0001') return 'loopback';
  if (full.startsWith('ff')) return 'multicast';
  if (/^fe[89ab]/.test(full)) return 'link-local';
  if (/^(2|3)/.test(full)) return 'global-unicast';
  if (/^f[cd]/.test(full)) return 'unique-local';
  return 'other';
}

/** Same /prefixLen? Compares the leading bits of the expanded form. */
export function sameIpv6Prefix(a, b, prefixLen) {
  const fa = expandIpv6(a), fb = expandIpv6(b);
  if (!fa || !fb) return false;
  const bits = s => s.split(':').map(h => parseInt(h, 16).toString(2).padStart(16, '0')).join('');
  return bits(fa).slice(0, prefixLen) === bits(fb).slice(0, prefixLen);
}

/** EUI-64 interface identifier from a MAC (aabb.ccdd.eeff or aa:bb:...). */
export function eui64(mac) {
  const hex = mac.replace(/[.:-]/g, '').toLowerCase();
  if (hex.length !== 12) return null;
  let first = parseInt(hex.slice(0, 2), 16) ^ 0x02;
  const h = first.toString(16).padStart(2, '0') + hex.slice(2);
  const withFffe = h.slice(0, 6) + 'fffe' + h.slice(6);
  return withFffe.match(/.{4}/g).join(':');
}

/* ----------------------------------------------------------------- MAC --- */

/** Cisco display form: aabb.ccdd.eeff */
export function formatMac(hex) {
  const h = hex.replace(/[.:-]/g, '').toUpperCase();
  return h.match(/.{4}/g).join('.');
}

/** Windows display form: AA-BB-CC-DD-EE-FF */
export function formatMacWindows(hex) {
  const h = hex.replace(/[.:-]/g, '').toUpperCase();
  return h.match(/.{2}/g).join('-');
}

/** A MAC as a comparable number — spanning tree elections turn on this. */
export function macToInt(hex) {
  return parseInt(String(hex).replace(/[.:-]/g, ''), 16);
}

/** Deterministic per-device/per-interface MAC so labs are reproducible. */
export function makeMac(deviceIndex, ifaceIndex) {
  const oui = '0060';
  const body = (((deviceIndex + 1) * 0x100 + ifaceIndex) & 0xFFFFFF).toString(16).padStart(6, '0');
  return formatMac(oui + '2f' + body.slice(0, 6)).toLowerCase();
}

export const BROADCAST_MAC = 'ffff.ffff.ffff';
