# Protocol

Compatibility identifier: `project-memory.coordinator.v1`
Contract version: `1`
Protocol package version: `1`

The protocol package lives at `continuity/scripts/lib/protocol/`. It defines types and ports. It does not contain provider business logic or the journal implementation.

## Ports

- **MemoryPort** — `doctor`, `validate`, `record`, `recordFile`
- **ContinuityReadPort** — `inspect`, `inspectReady`, `inspectWave`, `handoff`, `history`
- **CoordinatorWritePort** — validated recipes for packet, assign, start, report, evidence, result, fail, verify, context, release, and agent registration
- **AgentRuntimeAdapter** — `discoverCapabilities`, `validateConfiguration`, `launchAssignment`, `sendContext`, `waitForReport`, `cancelAssignment`, `collectEvidence`, `healthCheck`

## Records

WorkPacket, Assignment, AttemptReport, EvidenceRecord, VerificationReport, ContextHandoff, CoordinatorRunState, and release compatibility metadata are validated before use.

Unknown fields, secrets, credentials, billing tokens, private environment dumps, absolute paths, and unbounded payloads are rejected.

## Client

`createCliClient()` talks to `continuity/scripts/continuity.mjs` as a child process. Coordinator runtimes must use this client or an equivalent validated Core API. Direct journal writes are out of contract.

## Compatibility

Existing consumers of `project-memory.coordinator.v1` keep that identifier. A breaking change requires a new identifier and a migration path.
