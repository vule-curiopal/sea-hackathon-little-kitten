import { describe, expect, it, vi } from 'vitest';
import { VoiceController, type CapturePort, type PlaybackPort, type VoiceApiPort } from '../src/controller.js';
import { canceledError } from '../src/errors.js';
import { captured, session, turn } from './fixtures.js';
import type { CapturedAudio, TurnResponse } from '../src/index.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
function setup() {
  let recording = deferred<CapturedAudio>();
  recording.resolve(captured()); // No capture is active before start() is called.
  const capture = {
    start: vi.fn(() => { recording = deferred<CapturedAudio>(); return recording.promise; }),
    send: vi.fn(() => true), cancel: vi.fn(() => recording.reject(canceledError())),
  } satisfies CapturePort;
  const playback = {
    play: vi.fn<PlaybackPort['play']>().mockResolvedValue('playing'),
    resume: vi.fn<PlaybackPort['resume']>().mockResolvedValue('playing'), stop: vi.fn(), flushReceipts: vi.fn(async () => {}),
  } satisfies PlaybackPort;
  const api = {
    createRequestId: vi.fn(() => turn().turn_id),
    createSession: vi.fn<VoiceApiPort['createSession']>().mockResolvedValue(session()),
    configure: vi.fn<VoiceApiPort['configure']>().mockResolvedValue({ configuration: session().configuration, clock_version: 1, state_version: 1 }),
    submitTurn: vi.fn<VoiceApiPort['submitTurn']>().mockResolvedValue(turn()),
    cancelTurn: vi.fn(async () => {}), playback: vi.fn(async () => {}), endSession: vi.fn(async () => {}),
  } satisfies VoiceApiPort;
  const controller = new VoiceController({ api, capture, playback });
  return { controller, api, capture, playback, recording: () => recording };
}

describe('voice controller', () => {
  it('selects language before recording and runs capture/upload/playback through the canonical API', async () => {
    const fake = setup();
    await fake.controller.openProfile('an', 'vi');
    expect(fake.api.configure).toHaveBeenCalledWith(session(), 'vi', undefined, expect.any(AbortSignal), {});
    const pending = fake.controller.talk({ fixtureId: 'voice_sample_vi' });
    expect(fake.capture.start).toHaveBeenCalledOnce();
    fake.recording().resolve(captured());
    expect(await pending).toEqual(turn());
    expect(fake.api.submitTurn).toHaveBeenCalledWith(session(), expect.objectContaining({ fixtureId: 'voice_sample_vi', requestId: turn().turn_id }));
    expect(fake.playback.play).toHaveBeenCalledOnce();
    expect(fake.controller.state).toBe('speaking');
    await fake.controller.close();
  });

  it('drops a late server response after Stop and uses a separate cancellation request', async () => {
    const fake = setup();
    await fake.controller.openProfile('an', 'vi');
    const reply = deferred<TurnResponse>();
    fake.api.submitTurn.mockReturnValueOnce(reply.promise);
    const pending = fake.controller.talk({ fixtureId: 'voice_sample_vi' });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'CANCELED' });
    fake.recording().resolve(captured());
    await settle();
    expect(fake.api.submitTurn).toHaveBeenCalledOnce();
    await fake.controller.stop();
    expect(fake.api.submitTurn.mock.calls[0]![1].signal!.aborted).toBe(true);
    reply.resolve(turn());
    await assertion;
    expect(fake.playback.play).not.toHaveBeenCalled();
    expect(fake.api.cancelTurn).toHaveBeenCalledWith(session(), turn().turn_id);
    expect(fake.controller.session?.state_version).toBe(1);
  });

  it('starts capture in the user gesture even while awaiting previous server cancellation', async () => {
    const fake = setup();
    await fake.controller.openProfile('an', 'vi');
    const first = fake.controller.talk();
    const firstAssertion = expect(first).rejects.toMatchObject({ code: 'CANCELED' });
    const cancellation = deferred<void>();
    fake.api.cancelTurn.mockReturnValueOnce(cancellation.promise);
    const second = fake.controller.talk({ fixtureId: 'voice_sample_vi' });
    expect(fake.capture.start).toHaveBeenCalledTimes(2);
    fake.recording().resolve(captured());
    await settle();
    expect(fake.api.submitTurn).not.toHaveBeenCalled();
    cancellation.resolve();
    await firstAssertion;
    await second;
    expect(fake.api.submitTurn).toHaveBeenCalledOnce();
    await fake.controller.close();
  });

  it('keeps blocked playback available for an explicit Play and cancels setup before it can open a session', async () => {
    const fake = setup();
    const opening = fake.controller.openProfile('an', 'vi');
    const openingAssertion = expect(opening).rejects.toMatchObject({ code: 'CANCELED' });
    await fake.controller.stop();
    await openingAssertion;
    expect(fake.api.createSession).not.toHaveBeenCalled();
    await fake.controller.openProfile('an', 'vi');
    fake.playback.play.mockResolvedValueOnce('blocked');
    const pending = fake.controller.talk({ fixtureId: 'voice_sample_vi' });
    fake.recording().resolve(captured());
    await pending;
    expect(fake.controller.state).toBe('playback_blocked');
    expect(await fake.controller.resumePlayback()).toBe('playing');
    expect(fake.controller.state).toBe('speaking');
    await fake.controller.close();
  });
});
