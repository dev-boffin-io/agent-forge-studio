"""Run with:  python -m unittest test_langvoice"""
import unittest
import langvoice as lv


class Detect(unittest.TestCase):
    def test_scripts(self):
        self.assertEqual(lv.classify("আমি বাংলায় কথা বলি।"), "bn")
        self.assertEqual(lv.classify("यह हिंदी वाक्य है"), "hi")
        self.assertEqual(lv.classify("مرحبا بالعالم"), "ar")
        self.assertEqual(lv.classify("یہ اردو ہے ٹھیک"), "ur")
        self.assertEqual(lv.classify("こんにちは世界"), "ja")
        self.assertEqual(lv.classify("你好，世界"), "zh")
        self.assertEqual(lv.classify("안녕하세요"), "ko")
        self.assertEqual(lv.classify("Привет мир"), "ru")
        self.assertEqual(lv.classify("Hello there"), "latin")
        self.assertIsNone(lv.classify("2024 — 12:30!"))


class Plan(unittest.TestCase):
    def test_mixed_script_gets_one_voice_per_language(self):
        text = "Welcome to the channel. আজ আমরা একটি নতুন বিষয় নিয়ে কথা বলব। এটি খুব মজার। Thanks for watching."
        chunks = lv.plan(text)
        self.assertEqual([c["lang"] for c in chunks], ["en", "bn", "en"])
        self.assertIn("মজার", chunks[1]["text"])

    def test_bengali_never_uses_the_english_voice(self):
        voice, _ = lv.voice_for("bn", "en-US-AriaNeural")     # LLM passed an English voice
        self.assertTrue(voice.startswith("bn-"))
        self.assertEqual(lv.voice_for("bn")[0], lv.VOICES["bn"])

    def test_explicit_voice_honoured_for_matching_or_latin_text(self):
        self.assertEqual(lv.voice_for("en", "en-GB-SoniaNeural")[0], "en-GB-SoniaNeural")
        self.assertEqual(lv.voice_for("bn", "bn-IN-TanishaaNeural")[0], "bn-IN-TanishaaNeural")

    def test_latin_hint_selects_language(self):
        chunks = lv.plan("Hola amigos. ¿Cómo estáis?", "es")
        self.assertEqual({c["lang"] for c in chunks}, {"es"})
        self.assertTrue(lv.voice_for("es")[0].startswith("es-"))

    def test_numbers_attach_to_previous_language(self):
        chunks = lv.plan("আজ তারিখ। 2024. আবহাওয়া ভালো।")
        self.assertEqual([c["lang"] for c in chunks], ["bn"])

    def test_long_text_is_chunked(self):
        text = " ".join(["এটি একটি দীর্ঘ বাক্য।"] * 400)
        chunks = lv.plan(text, limit=500)
        self.assertGreater(len(chunks), 3)
        self.assertTrue(all(len(c["text"]) <= 500 for c in chunks))

    def test_punctuation_only_is_dropped(self):
        self.assertEqual(lv.plan("... !!! ---"), [])


if __name__ == "__main__":
    unittest.main()
