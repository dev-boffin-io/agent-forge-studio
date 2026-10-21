from fastapi import FastAPI
from pydantic import BaseModel
import os

app = FastAPI()

class CapReq(BaseModel):
    audio: str

@app.get("/health")
def health(): return {"ok": True}

@app.post("/generate")
def gen(req: CapReq):
    return {"srt": req.audio + ".srt", "vtt": req.audio + ".vtt", "json": req.audio + ".captions.json", "stub": True}
