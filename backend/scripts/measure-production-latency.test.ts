import test from 'node:test';
import assert from 'node:assert/strict';
import { measureProductionLatency } from './measure-production-latency.js';

// Input-boundary checks only. Empty SSH configuration ensures no production
// connection could succeed; every tested input must fail before SSH is attempted.
test('production latency probe requires an explicit matching overlay source and archive', async () => {
  await assert.rejects(measureProductionLatency({}, { source: 'overlay' }), /invalid_probe_source/u);
  await assert.rejects(measureProductionLatency({}, { source: 'current', overlay: '/private/tmp/unit-only.tar.gz' }), /invalid_probe_source/u);
});

test('production latency probe rejects remote environment traversal and shell metacharacters before SSH', async () => {
  await assert.rejects(measureProductionLatency({}, { remoteEnv: '/etc/miu/../other.env' }), /invalid_remote_env_path/u);
  await assert.rejects(measureProductionLatency({}, { remoteEnv: '/etc/miu/api.env;echo' }), /invalid_remote_env_path/u);
});

test('production latency probe rejects malformed ephemeral model overrides before SSH', async () => {
  await assert.rejects(measureProductionLatency({}, { classifyModel: 'gpt-6-luna;echo' }), /invalid_probe_model/u);
  await assert.rejects(measureProductionLatency({}, { checkModel: 'model\nOTHER=value' }), /invalid_probe_model/u);
});
