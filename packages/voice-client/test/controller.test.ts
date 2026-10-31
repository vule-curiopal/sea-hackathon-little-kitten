import { describe, expect, it, vi } from 'vitest';
import { VoiceController, type CapturePort, type PlaybackPort, type VoiceApiPort } from '../src/controller.js';
import { canceledError, isSessionExpired, VoiceClientError } from '../src/errors.js';
import { captured, session, turn } from './fixtures.js';
import type { CapturedAudio, PlaybackEvent, TurnResponse } from '../src/index.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
function setup() {
  const playbackListeners = new Set<(event: PlaybackEvent) => void>();
  let recording = deferred<CapturedAudio>();
  recording.resolve(captured()); // No capture is active before start() is called.
  const capture = {
    start: vi.fn(() => { recording = deferred<CapturedAudio>(); return recording.promise; }),
    send: vi.fn(() => true), cancel: vi.fn(() => recording.reject(canceledError())),
  } satisfies CapturePort;
  const playback = {
    play: vi.fn<PlaybackPort['play']>().mockResolvedValue('playing'),
    resume: vi.fn<PlaybackPort['resume']>().mockResolvedValue('playing'), stop: vi.fn(), flushReceipts: vi.fn(async () => {}),
    subscribe: (listener: (event: PlaybackEvent) => void) => { playbackListeners.add(listener); return () => { playbackListeners.delete(listener); }; },
  } satisfies PlaybackPort;
  const api = {
    createRequestId: vi.fn(() => turn().turn_id),
    createSession: vi.fn<VoiceApiPort['createSession']>().mockResolvedValue(session()),
    configure: vi.fn<VoiceApiPort['configure']>().mockResolvedValue({ configuration: session().configuration, clock_version: 1, state_version: 1 }),
    submitTurn: vi.fn<VoiceApiPort['submitTurn']>().mockResolvedValue(turn()),
    submitText: vi.fn<NonNullable<VoiceApiPort['submitText']>>().mockResolvedValue({ ...turn(), input_mode: 'text', audio: null }),
    cancelTurn: vi.fn(async () => {}), playback: vi.fn(async () => {}), endSession: vi.fn(async () => {}),
  } satisfies VoiceApiPort;
  const controller = new VoiceController({ api, capture, playback });
  return { controller, api, capture, playback, recording: () => recording, emitPlayback: (event: PlaybackEvent) => { for (const listener of playbackListeners) listener(event); } };
}

