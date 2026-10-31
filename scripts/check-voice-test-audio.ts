import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectAudio } from '../backend/pipeline/src/audio.js';
import { AdaptiveSilenceDetector, DEFAULT_DETECTOR_CONFIG, rmsDbfs } from '../packages/voice-client/src/detector.js';

// Offline waveform checks only: never reads .env or sends audio to providers.
const corpusRoot = fileURLToPath(new URL('../test-assets/voice-pipeline/', import.meta.url));
const WINDOW_MS = 20;
const EXPECTED_FILES = 20;
const MAX_DURATION_MS = 30_000;
const MAX_BYTES = 5 * 1024 * 1024;

interface Segment { start_ms: number; end_ms: number; text: string }
interface Asset {
  id: string; file: string; language: 'vi' | 'en' | null; speech_present: boolean;
  reference_text: string; duration_ms: number; bytes: number; sha256: string;
  condition: string; segments: Segment[];
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function parseAsset(value: unknown): Asset {
  check(record(value), 'Manifest asset must be an object.');
  check(typeof value.id === 'string' && value.id.length > 0, 'Asset ID is missing.');
  const id = value.id;
  check(typeof value.file === 'string' && /^audio\/[A-Za-z0-9_-]+\.wav$/u.test(value.file), `${id}: invalid audio path.`);
  check(value.language === 'vi' || value.language === 'en' || value.language === null, `${id}: invalid language.`);
  check(typeof value.speech_present === 'boolean', `${id}: speech_present must be boolean.`);
  check(typeof value.reference_text === 'string', `${id}: reference_text must be a string.`);
  check(finite(value.duration_ms) && value.duration_ms > 0, `${id}: invalid duration.`);
  check(Number.isInteger(value.bytes) && Number(value.bytes) > 0, `${id}: invalid byte count.`);
  check(typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(value.sha256), `${id}: invalid SHA256.`);
  check(typeof value.condition === 'string' && value.condition.length > 0, `${id}: condition is missing.`);
  check(Array.isArray(value.segments), `${id}: segments must be an array.`);
  let previousEnd = 0;
  for (const segment of value.segments) {
    check(record(segment) && finite(segment.start_ms) && finite(segment.end_ms)
      && segment.start_ms >= previousEnd && segment.end_ms > segment.start_ms
      && segment.end_ms <= value.duration_ms + 1 && typeof segment.text === 'string'
      && segment.text.trim().length > 0, `${id}: invalid or overlapping reference segment.`);
    previousEnd = segment.end_ms;
  }
  check(value.speech_present === (value.segments.length > 0), `${id}: speech flag/segments disagree.`);
  check(value.speech_present === (value.reference_text.trim().length > 0), `${id}: speech flag/reference text disagree.`);
  return value as unknown as Asset;
}

function pcmSamples(bytes: Buffer, id: string): Float32Array {
  check(bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WAVE'
    && bytes.readUInt32LE(4) + 8 === bytes.length, `${id}: invalid RIFF/WAVE size.`);
  let offset = 12;
  let formatFound = false;
  let data: Buffer | undefined;
  while (offset < bytes.length) {
    check(offset + 8 <= bytes.length, `${id}: truncated WAV chunk.`);
    const name = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    check(start + length <= bytes.length, `${id}: truncated WAV payload.`);
    if (name === 'fmt ') {
      check(!formatFound && length >= 16, `${id}: invalid format chunk.`);
      check(bytes.readUInt16LE(start) === 1 && bytes.readUInt16LE(start + 2) === 1
        && bytes.readUInt32LE(start + 4) === 24_000 && bytes.readUInt32LE(start + 8) === 48_000
        && bytes.readUInt16LE(start + 12) === 2 && bytes.readUInt16LE(start + 14) === 16,
      `${id}: expected PCM16, mono, 24000 Hz.`);
      formatFound = true;
    } else if (name === 'data') {
      check(!data && length > 0 && length % 2 === 0, `${id}: invalid data chunk.`);
      data = bytes.subarray(start, start + length);
    }
    offset = start + length + length % 2;
  }
  check(offset === bytes.length && formatFound && data, `${id}: missing or invalid WAV chunks.`);
  const samples = new Float32Array(data.length / 2);
  for (let index = 0; index < samples.length; index++) samples[index] = data.readInt16LE(index * 2) / 32768;
  return samples;
}

function simulate(samples: Float32Array, asset: Asset) {
  const detector = new AdaptiveSilenceDetector({}, 0);
  const stepSamples = 24_000 * WINDOW_MS / 1000;
  let snapshot = detector.snapshot;
  for (let offset = 0; offset < samples.length; offset += stepSamples) {
    const end = Math.min(offset + stepSamples, samples.length);
    snapshot = detector.update(rmsDbfs(samples.subarray(offset, end)), end / 24_000 * 1000);
    if (snapshot.decision) break;
  }
  const decisionAt = snapshot.decision ? snapshot.timeMs : null;
  const speechAfterDecision = decisionAt !== null && asset.segments.some(segment => segment.end_ms > decisionAt);
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    signal_found: snapshot.hasSignal,
    first_decision: snapshot.decision,
    decision_at_ms: decisionAt === null ? null : round(decisionAt),
    noise_floor_dbfs: round(snapshot.noiseFloorDbfs),
    start_threshold_dbfs: round(snapshot.startThresholdDbfs),
    end_threshold_dbfs: round(snapshot.endThresholdDbfs),
    reference_speech_after_decision: speechAfterDecision,
    premature_endpoint: snapshot.decision?.action === 'submit' && speechAfterDecision,
    false_signal_on_noise_only: !asset.speech_present && snapshot.hasSignal,
  };
}

