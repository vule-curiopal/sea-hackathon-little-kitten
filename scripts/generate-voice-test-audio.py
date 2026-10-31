"""Create 20 synthetic speech/noise fixtures. Network is opt-in; never prints keys."""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import io
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import wave

import numpy as np
import requests
from scipy import signal


ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "test-assets" / "voice-pipeline"
CACHE = ROOT / ".cache" / "voice-test-audio" / "tts"
RATE = 24000
SEED = 841027
LEAD_MS = 1000
TAIL_MS = 2000
MODEL = "eleven_flash_v2_5"
SOURCES = {
    "vi": {
        "voice_id": "x4KAhuXs2G8TfK9Zr7Q4", "voice_name": "Cam Hong",
        "pitch_shift_semitones": 3.0,
        "main": "Miu ơi, mình muốn nghe một câu chuyện về chú mèo con.",
        "pause_a": "Hôm nay mình hơi buồn.",
        "pause_b": "Bạn chơi với mình nhé.",
    },
    "en": {
        "voice_id": "fBD19tfE58bkETeiwUoC", "voice_name": "Little Dude II",
        "pitch_shift_semitones": 2.0,
        "main": "Miu, can you tell me a story about a little kitten?",
        "pause_a": "I feel a little sad today.",
        "pause_b": "Will you play with me?",
    },
}
CASES = [
    ("clean", "Rõ, nền yên tĩnh", "Baseline so sánh transcript với câu gốc."),
    ("soft", "Nói rất nhỏ", "Kiểm tra bỏ sót tín hiệu; có thể cần Gửi thủ công."),
    ("muffled", "Nghẹt/không rõ", "Low-pass 1.000 Hz giả lập mic bị che, không phải lỗi phát âm thật."),
    ("clipped", "Vỡ tiếng", "Hard clipping có kiểm soát trước khi xuất WAV PCM hợp lệ."),
    ("fan_snr20", "Nền quạt, SNR +20 dB", "Nhiễu ổn định hiện diện cả calibration và đuôi."),
    ("rain_snr10", "Nền mưa, SNR +10 dB", "Nhiễu vừa hiện diện cả calibration và đuôi."),
    ("noise_snr0", "Nhiễu mạnh, SNR 0 dB, đủ 30 giây", "Nền tăng sau calibration và kéo dài tới 30 giây; kiểm tra giới hạn thu khi nhiễu giữ detector mở."),
    ("pause_0800ms", "Ngắt câu 800 ms", "Khoảng nghỉ ngắn hơn endSilence 1.500 ms."),
    ("pause_2200ms", "Ngắt câu 2.200 ms", "Auto-end có thể gửi trước mệnh đề thứ hai; upload toàn file vẫn có cả hai."),
    ("noise_only", "Chỉ tiếng nền, không lời", "Negative control: kiểm tra no-signal hoặc false trigger, không ép STT có transcript."),
]


def rms(values: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(values)))) if values.size else 0.0


def dbfs(values: np.ndarray) -> float:
    return 20 * math.log10(max(rms(values), 1e-12))


def normalize(values: np.ndarray, target_dbfs: float) -> np.ndarray:
    level = rms(values)
    if level < 1e-10:
        raise ValueError("Cannot normalize an empty/silent source.")
    return values * (10 ** (target_dbfs / 20) / level)


def read_key() -> str:
    if os.environ.get("ELEVENLABS_API_KEY"):
        return os.environ["ELEVENLABS_API_KEY"]
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8-sig").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                name, value = line.split("=", 1)
                if name.strip() == "ELEVENLABS_API_KEY":
                    return value.strip().strip("\"'")
    raise RuntimeError("ELEVENLABS_API_KEY is missing; no network request was made.")


