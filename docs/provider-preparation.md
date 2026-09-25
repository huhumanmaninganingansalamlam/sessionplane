# Agent-guided provider preparation

## Responsibility boundary

SessionPlane owns the dedicated browser, exact session/generation, all page
mutations, durable submission attempts, acknowledgement and answer recovery.
The calling agent interprets live UI evidence when automatic preparation cannot
resolve the requested intent. It returns a decision, not executable JavaScript,
CSS selectors, coordinates or a separate browser connection.

This is a provider-session workflow, not arbitrary website automation. ChatGPT
remains Chat-only; provider allowlists, human-verification boundaries and semantic
model intent remain enforced. WebGPT is comparative evidence, not a dependency.

## Decision and continuation

A preparation handoff identifies the original request, session and generation.
The caller retains its requested model/effort; inspection supplies the current
observation revision and evidence for identifying the unresolved control.
Evidence includes live roles, names, descriptions, relationships and selected,
disabled or editable state. Observation must not depend on a fixed model-menu
CSS root. Broader evidence must be obtainable when initial candidates are absent
or ambiguous; truncation must be explicit.

Preparation purposes include model/effort selection and identifying the current
composer or send control. Identifying a composer/send target never fills or submits
it; those mutations remain inside the recorded core submission operation.

The agent selects an observed candidate for a preparation purpose, requests more
observation, or reports that the intent cannot be satisfied. Core executes the
choice using its existing page owner and verifies the resulting live state.
A choice is evidence-backed caller judgment, not proof that the provider selected
the requested model. Requested intent and observed selection stay distinct.

Continue the original request and generation after preparation. Do not allocate
a fresh generation, replay the prompt or rerun automatic model selection over a
verified caller selection. Existing automatic send remains available; it and
assisted continuation share submission and acknowledgement logic.

Automatic preparation uncertainty must branch into a durable, nonterminal
preparation wait before recording a terminal pre-submit failure. Existing terminal
generations are not reopened. Same-request replay returns the pending decision
state without executing preparation. Restart distinguishes this wait from an
interrupted ordinary preparation and restores observation only.

Verification of a caller choice must use the selected live control and its
resulting evidence, not require the old automatic menu recognizer to succeed.

## Public preparation protocol

`session.send` opts in with `assistedPreparation: true`; omitted/false retains
the existing send contract. The first implementation exposes assisted
preparation through MCP; the ordinary CLI flow is unchanged. On unresolved
preparation, `session.send` returns typed `provider.preparation-required` with
the exact nonterminal snapshot. This is a caller decision request, not evidence
that the requested model is unavailable.

- `session.preparation.inspect` reads current evidence for the original owner
  `clientId + requestId + sessionId + generation`; broader observation is allowed.
- `session.preparation.decide` records a distinct decision ID and interprets an
  observed candidate for the requested purpose. It can also cancel preparation.
- `session.preparation.resume` explicitly continues the original submission after
  verifying the observed selections. It does not allocate a new generation.

The MCP handoff returns `isError: true` and `structuredContent` with
`errorCode: "provider.preparation-required"` and `details` containing the
original `requestId`, exact `sessionId` and `generation`, and nonterminal
`snapshot`. Inspect that identity, choose only refs from its latest returned
`snapshotId`, then inspect again before every next decision because each
successful decision refreshes the observation. For example, opt in on send:

```json
{
  "name": "sessionplane_send",
  "arguments": {
    "clientId": "codex-main",
    "requestId": "task-123-generation-1",
    "teamId": "<team-uuid>",
    "roleKey": "main",
    "prompt": "Answer the question.",
    "model": "Pro",
    "assistedPreparation": true
  }
}
```

An unresolved selection has this shape; the full snapshot includes the exact
session and generation fields:

```json
{
  "isError": true,
  "structuredContent": {
    "requestOk": false,
    "errorCode": "provider.preparation-required",
    "details": {
      "promptSubmitted": false,
      "requestId": "task-123-generation-1",
      "sessionId": "<session-uuid>",
      "generation": 1,
      "snapshot": {
        "sessionState": "submitting",
        "submissionState": "prepared",
        "promptSubmitted": false
      }
    }
  }
}
```

Inspect it using that exact identity:

```json
{
  "name": "sessionplane_preparation_inspect",
  "arguments": {
    "clientId": "codex-main",
    "requestId": "task-123-generation-1",
    "sessionId": "<session-uuid>",
    "generation": 1
  }
}
```

Pass the returned `snapshotId` and an observed candidate `ref` to
`sessionplane_preparation_decide`. Use a distinct `decisionId` for each call;
choose includes `purpose` (`model`, `effort`, `composer`, or `submit`), while a
slider choose also requires its explicit numeric `value`. Use `reveal` to open a
related model or effort choice list, then inspect it. Finally call
`sessionplane_preparation_resume` with the original request identity. Resume
fills the prompt and submits it once through the existing core operation.
`sessionplane_preparation_decide` with `decision: "cancel"` abandons the pending
generation before submit.

Replaying the original `session.send` never resumes browser mutations; it returns
the pending preparation condition. Inspection after restart refreshes transient
references before any new decision. Protocol details in bundled skills must match
the implemented tool schemas.

## Ownership and uncertainty

Individual action locks are insufficient: the original preparation request owns
the multi-call workflow. Other clients cannot change its selection or submit
between decisions. Unrelated sessions remain independent. Every decision checks
request ownership, current generation, page binding, observation revision and
current target semantics before mutation. Old references cannot authorize a new
page or a changed control.

Core restart invalidates transient observations. Continuation begins with fresh
observation and durable request state, never an automatic replay of an action.
No prepared draft, elapsed timeout or expired owner proves non-submission.
Failures after attachment or composer mutation do not enter the decision loop;
the pre-submit failure remains explicit. Bind composer/send choices before
resuming when the automatic targets are unknown.

Decisions are purpose-scoped preparation operations, not unrestricted click or
Enter commands. Composer filling and final submit remain the existing recorded
core operation. A stale draft or evidence of possible submission must be
reconciled before further mutation. An unexpected side effect is uncertainty,
not a pre-submit success; do not claim arbitrary page event handlers can be
proven harmless. Ambiguous action receipts must not be replayed blindly.

## Answers and compatibility

Answer completion still requires exact submitted-user identity and matching
assistant ancestry. Caller-provided text cannot mark a generation complete.
Provider observation failures remain distinct from preparation decisions.
No provider/model fallback, challenge bypass, or Work submission is introduced.

The assisted protocol currently supports ChatGPT through MCP/RPC. Other
providers retain their existing submission behavior. CLI send remains unchanged.

Existing send inputs and ordinary successful behavior remain supported. New
assisted operations must be explicitly described in the bundled skill, including
how the caller discovers a pending decision and resumes the same request. Keep
storage changes minimal and reuse outbox/receipt identity where sufficient.

## Acceptance

Verify one end-to-end case whose model UI is not recognized by the automatic
selector: inspect evidence, select through caller reasoning, continue the same
request/generation, submit once and recover its exact answer. Also verify stale
choice rejection, competing-client exclusion and no resend after interrupted
submission. Reuse existing behavioral tests; add only distinct high-risk coverage.
Do not claim live-provider validation from a fixture alone.
