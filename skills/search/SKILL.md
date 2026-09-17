---
name: search
description: Fetch original pages safely, extract strict schemas, verify search candidates, and build evidence-led research plans with SessionPlane.
---

# SessionPlane Search

Use original-page evidence rather than treating snippets as proof.

```bash
sessplane fetch https://example.com/article --json
sessplane search "Node.js 24 SQLite" --results candidates.json --json
sessplane search --verify https://example.com/article --json
sessplane research plan --query "Node.js 24 SQLite" --json
sessplane research enrich-fetch --plan plan.json --results candidates.json --json
sessplane research browse-plan --plan plan.json --enrichment enrichment.json --json
```

Fetch rejects credentials, unsafe protocols, private/link-local targets, and
unsafe redirects unless the local/private override is explicit in core config.
Schema extraction rejects missing, extra, or unsupported recursive fields.

