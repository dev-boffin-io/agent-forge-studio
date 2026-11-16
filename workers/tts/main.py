"""TTS worker — real voiceover synthesis via edge-tts.

Runs as a tiny FastAPI service so the Node app stays zero-runtime-dependency and the
heavy audio stack lives in its own Python environment. Start it with:

    pip install -r requirements.txt
    uvicorn main:app --host 127.0.0.1 --port 8101

Endpoints:
    GET  /health   -> {"ok": true}
    POST /synth    -> {"text", "lang"?: "bn", "voice"?: "...", "out"?: "<abs .mp3>"}
                      The language of every sentence is detected from its script and spoken with a
                      native voice (Bengali, Hindi, Arabic, Japanese, ... and mixed text). `lang` is only
                      needed to pick the language of Latin-script text (es, fr, de...). Returns
                      {"audio": "<abs path>", "duration": <seconds>, "segments": [...], "stub": false}

The output path defaults to <YT_TTS_OUT_DIR or a temp dir>/<sha1(text)>.mp3 so repeated
requests for the same text are cached. Pass an explicit "out" to control the location.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import langvoice

app = FastAPI(title="youtube-forge tts worker")



class TTSReq(BaseModel):
    text: str
    voice: str | None = None  # optional; "auto"/omitted = pick a native voice per language
    lang: str | None = None   # optional hint for Latin-script text, e.g. "es"
    out: str | None = None    # absolute path for the .mp3; omit to use the cache dir


def _out_dir() -> Path:
    d = Path(os.environ.get("YT_TTS_OUT_DIR", os.path.join(tempfile.gettempdir(), "ytforge-tts")))
    d.mkdir(parents=True, exist_ok=True)
    return d


def _target_path(req: TTSReq) -> Path:
    if req.out:
        p = Path(req.out)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p
    key = f"{req.voice or 'auto'}\x00{req.lang or ''}\x00{req.text}".encode()
    return _out_dir() / f"{hashlib.sha1(key).hexdigest()[:16]}.mp3"


def _duration_seconds(path: Path) -> float:
    """Duration via ffprobe when available; otherwise estimate from the MP3 size/bitrate
    (edge-tts writes 24 kHz mono MP3 at 48 kbps, so bytes*8/48000 is a close estimate)."""
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=15,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return round(float(proc.stdout.strip()), 3)
    except Exception:  # ffprobe missing or failed — fall through to the estimate
        pass
    try:
        return round(path.stat().st_size * 8 / 48000.0, 3)
    except Exception:
        return 0.0


def merge_mp3(parts: list[Path], target: Path) -> None:
    """Join the per-language MP3 chunks into one file."""
    if len(parts) == 1:
        shutil.move(str(parts[0]), str(target))
        return
    if shutil.which("ffmpeg"):
        listing = target.with_suffix(".list.txt")
        listing.write_text("".join(f"file '{str(p).replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'\n" for p in parts))
        try:
            proc = subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listing),
                 "-c:a", "libmp3lame", "-ar", "24000", "-ac", "1", "-b:a", "48k", str(target)],
                capture_output=True, text=True, timeout=600,
            )
            if proc.returncode == 0 and target.exists() and target.stat().st_size > 0:
                return
        finally:
            listing.unlink(missing_ok=True)
    with open(target, "wb") as out:          # MP3 frames can simply be concatenated
        for p in parts:
            out.write(p.read_bytes())


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/synth")
async def synth(req: TTSReq) -> dict:
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    chunks = langvoice.plan(text, req.lang)
    if not chunks:
        raise HTTPException(status_code=400, detail="text has nothing speakable (only punctuation?)")

    try:
        import edge_tts
    except ImportError as e:  # pragma: no cover - depends on the worker env
        raise HTTPException(status_code=503, detail=f"edge-tts is not installed: {e}")

    target = _target_path(req)
    warnings: list[str] = []
    segments: list[dict] = []
    parts: list[Path] = []
    tmp = Path(tempfile.mkdtemp(prefix="ytforge-tts-"))
    try:
        for i, chunk in enumerate(chunks):
            voice, warn = langvoice.voice_for(chunk["lang"], req.voice)
            if warn and warn not in warnings:
                warnings.append(warn)
            part = tmp / f"part{i:04d}.mp3"
            try:
                await edge_tts.Communicate(chunk["text"], voice).save(str(part))
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"edge-tts failed for {chunk['lang']} text with {voice}: {e}")
            if not part.exists() or part.stat().st_size == 0:
                raise HTTPException(status_code=502, detail=f"edge-tts produced no audio for {chunk['lang']} text ({voice})")
            parts.append(part)
            segments.append({"lang": chunk["lang"], "voice": voice, "chars": len(chunk["text"])})
        merge_mp3(parts, target)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if not target.exists() or target.stat().st_size == 0:
        raise HTTPException(status_code=502, detail="edge-tts produced no audio")
    out = {"audio": str(target), "duration": _duration_seconds(target), "segments": segments, "stub": False}
    if warnings:
        out["warnings"] = warnings
    return out
