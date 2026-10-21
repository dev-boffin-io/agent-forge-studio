from fastapi import FastAPI
from pydantic import BaseModel
import os

app = FastAPI()

class RenderReq(BaseModel):
    script: str | None = None
    captions: str | None = None
    audio: str | None = None
    shots: list | None = None

@app.get("/health")
def health(): return {"ok": True}

@app.post("/render")
def render(req: RenderReq):
    # Stub: in production MoviePy + FLUX would render here
    out = os.environ.get("YT_RENDER_OUT", "/tmp/out.mp4")
    return {"video": out, "duration": 0, "stub": True}
