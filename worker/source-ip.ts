const ipv4 = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;

/** Expand a valid IPv6 address to eight lowercase groups. IPv4 and invalid text return null. */
export function canonicalIpv6(value: string): string | null {
  const raw = value.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(raw) || raw.includes(':::')) return null;
  const halves = raw.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string) => part === '' ? [] : part.split(':');
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  if ([...head, ...tail].some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...head, ...Array.from({ length: missing }, () => '0'), ...tail].map(group => group.padStart(4, '0')).join(':');
}

/** Accept only a Cloudflare-supplied connecting address. Formatted values are canonical; anything else is dropped. */
export function canonicalIp(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw || raw.length > 64) return null;
  if (ipv4.test(raw)) {
    const parts = raw.split('.').map(Number);
    return parts.every(part => part <= 255) ? parts.join('.') : null;
  }
  return canonicalIpv6(raw);
}
