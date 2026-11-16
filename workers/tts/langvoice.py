"""Language detection + voice selection for the TTS worker (pure Python, no dependencies).

The old worker read every text with ONE English voice, so Bengali/Hindi/Arabic/... text came out
garbled or silent. Here the text is split into sentences, each sentence is classified by its
Unicode script, neighbouring sentences of the same language are merged, and each chunk is
spoken with a native voice. Mixed-language scripts therefore work: every part gets its own voice.

Latin-script text is ambiguous (English/Spanish/French...), so it uses the optional `lang` hint
(e.g. "es") and otherwise English.
"""

from __future__ import annotations

import json
import os
import re

# language -> default edge-tts voice (override any of them with env YT_TTS_VOICES='{"bn":"bn-IN-TanishaaNeural"}')
VOICES = {
    "en": os.environ.get("YT_TTS_VOICE", "en-US-AriaNeural"),
    "bn": "bn-BD-NabanitaNeural", "hi": "hi-IN-SwaraNeural", "mr": "mr-IN-AarohiNeural",
    "gu": "gu-IN-DhwaniNeural", "ta": "ta-IN-PallaviNeural", "te": "te-IN-ShrutiNeural",
    "kn": "kn-IN-SapnaNeural", "ml": "ml-IN-SobhanaNeural", "si": "si-LK-ThiliniNeural",
    "ur": "ur-PK-UzmaNeural", "ar": "ar-SA-ZariyahNeural", "he": "he-IL-HilaNeural",
    "th": "th-TH-PremwadeeNeural", "ja": "ja-JP-NanamiNeural", "ko": "ko-KR-SunHiNeural",
    "zh": "zh-CN-XiaoxiaoNeural", "ru": "ru-RU-SvetlanaNeural", "el": "el-GR-AthinaNeural",
    "es": "es-ES-ElviraNeural", "fr": "fr-FR-DeniseNeural", "de": "de-DE-KatjaNeural",
    "pt": "pt-BR-FranciscaNeural", "it": "it-IT-ElsaNeural", "id": "id-ID-GadisNeural",
    "tr": "tr-TR-EmelNeural", "vi": "vi-VN-HoaiMyNeural", "nl": "nl-NL-ColetteNeural",
    "pl": "pl-PL-ZofiaNeural",
}
try:
    VOICES.update(json.loads(os.environ.get("YT_TTS_VOICES", "{}")))
except ValueError:
    pass

# (language, first, last) code-point ranges
_RANGES = [
    ("bn", 0x0980, 0x09FF), ("hi", 0x0900, 0x097F), ("gu", 0x0A80, 0x0AFF), ("ta", 0x0B80, 0x0BFF),
    ("te", 0x0C00, 0x0C7F), ("kn", 0x0C80, 0x0CFF), ("ml", 0x0D00, 0x0D7F), ("si", 0x0D80, 0x0DFF),
    ("th", 0x0E00, 0x0E7F), ("he", 0x0590, 0x05FF), ("ru", 0x0400, 0x04FF),
    ("el", 0x0370, 0x03FF), ("el", 0x1F00, 0x1FFF),
    ("ar", 0x0600, 0x06FF), ("ar", 0x0750, 0x077F), ("ar", 0xFB50, 0xFDFF), ("ar", 0xFE70, 0xFEFF),
    ("ko", 0xAC00, 0xD7AF), ("ko", 0x1100, 0x11FF), ("ko", 0x3130, 0x318F),
    ("kana", 0x3040, 0x30FF), ("han", 0x4E00, 0x9FFF), ("han", 0x3400, 0x4DBF),
    ("latin", 0x0041, 0x005A), ("latin", 0x0061, 0x007A), ("latin", 0x00C0, 0x024F),
]
_URDU_ONLY = set("ٹڈڑںھے")
_DEVANAGARI_HINTS = {"hi", "mr", "ne"}

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?।॥。！？؟…])\s+|\n+")
MAX_CHARS = int(os.environ.get("YT_TTS_CHUNK", "1500"))


def script_of(ch: str) -> str | None:
    cp = ord(ch)
    for lang, lo, hi in _RANGES:
        if lo <= cp <= hi:
            return lang
    return None


def classify(sentence: str) -> str | None:
    """Dominant language of one sentence, or None when it has no letters (digits/punctuation)."""
    counts: dict[str, int] = {}
    for ch in sentence:
        s = script_of(ch)
        if s:
            counts[s] = counts.get(s, 0) + 1
    if not counts:
        return None
    if "kana" in counts:
        return "ja"                      # Japanese mixes kana with Han
    best = max(counts, key=lambda k: counts[k])
    if best == "han":
        return "zh"
    if best == "ar" and any(c in _URDU_ONLY for c in sentence):
        return "ur"
    return best                          # may be "latin"


def split_sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_SPLIT.split(text or "") if s and s.strip()]


def _hard_split(sentence: str, limit: int) -> list[str]:
    """Break an over-long sentence at commas/spaces so no chunk exceeds `limit`."""
    out, cur = [], ""
    for piece in re.split(r"(?<=[,;:،、])\s*|\s+", sentence):
        if cur and len(cur) + len(piece) + 1 > limit:
            out.append(cur)
            cur = piece
        else:
            cur = f"{cur} {piece}".strip()
    if cur:
        out.append(cur)
    return out


def plan(text: str, lang_hint: str | None = None, limit: int = MAX_CHARS) -> list[dict]:
    """Split `text` into [{"lang", "text"}] chunks, one native voice per chunk."""
    hint = (lang_hint or "").strip().lower().split("-")[0] or None
    labelled: list[tuple[str | None, str]] = []
    for sent in split_sentences(text):
        lang = classify(sent)
        if lang == "latin":
            lang = hint or "en"
        elif lang == "hi" and hint in _DEVANAGARI_HINTS:
            lang = hint if hint in VOICES else "hi"
        labelled.append((lang, sent))
    if not labelled:
        return []
    # sentences with no letters (e.g. "2024.") join the previous chunk
    first = next((l for l, _ in labelled if l), "en")
    prev = first
    resolved = []
    for lang, sent in labelled:
        prev = lang or prev
        resolved.append((prev, sent))

    chunks: list[dict] = []
    for lang, sent in resolved:
        pieces = _hard_split(sent, limit) if len(sent) > limit else [sent]
        for piece in pieces:
            if chunks and chunks[-1]["lang"] == lang and len(chunks[-1]["text"]) + len(piece) + 1 <= limit:
                chunks[-1]["text"] += " " + piece
            else:
                chunks.append({"lang": lang, "text": piece})
    return [c for c in chunks if re.search(r"\w", c["text"])]


def voice_for(lang: str, explicit: str | None = None) -> tuple[str, str | None]:
    """(voice, warning). An explicit voice is honoured for Latin text; for a non-Latin language the
    explicit voice is used only if it belongs to that language — otherwise the native voice wins."""
    native = VOICES.get(lang) or VOICES["en"]
    if not explicit or explicit.lower() == "auto":
        warn = None if lang in VOICES else f"no native voice for '{lang}', used the default voice"
        return native, warn
    explicit_lang = explicit.split("-")[0].lower()
    if lang in ("en",) or explicit_lang == lang:
        return explicit, None
    if lang in VOICES and lang not in ("en",):
        return native, f"voice {explicit} cannot speak '{lang}' text, used {native}"
    return explicit, None
