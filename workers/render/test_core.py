"""Run with:  python -m unittest test_core   (needs ffmpeg + ffprobe)"""
import json, shutil, subprocess, tempfile, unittest
from pathlib import Path

import core

def _usable(binary):
    if not shutil.which(binary):
        return False
    try:
        return subprocess.run([binary, "-version"], capture_output=True, timeout=10).returncode == 0
    except Exception:
        return False

HAVE_FFMPEG = _usable("ffmpeg") and _usable("ffprobe")


def ff(*args):
    subprocess.run(["ffmpeg", "-y", "-v", "error", *args], check=True)


class PureTests(unittest.TestCase):
    def test_parse_aspect(self):
        self.assertEqual(core.parse_aspect("portrait"), "9:16")
        self.assertEqual(core.parse_aspect("Shorts"), "9:16")
        self.assertEqual(core.parse_aspect("9x16"), "9:16")
        self.assertEqual(core.parse_aspect("1:1"), "1:1")
        self.assertEqual(core.parse_aspect("nonsense"), "16:9")
        self.assertEqual(core.parse_aspect(None), "16:9")

    def test_target_size_even_and_correct(self):
        self.assertEqual(core.target_size("16:9", 1080), (1920, 1080))
        self.assertEqual(core.target_size("9:16", 1080), (1080, 1920))
        self.assertEqual(core.target_size("1:1", 720), (720, 720))
        self.assertEqual(core.target_size("4:5", 1080), (1080, 1350))
        for a in core.ASPECTS:
            w, h = core.target_size(a, 721)
            self.assertEqual((w % 2, h % 2), (0, 0))

    def test_plan_fills_audio_and_never_uses_whole_long_clip(self):
        clips = [{"file": "long.mp4", "duration": 600, "want": None},
                 {"file": "short.mp4", "duration": 4, "want": None}]
        cuts = core.plan_segments(clips, 30.0, seg=6)
        self.assertAlmostEqual(sum(c["dur"] for c in cuts), 30.0, places=3)
        self.assertTrue(all(c["dur"] <= 6.5 for c in cuts))
        self.assertTrue(all(c["loop"] for c in cuts if c["file"] == "short.mp4"))
        # a long clip advances through its footage instead of repeating the first seconds
        starts = [c["start"] for c in cuts if c["file"] == "long.mp4"]
        self.assertEqual(starts, sorted(starts))
        self.assertGreater(len(set(starts)), 1)

    def test_plan_without_audio_uses_each_clip_once_and_capped(self):
        cuts = core.plan_segments([{"file": "a", "duration": 300, "want": None},
                                   {"file": "b", "duration": 3, "want": 5}], None, seg=6)
        self.assertEqual(len(cuts), 2)
        self.assertLessEqual(cuts[0]["dur"], 12)
        self.assertLessEqual(cuts[1]["dur"], 3)

    def test_scene_weights_drive_the_timeline(self):
        clips = [{"file": "intro", "duration": 40, "want": 4},
                 {"file": "body", "duration": 40, "want": 12}]
        cuts = core.plan_segments(clips, 16.0, seg=6)
        self.assertAlmostEqual(sum(c["dur"] for c in cuts), 16.0, places=3)
        intro = sum(c["dur"] for c in cuts if c["file"] == "intro")
        body = sum(c["dur"] for c in cuts if c["file"] == "body")
        self.assertAlmostEqual(intro, 4.0, places=3)
        self.assertAlmostEqual(body, 12.0, places=3)

    def test_audio_filter_normalises_voice_and_ducks_music(self):
        voice = core.build_audio_filter(20.0, music=False)
        self.assertIn("loudnorm", voice)
        self.assertNotIn("sidechaincompress", voice)
        mixed = core.build_audio_filter(20.0, music=True, duck=True)
        self.assertIn("sidechaincompress", mixed)
        self.assertIn("volume=0.1200", mixed)
        self.assertIn("afade=t=out:st=18.000", mixed)


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe unavailable or unusable")
class RenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.land = cls.tmp / "land.mp4"      # 40 s landscape 4:3 (odd ratio on purpose)
        cls.port = cls.tmp / "port.mp4"      # 3 s portrait
        cls.audio = cls.tmp / "voice.mp3"    # 14 s
        ff("-f", "lavfi", "-i", "testsrc=size=640x480:rate=25:duration=40", "-pix_fmt", "yuv420p", str(cls.land))
        ff("-f", "lavfi", "-i", "testsrc=size=360x640:rate=25:duration=3", "-pix_fmt", "yuv420p", str(cls.port))
        ff("-f", "lavfi", "-i", "sine=frequency=440:duration=14", "-c:a", "libmp3lame", str(cls.audio))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _render(self, aspect, name):
        out = self.tmp / name
        shots = [{"file": str(self.land), "start": 0, "end": 5},
                 {"file": str(self.port), "start": 5, "end": 8},
                 {"file": str(self.tmp / "missing.mp4"), "start": 8, "end": 10}]
        return core.render(shots, str(self.audio), out, aspect=aspect, short_side=360), out

    def test_landscape_matches_audio_and_aspect(self):
        res, out = self._render("16:9", "o169.mp4")
        info = core.probe(out)
        self.assertEqual((info["width"], info["height"]), (640, 360))
        self.assertAlmostEqual(info["duration"], 14.0, delta=0.6)    # not 43 s of raw footage
        self.assertEqual(res["aspect"], "16:9")

    def test_portrait_vertical_frame(self):
        res, out = self._render("portrait", "o916.mp4")
        info = core.probe(out)
        self.assertEqual((info["width"], info["height"]), (360, 640))
        self.assertAlmostEqual(info["duration"], 14.0, delta=0.6)

    def test_audio_stream_present(self):
        _, out = self._render("1:1", "o11.mp4")
        p = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                            "stream=codec_name", "-of", "json", str(out)], capture_output=True, text=True)
        self.assertEqual(json.loads(p.stdout)["streams"][0]["codec_name"], "aac")

    def test_music_is_mixed_and_original_audio_is_muted(self):
        music = self.tmp / "music.mp3"
        ff("-f", "lavfi", "-i", "sine=frequency=220:duration=5", "-c:a", "libmp3lame", str(music))
        out = self.tmp / "music-mix.mp4"
        res = core.render([{"file": str(self.land), "start": 0, "end": 5}], str(self.audio), out,
                          aspect="16:9", short_side=240, music=str(music), music_volume=0.1)
        info = core.probe(out)
        self.assertTrue(res["originalAudioMuted"])
        self.assertEqual(res["music"], str(music))
        self.assertAlmostEqual(info["duration"], 14.0, delta=0.6)

    def test_no_audio_each_clip_once(self):
        out = self.tmp / "noaudio.mp4"
        res = core.render([{"file": str(self.land)}, {"file": str(self.port), "start": 0, "end": 3}],
                          None, out, aspect="16:9", short_side=240)
        self.assertLess(res["duration"], 20)

    def test_no_clips_is_an_error(self):
        with self.assertRaises(core.RenderError):
            core.render([{"file": "/nope.mp4"}], None, self.tmp / "x.mp4")


if __name__ == "__main__":
    unittest.main()
