import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isBlockedAddress,
  UrlSafetyError,
  validateFetchTarget,
} from '../../src/fetch/url-safety.ts';

test('URL safety accepts public HTTP(S) targets and pins one validated address', async () => {
  const target = await validateFetchTarget('https://example.com/path?q=1', {
    resolver: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ],
  });
  assert.equal(target.url.href, 'https://example.com/path?q=1');
  assert.equal(target.hostname, 'example.com');
  assert.equal(target.selectedAddress.address, '93.184.216.34');
  assert.equal(target.addresses.length, 2);
});

test('URL safety rejects credentials, unsupported protocols, and any private DNS answer', async () => {
  await assert.rejects(
    validateFetchTarget('file:///etc/passwd'),
    hasCode('fetch.unsupported-protocol'),
  );
  await assert.rejects(
    validateFetchTarget('https://user:secret@example.com/'),
    hasCode('fetch.credentials-forbidden'),
  );
  await assert.rejects(
    validateFetchTarget('https://mixed.example/', {
      resolver: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    }),
    hasCode('fetch.private-address-blocked'),
  );
});

test('URL safety recognizes private, link-local, documentation, and multicast ranges', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.168.1.1',
    '198.51.100.2',
    '203.0.113.1',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    'ff02::1',
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  assert.equal(isBlockedAddress('2606:4700:4700::1111'), false);
});

test('private targets require an explicit test/local override', async () => {
  const target = await validateFetchTarget('http://127.0.0.1:8080/test', {
    allowPrivateNetworks: true,
  });
  assert.equal(target.selectedAddress.address, '127.0.0.1');
});

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof UrlSafetyError && error.errorCode === code;
}
