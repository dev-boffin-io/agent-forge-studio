"""Render core — ffmpeg only (no MoviePy), importable without FastAPI.

What it fixes compared with the old MoviePy worker:
  * clips are TRIMMED to the planned segment length (a 3-minute stock clip no longer becomes
    3 minutes of video),
  * every clip is scaled to *cover* the target frame and centre-cropped (no stretching, so the
    aspect ratio is always right: 16:9, 9:16, 1:1 or 4:5),
  * the video length follows the voiceover: clips are cycled/looped to fill the audio,
  * the original clip audio is always muted (-an), the voiceover is loudness-normalised, and
    optional background music is looped and side-chain ducked under the voice.
  * much lighter on RAM/CPU than MoviePy, which matters on Termux/proot ARM64.

Requires `ffmpeg` and `ffprobe` on PATH.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ASPECTS = {"16:9": (16, 9), "9:16": (9, 16), "1:1": (1, 1), "4:5": (4, 5)}
DEFAULT_ASPECT = "16:9"
FPS = int(os.environ.get("YT_RENDER_FPS", "30"))
SEGMENT_SECONDS = float(os.environ.get("YT_RENDER_SEGMENT", "6"))   # b-roll cut length
MIN_SEGMENT = 1.5
PRESET = os.environ.get("YT_RENDER_PRESET", "veryfast")
CRF = os.environ.get("YT_RENDER_CRF", "23")

_ALIASES = {
    "landscape": "16:9", "horizontal": "16:9", "youtube": "16:9", "wide": "16:9",
    "portrait": "9:16", "vertical": "9:16", "shorts": "9:16", "reels": "9:16", "tiktok": "9:16",
    "square": "1:1",
}


class RenderError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def parse_aspect(value) -> str:
    """Normalise 'landscape' / 'portrait' / 'shorts' / '16:9' / '9x16' to a key of ASPECTS."""
    raw = str(value or "").strip().lower()
    if raw in _ALIASES:
        return _ALIASES[raw]
    raw = raw.replace("x", ":").replace("/", ":")
    return raw if raw in ASPECTS else DEFAULT_ASPECT


def target_size(aspect: str, short_side: int | None = None) -> tuple[int, int]:
    """(width, height), both even. `short_side` is the shorter edge: 1080 → 1920x1080 / 1080x1920."""
    short = int(short_side or os.environ.get("YT_RENDER_SHORT_SIDE", 1080))
    short = max(240, min(short, 2160))
    aw, ah = ASPECTS[parse_aspect(aspect)]
    if aw >= ah:
        h, w = short, round(short * aw / ah)
    else:
        w, h = short, round(short * ah / aw)
    return w - w % 2, h - h % 2


def _run(cmd: list[str], what: str, timeout: int = 1800) -> None:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        raise RenderError("ffmpeg is not installed (install ffmpeg: apt/pkg install ffmpeg)", 503)
    except subprocess.TimeoutExpired:
        raise RenderError(f"{what} timed out")
    if p.returncode != 0:
        tail = (p.stderr or "").strip().splitlines()[-4:]
        raise RenderError(f"{what} failed: {' | '.join(tail)}")


def probe(path: str | Path) -> dict | None:
    """{duration, width, height} for a playable video file, else None."""
    try:
        p = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height:format=duration", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        if p.returncode != 0:
            return None
        data = json.loads(p.stdout or "{}")
        stream = (data.get("streams") or [{}])[0]
        if not stream.get("width"):
            return None
        try:
            duration = float((data.get("format") or {}).get("duration"))
        except (TypeError, ValueError):
            duration = 0.0
        return {"duration": duration, "width": int(stream["width"]), "height": int(stream["height"])}
    except FileNotFoundError:
        raise RenderError("ffprobe is not installed (install ffmpeg)", 503)
    except Exception:
        return None


def probe_audio_duration(path: str | Path) -> float:
    try:
        p = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        return float(p.stdout.strip()) if p.returncode == 0 else 0.0
    except Exception:
        return 0.0


def _cuts_for_weight(c: dict, target: float, seg: float) -> list[dict]:
    """Split one scene's target duration into cuts, advancing through the source clip."""
    real = c.get("duration") or 0
    n = max(1, int(target // max(MIN_SEGMENT, 0.5)))
    base = target / n
    cuts = []
    off = 0.0
    for _ in range(n):
        if real and off + base > real:
            off = 0.0
        cuts.append({
            "file": c["file"], "start": round(off, 3), "dur": base,
            "loop": bool(real) and real < base + 0.05,
        })
        off += base
    return cuts


def plan_segments(clips: list[dict], total: float | None, seg: float = SEGMENT_SECONDS) -> list[dict]:
    """Turn the available clips into an ordered list of cuts.

    clips: [{"file", "duration" (real clip length, 0 if unknown), "want" (planned seconds or None)}]
    total: audio length. With audio and scene weights, each clip gets its proportional share so
           the b-roll follows the narration. Without weights, clips are cycled evenly. Without
           audio each clip is used once for its planned length (capped at the real clip length).
    Returns [{"file", "start" (offset inside the clip), "dur", "loop"}].
    """
    if not clips:
        return []
    if not total or total <= 0:
        out = []
        for c in clips:
            real = c.get("duration") or 0
            dur = c.get("want") or min(real or seg * 2, seg * 2)
            if real:
                dur = min(dur, real)
            out.append({"file": c["file"], "start": 0.0, "dur": max(dur, MIN_SEGMENT), "loop": False})
        return out

    wants = [float(c.get("want") or 0) for c in clips]
    if all(w > 0 for w in wants):
        wanted_total = sum(wants)
        cuts: list[dict] = []
        for c, want in zip(clips, wants):
            target = total * (want / wanted_total)
            cuts.extend(_cuts_for_weight(c, target, seg))
        # rounding can leave a few milliseconds: extend the last cut so the video matches audio
        made = sum(c["dur"] for c in cuts)
        if cuts and abs(made - total) > 0.001:
            cuts[-1]["dur"] += total - made
        return cuts

    n = max(1, round(total / seg))
    base = total / n
    used: dict[int, float] = {}
    cuts = []
    for k in range(n):
        i = k % len(clips)
        c = clips[i]
        real = c.get("duration") or 0
        off = used.get(i, 0.0)
        if real and off + base > real:      # ran out of footage in this clip → restart it
            off = 0.0
        loop = bool(real) and real < base + 0.05
        cuts.append({"file": c["file"], "start": round(off, 3), "dur": base, "loop": loop})
        used[i] = off + base
    return cuts


def build_audio_filter(total: float, *, music: bool = False, duck: bool = True,
                       music_volume: float = 0.12, fade: float = 2.0) -> str:
    """ffmpeg filtergraph: normalise the voice and optionally duck looped music under it."""
    fade = max(0.0, min(float(fade or 0), total / 2.0))
    fade_out = max(0.0, total - fade)
    voice = "[1:a]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11[voice]"
    if not music:
        return f"{voice};[voice]anull[a]"
    vol = max(0.0, min(float(music_volume), 1.0))
    music_chain = (
        f"[2:a]aresample=48000,volume={vol:.4f},"
        f"afade=t=in:st=0:d={fade:.3f},afade=t=out:st={fade_out:.3f}:d={fade:.3f}[music]"
    )
    if duck:
        return (
            f"{voice};{music_chain};[voice]asplit=2[voice_main][voice_sc];"
            "[music][voice_sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked];"
            "[voice_main][ducked]amix=inputs=2:duration=first:dropout_transition=0,"
            "alimiter=limit=0.98[a]"
        )
    return (
        f"{voice};{music_chain};[voice][music]amix=inputs=2:duration=first:"
        "dropout_transition=0,alimiter=limit=0.98[a]"
    )


def _encode_segment(cut: dict, w: int, h: int, out: Path) -> None:
    vf = (f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},"
          f"setsar=1,fps={FPS},format=yuv420p")
    cmd = ["ffmpeg", "-y", "-v", "error"]
    if cut["loop"]:
        cmd += ["-stream_loop", "-1"]
    cmd += ["-ss", f"{cut['start']:.3f}", "-i", cut["file"], "-t", f"{cut['dur']:.3f}",
            "-an", "-vf", vf, "-c:v", "libx264", "-preset", PRESET, "-crf", CRF,
            "-pix_fmt", "yuv420p", str(out)]
    _run(cmd, f"encoding {Path(cut['file']).name}")


def render(shots: list[dict], audio: str | None, out: str | Path,
           aspect: str | None = None, short_side: int | None = None,
           music: str | None = None, music_volume: float = 0.12,
           duck_music: bool = True, fade_seconds: float = 2.0) -> dict:
    """Build the final MP4. `shots` is [{"file", "start", "end"}] (timeline hints)."""
    aspect = parse_aspect(aspect)
    w, h = target_size(aspect, short_side)

    clips, skipped = [], []
    for s in shots or []:
        f = s.get("file")
        if not f or not Path(f).exists():
            continue
        info = probe(f)
        if not info:
            skipped.append(f)
            continue
        want = None
        if s.get("end") is not None and s.get("start") is not None:
            want = max(0.0, float(s["end"]) - float(s["start"])) or None
        clips.append({"file": f, "duration": info["duration"], "want": want})
    if not clips:
        raise RenderError("no playable shot files were provided", 400)

    total = None
    if audio and Path(audio).exists():
        total = probe_audio_duration(audio) or None
    cuts = plan_segments(clips, total)

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ytforge-render-") as tmp:
        tmpd = Path(tmp)
        parts = []
        used_music = False
        used_duck = False
        for i, cut in enumerate(cuts):
            part = tmpd / f"seg{i:04d}.mp4"
            _encode_segment(cut, w, h, part)
            parts.append(part)
        listing = tmpd / "list.txt"
        listing.write_text("".join(f"file '{str(p).replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'\n" for p in parts))
        silent = tmpd / "video.mp4"
        _run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listing),
              "-c", "copy", str(silent)], "joining segments")
        if total:
            music_file = music if music and Path(music).exists() else None
            used_music = bool(music_file)
            used_duck = used_music and duck_music
            def attach_audio(duck: bool) -> None:
                cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(silent), "-i", str(audio)]
                if music_file:
                    cmd += ["-stream_loop", "-1", "-i", str(music_file)]
                cmd += ["-filter_complex", build_audio_filter(
                            total, music=bool(music_file), duck=duck,
                            music_volume=music_volume, fade=fade_seconds),
                        "-map", "0:v:0", "-map", "[a]", "-c:v", "copy",
                        "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.3f}",
                        "-movflags", "+faststart", str(out)]
                _run(cmd, "adding the voiceover" + (" and music" if music_file else ""))
            try:
                attach_audio(used_duck)
            except RenderError:
                if not used_duck:
                    raise
                # some old ffmpeg builds lack sidechaincompress — still mix, without ducking
                used_duck = False
                attach_audio(False)
        else:
            _run(["ffmpeg", "-y", "-v", "error", "-i", str(silent), "-c", "copy",
                  "-movflags", "+faststart", str(out)], "finalising the video")

    if not out.exists() or out.stat().st_size == 0:
        raise RenderError("render produced no file")
    final = probe(out) or {}
    return {
        "video": str(out), "duration": round(final.get("duration") or total or 0, 3),
        "aspect": aspect, "width": w, "height": h, "segments": len(cuts),
        "skipped": skipped, "music": str(music) if used_music else None,
        "musicDucked": used_duck,
        "originalAudioMuted": True, "stub": False,
    }