def source_audio(language: str, part: str, fetch_tts: bool) -> np.ndarray:
    settings = SOURCES[language]
    path = CACHE / f"{language}_{part}.mp3"
    if not path.exists():
        if not fetch_tts:
            raise RuntimeError(f"Missing cached source {language}_{part}; use --fetch-tts to allow a billable TTS request.")
        response = requests.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{settings['voice_id']}",
            params={"output_format": "mp3_44100_128", "enable_logging": "true"},
            headers={"xi-api-key": read_key()},
            json={"text": settings[part], "model_id": MODEL, "language_code": language,
                  "seed": SEED, "voice_settings": {"stability": 0.5, "similarity_boost": 0.75,
                  "style": 0, "use_speaker_boost": False, "speed": 0.95}},
            timeout=(10, 45),
        )
        if not response.ok or not response.headers.get("content-type", "").startswith("audio/"):
            raise RuntimeError(f"TTS failed for {language}_{part}, HTTP {response.status_code}; response body omitted.")
        if not 1000 <= len(response.content) <= 5 * 1024 * 1024:
            raise RuntimeError("Unexpected TTS response size.")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(response.content)
    factor = 2 ** (float(settings["pitch_shift_semitones"]) / 12)
    result = subprocess.run([
        "ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-af",
        f"rubberband=pitch={factor:.9f}:formant=shifted:pitchq=quality",
        "-ac", "1", "-ar", str(RATE), "-f", "f32le", "pipe:1",
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, check=True)
    samples = np.frombuffer(result.stdout, dtype="<f4").astype(np.float64)
    if not samples.size or not np.isfinite(samples).all():
        raise RuntimeError("Invalid decoded TTS audio.")
    # Keep 80 ms around audible content; these are synthetic source boundaries, not forced alignment.
    audible = np.flatnonzero(np.abs(samples) > 10 ** (-55 / 20))
    if not audible.size:
        raise RuntimeError("TTS source contains no audible content.")
    padding = int(0.08 * RATE)
    samples = samples[max(0, audible[0] - padding):min(len(samples), audible[-1] + padding + 1)]
    return normalize(samples, -24)


def noise(kind: str, count: int, rng: np.random.Generator) -> np.ndarray:
    # Synthetic backdrops only: no third-party recordings, music or identifiable background speakers.
    white = rng.normal(0, 1, count)
    t = np.arange(count) / RATE
    if kind == "fan":
        low = signal.sosfilt(signal.butter(3, 650, fs=RATE, output="sos"), white)
        values = low + 0.13 * np.sin(2 * np.pi * 120 * t) + 0.08 * np.sin(2 * np.pi * 240 * t)
    elif kind == "rain":
        values = signal.sosfilt(signal.butter(2, [400, 9000], btype="bandpass", fs=RATE, output="sos"), white)
        values *= 0.8 + 0.2 * np.sin(2 * np.pi * 1.3 * t)
    elif kind == "changing":
        values = signal.sosfilt(signal.butter(2, [150, 6000], btype="bandpass", fs=RATE, output="sos"), white)
        values *= 0.35 + 0.65 * (0.5 + 0.5 * np.sin(2 * np.pi * 2.7 * t)) ** 2
    else:
        values = white
    return values / max(rms(values), 1e-12)


def pcm_wav(samples: np.ndarray) -> tuple[bytes, np.ndarray]:
    if np.max(np.abs(samples)) > 10 ** (-1 / 20) + 1e-9:
        raise ValueError("Unexpected output peak; apply a shared gain before PCM conversion.")
    pcm = np.rint(samples * 32767).astype("<i2")
    output = io.BytesIO()
    with wave.open(output, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(pcm.tobytes())
    return output.getvalue(), pcm.astype(np.float64) / 32768


def make_asset(language: str, case_index: int, sources: dict[str, np.ndarray]) -> dict:
    condition, label, intent = CASES[case_index]
    settings = SOURCES[language]
    asset_seed = SEED + case_index + (100 if language == "en" else 0)
    rng = np.random.default_rng(asset_seed)
    lead = round(LEAD_MS * RATE / 1000)
    tail = round(TAIL_MS * RATE / 1000)
    segments = []
    transforms: list[dict] = []
    speech_mask: np.ndarray
    target_snr = None
    if condition == "noise_only":
        count = round(6.5 * RATE)
        speech = np.zeros(count)
        speech_mask = np.zeros(count, dtype=bool)
        background = normalize(noise("fan", count, rng), -42)
        if language == "en":
            # A noise-only energy increase deliberately exposes the limits of an RMS detector.
            start, end = round(1.2 * RATE), round(1.9 * RATE)
            burst = normalize(noise("changing", end - start, rng), -20)
            background[start:end] += burst
            transforms.append({"kind": "non_speech_burst", "start_ms": 1200, "end_ms": 1900, "rms_dbfs": -20})
        transforms.append({"kind": "synthetic_fan", "rms_dbfs": -42})
        reference = ""
    else:
        if condition.startswith("pause_"):
            gap_ms = 800 if condition == "pause_0800ms" else 2200
            a, b = sources["pause_a"], sources["pause_b"]
            gap = round(gap_ms * RATE / 1000)
            speech = np.concatenate([np.zeros(lead), a, np.zeros(gap), b, np.zeros(tail)])
            segments = [
                {"start_ms": LEAD_MS, "end_ms": (lead + len(a)) * 1000 / RATE, "text": settings["pause_a"]},
                {"start_ms": (lead + len(a) + gap) * 1000 / RATE,
                 "end_ms": (lead + len(a) + gap + len(b)) * 1000 / RATE, "text": settings["pause_b"]},
            ]
            reference = f"{settings['pause_a']} {settings['pause_b']}"
            transforms.append({"kind": "inter_clause_pause", "duration_ms": gap_ms})
        else:
            voice = sources["main"].copy()
            if condition == "soft":
                voice = normalize(voice, -58)
                transforms.append({"kind": "quiet_speech", "target_region_rms_dbfs": -58})
            elif condition == "muffled":
                voice = signal.sosfilt(signal.butter(5, 1000, fs=RATE, output="sos"), voice)
                voice = normalize(voice, -24)
                transforms.append({"kind": "low_pass", "cutoff_hz": 1000, "order": 5})
            elif condition == "clipped":
                driven = voice * 6
                fraction = float(np.mean(np.abs(driven) >= 0.12))
                voice = normalize(np.clip(driven, -0.12, 0.12), -24)
                transforms.append({"kind": "hard_clip", "drive_gain_db": round(20 * math.log10(6), 3),
                                   "threshold_amplitude": 0.12, "clipped_source_fraction": round(fraction, 6)})
            if condition == "noise_snr0":
                tail = 30 * RATE - lead - len(voice)
                transforms.append({"kind": "maximum_recording_guardrail", "duration_ms": 30000})
            speech = np.concatenate([np.zeros(lead), voice, np.zeros(tail)])
            segments = [{"start_ms": LEAD_MS, "end_ms": (lead + len(voice)) * 1000 / RATE, "text": settings["main"]}]
            reference = settings["main"]
        count = len(speech)
        speech_mask = np.zeros(count, dtype=bool)
        for segment in segments:
            speech_mask[round(segment["start_ms"] * RATE / 1000):round(segment["end_ms"] * RATE / 1000)] = True
        background = normalize(noise("room", count, rng), -70)
        if condition in {"fan_snr20", "rain_snr10", "noise_snr0"}:
            target_snr = {"fan_snr20": 20, "rain_snr10": 10, "noise_snr0": 0}[condition]
            kind = {"fan_snr20": "fan", "rain_snr10": "rain", "noise_snr0": "changing"}[condition]
            background = noise(kind, count, rng)
            if kind == "changing":
                envelope = np.ones(count)
                envelope[:round(0.85 * RATE)] = 0.02
                ramp_end = round(1.15 * RATE)
                envelope[round(0.85 * RATE):ramp_end] = np.linspace(0.02, 1, ramp_end - round(0.85 * RATE))
                background *= envelope
            background *= rms(speech[speech_mask]) / (10 ** (target_snr / 20) * rms(background[speech_mask]))
            transforms.append({"kind": f"synthetic_{kind}", "target_snr_db": target_snr,
                               "snr_region": "union_of_declared_source_segments_including_intra_sentence_silence"})
    mixed = speech + background
    peak = float(np.max(np.abs(mixed)))
    gain = min(1.0, 10 ** (-1 / 20) / max(peak, 1e-12))
    speech *= gain
    background *= gain
    mixed *= gain
    if gain != 1:
        transforms.append({"kind": "shared_peak_gain", "gain_db": round(20 * math.log10(gain), 3)})
    data, actual = pcm_wav(mixed)
    filename = f"{case_index + 1 + (10 if language == 'en' else 0):02d}_{language}_{condition}.wav"
    path = DEST / "audio" / filename
    path.write_bytes(data)
    if len(data) > 5 * 1024 * 1024 or len(actual) / RATE > 30:
        raise ValueError("Generated audio exceeds the pipeline limits.")
    measured_snr = None
    if speech_mask.any():
        measured_snr = round(20 * math.log10(rms(speech[speech_mask]) / rms(background[speech_mask])), 3)
    return {
        "id": path.stem, "file": f"audio/{filename}", "language": language,
        "condition": condition, "label_vi": label, "test_intent": intent,
        "speech_present": bool(segments), "reference_text": reference,
        "reference_status": "TTS input, not an independently verified STT transcript",
        "segments": [{**s, "start_ms": round(s["start_ms"], 3), "end_ms": round(s["end_ms"], 3)} for s in segments],
        "segment_boundary_method": "trimmed source clip bounds, not word alignment",
        "lead_in_ms": LEAD_MS if segments else None, "tail_ms": round(tail * 1000 / RATE, 3) if segments else None,
        "voice": {"provider": "ElevenLabs", "model_id": MODEL, "voice_id": settings["voice_id"],
                  "voice_name": settings["voice_name"], "pitch_shift_semitones": settings["pitch_shift_semitones"],
                  "description": "Synthetic childlike approximation via TTS and pitch/formant shift; not a real child recording"} if segments else None,
        "seed": asset_seed, "transforms": transforms, "target_snr_db": target_snr,
        "measured_snr_db_before_pcm_quantization": measured_snr,
        "speech_region_rms_dbfs": round(dbfs(speech[speech_mask]), 3) if speech_mask.any() else None,
        "noise_rms_dbfs": round(dbfs(background), 3), "rms_dbfs": round(dbfs(actual), 3),
        "peak_dbfs": round(20 * math.log10(max(float(np.max(np.abs(actual))), 1e-12)), 3),
        "duration_ms": round(len(actual) * 1000 / RATE, 3), "sample_rate_hz": RATE,
        "channels": 1, "bit_depth": 16, "frames": len(actual), "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def write_preview(assets: list[dict]) -> None:
    cards = []
    for asset in assets:
        text = html.escape(asset["reference_text"] or "Không có lời nói / No speech")
        cards.append(f'''<article><h2>{html.escape(asset['id'])}</h2>
<p>{html.escape(asset['label_vi'])} · {asset['duration_ms']/1000:.2f} s</p>
<audio controls preload="none" src="{html.escape(asset['file'])}"></audio>
<p class="text">{text}</p><p>{html.escape(asset['test_intent'])}</p>
<a href="{html.escape(asset['file'])}" download>Tải WAV</a></article>''')
    page = '''<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>20 audio kiểm thử voice pipeline</title><style>
body{font:16px/1.6 system-ui,sans-serif;background:#f5f3ee;color:#262722;margin:0;padding:24px;max-width:1100px;margin-inline:auto}
h1{font-size:28px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,310px),1fr));gap:16px}
article{background:white;border:1px solid #d9dbd4;border-radius:14px;padding:18px;overflow-wrap:anywhere}
h2{font-size:17px;margin:0}audio{width:100%;margin:8px 0}.text{font-weight:600}a{color:#246045}aside{margin-bottom:24px}
</style><h1>20 audio kiểm thử voice pipeline</h1><aside>
<p>10 file Việt + 10 file Anh · WAV PCM16 mono 24 kHz. Giọng tổng hợp mô phỏng trẻ em qua TTS và chỉnh cao độ, không phải bản thu trẻ thật.</p>
<p>Nhấn phát từng file. Các biến thể dùng chung câu để so sánh; 1 file cuối mỗi nhóm chỉ có tiếng nền.
Trang này phát toàn bộ file, không chạy STT hoặc tự dừng bằng detector.</p>
<p>Upload file chỉ kiểm tra backend; fake mode trả sample cố định. Xem <a href="README.md">README</a> và <a href="manifest.json">manifest</a>.</p>
</aside><main>''' + "\n".join(cards) + "</main></html>\n"
    (DEST / "preview.html").write_text(page, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fetch-tts", action="store_true", help="Allow paid ElevenLabs generation of missing cached sources (max six requests).")
    args = parser.parse_args()
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg with the rubberband filter is required.")
    (DEST / "audio").mkdir(parents=True, exist_ok=True)
    assets = []
    sources_info = []
    for language in SOURCES:
        source = {part: source_audio(language, part, args.fetch_tts) for part in ["main", "pause_a", "pause_b"]}
        for part in source:
            cached = CACHE / f"{language}_{part}.mp3"
            sources_info.append({"id": f"{language}_{part}", "text": SOURCES[language][part],
                                 "voice_id": SOURCES[language]["voice_id"], "model_id": MODEL,
                                 "seed": SEED, "source_mp3_sha256": hashlib.sha256(cached.read_bytes()).hexdigest()})
        for index in range(len(CASES)):
            assets.append(make_asset(language, index, source))
    manifest = {"schema_version": 1, "sample_rate_hz": RATE, "asset_count": len(assets),
                "corpus_kind": "synthetic childlike speech and synthetic acoustic degradations",
                "not_evidence_of": ["real child speech accuracy", "microphone/iPad compatibility", "real STT accuracy", "latency target"],
                "generation": {"seed": SEED, "tts_model": MODEL, "tts_enable_logging": True,
                               "tts_scope": "Six fictional text snippets only; no voice cloning or user recordings",
                               "source_cache": ".cache/voice-test-audio/tts (gitignored)",
                               "determinism": "Noise/rendering deterministic for cached sources and tool versions; TTS seed is best effort",
                               "numpy_version": np.__version__, "scipy_version": __import__("scipy").__version__,
                               "ffmpeg_version": subprocess.check_output(["ffmpeg", "-version"], text=True).splitlines()[0]},
                "sources": sources_info, "assets": assets}
    (DEST / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with (DEST / "manifest.csv").open("w", newline="", encoding="utf-8-sig") as handle:
        fields = ["id", "file", "language", "condition", "speech_present", "reference_text", "duration_ms", "target_snr_db", "rms_dbfs", "bytes", "sha256"]
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(assets)
    write_preview(assets)
    print(json.dumps({"created_wav_files": len(assets), "total_bytes": sum(a["bytes"] for a in assets),
                      "duration_seconds": round(sum(a["duration_ms"] for a in assets) / 1000, 2),
                      "output": str(DEST)}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, requests.RequestException, subprocess.SubprocessError) as exc:
        # Do not dump HTTP responses, headers, environment or traceback locals.
        message = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        raise SystemExit(f"Audio generation failed: {message}") from None
