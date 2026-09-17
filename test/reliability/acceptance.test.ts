import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

interface AcceptanceEvidence {
  readonly id: `A${string}`;
  readonly description: string;
  readonly files: readonly string[];
}

const ACCEPTANCE_EVIDENCE: readonly AcceptanceEvidence[] = [
  {
    id: 'A01',
    description: 'one team resolves primary plus three attached roles',
    files: ['test/integration/team-session-rpc.test.ts'],
  },
  {
    id: 'A02',
    description: 'the same roleKey remains isolated between teams',
    files: ['test/integration/team-session-rpc.test.ts'],
  },
  {
    id: 'A03',
    description: 'current-session replacement preserves predecessor lineage',
    files: ['test/integration/team-session-rpc.test.ts'],
  },
  {
    id: 'A04',
    description: 'four background Pages are read without focus mutation',
    files: ['test/browser/background-pages.test.ts'],
  },
  {
    id: 'A05',
    description: 'conversation navigation invalidates exact page identity',
    files: ['test/browser/page-registry.test.ts', 'test/browser/chatgpt-submission.test.ts'],
  },
  {
    id: 'A06',
    description: 'duplicate conversation Pages are quarantined',
    files: ['test/browser/page-registry.test.ts', 'test/browser/browser-restart-recovery.test.ts'],
  },
  {
    id: 'A07',
    description: 'twenty waits share one actor and one core observer',
    files: ['test/integration/health-metrics.test.ts', 'test/integration/session-actor-wait.test.ts'],
  },
  {
    id: 'A08',
    description: 'stale DOM can recover the exact server final',
    files: ['test/integration/backend-recovery.test.ts'],
  },
  {
    id: 'A09',
    description: 'backend HTTP 429 becomes observation deferral, never provider blocked',
    files: ['test/integration/backend-recovery.test.ts', 'test/unit/probe-coordinator.test.ts'],
  },
  {
    id: 'A10',
    description: 'only a visible provider rate-limit dialog becomes blocked',
    files: ['test/browser/chatgpt-observer.test.ts', 'test/unit/exact-final.test.ts'],
  },
  {
    id: 'A11',
    description: 'client wait expiry does not terminalize the generation',
    files: ['test/integration/session-actor-wait.test.ts', 'test/integration/session-observation.test.ts'],
  },
  {
    id: 'A12',
    description: 'recent exact progress remains observing past the session deadline',
    files: ['test/unit/wait-reducer.test.ts'],
  },
  {
    id: 'A13',
    description: 'unknown deadline state remains nonterminal',
    files: ['test/unit/wait-reducer.test.ts'],
  },
  {
    id: 'A14',
    description: 'duplicate send requestId executes one browser mutation',
    files: ['test/integration/session-send.test.ts'],
  },
  {
    id: 'A15',
    description: 'the same requestId with another payload conflicts',
    files: ['test/integration/session-send.test.ts'],
  },
  {
    id: 'A16',
    description: 'lost submit acknowledgement stays submission_unknown without resend',
    files: ['test/integration/session-send.test.ts', 'test/integration/restart-recovery.test.ts'],
  },
  {
    id: 'A17',
    description: 'disabled requested model fails before submit',
    files: ['test/browser/chatgpt-submission.test.ts', 'test/integration/session-send.test.ts'],
  },
  {
    id: 'A18',
    description: 'historical branches and later-user answers are rejected',
    files: ['test/unit/backend-recovery.test.ts'],
  },
  {
    id: 'A19',
    description: 'late writes for superseded generations are rejected',
    files: ['test/integration/session-actor-wait.test.ts'],
  },
  {
    id: 'A20',
    description: 'service restart restores active observation without prompt resend',
    files: ['test/integration/restart-recovery.test.ts'],
  },
  {
    id: 'A21',
    description: 'browser restart rebinds by exact conversation identity, never title',
    files: ['test/browser/browser-restart-recovery.test.ts'],
  },
  {
    id: 'A22',
    description: 'MCP subprocess restart leaves the core session actor intact',
    files: ['test/integration/cli-mcp.test.ts'],
  },
  {
    id: 'A23',
    description: 'CLI and MCP preserve the same state and error semantics',
    files: ['test/integration/cli-mcp.test.ts'],
  },
  {
    id: 'A24',
    description: '500KB answer SHA-256 is identical through DB, RPC, CLI, and MCP',
    files: ['test/integration/large-answer-transport.test.ts'],
  },
  {
    id: 'A25',
    description: 'isolated clean source copy passes install, typecheck, tests, build, and doctor',
    files: ['scripts/clean-checkout-gate.mjs'],
  },
];

test('acceptance A01-A25 has executable, repository-local evidence', () => {
  assert.equal(ACCEPTANCE_EVIDENCE.length, 25);
  assert.deepEqual(
    ACCEPTANCE_EVIDENCE.map((entry) => entry.id),
    Array.from({ length: 25 }, (_, index) => `A${String(index + 1).padStart(2, '0')}`),
  );

  for (const entry of ACCEPTANCE_EVIDENCE) {
    assert.ok(entry.description.length > 0, `${entry.id} must explain its observable contract`);
    assert.ok(entry.files.length > 0, `${entry.id} must name executable evidence`);
    for (const file of entry.files) {
      assert.equal(
        existsSync(path.resolve(process.cwd(), file)),
        true,
        `${entry.id} evidence is missing: ${file}`,
      );
    }
  }
});

test('runtime identity surfaces contain no focus mutation or title-based selection', () => {
  for (const file of [
    'src/browser/browser-owner.ts',
    'src/browser/page-registry.ts',
    'src/core/recovery-service.ts',
    'src/providers/chatgpt/adapter.ts',
  ]) {
    const source = readFileSync(path.resolve(process.cwd(), file), 'utf8');
    assert.equal(source.includes('bringToFront('), false, `${file} must not focus a Page`);
    assert.equal(source.includes('document.title'), false, `${file} must not use title identity`);
  }
});
