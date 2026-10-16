import { isIP } from "node:net";

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0);
}

function inIpv4Range(address: number, base: string, bits: number): boolean {
  const baseNumber = ipv4Number(base);
  if (baseNumber === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (baseNumber & mask);
}

function ipv6Number(address: string): bigint | null {
  if (isIP(address) !== 6) return null;
  let normalized = address.toLowerCase();
  const embeddedIpv4 = normalized.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embeddedIpv4) {
    const value = ipv4Number(embeddedIpv4[1]);
    if (value === null) return null;
    normalized = normalized.replace(
      embeddedIpv4[1],
      `${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`,
    );
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
      : left;
  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) {
    return null;
  }
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const value = ipv4Number(address);
    if (value === null) return false;
    const denied = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ] as const;
    return !denied.some(([base, bits]) => inIpv4Range(value, base, bits));
  }

  if (version !== 6) return false;
  const value = ipv6Number(address);
  if (value === null) return false;
  const globalUnicast = value >> 125n === 1n;
  const documentation = value >> 96n === 0x20010db8n;
  const protocolAssignments =
    value >> 112n === 0x2001n && (value >> 96n) % 0x10000n < 0x0200n;
  const sixToFour = value >> 112n === 0x2002n;
  return globalUnicast && !documentation && !protocolAssignments && !sixToFour;
}

export function validateTaskUrl(value: unknown, allowedDomains: Set<string>): URL {
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("Invalid URL");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid URL");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    isIP(hostname) !== 0 ||
    !allowedDomains.has(hostname)
  ) {
    throw new Error("Destination is not allowed");
  }
  return url;
}

export function parseDomainAllowlist(value: string | undefined): Set<string> {
  if (!value) throw new Error("ALLOWED_DOMAINS must explicitly allow at least one domain");
  const domains = value.split(",").map((domain) => domain.trim().toLowerCase());
  if (
    domains.some(
      (domain) =>
        domain.length > 253 ||
        !domain.includes(".") ||
        domain.endsWith(".") ||
        isIP(domain) !== 0 ||
        !/^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(
          domain,
        ),
    )
  ) {
    throw new Error("ALLOWED_DOMAINS must contain exact valid hostnames");
  }
  return new Set(domains);
}
