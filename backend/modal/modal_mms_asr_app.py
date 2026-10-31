"""
Docarion live-scribe speech recognition on Modal (hackathon plan: Meta MMS-1B).

    modal deploy backend/modal/modal_mms_asr_app.py

Endpoints (POST JSON, header X-Docarion-Key must match the Modal secret
`docarion-asr` key ASR_SHARED_SECRET):
    transcribe:  {"audio_base64": "...", "language": "en|pcm|ha|yo|ig|english|pidgin|...",
                  "speaker": "SPEAKER_DOCTOR" (optional)}
              -> {"model": "facebook/mms-1b-all", "language": "eng",
                  "turns": [{"speaker": "...", "transcript": "...", "language": "eng"}]}
    health (GET) -> {"status": "ok"}

The audio is decoded in memory and never written to storage or logged.
Silence returns no turns (never a placeholder transcript).
"""
import base64
import os
import subprocess
from typing import Any, Dict

import modal

MODEL_ID = "facebook/mms-1b-all"
MODEL_DIR = "/models/mms-1b-all"
SAMPLE_RATE = 16_000
MAX_SECONDS = 60
MAX_AUDIO_BYTES = 2 * 1024 * 1024

# Request language -> MMS ISO 639-3 adapter. Unknown values fall back to English.
LANGUAGE_MAP = {
    "en": "eng", "eng": "eng", "english": "eng",
    "pcm": "pcm", "pidgin": "pcm", "naija": "pcm",
    "ha": "hau", "hau": "hau", "hausa": "hau",
    "yo": "yor", "yor": "yor", "yoruba": "yor",
    "ig": "ibo", "ibo": "ibo", "igbo": "ibo",
    "fr": "fra", "fra": "fra", "french": "fra",
}


def download_model() -> None:
    from huggingface_hub import snapshot_download

    snapshot_download(MODEL_ID, local_dir=MODEL_DIR)


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "torch==2.4.1",
        "transformers==4.44.2",
        "huggingface_hub==0.24.6",
        "numpy==1.26.4",
        "fastapi[standard]==0.115.0",
    )
    .run_function(download_model)
)

app = modal.App("docarion-mms-asr")


def decode_to_pcm(audio: bytes):
    """Any container (webm/ogg/wav/mp4) -> mono 16 kHz float32, via ffmpeg pipes."""
    import numpy as np

    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
         "-t", str(MAX_SECONDS), "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1"],
        input=audio, capture_output=True, check=False,
    )
    if proc.returncode != 0:
        raise ValueError("audio could not be decoded")
    return np.frombuffer(proc.stdout, dtype=np.float32)


@app.cls(
    gpu="T4",
    image=image,
    scaledown_window=120,
    timeout=120,
    secrets=[modal.Secret.from_name("docarion-asr")],
)
class MmsAsr:
    @modal.enter()
    def load(self) -> None:
        import torch
        from transformers import AutoProcessor, Wav2Vec2ForCTC

        self.torch = torch
        self.processor = AutoProcessor.from_pretrained(MODEL_DIR)
        self.model = Wav2Vec2ForCTC.from_pretrained(MODEL_DIR).to("cuda").eval()
        self.supported = set(self.processor.tokenizer.vocab.keys())
        self.current = "eng"
        self.processor.tokenizer.set_target_lang("eng")
        self.model.load_adapter("eng")

    def _use_language(self, lang: str) -> str:
        code = LANGUAGE_MAP.get((lang or "").strip().lower(), "eng")
        if code not in self.supported:
            code = "eng"
        if code != self.current:
            self.processor.tokenizer.set_target_lang(code)
            self.model.load_adapter(code)
            self.current = code
        return code

    def _transcribe(self, audio: bytes, language: str) -> Dict[str, Any]:
        import numpy as np

        samples = decode_to_pcm(audio)
        code = self._use_language(language)
        # Silence (or near-silence) is reported as no speech, never invented.
        if samples.size < SAMPLE_RATE // 4 or float(np.sqrt(np.mean(samples ** 2))) < 0.003:
            return {"language": code, "text": ""}
        inputs = self.processor(samples, sampling_rate=SAMPLE_RATE, return_tensors="pt").to("cuda")
        with self.torch.inference_mode():
            logits = self.model(**inputs).logits
        ids = self.torch.argmax(logits, dim=-1)[0]
        text = self.processor.decode(ids).strip()
        return {"language": code, "text": text}

    @modal.method()
    def run(self, audio: bytes, language: str) -> Dict[str, Any]:
        return self._transcribe(audio, language)


@app.function(image=image, secrets=[modal.Secret.from_name("docarion-asr")], timeout=120)
@modal.asgi_app()
def api():
    import hmac

    from fastapi import FastAPI, Header, HTTPException

    web = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    shared = os.environ.get("ASR_SHARED_SECRET", "")

    def check(key: str) -> None:
        if not shared or not hmac.compare_digest(key or "", shared):
            raise HTTPException(status_code=401, detail="unauthorized")

    @web.get("/health")
    def health() -> Dict[str, str]:
        return {"status": "ok", "model": MODEL_ID}

    @web.post("/transcribe")
    def transcribe(item: Dict[str, Any], x_docarion_key: str = Header(default="")) -> Dict[str, Any]:
        check(x_docarion_key)
        raw = str(item.get("audio_base64") or "")
        if "," in raw[:100] and raw.startswith("data:"):
            raw = raw.split(",", 1)[1]
        try:
            audio = base64.b64decode(raw, validate=True)
        except Exception:
            raise HTTPException(status_code=400, detail="audio_base64 is not valid base64")
        if not audio or len(audio) > MAX_AUDIO_BYTES:
            raise HTTPException(status_code=400, detail="audio missing or too large")
        try:
            out = MmsAsr().run.remote(audio, str(item.get("language") or "en"))
        except ValueError:
            raise HTTPException(status_code=400, detail="audio could not be decoded")
        speaker = str(item.get("speaker") or "SPEAKER")[:40]
        turns = [{"speaker": speaker, "transcript": out["text"], "language": out["language"]}] if out["text"] else []
        return {"model": MODEL_ID, "language": out["language"], "turns": turns}

    # The live scribe and call-diarize clients post to /diarize.
    web.add_api_route("/diarize", transcribe, methods=["POST"])
    return web
