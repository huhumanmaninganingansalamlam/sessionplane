import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface ValidatedFetchTarget {
  readonly url: URL;
  readonly hostname: string;
  readonly addresses: readonly ResolvedAddress[];
  readonly selectedAddress: ResolvedAddress;
}

export interface UrlSafetyOptions {
  readonly allowPrivateNetworks?: boolean;
  readonly resolver?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
}

export class UrlSafetyError extends Error {
  readonly errorCode: string;
  readonly details: unknown;

  constructor(errorCode: string, message: string, details?: unknown) {
    super(message);
    this.name = 'UrlSafetyError';
    this.errorCode = errorCode;
    this.details = details;
  }
}

export async function validateFetchTarget(
  value: string | URL,
  options: UrlSafetyOptions = {},
): Promise<ValidatedFetchTarget> {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch (error) {
    throw new UrlSafetyError('fetch.invalid-url', `Invalid URL: ${String(value)}`, error);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlSafetyError(
      'fetch.unsupported-protocol',
      `Only HTTP and HTTPS URLs are allowed: ${url.protocol}`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new UrlSafetyError('fetch.credentials-forbidden', 'URL credentials are forbidden');
  }
  const hostname = stripIpv6Brackets(url.hostname.toLowerCase());
  if (hostname.length === 0) {
    throw new UrlSafetyError('fetch.invalid-url', 'URL hostname is required');
  }

  const literalFamily = isIP(hostname);
  const addresses = literalFamily === 0
    ? await (options.resolver ?? resolveAddresses)(hostname)
    : [{ address: hostname, family: literalFamily as 4 | 6 }];
  if (addresses.length === 0) {
    throw new UrlSafetyError('fetch.dns-empty', `No DNS addresses found for ${hostname}`);
  }
  const normalized = deduplicateAddresses(addresses);
  if (options.allowPrivateNetworks !== true) {
    const unsafe = normalized.find((address) => isBlockedAddress(address.address));
    if (unsafe !== undefined) {
      throw new UrlSafetyError(
        'fetch.private-address-blocked',
        `URL resolves to a blocked address: ${unsafe.address}`,
        { hostname, address: unsafe.address, family: unsafe.family },
      );
    }
  }
  return Object.freeze({
    url,
    hostname,
    addresses: Object.freeze(normalized),
    selectedAddress: normalized[0] as ResolvedAddress,
  });
}

export function isBlockedAddress(value: string): boolean {
  const address = stripIpv6Brackets(value.toLowerCase());
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

async function resolveAddresses(hostname: string): Promise<readonly ResolvedAddress[]> {
  try {
    const rows = await lookup(hostname, { all: true, verbatim: true });
    return rows
      .filter((row): row is { address: string; family: 4 | 6 } => row.family === 4 || row.family === 6)
      .map((row) => ({ address: row.address, family: row.family }));
  } catch (error) {
    throw new UrlSafetyError('fetch.dns-failed', `DNS resolution failed for ${hostname}`, error);
  }
}

function deduplicateAddresses(values: readonly ResolvedAddress[]): ResolvedAddress[] {
  const seen = new Set<string>();
  const result: ResolvedAddress[] = [];
  for (const value of values) {
    const address = stripIpv6Brackets(value.address.toLowerCase());
    if (isIP(address) !== value.family) {
      throw new UrlSafetyError(
        'fetch.invalid-address',
        `Resolver returned an invalid address: ${value.address}`,
      );
    }
    const key = `${value.family}:${address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ address, family: value.family });
  }
  return result;
}

function isBlockedIpv4(value: string): boolean {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function isBlockedIpv6(value: string): boolean {
  const normalized = value.split('%')[0] ?? value;
  if (normalized === '::' || normalized === '::1') return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped?.[1] !== undefined) return isBlockedIpv4(mapped[1]);
  const bytes = ipv6Bytes(normalized);
  if (bytes === null) return true;
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const third = bytes[2] ?? 0;
  const fourth = bytes[3] ?? 0;
  return (
    (first & 0xfe) === 0xfc ||
    (first === 0xfe && (second & 0xc0) === 0x80) ||
    first === 0xff ||
    (first === 0x20 && second === 0x01 && third === 0x0d && fourth === 0xb8) ||
    bytes.every((byte) => byte === 0)
  );
}

function ipv6Bytes(value: string): Uint8Array | null {
  const split = value.split('::');
  if (split.length > 2) return null;
  const parseSide = (side: string | undefined): number[] | null => {
    if (side === undefined || side === '') return [];
    const groups: number[] = [];
    for (const token of side.split(':')) {
      if (token.includes('.')) {
        const ipv4 = token.split('.').map(Number);
        if (
          ipv4.length !== 4 ||
          ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
        ) {
          return null;
        }
        groups.push((ipv4[0] as number) * 256 + (ipv4[1] as number));
        groups.push((ipv4[2] as number) * 256 + (ipv4[3] as number));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
      groups.push(Number.parseInt(token, 16));
    }
    return groups;
  };
  const left = parseSide(split[0]);
  const right = parseSide(split[1]);
  if (left === null || right === null) return null;
  let groups: number[];
  if (value.includes('::')) {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}
