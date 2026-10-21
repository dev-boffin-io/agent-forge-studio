from fastapi import FastAPI
from pydantic import BaseModel
import os

app = FastAPI()

class TTSReq(BaseModel):
    text: str
    voice: str | None = None

@app.get("/health")
def health(): return {"ok": True}

@app.post("/synth")
def synth(req: TTSReq):
    out = os.environ.get("YT_TTS_OUT", "/tmp/voice.mp3")
    return {"audio": out, "duration": 0, "stub": True}
