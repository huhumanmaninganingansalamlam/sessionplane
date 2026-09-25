# Agent-directed ChatGPT submission

## One execution path

Every ChatGPT send begins a durable preparation request. The core opens the exact
owned page, checks authentication, human verification and Chat-only boundaries,
and returns `provider.preparation-required` before filling or submitting.
There is no automatic model/menu/composer/send discovery path and no
`assistedPreparation` opt-in. That input is removed, not an alias for the new flow.

The agent interprets current roles, labels, descriptions, relationships and
selected state. It selects observed controls; it never sends executable
JavaScript, selectors or coordinates. Core validates fresh evidence and owns
all browser mutations, request receipts, submission attempts and answer identity.

## MCP flow

1. Call `sessionplane_send` with the intended provider session, prompt, model,
   effort, stable client ID and request ID. Its preparation handoff has
   `isError: true`, `errorCode: "provider.preparation-required"`, and `details`
   containing the same `requestId`, `sessionId`, `generation` and pending snapshot.
2. Call `sessionplane_preparation_inspect` with that exact four-part identity.
   Inspect again before each decision. `maxNodes` can broaden the observation;
   truncation is explicit. Interpret the current UI instead of assuming labels,
   model version numbers or fixed menu roots.
3. Use `sessionplane_preparation_decide` with a distinct `decisionId`, latest
   `snapshotId`, observed `ref`, and purpose `model`, `effort`, `composer` or
   `submit`. `reveal` opens a related model/effort chooser; `choose` records a
   choice and verifies its selected state. Sliders also need an explicit numeric
   `value`. Choose model/effort when requested, and always choose composer/send.
   Choosing composer/send does not fill or submit anything.
4. Call `sessionplane_preparation_resume` with the original request identity.
   Core revalidates the choices, transfers attachments, verifies the exact prompt,
   records the attempt, and submits once. It never reruns an automatic selector.
5. Wait using the exact returned session and generation. If requested intent
   cannot be matched to evidence before submission, explicitly cancel preparation
   with `decision: "cancel"`; never select another model/provider as fallback.

Requested intent and observed selection are distinct. The agent is responsible
for choosing evidence that satisfies the intent; a selected control alone does
not prove that an unrelated option matches it. Preserve semantic `model=Pro`.
ChatGPT Work is forbidden. Named-mode automatic switching is removed.

## Identity and restart

The original caller and request own the entire preparation workflow. Each action
checks owner, generation, page binding, observation revision and live semantics.
Unrelated sessions remain independent. Replay of `session.send` reports the
existing request; it never repeats browser mutations. Restart clears transient
choices and requires fresh inspection. Terminal generations are not reopened.

Existing durable submitted/ambiguous records remain evidence, not permission to
run removed submission behavior. No DB rewrite, implicit resend, fallback or
challenge bypass is part of this change. Gemini/Grok retain their own adapters
and require explicit operator enablement.

## Submission uncertainty

`sessionplane_submission_inspect` (`session.submission.inspect`) takes the
original `clientId + requestId + sessionId + generation`. It attempts existing
read-only exact acknowledgement recovery, then returns the current snapshot,
original prompt/model/effort and current owned-page evidence. This also works
after the automatic recovery window expires. Recovered identity starts the
existing answer observer on the same generation. Inspection never submits.

If identity remains unproven, do not repeat waits as though generation were
confirmed. A draft, absent message, missing CLI output or expired timeout does
not prove non-submission. Inspect evidence and obtain an explicit operator
decision before replacement/resubmission. Preparation decisions cannot mutate
an ambiguous submission. Final answers require exact submitted-user identity
and matching assistant ancestry; caller-provided answer text is not accepted.

## CLI transport

Prefer MCP structured arguments. CLI `send` initiates the same preparation
workflow; it is not a one-call browser submission shortcut. For long bodies use
`--prompt-file PATH` or `--prompt-stdin`, exclusively with each other and
`--prompt`. These preserve literal UTF-8 text including quotes and newlines.
Never interpolate arbitrary prompt text into shell commands.

## Verification

Keep one end-to-end MCP decision flow, exact identity/restart/no-resend checks,
and literal prompt transport coverage. Delete tests for removed automatic model
selection behavior; do not retain a second implementation to satisfy them.
Live provider evidence must be reported separately from browser fixtures.
