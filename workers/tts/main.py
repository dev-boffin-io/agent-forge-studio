"""TTS worker — real voiceover synthesis via edge-tts.

Runs as a tiny FastAPI service so the Node app stays zero-runtime-dependency and the
heavy audio stack lives in its own Python environment. Start it with:

    pip install -r requirements.txt
    uvicorn main:app --host 127.0.0.1 --port 8101

Endpoints:
    GET  /health   -> {"ok": true}
    POST /synth    -> synthesizes text to an .mp3 and returns
                      {"audio": "<abs path>", "duration": <seconds>, "stub": false}

The output path defaults to <YT_TTS_OUT_DIR or a temp dir>/<sha1(text)>.mp3 so repeated
requests for the same text are cached. Pass an explicit "out" to control the location.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="youtube-forge tts worker")

DEFAULT_VOICE = os.environ.get("YT_TTS_VOICE", "en-US-AriaNeural")


class TTSReq(BaseModel):
    text: str
    voice: str | None = None
    out: str | None = None  # absolute path for the .mp3; omit to use the cache dir


def _out_dir() -> Path:
    d = Path(os.environ.get("YT_TTS_OUT_DIR", os.path.join(tempfile.gettempdir(), "ytforge-tts")))
    d.mkdir(parents=True, exist_ok=True)
    return d


def _target_path(req: TTSReq) -> Path:
    if req.out:
        p = Path(req.out)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p
    digest = hashlib.sha1((req.voice or DEFAULT_VOICE).encode() + b"\x00" + req.text.encode()).hexdigest()[:16]
    return _out_dir() / f"{digest}.mp3"


def _duration_seconds(path: Path) -> float:
    """Duration via ffprobe when available; otherwise estimate from the MP3 size/bitrate.

    edge-tts writes 24 kHz mono MP3 at 48 kbps, so bytes*8/48000 is a close estimate.
    """
    try:
        import subprocess

        proc = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
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


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/synth")
async def synth(req: TTSReq) -> dict:
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    try:
        import edge_tts
    except ImportError as e:  # pragma: no cover - depends on the worker env
        raise HTTPException(status_code=503, detail=f"edge-tts is not installed: {e}")

    target = _target_path(req)
    voice = req.voice or DEFAULT_VOICE

    try:
        communicate = edge_tts.Communicate(text, voice)
        await communicate.save(str(target))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"edge-tts failed: {e}")

    if not target.exists() or target.stat().st_size == 0:
        raise HTTPException(status_code=502, detail="edge-tts produced no audio")

    return {"audio": str(target), "duration": _duration_seconds(target), "stub": False}
