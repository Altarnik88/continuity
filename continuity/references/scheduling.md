# Scheduling and adaptive waves

Ready-set and wave construction are pure functions over the current projection plus an optional AgentCapabilityRegistry. They do not write continuity data.

## Ready set

A task is ready only if all of the following hold:

- every dependency is `succeeded` or `superseded`
- the task is not a confirmed `blocked` task
- it is not in a dependency cycle
- it is not already held by an assignment
- it does not collide on path ownership with a held assignment
- it is allowed by the current Build-First phase
- it is not `XL` (those must be split first)
- `priority` is not `backlog`
- if a registry is supplied, some agent is eligible

Tie-break: priority rank, then blocked status, then `taskId` lexicographic order. The order is deterministic.

## Work packets

A WorkPacket contains `taskIds`, `weight`, `prerequisites`, `allowedPaths`, `forbiddenPaths`, `requiredCapabilities`, `riskCeiling`, `contextBudget`, `focusedChecks`, `completionContract`, and `handoffContract`.

Isolate (one task per packet) when complexity is `high`, risk is `significant` or `critical`, size is `L`/`XL`, or the class is security, migration, or architecture.

Batch 2–4 `XS`/`S` tasks only when they share `moduleId`, share required capabilities, have compatible non-overlapping ownership, stay inside the context budget, and keep separate statuses and acceptance criteria. Do not batch security, migration, architecture, and cosmetic work together to fill a slot.

`record packet` enforces these batching and isolation rules again on persistence. A packet has 1–4 tasks; `XL` is rejected until split, and complex, significant/critical-risk, `L`, security, migration, and architecture work remains isolated.

## Waves

Wave size is `min(available slots, independent packets)` under the resource weight limit. Unused slots stay idle when no independent work exists.

Packets are placed heaviest-first onto the current lightest slot. That balances **weight**, not task count. A freed slot may take the next ready packet without waiting for the rest of the wave, provided ownership and the integration contract still hold.

## AgentCapabilityRegistry

Vendor-neutral. Stored or passed records may contain only:

`actorId`, `providerFamily`, `modelFamily`, `capabilityProfiles`, `costTier`, `speedTier`, `contextCapacity`, `availableTools`, `worktreeSupport`, `trustTier`, `platformLimitations`, `calibrationStatus`, `kind`.

Profiles: `mechanical`, `implementation`, `integration`, `deep_reasoning`, `security_critical`, `visual`.

Selection: cheapest eligible agent that satisfies required profiles. Critical work cannot use unknown or insufficient capability. Stored registry records are exact: unknown fields and secret, credential, billing, or environment keys at any nesting are rejected. `high` trust requires `calibrated`; calibration never promotes trust automatically.

For critical verification prefer a different actor and, when available, a different model family. Family difference is not evidence.

## Assignments

Assignments are journal events with a generation token. Duplicate or ownership-conflicting assigns fail closed. Release is an explicit `assignment.released` or a `context_handoff.recorded`. Wall-clock expiry is not sufficient to free a lease. There is no assignment daemon.

When assignment ownership is omitted, it inherits each task's ownership paths, or its `moduleId` when no paths exist. Ownership must be canonical repository-relative paths/modules: traversal, UNC, home-relative, absolute, drive-letter, colon, and backslash forms are rejected. Conflict checks are case-folded segment-prefix checks (`src` overlaps `SRC/core`, but not `src-old`).

`record assign` revalidates its registered packet, registered actor, task capability/risk requirements, and all held ownership. Invalid actors, insufficient critical capability, stale/invalid packets, and overlaps are no-effect rejections.
