"""Render worker — assembles the final video with ffmpeg (see core.py).

    pip install -r requirements.txt     # also needs ffmpeg + ffprobe on PATH
    uvicorn main:app --host 127.0.0.1 --port 8102

Endpoints:
    GET  /health    -> {"ok": true, "ffmpeg": <bool>}
    POST /render    -> {"shots": [...], "audio": "<mp3>", "aspect": "16:9|9:16|1:1|4:5", "resolution": 1080,
                        "music": "<optional mp3>", "musicVolume": 0.12, "duckMusic": true}
                       returns {"video", "duration", "aspect", "width", "height", "segments",
                                "music", "musicDucked", "originalAudioMuted": true, "stub": false}
    POST /thumbnail -> draws a 1280x720 PNG from a title
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import core

app = FastAPI(title="youtube-forge render worker")


class Shot(BaseModel):
    file: str | None = None
    start: float | None = None
    end: float | None = None
    query: str | None = None


class RenderReq(BaseModel):
    shots: list[Shot] | None = None
    audio: str | None = None
    out: str | None = None
    aspect: str | None = None       # 16:9 (default) | 9:16 | 1:1 | 4:5, or landscape/portrait/shorts
    resolution: int | None = None   # shorter edge in px (default 1080; use 720 on slow devices)
    music: str | None = None        # optional background-music file (looped under the voice)
    musicVolume: float | None = None # 0..1, default 0.12
    duckMusic: bool | None = None   # side-chain duck music under the voice (default true)
    fadeSeconds: float | None = None # music fade-in/out seconds (default 2)
    # Legacy fields kept so the old contract still validates.
    script: str | None = None
    captions: str | None = None


class ThumbReq(BaseModel):
    title: str
    subtitle: str | None = None
    out: str | None = None


def _render_out(req: RenderReq) -> Path:
    if req.out:
        p = Path(req.out)
    else:
        p = Path(os.environ.get("YT_RENDER_OUT", os.path.join(tempfile.gettempdir(), "ytforge-render", "out.mp4")))
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _usable(binary: str) -> bool:
    if not shutil.which(binary):
        return False
    try:
        return subprocess.run([binary, "-version"], capture_output=True, timeout=10).returncode == 0
    except Exception:
        return False


@app.get("/health")
def health() -> dict:
    return {"ok": True, "ffmpeg": _usable("ffmpeg") and _usable("ffprobe")}


@app.post("/render")
def render(req: RenderReq) -> dict:
    try:
        return core.render(
            [s.model_dump() for s in (req.shots or [])], req.audio, _render_out(req),
            aspect=req.aspect, short_side=req.resolution,
            music=req.music, music_volume=req.musicVolume if req.musicVolume is not None else 0.12,
            duck_music=req.duckMusic if req.duckMusic is not None else True,
            fade_seconds=req.fadeSeconds if req.fadeSeconds is not None else 2.0,
        )
    except core.RenderError as e:
        raise HTTPException(status_code=e.status, detail=str(e))


@app.post("/thumbnail")
def thumbnail(req: ThumbReq) -> dict:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as e:  # pragma: no cover - depends on the worker env
        raise HTTPException(status_code=503, detail=f"pillow is not installed: {e}")

    out = Path(req.out) if req.out else Path(
        os.environ.get("YT_THUMB_OUT", os.path.join(tempfile.gettempdir(), "ytforge-render", "thumbnail.png"))
    )
    out.parent.mkdir(parents=True, exist_ok=True)

    img = Image.new("RGB", (1280, 720), (31, 111, 235))
    draw = ImageDraw.Draw(img)
    # a simple diagonal sheen so the thumbnail is not a flat block
    for i in range(720):
        draw.line([(0, i), (1280, i - 200)], fill=(20 + i % 40, 90 + i % 30, 200))

    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 84)
    except Exception:
        font = ImageFont.load_default()

    text = (req.title or "Untitled").strip()
    words = " ".join(text.split()[:5])
    draw.text((64, 300), words or "Auto-Forge", fill=(255, 255, 255), font=font)
    if req.subtitle:
        draw.text((64, 620), req.subtitle[:80], fill=(255, 255, 255), font=ImageFont.load_default())

    img.save(out, "PNG")
    return {"thumbnail": str(out), "format": "png", "stub": False}
