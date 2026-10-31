import { spawn } from 'node:child_process';
import { LIMITS } from '@miu/voice-contracts';
import { abortError, PipelineError } from './errors.js';

export interface InspectedAudio { mimeType: string; durationMs: number }
type Container = 'wav' | 'mp4' | 'webm' | 'mp3';
const MAX_PROBE_OUTPUT = 1024 * 1024;
const MAX_PROBE_ERRORS = 64 * 1024;
const PROBE_TIMEOUT_MS = 5000;
// Capture still stops at 30s. Compressed containers can include encoder padding.
export const ENCODER_PADDING_TOLERANCE_MS = 250;

function invalid(): never { throw new PipelineError('invalid_audio', 422); }
function unsupported(): never { throw new PipelineError('unsupported_audio', 415); }
function finiteNumber(value: unknown): number | undefined {
  const result = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof result === 'number' && Number.isFinite(result) ? result : undefined;
}
function duration(durationMs: number, paddingMs = 0): number {
  if (!Number.isFinite(durationMs) || durationMs < 100) invalid();
  if (durationMs > LIMITS.recordingMs + paddingMs) throw new PipelineError('audio_too_long', 413);
  return Math.round(durationMs);
}
function mimeContainer(mime: string, synthesized: boolean): Container {
  const base = mime.split(';', 1)[0]?.trim().toLowerCase();
  if (base === 'audio/wav' || base === 'audio/x-wav' || base === 'audio/wave') return 'wav';
  if (!synthesized && (base === 'audio/mp4' || base === 'audio/x-m4a')) return 'mp4';
  if (!synthesized && base === 'audio/webm') return 'webm';
  if (synthesized && (base === 'audio/mpeg' || base === 'audio/mp3')) return 'mp3';
  return unsupported();
}
function sniff(bytes: Buffer, container: Container): void {
  if (container === 'wav') {
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') unsupported();
  } else if (container === 'mp4') {
    if (bytes.length < 24 || bytes.toString('ascii', 4, 8) !== 'ftyp') unsupported();
    const boxes = new Set<string>();
    let position = 0;
    while (position < bytes.length) {
      if (position + 8 > bytes.length) invalid();
      let size = bytes.readUInt32BE(position);
      const type = bytes.toString('ascii', position + 4, position + 8);
      let header = 8;
      if (size === 1) {
        if (position + 16 > bytes.length) invalid();
        const largeSize = bytes.readBigUInt64BE(position + 8);
        if (largeSize > BigInt(bytes.length)) invalid();
        size = Number(largeSize);
        header = 16;
      } else if (size === 0) size = bytes.length - position;
      if (size < header || position + size > bytes.length) invalid();
      boxes.add(type);
      position += size;
    }
    if (!boxes.has('moov') || !boxes.has('mdat')) invalid();
  } else if (container === 'webm') {
    if (bytes.length < 16 || bytes.readUInt32BE(0) !== 0x1a45dfa3) unsupported();
    // Browser WebM must declare its document type in the bounded EBML header.
    const headerEnd = Math.min(bytes.length, 4096);
    const docType = bytes.indexOf(Buffer.from([0x42, 0x82]));
    if (docType < 0 || docType + 7 > headerEnd || bytes[docType + 2] !== 0x84 || bytes.toString('ascii', docType + 3, docType + 7) !== 'webm') unsupported();
  } else if (!(bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0))) unsupported();
}

function inspectWav(bytes: Buffer): InspectedAudio {
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
  let offset = 12;
  let blockAlign: number | undefined;
  let sampleRate: number | undefined;
  let dataSize = 0;
  let hasData = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) invalid();
    const id = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > bytes.length) invalid();
    if (id === 'fmt ') {
      if (blockAlign !== undefined || length < 16) invalid();
      const format = bytes.readUInt16LE(start);
      const channels = bytes.readUInt16LE(start + 2);
      sampleRate = bytes.readUInt32LE(start + 4);
      const byteRate = bytes.readUInt32LE(start + 8);
      blockAlign = bytes.readUInt16LE(start + 12);
      const bits = bytes.readUInt16LE(start + 14);
      const pcmGuid = Buffer.from('0100000000001000800000aa00389b71', 'hex');
      const pcm = format === 1 || (format === 0xfffe && length >= 40 && bytes.readUInt16LE(start + 16) >= 22
        && bytes.subarray(start + 24, start + 40).equals(pcmGuid));
      if (!pcm || channels < 1 || channels > 2 || ![8, 16, 24, 32].includes(bits)) unsupported();
      if (sampleRate < 8000 || sampleRate > 192000 || blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign) invalid();
    } else if (id === 'data') {
      if (hasData) invalid();
      hasData = true;
      dataSize = length;
    }
    offset = start + length + (length % 2);
    if (offset > bytes.length) invalid();
  }
  if (!hasData || !blockAlign || !sampleRate || dataSize % blockAlign !== 0) invalid();
  return { mimeType: 'audio/wav', durationMs: duration(dataSize / blockAlign / sampleRate * 1000) };
}

