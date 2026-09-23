---
name: web-ai
description: Run durable ChatGPT, Gemini, and Grok sessions through SessionPlane teams, roles, generations, uploads, waits, and artifacts.
---

# SessionPlane Web AI

The core owns provider Pages and continues observation after the calling shell
or MCP subprocess exits. Preserve `teamId`, `roleKey`, `sessionId`, and
`generation`; never select a chat by active tab or title.

Use SessionPlane only for ChatGPT, Gemini, and Grok provider workflows. General
browser automation belongs to Playwright/the general browser skill. Do not
start another SessionPlane core, do not pass --state-dir, and do not use
SessionPlane to log into or manipulate unrelated websites.

```bash
sessplane team create --name issue-123 --request-id issue-123-team --json
sessplane role add "$TEAM_ID" expert.backend --type expert \
  --request-id issue-123-backend-role --json
sessplane session create "$TEAM_ID" expert.backend --provider chatgpt \
  --request-id issue-123-backend-session --json
sessplane send "$TEAM_ID" expert.backend --prompt "Review this" \
  --file ./context.md --request-id issue-123-backend-1 --json
sessplane wait --session "$SESSION_ID" --generation "$GENERATION" --json
```

`waitExpired` and backend observation deferral are nonterminal success states.
`submission_unknown` must never be automatically resent. Use a stable
`requestId` only for an exact retry of the same mutation.

## Provider continuity and model families

Provider availability is an operator-owned core setting. ChatGPT is enabled by default; Gemini and Grok require explicit operator enablement. Check `system.health.providers.enabled` when choosing a provider. Do not create a session for a disabled provider and do not reinterpret `provider.disabled` as a reason to fall back to another provider.

Keep a role on its current provider when a generation must be reconstructed or
replaced. Never use Gemini or Grok as an implicit fallback for ChatGPT because
of `submission_unknown`, model unavailability, a consent/interstitial page,
rate limiting, wait expiry, or observation trouble. Change provider only when
the user or caller explicitly requested a different provider.

For ChatGPT, pass `--model Pro` when the intent is the best currently available
Pro-family model. SessionPlane discovers the live model menu, selects the
highest enabled Pro-family option, and falls back to the next enabled Pro option
before submit. Do not encode version labels such as `6 Pro` or `5.6 Pro` in the
agent workflow.

Do not inspect `/backend-api/models`, a partial model list, or one picker snapshot
and declare Pro unavailable before calling SessionPlane. ChatGPT can return an
Instant-only capability feed while the live composer picker still exposes Pro.
Let `sessplane send --model Pro` perform both capability and live-picker
reconciliation. Only a typed pre-submit `provider.model-unavailable` returned by
that current submission establishes Pro unavailability. A missing catalog entry
is not a task blocker. Do not call it a rate limit unless SessionPlane reports
structured 429/deferred evidence or verified visible provider rate-limit evidence.

`provider.human-action-required` means a visible browser verification is open.
Do not retry in a loop and do not attempt to click or bypass it. Ask the user to
complete it in the headed SessionPlane Chrome window, then rerun the submission
with a new request ID because the previous attempt ended before prompt mutation.

Provider-created files are durable:

```bash
sessplane artifact discover --session "$SESSION_ID" --json
sessplane artifact capture --session "$SESSION_ID" --json
sessplane artifact export "$ARTIFACT_ID" --out ./result.zip
```

Use `sessplane context dry-run` before a large submission and either upload the
generated package or select inline transport.

## ChatGPT Chat only

SessionPlane never submits through ChatGPT Work and never silently changes a
Work composer back to Chat. An explicit `surface=work` request or a visibly
active Work composer fails before the irreversible submit. Use ordinary Chat
model/reasoning selection and named Chat modes instead.

## ChatGPT Project Sources

Always pass the exact `https://chatgpt.com/g/<project-id>` URL. Inspect the
files first with `--dry-run`; actual additions are append-only by visible file
name and concurrent mutations to one project are serialized.

```bash
sessplane chatgpt project-sources add \
  --project-url "$PROJECT_URL" \
  --file ./context.md --dry-run --json

sessplane chatgpt project-sources add \
  --project-url "$PROJECT_URL" \
  --file ./context.md --request-id project-source-1 --json
```

## ChatGPT code mode

`code generate` is a normal durable generation followed by exact artifact
recovery. It never scans the active tab. New code ZIPs must contain a nonempty
root `PLAN.md` or `00_plan.md`; unsafe or malformed archives are rejected.

```bash
sessplane code generate --session "$SESSION_ID" \
  --prompt "Build a minimal TypeScript CLI" \
  --output-zip ./result.zip \
  --request-id code-1 --json

sessplane code generate --session "$SESSION_ID" \
  --prompt "Build frontend and backend archives" \
  --multi-zip --output-dir ./artifacts \
  --request-id code-2 --json
```

`code extract` is read-only provider recovery. Prefer an exact durable session;
an explicit conversation ID or URL is also accepted. Omit `--require-plan`
only when recovering legacy archives created before the plan contract.

```bash
sessplane code extract --session "$SESSION_ID" \
  --output-zip ./recovered.zip --require-plan --json
```

