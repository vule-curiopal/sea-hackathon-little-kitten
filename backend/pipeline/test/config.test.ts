import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('STT logging configuration', () => {
  it.each([{}, { STT_LOGGING: '' }, { STT_LOGGING: '  ', ELEVENLABS_ENABLE_LOGGING: '' }])('defaults to brain normal logging for unset or empty flags: %j', env => {
    expect(loadConfig(env).enableLogging).toBe(true);
  });

  it.each([
    [{ STT_LOGGING: '1' }, true],
    [{ STT_LOGGING: '0' }, false],
    [{ STT_LOGGING: ' 1 ' }, true],
    [{ ELEVENLABS_ENABLE_LOGGING: 'true' }, true],
    [{ ELEVENLABS_ENABLE_LOGGING: 'false' }, false],
    [{ STT_LOGGING: '', ELEVENLABS_ENABLE_LOGGING: 'false' }, false],
    [{ STT_LOGGING: '1', ELEVENLABS_ENABLE_LOGGING: 'true' }, true],
    [{ STT_LOGGING: '0', ELEVENLABS_ENABLE_LOGGING: 'false' }, false],
  ] as const)('reads the brain flag with legacy compatibility: %j', (env, expected) => {
    expect(loadConfig(env).enableLogging).toBe(expected);
  });

  it.each([
    { STT_LOGGING: 'false' },
    { STT_LOGGING: '2' },
    { ELEVENLABS_ENABLE_LOGGING: '0' },
    { STT_LOGGING: '1', ELEVENLABS_ENABLE_LOGGING: 'invalid' },
  ])('rejects invalid values rather than changing retention silently: %j', env => {
    expect(() => loadConfig(env)).toThrow(/STT_LOGGING|ELEVENLABS_ENABLE_LOGGING/u);
  });

  it.each([
    { STT_LOGGING: '1', ELEVENLABS_ENABLE_LOGGING: 'false' },
    { STT_LOGGING: '0', ELEVENLABS_ENABLE_LOGGING: 'true' },
  ])('rejects conflicting brain and legacy flags: %j', env => {
    expect(() => loadConfig(env)).toThrow('STT_LOGGING and ELEVENLABS_ENABLE_LOGGING conflict');
  });

  it('starts real mode with both keys and the working brain logging default', () => {
    const config = loadConfig({ MIU_PROVIDER: 'real', ELEVENLABS_API_KEY: 'eleven-test-secret', OPENAI_API_KEY: 'openai-test-secret' });
    expect(config.mode).toBe('real');
    expect(config.enableLogging).toBe(true);
  });

  it.each(['ELEVENLABS_API_KEY', 'OPENAI_API_KEY'] as const)('still requires %s for real mode', key => {
    expect(() => loadConfig({ MIU_PROVIDER: 'real', ELEVENLABS_API_KEY: 'eleven-test-secret', OPENAI_API_KEY: 'openai-test-secret', [key]: '' })).toThrow('Real mode requires both API keys');
  });
});
