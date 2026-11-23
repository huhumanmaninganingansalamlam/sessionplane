# Contributing

SessionPlane's repository product contract is [docs/PRD.md](docs/PRD.md). The
canonical workspace keeps its private product-authority index and editable Task
ledger in the parent `docs/` tree. Repository documentation describes the
product and review rules; it does not duplicate Task status or completion
evidence.

## Work records and branches

- GitHub issue intake is for **Bug** reports and **Feature** proposals. Accepted
  implementation, refactor, maintenance and operations work is recorded as a
  workspace `repoctl` Task before code changes begin.
- From the canonical workspace root, create a Task with:

  ```sh
  ./scripts/repoctl task create "Task title" --start --json
  ```

- Internal SessionPlane development uses the existing canonical `repos/`
  checkout on `dev`. Do not create arbitrary task branches or worktrees and do
  not discard unrelated user work merely to obtain a clean tree.
- External forks may use their own review branches, but publication into this
  repository still follows the reviewed `dev → main` promotion path.
- Keep one Task and one reviewable logical change focused. Do not mix behavior
  changes with unrelated formatting, dependency updates or mass renames.

## Review and publication

- Explain why and what changed, the checks actually performed and any
  compatibility or evidence impact. Do not copy a file-by-file change log or a
  generic CI checklist into the PR body.
- Use titles such as `fix(core): prevent duplicate continuation` or
  `docs: clarify authority path`.
- Promote reviewed `dev` to `main` through a release PR. Preserve the merge
  relationship required to realign the permanent `dev` branch with `main`.
- Never force-push or push directly to protected `main`; never move a published
  version tag.
- Branch, clean-tree, ancestry and provenance gates apply to publication. They
  do not block an authorized local fix, test, recovery or acceptance
  continuation in the existing checkout.

## GitHub issue triage and labels

The issue chooser intentionally contains only Bug and Feature forms. There is no
generic Task issue because workspace `repoctl` Tasks are the authoritative work
record.

- Bug reports use `type/bug`; feature proposals use `type/feature`.
- New issues receive `status/triage`.
- Assign one `priority/*` only after review.
- `status/needs-info` and `status/blocked` require a written reason and an
  explicit unblock condition.
- Use `resolution/*` only when closing without a normal implementation.
- Do not create or apply `type/task` as a second implementation ledger. When an
  issue is accepted, link it from the workspace Task rather than copying Task
  status back into the issue body.

## Local verification

Use Node.js 24. Run the checks relevant to the change:

```sh
npm ci --ignore-scripts
npm run lint:docs
npm run typecheck
npm run test:ci
npm run test:browser
npm run build
npm run test:package
```

A small documentation change does not need to repeat the entire browser suite.
It does require the documentation authority check, focused contract test,
typecheck and diff validation. Do not claim a live 20-minute continuation from a
virtual-clock fixture. Release acceptance and official-package checks remain
separate from local tests.

No live ChatGPT send, browser/profile replacement, user-data removal or
installed Core handover is implied by a PR or a documentation-only Task.
