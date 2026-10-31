import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReferenceSession } from '../../memory/import-history.js';
import type { Provider } from '../../shared/types.js';
import { runGrowthReplay } from './runner.js';

/** Configuration-only unit checks. These never evaluate dialogue, create a
 * database, construct an SDK client, or invoke a provider method. Credentialed
 * model performance is evaluated exclusively by the explicit real-run CLI. */
function session(date: string): ReferenceSession {
  const sessionId = `growth_${date}`;
  const messages = [
    { id: `${sessionId}_user`, role: 'user' as const, speaker: 'An', timestamp: `${date}T09:00:00+07:00`, content: 'Hello Miu' },
    { id: `${sessionId}_reference`, role: 'assistant' as const, speaker: 'Miu', timestamp: `${date}T09:01:00+07:00`, content: 'Offline reference for configuration validation only.' },
  ];
  return {
    schema_version: 'miu-synthetic-year-v1', synthetic: true, response_origin: 'authored_reference',
    session_id: sessionId, profile_id: 'synthetic-an-001', local_date: date, timezone: 'Asia/Ho_Chi_Minh',
    started_at: messages[0]!.timestamp, ended_at: messages[1]!.timestamp,
    child_age_years: 6, language: 'en', title: `Configuration check ${date}`, tags: ['memory'],
    child_mood: { source: 'author_annotation', start: 'calm', end: 'calm' }, miu_daily_mood: 'content', messages,
  };
}

function forbiddenProvider(mode: Provider['mode']): { provider: Provider; calls: () => number } {
  let count = 0;
  async function forbidden(): Promise<never> { count++; throw new Error('provider_must_not_be_invoked_by_configuration_checks'); }
  return { provider: { mode, classify: forbidden, reply: forbidden, check: forbidden }, calls: () => count };
}

test('growth evaluation requires explicit real provider injection before creating output', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'miu-growth-config-')); const outputDir = join(parent, 'run');
  try {
    await assert.rejects(runGrowthReplay({ sessions: [session('2025-11-01')], outputDir }), /growth_real_provider_required/);
    await assert.rejects(stat(outputDir), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('growth configuration rejects non-model mode without invoking any provider method', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'miu-growth-mode-')); const outputDir = join(parent, 'run');
  const guard = forbiddenProvider('fake');
  try {
    await assert.rejects(runGrowthReplay({ sessions: [session('2025-11-01')], providerInstance: guard.provider, outputDir }), /growth_real_provider_required/);
    assert.equal(guard.calls(), 0);
    await assert.rejects(stat(outputDir), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('growth source validation rejects reverse chronology before output or model invocation', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'miu-growth-source-')); const outputDir = join(parent, 'run');
  const guard = forbiddenProvider('real');
  try {
    await assert.rejects(runGrowthReplay({ sessions: [session('2025-11-02'), session('2025-11-01')], providerInstance: guard.provider, outputDir }), /chronological/);
    assert.equal(guard.calls(), 0);
    await assert.rejects(stat(outputDir), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('a mode label on an injected double cannot impersonate a real evaluation adapter', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'miu-growth-provider-guard-'));
  const guard = forbiddenProvider('real');
  try {
    await assert.rejects(runGrowthReplay({ sessions: [session('2025-11-01')], providerInstance: guard.provider, outputDir: join(parent, 'run') }), /growth_real_provider_required/);
    assert.equal(guard.calls(), 0);
    await assert.rejects(stat(join(parent, 'run')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('behavioral growth CLI rejects fake and offers no harness self-test switch', async () => {
  const execute = promisify(execFile);
  for (const args of [['--provider', 'fake'], ['--run-kind', 'harness_self_test']]) {
    await assert.rejects(execute(process.execPath, ['--import', 'tsx', 'backend/scripts/evaluate-growing-year.ts', ...args], { cwd: process.cwd(), maxBuffer: 100_000 }), (error: unknown) => {
      const failure = error as { stderr?: string };
      assert.match(failure.stderr ?? '', args[0] === '--provider' ? /requires a real model/ : /Unknown option/);
      return true;
    });
  }
});
