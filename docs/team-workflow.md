# Team-centered MCP contract

The agent retains `teamId`. `sessionplane_team_get` returns roles with `roleRef`
and requests with `requestRef`. Copy these references; do not reconstruct them.
A role reference binds the current session and generation. A request reference
is the durable outbox UUID, valid across client/core restarts and role replacement.
References are identity handles, not authentication tokens; the owner-only local
socket remains the trust boundary.

The catalog has ten tools: `team_create`, `team_get`, `role_create`, `role_retire`,
`send`, `decide`, `wait`, `stop`, `session_replace`, `session_delete`, all prefixed
`sessionplane_`. Creation includes the initial provider session. Provider defaults
to ChatGPT; explicitly disabled providers fail before creating team/role state.

Ordinary flow: team_get → send → decide when needed → wait.

- Mutations require a caller-generated stable `requestId` for delivery deduplication.
  Reuse it only with identical arguments. IDs are scoped to the team; team creation
  needs a globally unique ID. The core derives the team request namespace;
  callers do not supply another client identity on every operation.
- `send` accepts a `roleRef` and checks its generation inside the session actor
  before creating work. An exact duplicate replays the original request even if
  the role has advanced. Concurrent new sends from an old role reference fail.
- `needs_decision` is a successful intermediate result. It contains fresh evidence,
  recorded choices and requested intent. Evidence omits scripts, decorative SVG and empty DOM wrappers while retaining
  controls, selection states and visible explanatory text. The agent selects observed refs; core
  validates freshness and performs the action. `decide` then advances that same
  request. A reveal returns fresh choices without submitting. There is no separate
  resume tool and no model/version/menu-label inference inside the workflow layer.
- `team_get` with `requestRef` inspects that exact request, including read-only
  acknowledgement recovery. Ordinary team reads return compact current-request summaries. With `history:true`,
  team_get lists all generations newest first in pages of 50 requests; pass the
  returned `nextRequestRef` as `beforeRequestRef` to continue until it is null.
  Historical references can therefore be rediscovered using only teamId.
- `wait` accepts exact request references in one team. It observes existing actors,
  returns answers, and captures generated files in the durable artifact store.
  An optional output directory materializes those files. No prompts are fanned out.
  Preparation waits return decisions immediately; ambiguous requests are observed,
  never resent. Each request's result/failure is reported independently, including invalid or
  cross-team references in a mixed batch. Historical file retrieval uses the stored
  response message identity and the current page ownership generation separately;
  newer answers cannot substitute for the requested answer. Downloaded files remain
  available offline. Missing exact provider answers return a file error, not an
  empty successful file list.
- `stop` cancels preparation or stops the exact generating request. It cannot stop
  a newer generation. `session_replace` explicitly changes routing without replaying
  work or deleting history. `role_retire` prevents new work on a finished expert.
  `session_delete` separately requires an exact request and `outputsRetrieved:true`;
  existing cleanup checks reject unresolved/shared conversations.

General search/research, context packaging, project-source management and code ZIP
orchestration are outside the agent chat workflow. They are not optional MCP profiles
or hidden commands behind a generic execute tool. Ordinary file upload and generated
file retrieval remain chat capabilities.

Unchanged invariants: semantic model intent, Chat-only surface, no provider fallback,
no automatic ambiguous resend, exact answer ancestry, one mutation owner per page,
dedicated profile, human-only verification, durable restart observation.
