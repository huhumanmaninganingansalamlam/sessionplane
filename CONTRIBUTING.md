# Contributing

SessionPlane's current product contract is [docs/PRD.md](docs/PRD.md). This
repository maintains a persistent `dev` integration branch and promotes
reviewed releases from `dev` to protected `main`.

## Work and review

- Use a short-lived branch, generally `fix-123-short-description`,
  `feat-123-short-description`, or `chore-short-description`. An issue number
  is useful when it exists, but is not required.
- Send ordinary changes to `dev` through one focused PR. Include the behavior
  change, its tests, and the necessary documentation in that PR. Do not combine
  unrelated formatting, dependencies, or cleanup.
- Explain why and what changed, the checks actually performed, and any
  compatibility impact. Do not restate a file-by-file change log or copy the CI
  checklist into the PR body.
- Use titles such as `fix(core): prevent duplicate continuation` or
  `docs: clarify remote setup`. Prefer a squash merge for ordinary PRs.
- Promote reviewed `dev` to `main` through a release PR. Preserve this
  repository's merge-commit exception for that promotion so the permanent
  `dev` branch can be realigned with `main`. Do not auto-delete `dev`.
- Never force-push or push directly to protected `main`; never move an
  already published version tag. Delete short-lived branches after merging.

## Issue triage

Use one `type/*` label per issue or PR. New issues get `status/triage`;
assign one `priority/*` only after review. `status/needs-info` and
`status/blocked` require a written reason and an unblock condition.
Use `resolution/*` only when closing without a normal fix. Do not duplicate
the label type in an issue title.

## Local verification

Use Node.js 24. Run the checks relevant to the change:

```sh
npm ci --ignore-scripts
npm run typecheck
npm run test:ci
npm run test:browser
npm run build
npm run test:package
```

A small documentation change does not need to repeat the entire browser suite.
Do not claim a live 20-minute continuation from a virtual-clock fixture. The
release acceptance and official package checks run separately from local tests.
No live ChatGPT send, browser/profile replacement, user-data removal, or
installed Core handover is implied by a PR.
