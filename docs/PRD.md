# SessionPlane product contract

Status: current source contract for the v0.4.109 candidate. The installed
runtime remains whatever `sessplane health --json` reports until the candidate
is released and handed over.

## Product goal

SessionPlane owns the durable lifetime of one project conversation Task. It
keeps the exact browser conversation connected, performs approved work without
a connected client, asks the upstream agent for semantic decisions when needed,
executes the selected effect, verifies it, and resumes the same Task. A person
is involved only for an action outside the agent's delegated scope or an action
that inherently requires a person.

The authoritative path is:

```text
observe exact Task and provider state
→ derive provider actions and Task controls
→ persist a decision when semantic input is needed
→ agent pages any required evidence and selects one exact action
→ revalidate current Task, page, turn, control and authorization
→ execute once and verify the effect
→ persist the outcome
→ resume the same Task through the ordinary Core scheduler
→ observe the exact FINAL and complete the Task
```

A state name, error string, receipt or test count is not a successful handoff.
The selected effect must be verified and the original Task must make progress.

## Responsibilities

### Core Task kernel

The kernel owns the SQLite Task, immutable slot revision, attempts, exact turn
identities, dispatch evidence, ACKs, FINALs, decisions, timers, cancellation and
uncertain external effects. CLI, MCP and `task.wait` are transports; disconnecting
them does not end a Task or a timer.

A Task represents one user request. Every provider input is an Attempt. The
initial request and approved `계속` turns belong to the same Task. A later
independent business question in the same Main conversation is a new Task.

### Browser executor

The executor owns the dedicated browser profile, exact page lease and mutation
mutex. It reconnects by durable project, slot, Task, session generation and
canonical conversation identity. A changed PID, CDP port or target is a normal
recovery event, not a permanent failure. It never uses foreground focus, tab
order, title or URL alone as identity.

### ChatGPT semantic adapter

The adapter reports the exact conversation boundary, progress, questions,
permissions, model/configuration state and visible provider-owned controls. It
returns contextual action candidates instead of embedding widget-specific
business policy in the Core. Before every mutation it rechecks the exact Task,
turn, page, element and authorization, then verifies the resulting effect.

### Upstream agent

The agent interprets business meaning. It can page full decision evidence,
select a provider action, reobserve, wait, resume an approved continuation,
cancel, or request human help. It does not manage browser reconnection, timers,
collectors or repeated polling loops.

### Person

A person handles authentication, actions beyond explicit delegation, and
situations the agent elects to escalate with concrete evidence and a requested
action. Provider UI novelty alone is not a reason to call a person.

## Public Task interface

The public mutations are idempotent by `clientId` and `requestId`:

- `project.open`
- `task.start`
- `task.decide`
- `task.cancel`

The public reads are:

- `task.get`
- `task.wait`

`task.get` views:

| View | Meaning |
|---|---|
| `summary` | Current durable Task state and current decision preview. |
| `result` | Complete exact FINAL body and identity. |
| `evidence` | Bounded Task/attempt provenance. |
| `decision` | A page of one stored decision evidence section. |

Decision evidence sections include the original request, current attempt and
attempt history, provider question, permission, partial answer, capability
issues, provider controls and the complete provider action catalogue. The
summary packet stays bounded; `view=decision` returns `nextCursor` until the
selected section is complete. Information size never converts a real decision
into `unsupported`.

A decision contains two independent kinds of choices:

1. Provider actions derived from the current exact page.
2. Task controls: `reobserve`, `wait`, `resume`, `cancel`, and
   `request_human` when agent escalation is allowed.

Provider actions may be omitted from the bounded preview while remaining
selectable by the exact action reference retrieved from the paged action
catalogue. The durable decision stores every candidate and its evidence.

## Approved continuation

An approved ChatGPT continuation policy uses the literal `계속` and a fixed
20-minute interval. The Core owns every due even with no connected client.

At each due the Core:

1. Rechecks cancellation, completion and the exact active policy.
2. Observes the current exact turn and FINAL state.
3. Completes immediately if a valid FINAL exists.
4. Defers without interrupting a stream if ChatGPT is still generating.
5. Creates one new Attempt for this due only after fresh exact no-FINAL evidence
   and a safe composer state.
6. Sends once, then recovers that same Attempt if ACK/evidence recording was
   interrupted. It never replays the same Attempt.
