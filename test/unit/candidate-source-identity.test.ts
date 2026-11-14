import assert from 'node:assert/strict';
import test from 'node:test';
import { compareCandidateSource } from '../../scripts/candidate-source-identity.mjs';

const start = { branch: 'dev', head: 'a'.repeat(40), tree: 'b'.repeat(40), status: '' };
const identity = { sourceCommit: start.head, sourceTree: start.tree, sourceState: 'clean' };

test('same clean dev HEAD/tree and embedded build identity pass exact candidate provenance', () => {
  assert.deepEqual(compareCandidateSource(start, { ...start }, identity), {
    passed: true, issues: [],
  });
});

test('concurrent clean commit during acceptance fails closed even when all test commands passed', () => {
  const current = { ...start, head: 'c'.repeat(40), tree: 'd'.repeat(40) };
  assert.deepEqual(compareCandidateSource(start, current, identity), {
    passed: false, issues: [
      'candidate_head_changed_during_tests',
      'candidate_tree_changed_during_tests',
    ],
  });
});

test('uncommitted file changes or dirty emitted build cannot be reported as accepted', () => {
  assert.deepEqual(compareCandidateSource(start, { ...start, status: ' M src/main.ts' },
    { ...identity, sourceState: 'dirty' }), {
    passed: false, issues: [
      'candidate_worktree_modified_during_tests',
      'emitted_build_identity_differs_from_frozen_candidate',
    ],
  });
});
