---
name: browser
description: Control the SessionPlane-owned Chrome with explicit pageKey and snapshot-bound refs.
---

# SessionPlane Browser

Use `sessplane` or the compatible `agbrowse` binary. The long-running
SessionPlane core owns Chrome; clients never attach to a separate browser.

## Safe workflow

1. Start or inspect the core with `sessplane health --json`.
2. List Pages with `sessplane tabs --json` and preserve the returned `pageKey`.
3. Navigate or select an explicit Page. Do not infer identity from focus, title,
   recency, or page-array position.
4. Take `sessplane snapshot --page <pageKey> --interactive --json`.
5. Mutations use the exact `pageKey`, `snapshotId`, and ref returned by that
   snapshot. Refresh the snapshot after navigation or DOM replacement.

```bash
sessplane new-tab https://example.com --json
sessplane snapshot --page "$PAGE_KEY" --interactive --json
sessplane click e12 --page "$PAGE_KEY" --snapshot-id "$SNAPSHOT_ID" --json
sessplane type e18 --page "$PAGE_KEY" --snapshot-id "$SNAPSHOT_ID" \
  --text "hello" --json
sessplane screenshot --page "$PAGE_KEY" --out ./page.png --json
```

Diagnostics are available through `console`, `network`, `get-dom`, `text`,
`evaluate`, and `observe-bundle`. Browser mutation is serialized per Page.

