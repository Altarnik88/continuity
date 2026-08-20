#!/usr/bin/env node

// Compatibility alias for existing integrations. The canonical public wrapper
// is continuity.mjs and both paths intentionally share one implementation.
await import('./continuity.mjs');