describe('voice controller', () => {
  it('drops an unauthorized session, avoids another DELETE, and requires a fresh session before recording again', async () => {
    const fake = setup();
    await fake.controller.openProfile('an', 'vi');
    fake.api.submitTurn.mockRejectedValueOnce(new VoiceClientError('unauthorized', 'Session rejected', false, 401));
    const pending = fake.controller.talk({ fixtureId: 'voice_sample_vi' });
    const rejected = expect(pending).rejects.toMatchObject({ status: 401 });
    fake.recording().resolve(captured());
    await rejected;
    expect(fake.controller.session).toBeNull();
    expect(fake.controller.state).toBe('error');
    expect(fake.api.cancelTurn).not.toHaveBeenCalled();
    await expect(fake.controller.talk()).rejects.toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(fake.capture.start).toHaveBeenCalledOnce();
    expect(fake.api.submitTurn).toHaveBeenCalledOnce();

    await fake.controller.openProfile('an', 'vi');
    expect(fake.api.createSession).toHaveBeenCalledTimes(2);
    expect(fake.capture.start).toHaveBeenCalledOnce(); // Recovery never reopens the microphone.
    const next = fake.controller.talk({ fixtureId: 'voice_sample_vi' });
    fake.recording().resolve(captured());
    await next;
    expect(fake.capture.start).toHaveBeenCalledTimes(2);
    await fake.controller.close();
  });

  it('invalidates a session rejected during Stop and still permits a clean reconnect', async () => {
    const fake = setup();
    await fake.controller.openProfile('an', 'vi');
    const pending = fake.controller.talk();
    const canceled = expect(pending).rejects.toMatchObject({ code: 'CANCELED' });
    fake.api.cancelTurn.mockRejectedValueOnce(new VoiceClientError('unauthorized', 'Session rejected', false, 401));
    await expect(fake.controller.stop()).rejects.toMatchObject({ status: 401 });
    await canceled;
    expect(fake.controller.session).toBeNull();
    await fake.controller.openProfile('an', 'en');
    expect(fake.controller.state).toBe('idle');
    expect(fake.api.cancelTurn).toHaveBeenCalledOnce();
    expect(fake.capture.start).toHaveBeenCalledOnce();
    await fake.controller.close();
  });

  it('does not block a new session when cleanup of the old session is unauthorized', async () => {
    const fake = setup();
    await fake.controller.openProfile('an', 'vi');
    fake.api.endSession.mockRejectedValueOnce(new VoiceClientError('unauthorized', 'Old token expired', false, 401));
    await fake.controller.openProfile('binh', 'en');
    expect(fake.api.createSession).toHaveBeenCalledTimes(2);
    expect(fake.controller.state).toBe('idle');
    expect(fake.capture.start).not.toHaveBeenCalled();
    await fake.controller.close();
  });

  it('recognizes HTTP authentication failures even if the response body has a different code', () => {
    expect(isSessionExpired(new VoiceClientError('INVALID_RESPONSE', 'Non-JSON response', false, 401))).toBe(true);
    expect(isSessionExpired({ code: 'session_closed', status: 409 })).toBe(true);
    expect(isSessionExpired({ code: 'provider_quota', status: 503 })).toBe(false);
    expect(isSessionExpired(canceledError())).toBe(false);
  });

  it('an expired text delivery discards the old session without sending another cancellation request', async () => {
    const fake = setup();
    await fake.controller.openProfile('an', 'vi');
    await fake.controller.text('A question', { textOnly: true });
    fake.api.playback.mockRejectedValueOnce(new VoiceClientError('unauthorized', 'Session expired', false, 401));
    await expect(fake.controller.acknowledgeText()).rejects.toMatchObject({ status: 401 });
    expect(fake.controller.session).toBeNull();
    expect(fake.controller.state).toBe('error');
    expect(fake.api.cancelTurn).not.toHaveBeenCalled();
    await fake.controller.close();
  });

  it('a late unauthorized cleanup from an older session cannot clear its replacement', async () => {
    const fake = setup();
    await fake.controller.openProfile('an', 'vi');
    const cleanup = deferred<void>();
    fake.api.cancelTurn.mockReturnValueOnce(cleanup.promise);
    fake.api.submitTurn.mockRejectedValueOnce(new VoiceClientError('NETWORK_ERROR', 'Request failed', true));
    const pending = fake.controller.talk({ fixtureId: 'voice_sample_vi' });
    const failed = expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    fake.recording().resolve(captured());
    await failed;
    const fresh = { ...session(), session_id: 'replacement-session', demo_token: 'replacement-token' };
    fake.api.createSession.mockResolvedValueOnce(fresh);
    await fake.controller.openProfile('an', 'en');
    cleanup.reject(new VoiceClientError('unauthorized', 'Old cleanup rejected', false, 401));
    await settle();
    expect(fake.controller.session?.session_id).toBe(fresh.session_id);
    expect(fake.controller.state).toBe('idle');
    expect(fake.capture.start).toHaveBeenCalledOnce();
    await fake.controller.close();
  });

  it('leaves the microphone off on setup and after playback until another explicit Talk', async () => {
    const fake = setup();
    await fake.controller.openProfile('an', 'en');
    expect(fake.capture.start).not.toHaveBeenCalled();
    const first = fake.controller.talk();
    fake.recording().resolve(captured());
    await first;
    fake.emitPlayback({ type: 'state', state: 'idle' });
    await settle();
    expect(fake.controller.state).toBe('idle');
    expect(fake.capture.start).toHaveBeenCalledOnce();
    expect(fake.api.submitTurn).toHaveBeenCalledOnce();
    const second = fake.controller.talk();
    expect(fake.capture.start).toHaveBeenCalledTimes(2);
    fake.recording().resolve(captured());
    await second;
    await fake.controller.close();
  });

  it('accepts a late interruption conflict only after the same turn cancellation succeeds', async () => {
    for (const conflict of ['invalid_playback_transition', 'invalid_receipt_transition', 'turn_canceled', 'stale_state']) {
    const fake = setup();
    await fake.controller.openProfile('an', 'vi');
    const pending = fake.controller.talk();
    fake.recording().resolve(captured());
    await pending;
    const sender = fake.playback.play.mock.calls[0]![1];
    const cancellation = deferred<void>();
    fake.api.cancelTurn.mockReturnValueOnce(cancellation.promise);
    fake.api.playback.mockRejectedValueOnce(new VoiceClientError(conflict, 'Canceled', false, 409));
    const stopping = fake.controller.stop();
    let finished = false;
    const receipt = sender({ request_id: 'late-interrupted', status: 'interrupted', played_ms: 100, state_version: 2 }).then(() => { finished = true; });
    await settle();
    expect(finished).toBe(false);
    cancellation.resolve();
    await stopping;
    await receipt;
    expect(fake.controller.state).toBe('idle');
    }
  });

  it('does not hide failed cancellation, completed-receipt conflicts or unrelated receipt errors', async () => {
    for (const kind of ['cancel-failed', 'completed', 'unrelated', 'not-canceled'] as const) {
      const fake = setup();
      await fake.controller.openProfile('an', 'vi');
      const pending = fake.controller.talk();
      fake.recording().resolve(captured());
      await pending;
      const sender = fake.playback.play.mock.calls[0]![1];
      if (kind === 'cancel-failed') fake.api.cancelTurn.mockRejectedValueOnce(new VoiceClientError('NETWORK_ERROR', 'Unavailable'));
      const stopping = kind === 'not-canceled' ? Promise.resolve() : fake.controller.stop();
      const stopped = kind === 'cancel-failed' ? expect(stopping).rejects.toMatchObject({ code: 'NETWORK_ERROR' }) : stopping;
      const code = kind === 'unrelated' ? 'idempotency_conflict' : kind === 'not-canceled' ? 'stale_state' : 'invalid_playback_transition';
      fake.api.playback.mockRejectedValueOnce(new VoiceClientError(code, 'Conflict', false, 409));
      await expect(sender({ request_id: 'late-receipt', status: kind === 'completed' ? 'completed' : 'interrupted', played_ms: 100, state_version: 2 })).rejects.toMatchObject({ code: kind === 'cancel-failed' ? 'NETWORK_ERROR' : code });
      await stopped;
      if (kind === 'not-canceled') await fake.controller.stop();
    }
  });
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
