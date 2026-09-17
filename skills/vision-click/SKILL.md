---
name: vision-click
description: Use a SessionPlane screenshot and explicit pageKey for coordinate clicks when no stable DOM ref exists.
---

# SessionPlane Vision Click

Prefer snapshot refs. Use coordinates only when the target is genuinely
non-DOM, such as a canvas or rendered image.

```bash
sessplane screenshot --page "$PAGE_KEY" --out /tmp/page.png --json
# inspect the screenshot and choose x/y in CSS pixels
sessplane mouse-click --page "$PAGE_KEY" --x 420 --y 315 --json
```

Always keep the exact `pageKey`. Retake the screenshot after navigation,
resize, zoom, or layout changes. Do not use browser focus as identity.