7. Arms the next due from the new exact ACK.

There is no built-in one-Continue limit and no hidden fifth-probe or fifth-slot
threshold. `agentReviewAfterMs` is an optional explicit Task policy. When that
stagnation duration passes across repeated exact continuation ACKs without a
FINAL, the Core stops before the next send and gives the agent the full attempt
history plus `wait`, `resume`, `cancel` and escalation controls. `resume` resets
the stagnation epoch and immediately re-enters the same approved due path.

A backend 429 or pacing fence applies to that canonical read. It is not evidence
that no FINAL exists and is not authorization to send. UI observations may be
used only when they satisfy the same exact turn and conversation boundary.

## Dynamic provider controls

The adapter observes visible provider-owned dialogs after the exact latest user
turn. Each control reports its role, label, context, operation, enabled and
selected state, current value, options, expected effect, relevance and risk.
Multiple candidates remain distinct.

The generic executor supports small common operations:

- activate a current non-destructive control;
- set a bounded text value without submitting the chat request;
- select one current value.

Destructive, payment, publication, permission-grant and submit controls are not
made executable by the generic path. Generic affirmative labels such as
`Confirm` are also blocked when their current dialog has destructive context.
Unknown or unsafe controls remain observable so the agent can inspect more or
request human help. Stale references are rejected and replaced by a fresh
observation; a stale element is never clicked.

## Permission delegation

Provider permission text never creates authority. `task.start` may include an
exact once-only delegation:

```json
{
  "agentPermissionGrants": [
    {
      "appName": "hostspan-git",
      "toolName": "repository_read",
      "allowMode": "once"
    }
  ]
}
```

Only a current exact permission card matching the Task's user turn, app, tool,
arguments evidence and once mode exposes `grant_permission` and
`decline_permission`. The adapter reinspects the card immediately before the
choice and verifies that it disappeared afterward. A missing grant, a broader
scope, hidden arguments or sensitive evidence stays non-executable and may be
escalated by the agent.

## Uncertainty and recovery

A possible external mutation with an unknown effect is never automatically
replayed. The Core first finds the effect and joins it to the original Attempt.
Read failure is not send failure, and send uncertainty is not success.

Configuration actions are different from message submission. If a model or
reasoning choice is uncertain, a fresh exact observation may establish that it
already succeeded or expose one new current configuration action. The stale
old action remains non-replayable.

Agent-to-human escalation is atomic: resolving and consuming the agent decision,
recording its outcome and installing the exact human decision commit in one
SQLite transaction. A lost response replays the receipt and does not create a
second request.

A pending agent or human decision pauses new provider mutations, not FINAL
observation. An exact terminal FINAL supersedes the decision, clears timers and
completes the Task without a client reconnect.

## Runtime and removed paths

The installed runtime has one Core, one SQLite writer and one browser owner.
There is no public team/role/request/workflow mutation catalogue and no parallel
client-owned collector. The build roots are `main`, `cli/main` and `mcp/server`;
pre-Task source files not imported by those roots are not emitted into the npm
package. Standard MCP 2025 wire compatibility is a transport protocol, not an
old SessionPlane execution engine.

## Acceptance criteria

A release is accepted only when behavior, not state names, proves all of the
following:

- three or more Tasks use the same Main canonical conversation without answer
  mixing or an unnecessary project/conversation;
- a real 20-minute no-FINAL due sends one exact approved continuation and
  recovers its ACK and FINAL;
- repeated no-progress has no hidden count limit, reaches an explicit agent
  review policy, and the selected `resume` performs the next exact due;
- a provider question or changed UI yields contextual candidates, paged evidence
  and a verified same-Task resume;
- large questions, partial answers and action catalogues are fully pageable;
- stale element references never mutate the new screen;
- delegated permissions can be allowed or declined once; nondelegated grants
  cannot execute;
- FINAL arriving during agent or human decision wait completes without a client;
- Core/browser restart preserves policy, decisions, uncertain Attempts and exact
  identities without replaying an original request;
- multiple background Tasks progress without foreground activation and one
  blocked Task does not starve the others;
- clean source, official package, installed runtime and live receipt all name the
  same commit, tree and package digest.

Rare faults may use controlled tests. A synthetic clock is not evidence of the
real 20-minute provider path, and previous-version recovery is not represented
as a new-version end-to-end run.
