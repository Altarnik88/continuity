# Adapters

Runtime adapters launch work. They are not sources of Continuity truth.

Required methods:

- `discoverCapabilities()`
- `validateConfiguration()`
- `launchAssignment()`
- `sendContext()`
- `waitForReport()`
- `cancelAssignment()`
- `collectEvidence()`
- `healthCheck()`

## local-process

Shipped live adapter. It runs the current Node.js binary as a child process and returns a structured report. The child entry is `local-worker.mjs`; that file is not a separate adapter name. It does not open a network client and does not store credentials.

A passing `local-process` smoke is live adapter evidence. It proves a real process ran. It does not prove a hosted model ran.

## fake

Deterministic test double. It is not live proof of autonomous execution. `doctor` reports `adapter-class=test-only`.

## Configuration

See `continuity/assets/coordinator.config.json` and `examples/coordinator.config.json`. Unknown fields and secret-like keys are rejected. Do not put API keys in config, fixtures, journals, or release artifacts.

## Vendor neutrality

Adapters are named by capability, not by a vendor product. An unknown adapter name is an error, not a silent fallback.
