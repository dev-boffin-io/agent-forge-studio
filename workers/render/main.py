"""Render worker — assembles the final video with MoviePy + Pillow.

Runs as a small FastAPI service so the Node app stays zero-runtime-dependency.
Start it with:

    pip install -r requirements.txt
    uvicorn main:app --host 127.0.0.1 --port 8102

Endpoints:
    GET  /health   -> {"ok": true}
    POST /render   -> concatenates the clips in `shots`, lays `audio` over the result and
                      writes a real .mp4: {"video": "<abs path>", "duration": <s>, "stub": false}
    POST /thumbnail-> draws a real 1280x720 PNG from a title: {"thumbnail": "<abs path>", ...}

`shots` is the Auto-Forge shot list: [{"file": "<abs mp4>", "start": s, "end": s}, ...].
A shot with no downloadable file, or a missing rendered clip file, is skipped so a partly
downloaded set still renders. The audio is trimmed/looped to the video length.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="youtube-forge render worker")

TARGET_W, TARGET_H = 1920, 1080
DEFAULT_FPS = 30


class Shot(BaseModel):
    file: str | None = None
    start: float | None = None
    end: float | None = None
    query: str | None = None


class RenderReq(BaseModel):
    shots: list[Shot] | None = None
    audio: str | None = None
    out: str | None = None
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


def _clip_files(req: RenderReq) -> list[str]:
    files: list[str] = []
    for shot in req.shots or []:
        if shot.file and Path(shot.file).exists():
            files.append(shot.file)
    return files


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/render")
def render(req: RenderReq) -> dict:
    files = _clip_files(req)
    if not files:
        raise HTTPException(status_code=400, detail="no downloadable shot files were provided")

    try:
        from moviepy import AudioFileClip, ColorClip, VideoFileClip, concatenate_videoclips
        from moviepy.video.fx import Resize
    except ImportError as e:  # pragma: no cover - depends on the worker env
        raise HTTPException(status_code=503, detail=f"moviepy is not installed: {e}")

    clips = []
    for f in files:
        try:
            clip = VideoFileClip(f)
            if clip.w and clip.h and (clip.w, clip.h) != (TARGET_W, TARGET_H):
                clip = clip.resized((TARGET_W, TARGET_H))
            clips.append(clip)
        except Exception:
            continue  # skip a clip we cannot open rather than failing the whole render

    if not clips:
        raise HTTPException(status_code=422, detail="none of the provided clips could be opened")

    video = concatenate_videoclips(clips, method="compose")

    audio_path = req.audio
    if audio_path and Path(audio_path).exists():
        try:
            audio = AudioFileClip(audio_path)
            vid_len = float(video.duration or 0)
            if vid_len > 0 and audio.duration > vid_len:
                audio = audio.subclipped(0, vid_len)
            elif vid_len > 0 and audio.duration < vid_len:
                audio = audio.with_effects([])  # keep as-is; MoviePy leaves trailing silence
            video = video.with_audio(audio)
        except Exception:
            pass  # a broken audio track must not sink the video

    out = _render_out(req)
    try:
        video.write_videofile(
            str(out), fps=DEFAULT_FPS, codec="libx264", audio_codec="aac", logger=None,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"render failed: {e}")
    finally:
        try:
            video.close()
        except Exception:
            pass
        for c in clips:
            try:
                c.close()
            except Exception:
                pass

    if not out.exists() or out.stat().st_size == 0:
        raise HTTPException(status_code=502, detail="render produced no file")

    return {"video": str(out), "duration": round(float(video.duration or 0), 3), "stub": False}


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
