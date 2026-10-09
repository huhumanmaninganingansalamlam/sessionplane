import assert from 'node:assert/strict';
import test from 'node:test';
import { KeyedMutex } from '../../src/scheduler/keyed-mutex.ts';

test('timeout returns without releasing the page to queued mutations until abandoned work settles', async () => {
  const mutex = new KeyedMutex();
  const browserCommand = Promise.withResolvers<void>();
  const timeout = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const first = mutex.runExclusive('owned-page', async retainUntil => {
    entered.resolve();
    await timeout.promise;
    retainUntil(browserCommand.promise);
    throw new Error('preparation timeout');
  });
  await entered.promise;
  let nextEntered = false;
  const next = mutex.runExclusive('owned-page', async () => { nextEntered = true; });
  const rejected = assert.rejects(first, /preparation timeout/);
  timeout.resolve();
  await rejected;
  assert.equal(mutex.isBusy('owned-page'), true);
  assert.equal(nextEntered, false, 'already queued mutation must also wait');
  await mutex.runExclusive('another-page', async () => undefined);
  assert.equal(nextEntered, false, 'unrelated pages remain usable');
  browserCommand.reject(new Error('abandoned preparation unwound'));
  await next;
  assert.equal(nextEntered, true);
  assert.equal(mutex.isBusy('owned-page'), false);
});
