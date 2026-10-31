import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVALUATOR_VERSION } from './evaluate.js';
import { JUDGE_POLICY_VERSION } from './judge.js';

// Offline CLI rejection tests only. These fixtures contain invalid metadata,
// no model replies or invented provider traces, and cannot establish quality.
const execute = promisify(execFile);
const script = 'backend/scripts/merge-engine-evaluations.ts';
async function command(args: string[]) {
  try { const result = await execute(process.execPath, ['--import', 'tsx', script, ...args], { timeout: 10_000 }); return { code: 0, ...result }; }
  catch (error) { const result = error as Error & { code: number; stdout: string; stderr: string }; return { code: result.code, stdout: result.stdout, stderr: result.stderr }; }
}
async function metadataPair(overrides: Record<string, unknown>, source?: string) {
  const base = await mkdtemp(join(tmpdir(), 'miu-merge-guards-'));
  for (const suite of ['reviewed', 'remaining']) {
    await writeFile(join(base, suite + '.json'), JSON.stringify({ status: 'complete', provider: 'real', suite,
      evaluator_version: EVALUATOR_VERSION, reviewer_policy_version: JUDGE_POLICY_VERSION, ...overrides }));
  }
  // Directories are made explicitly; the CLI must never write into either one.
  const { mkdir } = await import('node:fs/promises');
  for (const suite of ['reviewed', 'remaining']) {
    await mkdir(join(base, suite));
    await writeFile(join(base, suite, 'manifest.json'), await readFile(join(base, suite + '.json')));
    if (source !== undefined) await writeFile(join(base, suite, 'source-manifest.json'), source);
  }
  return { base, args: ['--reviewed', join(base, 'reviewed'), '--remaining', join(base, 'remaining'), '--output', join(base, 'combined')] };
}

test('offline merger help does not require credentials or invoke providers', async () => {
  const result = await command(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No provider calls/u);
});

test('offline merger rejects fake or incomplete parents without modifying evidence or creating output', async () => {
  for (const override of [{ provider: 'fake' }, { status: 'running' }]) {
    const fixture = await metadataPair(override);
    const before = await readFile(join(fixture.base, 'reviewed', 'manifest.json'));
    const result = await command(fixture.args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /completed real reviewed\/remaining suites/u);
    assert.deepEqual(await readFile(join(fixture.base, 'reviewed', 'manifest.json')), before);
    await assert.rejects(() => access(join(fixture.base, 'combined')));
  }
});

test('offline merger rejects a declared source hash that does not bind the actual manifest bytes', async () => {
  const fixture = await metadataPair({ source_manifest_sha256: 'not-the-source-hash' }, '{"files":[]}\n');
  const result = await command(fixture.args);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /source-manifest hash does not match/u);
  await assert.rejects(() => access(join(fixture.base, 'combined')));
});

test('offline merger never prints malformed input contents in an unexpected parser error', async () => {
  const fixture = await metadataPair({ provider: 'fake' });
  const marker = 'SYNTHETIC_PRIVATE_PARSER_MARKER';
  await writeFile(join(fixture.base, 'reviewed', 'manifest.json'), marker);
  await writeFile(join(fixture.base, 'remaining', 'manifest.json'), marker);
  const result = await command(fixture.args);
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stderr, new RegExp(marker, 'u'));
  assert.match(result.stderr, /invalid or incomplete evidence/u);
});