async function main() {
  const root = await realpath(corpusRoot);
  const manifest: unknown = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  check(record(manifest) && manifest.schema_version === 1 && manifest.sample_rate_hz === 24_000
    && Array.isArray(manifest.assets) && manifest.assets.length === EXPECTED_FILES,
  `Manifest must declare schema 1, 24000 Hz and exactly ${EXPECTED_FILES} assets.`);
  const assets = manifest.assets.map(parseAsset);
  check(new Set(assets.map(asset => asset.id)).size === EXPECTED_FILES, 'Duplicate asset IDs.');
  check(new Set(assets.map(asset => asset.file)).size === EXPECTED_FILES, 'Duplicate asset paths.');
  const audioDirectory = path.join(root, 'audio');
  const diskFiles = (await readdir(audioDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.wav')).map(entry => `audio/${entry.name}`);
  check(diskFiles.length === EXPECTED_FILES && diskFiles.every(file => assets.some(asset => asset.file === file)),
    `Audio folder must contain exactly the ${EXPECTED_FILES} declared WAV files.`);
  const results = [];
  for (const asset of assets) {
    const filename = path.resolve(root, asset.file);
    check(within(root, filename) && within(root, await realpath(filename)), `${asset.id}: path escapes corpus directory.`);
    const bytes = await readFile(filename);
    check(bytes.length === asset.bytes && bytes.length <= MAX_BYTES, `${asset.id}: byte count or size limit mismatch.`);
    check(createHash('sha256').update(bytes).digest('hex') === asset.sha256, `${asset.id}: SHA256 mismatch.`);
    const samples = pcmSamples(bytes, asset.id);
    const durationMs = samples.length / 24_000 * 1000;
    check(durationMs <= MAX_DURATION_MS && Math.abs(durationMs - asset.duration_ms) <= 1,
      `${asset.id}: duration mismatch or over 30 seconds.`);
    const inspected = await inspectAudio(bytes, 'audio/wav', path.basename(filename), new AbortController().signal);
    check(inspected.mimeType === 'audio/wav' && Math.abs(inspected.durationMs - durationMs) <= 1,
      `${asset.id}: backend audio inspection mismatch.`);
    results.push({ id: asset.id, file: asset.file, condition: asset.condition, language: asset.language,
      speech_present: asset.speech_present, duration_ms: Math.round(durationMs * 100) / 100,
      bytes: bytes.length, wav_and_backend_validation: 'passed', detector: simulate(samples, asset) });
  }
  const report = {
    schema_version: 1,
    validation_scope: 'Offline PCM waveform simulation, not microphone/browser capture or STT/provider validation.',
    reference_text_scope: 'TTS input annotations; recognition accuracy and human perceived voice age are not verified.',
    window_ms: WINDOW_MS,
    detector_config: DEFAULT_DETECTOR_CONFIG,
    total_files: results.length,
    total_bytes: results.reduce((sum, item) => sum + item.bytes, 0),
    summary: {
      submit: results.filter(item => item.detector.first_decision?.action === 'submit').length,
      cancel: results.filter(item => item.detector.first_decision?.action === 'cancel').length,
      no_decision_before_file_end: results.filter(item => !item.detector.first_decision).length,
      premature_endpoints: results.filter(item => item.detector.premature_endpoint).length,
      noise_only_false_signals: results.filter(item => item.detector.false_signal_on_noise_only).length,
    },
    assets: results,
  };
  await writeFile(path.join(root, 'validation.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ validated_files: report.total_files, total_bytes: report.total_bytes,
    offline_detector: report.summary, report: 'test-assets/voice-pipeline/validation.json' }, null, 2));
}

main().catch(error => { console.error(`Audio corpus validation failed: ${error instanceof Error ? error.message : 'unknown error'}`); process.exitCode = 1; });
