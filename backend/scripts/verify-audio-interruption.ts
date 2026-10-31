import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { parseArgs } from 'node:util';
import express from 'express';
import { chromium, type Response } from 'playwright';
import { createIntegratedApp } from '../integration/server.js';
import { createServer } from '../pipeline/src/server-runtime.js';
import type { OpenAIProvider } from '../pipeline/providers.js';
import { renderAudioInterruptionReport, type FailedAudioAttempt } from './audio-interruption-report.js';

const { values } = parseArgs({ options: {
  'env-file': { type: 'string', default: '.env' }, output: { type: 'string' },
} });
if (existsSync(values['env-file'])) loadEnvFile(values['env-file']);
const output = resolve(values.output ?? `reports/audio-interruption-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
await mkdir(output, { recursive: false });
const dataDir = await mkdtemp(resolve(tmpdir(), 'miu-audio-interruption-'));
const startedAt = new Date().toISOString();
const sourceFiles = ['backend/application.ts', 'backend/integration/server.ts', 'backend/integration/engine-bridge.ts',
  'backend/pipeline/src/modules/sessions/session.service.ts', 'packages/voice-client/src/controller.ts',
  'packages/voice-client/src/playback.ts', 'packages/voice-client/dist/controller.js', 'packages/voice-client/dist/playback.js',
  'frontend/src/pages/Talk.tsx', 'frontend/src/lib/usePipelineVoice.ts', 'frontend/src/lib/playback-meter.ts', 'frontend/dist/index.html'];
const fingerprint = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
const sourceBefore = await fingerprint();
const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: undefined, DATABASE_SSH_TUNNEL: 'false',
  MIU_DATA_DIR: dataDir, MIU_PROVIDER: 'real', HOST: '127.0.0.1', STT_LOGGING: '0', ELEVENLABS_ENABLE_LOGGING: 'false' };
let integrated: Awaited<ReturnType<typeof createIntegratedApp>> | undefined;
let server: ReturnType<typeof createServer> | undefined;
let lifecycleServer: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let provider: OpenAIProvider | undefined;
const checks: { name: string; status: 'pass' | 'fail'; evidence?: unknown }[] = [];
const http: Record<string, unknown>[] = [];
const evidence: Record<string, unknown> = {};
let failure: string | null = null;
function check(condition: unknown, name: string, detail?: unknown): asserts condition {
  checks.push({ name, status: condition ? 'pass' : 'fail', evidence: detail });
  if (!condition) throw new Error(name);
}
function safeError(error: unknown) {
  if (error instanceof Error && /^audio_[a-z0-9_]+$/u.test(error.message)) return error.message;
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    const code = (error as { code: string }).code;
    if (/^[A-Za-z0-9_]{1,80}$/u.test(code)) return code;
  }
  return error instanceof Error && error.name === 'TimeoutError' ? 'browser_timeout' : 'verification_execution_failed';
}

// Observes actual media and a silent analyser branch. It does not replace
// playback, intercept HTTP responses, or synthesize media lifecycle events.
const probe = String.raw`(() => {
  const media = [], events = [], samples = [], clicks = [], monitors = [];
  let sequence = 0;
  const append = (type, id, extra = {}) => events.push({type, id, at: performance.now(), ...extra});
  const NativeAudio = window.Audio;
  window.Audio = new Proxy(NativeAudio, {construct(Target, args) {
    const element = Reflect.construct(Target, args), id = ++sequence;
    const record = {id, element, playCalls: 0}; media.push(record);
    const originalPlay = element.play.bind(element);
    element.play = function() {record.playCalls++; append('play_call', id); return originalPlay();};
    const originalPause = element.pause.bind(element);
    element.pause = function() {const before=element.paused; originalPause(); append('pause_call_return',id,{paused_before:before,paused_after:element.paused,time:element.currentTime});};
    for (const type of ['playing','pause','ended','emptied','error']) element.addEventListener(type, () => append(type,id,{time:element.currentTime,paused:element.paused}));
    return element;
  }});
  const NativeContext = window.AudioContext || window.webkitAudioContext;
  if (NativeContext) {
    const original = NativeContext.prototype.createMediaElementSource;
    NativeContext.prototype.createMediaElementSource = function(element) {
      const source = original.call(this, element), analyser = this.createAnalyser(), gain = this.createGain();
      analyser.fftSize = 2048; gain.gain.value = 0;
      source.connect(analyser); analyser.connect(gain); gain.connect(this.destination);
      monitors.push({id:media.find(item => item.element === element)?.id,analyser,context:this,buffer:new Float32Array(analyser.fftSize)});
      return source;
    };
  }
  setInterval(() => {
    const at=performance.now();
    for (const item of monitors) {
      item.analyser.getFloatTimeDomainData(item.buffer);
      let energy=0; for(const sample of item.buffer) energy+=sample*sample;
      samples.push({id:item.id,at,rms:Math.sqrt(energy/item.buffer.length),context_state:item.context.state});
    }
  },10);
  document.addEventListener('click',event => {
    if(event.target instanceof Element && event.target.closest('.voice-stop')) clicks.push({at:performance.now(),id:media.at(-1)?.id});
  },true);
  window.__audioInterruptionProbe={snapshot:() => ({
    media:media.map(({id,element,playCalls})=>({id,play_calls:playCalls,paused:element.paused,ended:element.ended,current_time:element.currentTime,src:element.getAttribute('src'),current_src:element.currentSrc})),
    events:[...events],samples:[...samples],clicks:[...clicks]
  })};
})();`;

try {
  check(!!env.OPENAI_API_KEY && !!env.ELEVENLABS_API_KEY, 'audio_real_credentials_present');
  integrated = await createIntegratedApp(env);
  // Test-only module routes exist only on this isolated server. Supplemental
  // trials exercise the shipped player using a real clip, with local receipts.
  const lifecycleApp = express();
  lifecycleApp.use('/api/__verification/voice-client', express.static(resolve('packages/voice-client/dist')));
  lifecycleApp.use('/api/__verification/contracts', express.static(resolve('packages/voice-contracts/dist')));
  lifecycleApp.get('/api/__verification/audio-lifecycle', (_request, response) => response.type('html').send(`<!doctype html><html><body>
    <button class="begin">Play real generated clip</button><button class="voice-stop">Stop</button><button class="resume">Resume canceled clip</button>
    <script type="importmap">{"imports":{"@miu/voice-contracts":"/api/__verification/contracts/index.js"}}</script>
    <script type="module">
      import {VoicePlayback,browserPlaybackEnvironment} from '/api/__verification/voice-client/playback.js';
      const native=browserPlaybackEnvironment(), context=new AudioContext();
      window.__localReceipts=[];
      const player=new VoicePlayback({environment:{...native,createAudio(){const audio=native.createAudio();context.createMediaElementSource(audio).connect(context.destination);return audio;}}});
      window.__player=player;
      document.querySelector('.begin').onclick=async()=>{await context.resume();window.__playResult=await player.play(window.__realClip,async receipt=>{window.__localReceipts.push(receipt);});};
      document.querySelector('.voice-stop').onclick=()=>player.stop();
      document.querySelector('.resume').onclick=async()=>{window.__resumeResult=await player.resume();};
      window.__ready=true;
    </script></body></html>`));
  provider = integrated.bridge.application.provider as OpenAIProvider;
  server = createServer(integrated.app);
  const base = await server.listen({ host: '127.0.0.1', port: 0 });
  lifecycleServer = createServer(lifecycleApp);
  const lifecycleBase = await lifecycleServer.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.name));
  await page.addInitScript({ content: probe });
  let session: { session_id: string; demo_token: string } | undefined;
  const captures = new Set<Promise<void>>();
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (!path.startsWith('/api/')) return;
    const work = (async () => {
      let status: unknown;
      try { status = response.request().postDataJSON()?.status; } catch { /* No JSON request. */ }
      let errorCode: string | null = null;
      if (!response.ok()) {
        try { const value = await response.json(); if (typeof value.error?.code === 'string' && /^[a-z0-9_]{1,80}$/u.test(value.error.code)) errorCode = value.error.code; } catch { /* No raw response logging. */ }
      }
      http.push({ method: response.request().method(), path, status: response.status(), receipt_status: status, error_code: errorCode });
      if (path === '/api/sessions' && response.request().method() === 'POST' && response.ok()) session = await response.json();
    })();
    captures.add(work); void work.finally(() => captures.delete(work));
  });
  const snapshot = () => page.evaluate('window.__audioInterruptionProbe.snapshot()') as Promise<any>;
  const panel = async () => {
    check(session, 'audio_session_missing');
    return page.evaluate(async token => {
      const response = await fetch('/api/demo/panel', { headers: { Authorization: 'Bearer ' + token } });
      if (!response.ok) throw new Error('audio_panel_failed');
      return response.json();
    }, session!.demo_token);
  };
  const isTurn = (response: Response) => response.request().method() === 'POST' && /\/api\/sessions\/[^/]+\/turns$/u.test(new URL(response.url()).pathname);
  const isReceipt = (response: Response, status: string) => {
    if (!response.ok() || response.request().method() !== 'POST' || !response.url().endsWith('/playback')) return false;
    try { return response.request().postDataJSON()?.status === status; } catch { return false; }
  };
  await page.goto(base + '/app/talk', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.microphone-button')?.disabled);
  await page.locator('button[aria-controls="conversation-panel"]').click();
  await page.locator('#message').waitFor({ state: 'visible' });
  const before = await panel();
  check(before.context.storyProgress === null, 'audio_initial_checkpoint_absent');
  const turnResponse = page.waitForResponse(isTurn, { timeout: 120_000 });
  await page.locator('#message').fill('Tell me a story.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const response = await turnResponse, turn = await response.json();
  check(response.ok() && turn.provider_mode === 'real' && turn.engine_mode === 'character_memory' && !!turn.audio?.data_base64, 'audio_real_story_and_tts');
  evidence.story = { turn_id: turn.turn_id, text: turn.reply.text, audio_mime: turn.audio.mime_type,
    duration_ms: turn.audio.duration_ms, audio_sha256: createHash('sha256').update(Buffer.from(turn.audio.data_base64, 'base64')).digest('hex') };
  // Wait for measured nonzero rendered waveform, not only an optimistic UI state.
  await page.waitForFunction(() => {
    const data = (window as any).__audioInterruptionProbe.snapshot(), last = data.media.at(-1);
    return last && !last.paused && last.current_time > 0.15 && data.samples.some((sample: any) => sample.id === last.id && sample.at > performance.now() - 100 && sample.rms > 0.002);
  }, undefined, { timeout: 30_000 });
  const playing = await snapshot();
  check(playing.events.some((event: any) => event.type === 'playing'), 'audio_native_playing_event');
  const canceled = page.waitForResponse(response => response.request().method() === 'DELETE' && /\/turns\/[^/]+$/u.test(new URL(response.url()).pathname), { timeout: 30_000 });
  await page.locator('.voice-stop').click();
  await canceled;
  // Observe actual browser output for longer than the 300 ms stop deadline.
  await page.waitForTimeout(1200);
  await Promise.all([...captures]);
  const stopped = await snapshot(), click = stopped.clicks.at(-1);
  check(click, 'audio_stop_control_observed');
  const media = stopped.media.find((item: any) => item.id === click.id);
  // load() may coalesce Chrome's queued pause event into emptied. Observe the
  // native pause() result as well as the independently rendered waveform.
  const paused = stopped.events.find((event: any) => event.id === click.id && event.type === 'pause_call_return' && event.paused_after === true && event.at >= click.at);
  const afterSamples = stopped.samples.filter((sample: any) => sample.id === click.id && sample.at >= click.at);
  const silence = afterSamples.find((sample: any) => sample.rms < 0.00001 && afterSamples.filter((later: any) => later.at >= sample.at && later.at < sample.at + 100).length >= 5 && afterSamples.filter((later: any) => later.at >= sample.at && later.at < sample.at + 100).every((later: any) => later.rms < 0.00001));
  const pauseLatency = paused ? paused.at - click.at : null, silenceLatency = silence ? silence.at - click.at : null;
  evidence.interruption = { input: 'actual Stop control click', click_at: click.at, pause_latency_ms: pauseLatency,
    graph_silence_latency_ms: silenceLatency, post_stop_observation_ms: 1200, final_media: media,
    events: stopped.events, graph_samples: stopped.samples };
  check(pauseLatency !== null && pauseLatency >= 0 && pauseLatency <= 300, 'audio_pause_within_300ms', pauseLatency);
  check(silenceLatency !== null && silenceLatency >= 0 && silenceLatency <= 300, 'audio_graph_silent_within_300ms', silenceLatency);
  check(media?.paused && media.src === null, 'audio_source_released');
  check(!stopped.events.some((event: any) => event.id === click.id && ['playing','play_call','ended'].includes(event.type) && event.at > click.at), 'audio_no_resume_or_completion_after_stop');
  await page.locator('#message').fill('Continue our story.');
  const uiAfterStop = { visible_error_notice: await page.locator('.voice-notice').count() > 0,
    stop_control_visible: await page.locator('.voice-stop').count() > 0,
    send_enabled: await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), runtime_errors: [...pageErrors] };
  evidence.ui_after_stop = uiAfterStop;
  check(!uiAfterStop.visible_error_notice && !uiAfterStop.stop_control_visible && uiAfterStop.send_enabled && pageErrors.length === 0, 'audio_stop_leaves_healthy_idle_ui', uiAfterStop);
  const afterStop = await panel();
  evidence.checkpoints = { before: before.context.storyProgress, after_interruption: afterStop.context.storyProgress };
  check(afterStop.context.storyProgress === null, 'audio_interruption_preserves_unheard_checkpoint');
  const stoppedTurnReceipts = http.filter(item => String(item.path).includes(turn.turn_id) && item.receipt_status !== undefined);
  evidence.interrupted_receipts = stoppedTurnReceipts;
  check(!stoppedTurnReceipts.some(item => item.receipt_status === 'completed'), 'audio_interrupted_turn_never_completed');
  await page.screenshot({ path: resolve(output, 'stopped.png'), fullPage: true });

  const resumedResponse = page.waitForResponse(isTurn, { timeout: 120_000 });
  const heard = page.waitForResponse(response => isReceipt(response, 'completed'), { timeout: 150_000 });
  await page.locator('#message').fill('Continue our story.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const resumedHttp = await resumedResponse, resumed = await resumedHttp.json();
  check(resumedHttp.ok() && resumed.provider_mode === 'real' && !!resumed.audio?.data_base64, 'audio_explicit_resume_uses_real_reply');
  check(resumed.reply.text === turn.reply.text, 'audio_explicit_resume_restarts_unheard_opening');
  await heard;
  const afterHeard = await panel();
  evidence.completed_continuation = { turn_id: resumed.turn_id, text: resumed.reply.text, checkpoint: afterHeard.context.storyProgress };
  check(afterHeard.context.storyProgress?.chapter === 0, 'audio_only_natural_completion_creates_opening_checkpoint');
  const final = await snapshot();
  check(final.events.some((event: any) => event.type === 'ended' && event.id !== click.id), 'audio_continuation_native_ended');
  const replies = provider.telemetry.filter(call => call.stage === 'reply' && call.outcome === 'completed' && call.responseId);
  check(replies.length >= 2, 'audio_real_model_reply_provenance', replies.map(call => call.responseId));

  const lifecycle = await browser.newPage();
  await lifecycle.addInitScript({ content: probe });
  await lifecycle.goto(lifecycleBase + '/api/__verification/audio-lifecycle');
  await lifecycle.waitForFunction(() => (window as any).__ready === true);
  await lifecycle.evaluate(clip => { (window as any).__realClip = clip; }, turn);
  const trials: Record<string, unknown>[] = [];
  evidence.supplemental_lifecycle_trials = { expected_trials: 9, clip_source: evidence.story,
    scope: 'Actual browser player/control trials reuse the real generated clip. They make no provider calls or backend receipts and are not additional engine-quality cases.', trials };
  for (let index = 1; index <= 9; index++) {
    await lifecycle.locator('.begin').click();
    await lifecycle.waitForFunction(() => {
      const data = (window as any).__audioInterruptionProbe.snapshot(), last = data.media.at(-1);
      return last && !last.paused && last.current_time > 0.15 && data.samples.some((sample: any) => sample.id === last.id && sample.at > performance.now() - 100 && sample.rms > 0.002);
    }, undefined, { timeout: 15_000 });
    await lifecycle.locator('.voice-stop').click();
    await lifecycle.locator('.resume').click();
    await lifecycle.waitForTimeout(1200);
    const state = await lifecycle.evaluate(() => ({ probe: (window as any).__audioInterruptionProbe.snapshot(),
      resume_result: (window as any).__resumeResult, receipts: (window as any).__localReceipts })) as any;
    const stop = state.probe.clicks.at(-1), last = state.probe.media.find((item: any) => item.id === stop.id);
    const pausedAt = state.probe.events.find((event: any) => event.id === stop.id && event.type === 'pause_call_return' && event.paused_after && event.at >= stop.at)?.at;
    const samples = state.probe.samples.filter((sample: any) => sample.id === stop.id && sample.at >= stop.at);
    const silent = samples.find((sample: any) => sample.rms < 0.00001 && samples.filter((later: any) => later.at >= sample.at && later.at < sample.at + 100).length >= 5 && samples.filter((later: any) => later.at >= sample.at && later.at < sample.at + 100).every((later: any) => later.rms < 0.00001));
    const lateEvents = state.probe.events.filter((event: any) => event.id === stop.id && event.at > stop.at && ['playing','play_call','ended'].includes(event.type));
    const receipts = state.receipts.slice((index - 1) * 2);
    const result = { trial: index, scope: 'browser_player_lifecycle_with_reused_real_tts_clip_not_new_engine_turn',
      pause_latency_ms: pausedAt === undefined ? null : pausedAt - stop.at,
      graph_silence_latency_ms: silent ? silent.at - stop.at : null, explicit_resume_result: state.resume_result,
      paused: last.paused, source_released: last.src === null, post_stop_observation_ms: 1200,
      late_events: lateEvents, local_receipts: receipts, events: state.probe.events.filter((event: any) => event.id === stop.id), graph_samples: samples };
    trials.push(result);
    check(result.pause_latency_ms !== null && result.pause_latency_ms <= 300 && result.graph_silence_latency_ms !== null && result.graph_silence_latency_ms <= 300 && last.paused && last.src === null && state.resume_result === 'canceled' && lateEvents.length === 0 && receipts.map((receipt: any) => receipt.status).join(',') === 'started,interrupted', `audio_supplemental_stop_trial_${index}`, { pause_latency_ms: result.pause_latency_ms, graph_silence_latency_ms: result.graph_silence_latency_ms });
  }
} catch (error) {
  failure = safeError(error);
} finally {
  await browser?.close().catch(() => undefined);
  await lifecycleServer?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  await integrated?.close().catch(() => undefined);
  const report = { run_kind: 'real_browser_audio_interruption', scenario: 'SC063', status: failure ? 'failed_or_blocked' : 'passed',
    started_at: startedAt, provider_mode: 'real', storage: { kind: 'isolated_pglite', production_connection: false, data_directory: dataDir },
    source_fingerprints: sourceBefore, source_changed_during_verification: JSON.stringify(sourceBefore) !== JSON.stringify(await fingerprint()),
    checks, error_code: failure, evidence, http, api_calls: provider?.telemetry ?? [],
    limitations: ['Desktop headless Chrome and its actual HTML audio/Web Audio rendering graph were measured; physical speaker audibility, mobile devices, microphone capture and STT were not tested.',
      'The probe adds only a zero-gain analyser branch. No provider responses, audio data, media events, receipts or HTTP routes were mocked.',
      'Only the integrated UI trial verifies server cancellation/checkpoints. Supplemental repeated-clip trials verify browser player lifecycle only; their receipts stay local and do not pretend delivery to the engine.',
      'This focused execution does not certify full character/memory behavior or general voice latency.'] };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const earlierFailures: FailedAudioAttempt[] = [];
  for (const directory of (await readdir(resolve(output, '..'))).filter(name => name.startsWith('audio-interruption-') && name !== basename(output)).sort()) {
    try {
      const previous = JSON.parse(await readFile(resolve(output, '..', directory, 'report.json'), 'utf8'));
      if (previous.status === 'failed_or_blocked') earlierFailures.push({ directory, error_code: previous.error_code });
    } catch { /* An incomplete earlier attempt remains untouched. */ }
  }
  await writeFile(resolve(output, 'report.md'), renderAudioInterruptionReport(report, earlierFailures));
  console.log(JSON.stringify({ output, status: report.status, error_code: failure, checks: checks.map(({ name, status }) => ({ name, status })) }));
  if (failure) process.exitCode = 1;
}
