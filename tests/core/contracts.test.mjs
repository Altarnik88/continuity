import assert from 'node:assert/strict';

import {
  EVENT_TYPES,
  REDUCER_HANDLERS,
  TEMPLATE_REGISTRY,
  TRANSITION_TABLE,
  canonicalV2,
  createDraftTemplate,
} from '../../continuity/scripts/lib/core/domain-v2.mjs';
import { EXPECTED_EVENT_TYPES } from '../helpers/v2-contract-fixture.mjs';

export async function run() {
  assert.equal(canonicalV2({ b: [true, null, 'x'], a: 1 }), '{"a":1,"b":[true,null,"x"]}');
  assert.equal(canonicalV2({ z: -0, a: '\u20ac' }), '{"a":"\u20ac","z":0}');

  const expected = [...EXPECTED_EVENT_TYPES].sort();
  assert.deepEqual([...EVENT_TYPES].sort(), expected);
  assert.deepEqual(Object.keys(TEMPLATE_REGISTRY).sort(), expected);
  assert.deepEqual(Object.keys(REDUCER_HANDLERS).sort(), expected);
  assert.deepEqual(Object.keys(TRANSITION_TABLE).sort(), expected);
  for (const eventType of EXPECTED_EVENT_TYPES) {
    const template = createDraftTemplate(eventType);
    assert.equal(template.eventType, eventType);
    for (const forbidden of ['occurredAt', 'recordedAt', 'previousEventHash', 'eventHash']) assert.equal(forbidden in template, false);
  }

  const migration = await import('../../continuity/scripts/lib/migration/index.mjs');
  const continuity = await import('../../continuity/scripts/lib/continuity/index.mjs');
  assert.equal(typeof migration.handleMigrationCommand, 'function');
  assert.equal(typeof continuity.handleInspectCommand, 'function');
  assert.equal(typeof continuity.createLiveContext, 'function');
}
