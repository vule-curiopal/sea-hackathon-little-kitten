import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReferenceSession } from '../../memory/import-history.js';
import { auditCapture } from './capture-audit.js';

test('capture diagnostics count only child evidence and distinguish proposed from acceptable memories', () => {
  const source = { local_date: '2025-11-01', session_id: 'audit', language: 'mixed', messages: [
    { id: 'child-1', role: 'user', content: 'I am scared of thunder' },
    { id: 'ref-1', role: 'assistant', content: 'My friend is Imaginary' },
    { id: 'child-2', role: 'user', content: 'I am scared of dragons' },
    { id: 'ref-2', role: 'assistant', content: 'I like everything' },
  ] } as unknown as ReferenceSession;
  const result = auditCapture([source]);
  assert.equal(result.summary.userMessages, 2);
  assert.equal(result.summary.ignoredAssistantMessages, 2);
  assert.equal(result.summary.proposedCandidates, 2);
  assert.equal(result.summary.acceptedCandidates, 1);
  assert.equal(result.summary.rejectedCandidates, 1);
  assert.equal(result.acceptedByKind['preference:fear'], 1);
  assert.equal(result.acceptedByKind.relationship, undefined);
  assert.equal(result.diagnosticOnly, true);
  assert.ok(result.acceptedCandidates.every(candidate => candidate.sourceId.startsWith('child-')));
});
