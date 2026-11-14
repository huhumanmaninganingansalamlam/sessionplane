/** Compare a frozen candidate with the *current* checkout and emitted build.
 * Every source mutation, including an otherwise valid concurrent commit,
 * invalidates this run rather than attaching test results to another tree.
 */
export function compareCandidateSource(initial, current, identity, options = {}) {
  const expectedBranch = options.expectedBranch ?? 'dev';
  if (!['dev', 'main'].includes(expectedBranch)) {
    throw new TypeError('Candidate source must be fenced to dev or main');
  }
  const issues = [];
  if (initial.branch !== expectedBranch || initial.status !== '' ||
      !/^[a-f0-9]{40}$/.test(initial.head) ||
      !/^[a-f0-9]{40}$/.test(initial.tree)) {
    issues.push('invalid_initial_' + expectedBranch + '_candidate');
  }
  if (current.head !== initial.head) issues.push('candidate_head_changed_during_tests');
  if (current.tree !== initial.tree) issues.push('candidate_tree_changed_during_tests');
  if (current.branch !== initial.branch) issues.push('candidate_branch_changed_during_tests');
  if (current.status !== '') issues.push('candidate_worktree_modified_during_tests');
  if (!identity || identity.sourceCommit !== initial.head ||
      identity.sourceTree !== initial.tree || identity.sourceState !== 'clean') {
    issues.push('emitted_build_identity_differs_from_frozen_candidate');
  }
  return { passed: issues.length === 0, issues };
}