interface ProbeStream { index?: unknown; codec_name?: unknown; codec_type?: unknown; sample_rate?: unknown; channels?: unknown; duration?: unknown }
interface ProbePacket { stream_index?: unknown; pts_time?: unknown; duration_time?: unknown; size?: unknown }
interface ProbeResult { streams?: ProbeStream[]; packets?: ProbePacket[]; format?: { duration?: unknown; format_name?: unknown } }

interface Mp4Box { type: string; start: number; end: number; header: number }
function mp4Boxes(bytes: Buffer, start: number, end: number): Mp4Box[] {
  const result: Mp4Box[] = [];
  while (start < end) {
    if (start + 8 > end) invalid();
    const type = bytes.toString('ascii', start + 4, start + 8);
    let size = bytes.readUInt32BE(start);
    let header = 8;
    if (size === 1) {
      if (start + 16 > end) invalid();
      const large = bytes.readBigUInt64BE(start + 8);
      if (large > BigInt(end - start)) invalid();
      size = Number(large); header = 16;
    } else if (size === 0) size = end - start;
    if (size < header || start + size > end) invalid();
    result.push({ type, start, end: start + size, header });
    start += size;
  }
  return result;
}

/** Inspect-only faststart for MP4 with tail metadata: stdin cannot seek backwards.
 * This bounded RAM copy relocates metadata/chunk offsets; uploaded bytes are never changed.
 */
function seekableMp4ForProbe(bytes: Buffer): Buffer {
  const boxes = mp4Boxes(bytes, 0, bytes.length);
  const moovs = boxes.filter(box => box.type === 'moov');
  const mdats = boxes.filter(box => box.type === 'mdat');
  if (moovs.length !== 1 || mdats.length === 0) invalid();
  const moov = moovs[0]!;
  if (moov.start < mdats[0]!.start) return bytes;
  // Fragmented browser recordings place moov first. Do not guess absolute tfhd offsets.
  if (boxes.some(box => box.type === 'moof')) invalid();
  const moved = Buffer.from(bytes.subarray(moov.start, moov.end));
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
  const visit = (start: number, end: number, depth: number): void => {
    if (depth > 8) invalid();
    for (const box of mp4Boxes(moved, start, end)) {
      if (containers.has(box.type)) visit(box.start + box.header, box.end, depth + 1);
      else if (box.type === 'stco' || box.type === 'co64') {
        const payload = box.start + box.header;
        if (payload + 8 > box.end) invalid();
        const count = moved.readUInt32BE(payload + 4);
        const width = box.type === 'stco' ? 4 : 8;
        if (count > 100000 || payload + 8 + count * width > box.end) invalid();
        for (let index = 0; index < count; index++) {
          const position = payload + 8 + index * width;
          const original = width === 4 ? BigInt(moved.readUInt32BE(position)) : moved.readBigUInt64BE(position);
          if (original > BigInt(bytes.length)) invalid();
          const offset = Number(original);
          if (!mdats.some(data => offset >= data.start + data.header && offset < data.end)) invalid();
          const updated = offset < moov.start ? offset + moved.length : offset;
          if (width === 4) moved.writeUInt32BE(updated, position);
          else moved.writeBigUInt64BE(BigInt(updated), position);
        }
      }
    }
  };
  visit(0, moved.length, 0);
  const insertAt = boxes[0]!.end; // ftyp was checked by sniff().
  return Buffer.concat([bytes.subarray(0, insertAt), moved, bytes.subarray(insertAt, moov.start), bytes.subarray(moov.end)]);
}

function runProbe(bytes: Buffer, signal: AbortSignal, executable: string): Promise<ProbeResult> {
  abortError(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(executable, [
      '-v', 'error', '-protocol_whitelist', 'pipe', '-probesize', String(LIMITS.audioBytes),
      '-show_packets', '-show_streams', '-show_format',
      '-show_entries', 'packet=stream_index,pts_time,duration_time,size:stream=index,codec_name,codec_type,start_time,duration,sample_rate,channels:format=duration,format_name',
      '-of', 'json', '-i', 'pipe:0',
    ], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    let outputSize = 0;
    let errorSize = 0;
    const finish = (error?: PipelineError, result?: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      child.stdin.destroy();
      if (error) {
        child.kill();
        reject(error);
      } else resolve(result!);
    };
    const onAbort = (): void => finish(new PipelineError('turn_canceled', 409));
    const timer = setTimeout(() => finish(new PipelineError('audio_probe_timeout', 503, true)), PROBE_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.on('error', () => finish(new PipelineError('audio_probe_unavailable', 503)));
    child.stdout.on('data', (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > MAX_PROBE_OUTPUT) finish(new PipelineError('invalid_audio', 422));
      else output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorSize += chunk.length;
      if (errorSize > MAX_PROBE_ERRORS) finish(new PipelineError('invalid_audio', 422));
    });
    // ffprobe may close its input early on corrupt data. A pipe error is handled by close/status.
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0 || errorSize > 0) return finish(new PipelineError('invalid_audio', 422));
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return finish(new PipelineError('invalid_audio', 422));
        finish(undefined, parsed as ProbeResult);
      } catch { finish(new PipelineError('invalid_audio', 422)); }
    });
    if (!settled) child.stdin.end(bytes);
  });
}

