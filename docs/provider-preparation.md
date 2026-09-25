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
   A collapsed model/effort chooser can confirm its currently displayed selection
   without clicking. Slider selection verifies the chosen numeric value; the agent
   interprets its meaning from the surrounding observed labels. Choosing
   composer/send does not fill or submit anything.
4. Call `sessionplane_preparation_resume` with the original request identity.
   Core revalidates model/effort and composer, and prepares the exact prompt. If
   the send control appears only after typing, resume returns preparation-required
   again with promptSubmitted:false. Inspect, choose that submit control, and
   resume the same request. Attachments transfer only after a submit target is
   available; core then records the attempt and submits once. It never reruns an automatic selector.
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

## Unreadable or long conversations

A successful health check only proves that the core and browser are available.
For each operation, inspect the exact session and generation. If wait reports
`provider.conversation-unavailable`, the conversation fetch failed and its
message/composer surface is absent. This is not evidence of ongoing generation,
permanent deletion, or non-submission. A 429 remains transport deferral: respect
`nextCheckAt`, and do not replace a healthy conversation because of 429 alone.
Use `sessionplane_submission_inspect` to inspect the live page and retrieve the
original prompt, model, effort, surface, attachments (path/hash), and deadline.
Do not endlessly repeat wait on a page that cannot display the conversation.

When the caller decides the conversation must be replaced, or a completed long
conversation needs a fresh context, use `sessionplane_session_create` for the
same `teamId`, `roleKey`, and provider with a new stable request ID. The old
session becomes superseded and the new one records `predecessorSessionId`.
Preserve completed answers and required artifacts, then carry only the relevant
role brief, current objective, decisions, and unresolved work into the new send.
Keep requested model/effort and verify attachment identity. Do not copy an entire
long transcript or rotate on an arbitrary message count. New sends still require
fresh preparation decisions. A new session does not imply permission to repeat
an unresolved submission; follow the caller/operator's explicit recovery intent.
An existing instruction to replace and continue is authorization; do not ask again.

Session replacement does not delete provider history. Cleanup is a separate
operation after the role's work is complete and required answers/artifacts have
been retrieved. Never delete active, unacknowledged, or unrecovered conversations
merely because a successor exists or the page cannot be loaded.

Call `sessionplane_session_delete` (`session.delete` RPC) with the exact session,
generation and conversation ID, stable request ID and `outputsRetrieved: true`.
This deletes ChatGPT history itself and closes its owned page while retaining
local durable answers. The core rejects unresolved generations and shared
conversation identities. It records the attempt before contacting the provider;
`provider.deletion-unknown` survives restart and cannot be retried under another
request ID. Successful replay returns the original deletion receipt.
