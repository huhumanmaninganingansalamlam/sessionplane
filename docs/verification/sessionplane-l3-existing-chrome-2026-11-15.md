# Authenticated existing Chrome: live three-turn L3 baseline (2026-11-15)

This acceptance reused the **already authenticated SessionPlane-owned Chrome**.
One disposable synthetic test project was admitted through the installed **v0.4.98**
Core, without another browser, login, Core process or interruption to existing
conversations. The original Core PID 927769 and Chrome PID 6639 remained unchanged;
installed schema remained 15.

Installed source commit: b804ef35ff3104b87b95daf9358b603ed553cc3f
Installed source tree: 7ab22ffb6e7e10d9332f20b0efde590ac6c2ba6b

| Turn | Initial attempts | Canonical ACK | Exact FINAL/token/UTF-8/SHA-256 | FINAL SHA-256 |
| --- | --- | --- | --- | --- |
| 1 | 1 | Verified | Pass | a48ae505e37915f9612cdc3b7095ac6b58199e718ec213487a2c282b254ad068 |
| 2 | 1 | Verified | Pass | 0fb7fcc0ade0a08ed887e8c75ac175ec3feed0d63a96c6909655b384a5516b60 |
| 3 | 1 | Verified | Pass | 5809fba2bc7f4270d389f5e594c6b7b5f8ea3d79189f96045868c031891628ee |

All three results belong to the **same exact canonical Main conversation**. The
first root POST observation count was one and unambiguous; all three durable
initial attempts were acknowledged, and each exact answer matched its
individual synthetic prompt token and recomputed UTF-8 byte count/hash.

Naturally observed account HTTP 429 and ACK probe pacing were recovered
**read-only without resending** original second/third prompts. The initial
client exited before completion, and resumed clients used the persisted Task
identities. The private raw evidence is retained locally at
/tmp/sessionplane-existing-chrome-l3-Lgn32U (mode 0700; do not publish
identifiers, auth state or transcripts).

**Scope limitation:** This is installed 0.4.98 L3, not the schema-16
v0.4.99 candidate. An actual eligible no-FINAL **20-minute E07** was not
observed; neither new-version L3 nor four simultaneous real projects,
native foreground continuity, approved release nor deployment is established.
The live test exposed a distinct acceptance-runner gap: ACK-uncertain during
429 returned immediately rather than waiting for the same Task revision.
The repaired dev runner now waits read-only without replay and has focused
regression coverage. The installed Core was not replaced.
