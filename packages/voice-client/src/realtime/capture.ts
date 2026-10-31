import type { SessionResponse, TurnResponse } from '@miu/voice-contracts';
import type { CaptureEvent } from '../capture.js';
import { VoiceClientError, canceledError, notify } from '../errors.js';
import { Pcm16Encoder, PCM_WORKLET } from './pcm.js';
import { validateTurnResponse } from '../api.js';

/** One held utterance owns one microphone/WS. Release flushes PCM before the final turn. */
export class RealtimeVoiceCapture {
  private readonly listeners = new Set<(event: CaptureEvent) => void>();
  private stopCurrent?: () => void;
  private sendCurrent?: () => boolean;
  constructor(private readonly baseUrl = '') {}
  subscribe(listener: (event: CaptureEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  send(): boolean { return this.sendCurrent?.() ?? false; }
  cancel(): void { this.stopCurrent?.(); }

  start(session: SessionResponse, requestId: string, signal: AbortSignal, onProcessing: () => void,
    beforeConnect: Promise<unknown> = Promise.resolve()): Promise<TurnResponse> {
    this.cancel();
    void beforeConnect.catch(() => {});
    return new Promise((resolve, reject) => {
      let stream: MediaStream | undefined, context: AudioContext | undefined, source: MediaStreamAudioSourceNode | undefined;
      let worklet: AudioWorkletNode | undefined, socket: WebSocket | undefined, encoder: Pcm16Encoder | undefined;
      let done = false, finishing = false, started = false, endSent = false, sequence = 0;
      let startedAt = 0;
      let flushResolve: (() => void) | undefined;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const state = (value: import('../capture.js').CaptureState) => notify(this.listeners, { type: 'state', state: value });
      const onHidden = () => { if (document.visibilityState === 'hidden') fail(canceledError()); };
      const stopMic = () => {
        document.removeEventListener('visibilitychange', onHidden);
        source?.disconnect(); worklet?.disconnect();
        for (const track of stream?.getTracks() ?? []) track.stop();
        if (context && context.state !== 'closed') void context.close().catch(() => {});
      };
      const cleanup = () => {
        flushResolve?.();
        for (const timer of timers) clearTimeout(timer);
        stopMic(); signal.removeEventListener('abort', onAbort);
        socket?.close(); this.stopCurrent = undefined; this.sendCurrent = undefined;
      };
      const fail = (error: unknown) => {
        if (done) return; done = true; cleanup(); state('idle'); reject(error);
      };
      const onAbort = () => fail(canceledError());
      this.stopCurrent = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });
      const sendPcm = (pcm: Uint8Array) => {
        if (done || !socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 128 * 1024) {
          throw new VoiceClientError('NETWORK_ERROR', 'Audio stream cannot keep up.', true);
        }
        const packet = new Uint8Array(pcm.length + 4);
        new DataView(packet.buffer).setUint32(0, sequence++, true); packet.set(pcm, 4); socket.send(packet);
      };
      const finish = async () => {
        if (done || finishing || !started || !socket || !encoder || !worklet) return;
        finishing = true; state('finalizing_capture');
        source?.disconnect();
        const flushed = new Promise<void>((yes, no) => {
          flushResolve = yes;
          timers.push(setTimeout(() => no(new VoiceClientError('CAPTURE_INTERRUPTED', 'Audio flush failed.')), 2000));
        });
        worklet.port.postMessage('flush');
        await flushed;
        if (done) return;
        const final = encoder.flush(); if (final) sendPcm(final);
        stopMic();
        if (!sequence) throw new VoiceClientError('NO_AUDIO', 'No audio was recorded.');
        endSent = true;
        socket.send(JSON.stringify({ type: 'audio.end', last_seq: sequence - 1 }));
      };
      this.sendCurrent = () => {
        if (finishing || done) return false;
        // Releasing while permission or the stream is still pending cancels
        // this hold. A late permission grant must never resume recording.
        if (!started) { fail(canceledError()); return false; }
        void finish().catch(fail); return true;
      };
      const setup = async () => {
        if (signal.aborted) throw canceledError();
        if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new VoiceClientError('INSECURE_CONTEXT', 'Microphone requires HTTPS.');
        state('requesting_permission');
        // Create/resume directly in the user gesture, before permissions or network awaits.
        context = new AudioContext();
        const resume = context.resume(); void resume.catch(() => {});
        const acquired = await navigator.mediaDevices.getUserMedia({ audio: {
          channelCount: { ideal: 1 }, echoCancellation: { ideal: true }, noiseSuppression: { ideal: true }, autoGainControl: { ideal: false },
        }, video: false });
        if (done) { for (const track of acquired.getTracks()) track.stop(); return; }
        stream = acquired;
        await resume;
        if (done) return;
        state('preparing_stream');
        if (!context.audioWorklet || context.state !== 'running') throw new VoiceClientError('MIC_UNAVAILABLE', 'AudioWorklet unavailable.');
        const asset = URL.createObjectURL(new Blob([PCM_WORKLET], { type: 'text/javascript' }));
        try { await context.audioWorklet.addModule(asset); } finally { URL.revokeObjectURL(asset); }
        if (done) return;
        encoder = new Pcm16Encoder(context.sampleRate);
        worklet = new AudioWorkletNode(context, 'miu-audio-capture');
        worklet.onprocessorerror = () => fail(new VoiceClientError('CAPTURE_INTERRUPTED', 'Audio processor failed.'));
        worklet.port.onmessage = event => {
          if (done) return;
          try {
            if (event.data.type === 'samples') {
              const samples = event.data.samples as Float32Array;
              let sum = 0; for (const sample of samples) sum += sample * sample;
              notify(this.listeners, { type: 'stream_meter', levelDbfs: 20 * Math.log10(Math.max(Math.sqrt(sum / samples.length), 1e-6)),
                elapsedMs: performance.now() - startedAt });
              for (const pcm of encoder!.push(samples)) sendPcm(pcm);
            }
            else if (event.data.type === 'flushed') flushResolve?.();
          } catch (error) { fail(error); }
        };
        for (const track of stream.getTracks()) track.addEventListener('ended', () => { if (!finishing) fail(new VoiceClientError('MIC_UNAVAILABLE', 'Microphone disconnected.')); });
        document.addEventListener('visibilitychange', onHidden);
        if (document.visibilityState === 'hidden') throw canceledError();
        context.addEventListener('statechange', () => {
          if (!finishing && !done && context!.state !== 'running') fail(new VoiceClientError('CAPTURE_INTERRUPTED', 'Audio was suspended.'));
        });
        await beforeConnect;
        if (done) return;
        const url = new URL(`/api/sessions/${encodeURIComponent(session.session_id)}/speech-stream`, this.baseUrl || location.origin);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(url);
        const connectTimeout = setTimeout(() => fail(new VoiceClientError('TIMEOUT', 'Speech connection timed out.')), 12_000);
        timers.push(connectTimeout);
        socket.onopen = () => socket!.send(JSON.stringify({ type: 'stream.start', token: session.demo_token,
          request_id: requestId, language: session.configuration.language_mode }));
        socket.onerror = () => fail(new VoiceClientError('NETWORK_ERROR', 'Speech connection failed.', true));
        socket.onclose = () => { if (!done) fail(new VoiceClientError('NETWORK_ERROR', 'Speech stream closed before completion.', true)); };
        socket.onmessage = event => {
          if (done) return;
          try {
            const message = JSON.parse(String(event.data));
            if (message.type === 'stream.ready') {
              if (started || finishing) throw new VoiceClientError('INVALID_RESPONSE', 'Duplicate speech-ready message.');
              clearTimeout(connectTimeout);
              source = context!.createMediaStreamSource(stream!); source.connect(worklet!); worklet!.connect(context!.destination);
              started = true; startedAt = performance.now(); state('recording');
              timers.push(setTimeout(() => fail(new VoiceClientError('TIMEOUT', 'Speech turn timed out.')), 180_000));
            } else if (message.type === 'turn.end_candidate') {
              // A provider's silence boundary is only a transcript segment.
              // The person holding the button owns the utterance boundary.
              return;
            }
            else if (message.type === 'transcript.final') {
              if (!endSent || typeof message.text !== 'string' || !message.text.trim() || [...message.text].length > 2000) {
                throw new VoiceClientError('INVALID_RESPONSE', 'Invalid final transcript.');
              }
              notify(this.listeners, { type: 'transcript_final', requestId, text: message.text });
            }
            else if (message.type === 'stream.processing') {
              if (!endSent) throw new VoiceClientError('INVALID_RESPONSE', 'Speech processed before release.');
              onProcessing();
            }
            else if (message.type === 'stream.error') fail(new VoiceClientError(String(message.code), 'Speech processing failed.',
              message.retryable === true, typeof message.status === 'number' ? message.status : undefined));
            else if (message.type === 'turn.result') {
              if (!endSent) throw new VoiceClientError('INVALID_RESPONSE', 'Speech result arrived before release.');
              const response = validateTurnResponse(message.response, session, requestId);
              if (response.session_id !== session.session_id || response.turn_id !== requestId || !response.reply?.text
                || response.reply.language !== session.configuration.language_mode || !response.audio?.data_base64
                || response.provider_mode !== 'real' || response.input_mode !== 'realtime_stt') throw new VoiceClientError('INVALID_RESPONSE', 'Invalid realtime turn result.');
              done = true; cleanup(); state('idle'); resolve(response);
            }
          } catch (error) { fail(error); }
        };
      };
      void setup().catch(error => {
        const code = error instanceof DOMException && error.name === 'NotAllowedError' ? 'MIC_PERMISSION_DENIED' : 'MIC_UNAVAILABLE';
        fail(error instanceof VoiceClientError ? error : new VoiceClientError(code, 'Microphone could not start.'));
      });
    });
  }
}
