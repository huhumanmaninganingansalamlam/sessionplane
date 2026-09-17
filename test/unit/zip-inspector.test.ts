import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectZip, readZipTextEntry } from '../../src/code/zip-inspector.ts';
import { SessionPlaneDomainError } from '../../src/domain/errors.ts';
import { createStoredZip } from '../helpers/zip-fixture.ts';

test('inspectZip accepts a safe code archive and requires a durable root plan', () => {
  const archive = createStoredZip({
    'PLAN.md': '# Plan\n\n- [x] Build\n- [x] Test\n',
    'src/index.ts': 'export const value = 1;\n',
  });
  const inspected = inspectZip(archive, { requireRootPlan: true });
  assert.equal(inspected.planPath, 'PLAN.md');
  assert.deepEqual(inspected.files, ['PLAN.md', 'src/index.ts']);
  assert.match(readZipTextEntry(archive, 'PLAN.md') ?? '', /\[x\] Test/);
});

test('inspectZip rejects missing plans, path traversal, and invalid archives', () => {
  assert.throws(
    () => inspectZip(createStoredZip({ 'src/index.ts': 'x' }), { requireRootPlan: true }),
    (error: unknown) =>
      error instanceof SessionPlaneDomainError &&
      error.errorCode === 'code-artifact.plan-missing',
  );
  assert.throws(
    () => inspectZip(createStoredZip({ '../escape.txt': 'nope' })),
    (error: unknown) =>
      error instanceof SessionPlaneDomainError &&
      error.errorCode === 'code-artifact.invalid-zip',
  );
  assert.throws(
    () => inspectZip(createStoredZip({ 'src\\windows-path.ts': 'nope' })),
    (error: unknown) =>
      error instanceof SessionPlaneDomainError &&
      error.errorCode === 'code-artifact.invalid-zip',
  );
  const mismatchedHeader = createStoredZip({ 'PLAN.md': '# Plan\n' });
  mismatchedHeader[30] = 'X'.charCodeAt(0);
  assert.throws(
    () => inspectZip(mismatchedHeader),
    (error: unknown) =>
      error instanceof SessionPlaneDomainError &&
      error.errorCode === 'code-artifact.invalid-zip',
  );
  assert.throws(
    () => inspectZip(Buffer.from('not-a-zip')),
    (error: unknown) =>
      error instanceof SessionPlaneDomainError &&
      error.errorCode === 'code-artifact.invalid-zip',
  );
});