async function inspect(bytes: Buffer, mime: string, signal: AbortSignal, executable: string, synthesized: boolean): Promise<InspectedAudio> {
  abortError(signal);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) invalid();
  if (bytes.length > LIMITS.audioBytes) throw new PipelineError('audio_too_large', 413);
  const container = mimeContainer(mime, synthesized);
  sniff(bytes, container);
  if (container === 'wav') return inspectWav(bytes);
  const probe = await runProbe(container === 'mp4' ? seekableMp4ForProbe(bytes) : bytes, signal, executable);
  abortError(signal);
  if (!Array.isArray(probe.streams) || probe.streams.length !== 1 || !Array.isArray(probe.packets) || probe.packets.length === 0) invalid();
  const stream = probe.streams[0]!;
  if (!stream || typeof stream !== 'object') invalid();
  if (typeof stream.index !== 'number' || !Number.isInteger(stream.index) || stream.index < 0) invalid();
  const expectedCodec = { mp4: 'aac', webm: 'opus', mp3: 'mp3' }[container];
  if (stream.codec_type !== 'audio' || stream.codec_name !== expectedCodec) unsupported();
  const sampleRate = finiteNumber(stream.sample_rate);
  const channels = finiteNumber(stream.channels);
  if (!sampleRate || sampleRate < 8000 || sampleRate > 192000 || !channels || channels < 1 || channels > 2) invalid();
  const formatName = probe.format?.format_name;
  if (typeof formatName !== 'string' || !formatName.split(',').includes({ mp4: 'mp4', webm: 'webm', mp3: 'mp3' }[container])) unsupported();
  let packetEnd = 0;
  let foundPacket = false;
  for (const [index, packet] of probe.packets.entries()) {
    if (!packet || typeof packet !== 'object') invalid();
    if (packet.stream_index !== stream.index || !(finiteNumber(packet.size)! > 0)) invalid();
    const start = finiteNumber(packet.pts_time);
    let length = finiteNumber(packet.duration_time);
    // ffprobe 6 omits the first AAC packet's duration in fragmented MP4 even
    // when its end is identified by the next packet's presentation timestamp.
    // Accept that measured boundary only; all other packet durations stay required.
    if (container === 'mp4' && index === 0 && packet.duration_time === undefined && start !== undefined) {
      const nextStart = finiteNumber(probe.packets[index + 1]?.pts_time);
      if (nextStart !== undefined) length = nextStart - start;
    }
    if (start === undefined || length === undefined || length <= 0) invalid();
    packetEnd = Math.max(packetEnd, start + length);
    foundPacket = true;
  }
  if (!foundPacket || packetEnd <= 0) invalid();
  const metadataDuration = Math.max(finiteNumber(stream.duration) ?? 0, finiteNumber(probe.format?.duration) ?? 0);
  // Packet timestamps support live/browser WebM files whose duration metadata is absent.
  // Taking the larger bound also prevents a forged short metadata duration bypassing the cap.
  const durationMs = duration(Math.max(packetEnd, metadataDuration) * 1000, container === 'mp4' || container === 'webm' ? ENCODER_PADDING_TOLERANCE_MS : 0);
  return { mimeType: { mp4: 'audio/mp4', webm: 'audio/webm', mp3: 'audio/mpeg' }[container], durationMs };
}

export async function inspectAudio(bytes: Buffer, declaredMime: string, _filename: string, signal: AbortSignal, ffprobePath = 'ffprobe'): Promise<InspectedAudio> {
  return inspect(bytes, declaredMime, signal, ffprobePath, false);
}

export async function inspectSynthesizedAudio(bytes: Buffer, mime: string, signal: AbortSignal, ffprobePath = 'ffprobe'): Promise<InspectedAudio> {
  try { return await inspect(bytes, mime, signal, ffprobePath, true); }
  catch (error) {
    if (error instanceof PipelineError && ['turn_canceled', 'audio_probe_unavailable', 'audio_probe_timeout'].includes(error.code)) throw error;
    throw new PipelineError('provider_invalid_audio', 503);
  }
}
