from functools import lru_cache
import os
import subprocess
import tempfile
import hashlib
import json
import logging
import threading
import time
import uuid
import re
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi import Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


CACHE_DIR = Path(__file__).resolve().parent / ".cache"
DEFAULT_TRANSLATOR_SCRIPT = Path(__file__).resolve().parent.parent / "translator" / "translate_vtt_zh_deepl_native.py"
TRANSLATOR_SCRIPT = Path(os.getenv("TRANSLATOR_SCRIPT", str(DEFAULT_TRANSLATOR_SCRIPT)))
JOB_TTL_SECONDS = 60 * 60
JOB_MAX_COUNT = 100


class TranslateRequest(BaseModel):
    vtt_text: str = Field(..., min_length=1)
    api_key: str = Field(..., min_length=1)
    provider: str = "deepseek"
    model: str = "deepseek-v4-flash"
    endpoint: str = ""
    target: str = "ZH"
    max_paragraphs: int = 6
    max_chars: int = 1200
    concurrency: int = 96
    rps: float = 0.0
    retries: int = 1
    bilingual: bool = False
    timeout: int | None = None
    reasoning_effort: str | None = None


class TranslateAsyncRequest(TranslateRequest):
    force_refresh: bool = False


app = FastAPI(title="Echo360 Online Subtitle Translator", version="0.1.0")
logger = logging.getLogger("echo360-translator")
PROGRESS_RE = re.compile(r"\[(\d+)/(\d+)\]\s+Translating")
_jobs_lock = threading.Lock()
_jobs: dict[str, dict] = {}
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def private_network_access_middleware(request, call_next):
    if request.method == "OPTIONS" and request.headers.get("access-control-request-private-network") == "true":
        resp = Response(status_code=204)
        origin = request.headers.get("origin", "*")
        req_headers = request.headers.get("access-control-request-headers", "*")
        req_method = request.headers.get("access-control-request-method", "POST")
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
        resp.headers["Access-Control-Allow-Methods"] = req_method
        resp.headers["Access-Control-Allow-Headers"] = req_headers
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
        return resp

    response = await call_next(request)
    if request.headers.get("origin"):
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


def allowed_reasoning_for_model(model: str) -> set[str]:
    m = (model or "").lower()
    if m.startswith("gpt-5.4"):
        return {"none", "low", "medium", "high", "xhigh"}
    if m.startswith("gpt-5"):
        return {"minimal", "low", "medium", "high"}
    if m.startswith("gpt-4.1") or m.startswith("gpt-4o-mini"):
        return {"low"}
    return {"low"}


@lru_cache(maxsize=1)
def get_supported_args() -> set[str]:
    if not TRANSLATOR_SCRIPT.exists():
        return set()
    python_bin = get_translator_python()
    try:
        proc = subprocess.run(
            [python_bin, str(TRANSLATOR_SCRIPT), "--help"],
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception:
        return set()
    text = (proc.stdout or "") + "\n" + (proc.stderr or "")
    supported = set()
    for flag in ("--request-timeout", "--openai-reasoning-effort"):
        if flag in text:
            supported.add(flag)
    return supported


def get_translator_python() -> str:
    configured = os.getenv("TRANSLATOR_PYTHON_BIN", "").strip()
    if configured:
        return configured
    return "python3"


def redact_args(args: list[str]) -> list[str]:
    redacted = []
    hide_next = False
    for arg in args:
        if hide_next:
            redacted.append("***")
            hide_next = False
            continue
        redacted.append(arg)
        if arg == "--key":
            hide_next = True
    return redacted


def build_translator_args(
    input_path: Path,
    out_vtt: Path,
    req: TranslateRequest,
    supported_args: set[str],
    warnings: list[str],
) -> list[str]:
    args = [
        get_translator_python(),
        str(TRANSLATOR_SCRIPT),
        str(input_path),
        "--out",
        str(out_vtt),
        "--key",
        req.api_key,
        "--provider",
        req.provider,
        "--model",
        req.model,
        "--target",
        req.target,
        "--max-paragraphs",
        str(int(req.max_paragraphs)),
        "--max-chars",
        str(int(req.max_chars)),
        "--concurrency",
        str(int(req.concurrency)),
        "--rps",
        str(float(req.rps)),
        "--max-retries",
        str(int(req.retries)),
    ]
    if "--request-timeout" in supported_args:
        args.extend(["--request-timeout", str(float(req.timeout) if req.timeout is not None else 10.0)])
    elif req.timeout is not None:
        warnings.append("translator script does not support --request-timeout, skipped")
    if req.bilingual:
        args.append("--bilingual")
    if req.endpoint:
        args.extend(["--endpoint", req.endpoint])
    if req.reasoning_effort and req.provider == "openai":
        if "--openai-reasoning-effort" in supported_args:
            args.extend(["--openai-reasoning-effort", req.reasoning_effort])
        else:
            warnings.append("translator script does not support --openai-reasoning-effort yet, skipped")
    return args


def build_cache_key(vtt_text: str, req: TranslateRequest) -> str:
    digest_input = {
        "vtt_text": vtt_text,
        "provider": req.provider,
        "model": req.model,
        "endpoint": req.endpoint,
        "target": req.target,
        "max_paragraphs": req.max_paragraphs,
        "max_chars": req.max_chars,
        "bilingual": req.bilingual,
        "reasoning_effort": req.reasoning_effort,
    }
    raw = json.dumps(digest_input, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def run_translation(
    vtt_text: str,
    req: TranslateRequest,
    force_refresh: bool = False,
    progress_callback=None,
) -> tuple[str, list[str], bool]:
    warnings: list[str] = []
    if req.reasoning_effort and req.provider == "openai":
        allowed = allowed_reasoning_for_model(req.model)
        if req.reasoning_effort not in allowed:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"reasoning_effort '{req.reasoning_effort}' is not allowed for model '{req.model}'. "
                    f"allowed={sorted(allowed)}"
                ),
            )
    cache_key = build_cache_key(vtt_text, req)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{cache_key}.vtt"
    if cache_file.exists() and not force_refresh:
        return cache_file.read_text(encoding="utf-8"), warnings, True

    supported_args = get_supported_args()
    with tempfile.TemporaryDirectory(prefix="echo360-vtt-") as tmpdir:
        tmp = Path(tmpdir)
        input_path = tmp / "input.vtt"
        out_vtt = tmp / "translated.vtt"
        input_path.write_text(vtt_text, encoding="utf-8")

        args = build_translator_args(input_path, out_vtt, req, supported_args, warnings)
        logger.info("translator command: %s", " ".join(redact_args(args)))
        try:
            proc = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            output_lines: list[str] = []
            assert proc.stdout is not None
            for line in proc.stdout:
                line = line.rstrip("\n")
                output_lines.append(line)
                logger.info("[translator] %s", line)
                match = PROGRESS_RE.search(line)
                if match and progress_callback:
                    progress_callback(int(match.group(1)), int(match.group(2)), line)
            return_code = proc.wait()
            if return_code != 0:
                logger.error("translator failed, returncode=%s", return_code)
                tail = "\n".join(output_lines[-30:]).strip()
                detail = tail or "translator command failed"
                raise HTTPException(status_code=500, detail=detail[:1000])
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("translator execution error")
            raise HTTPException(status_code=500, detail=str(exc)[:1000]) from exc

        if not out_vtt.exists():
            raise HTTPException(status_code=500, detail="translator did not output translated VTT")
        translated_vtt = out_vtt.read_text(encoding="utf-8")
        cache_file.write_text(translated_vtt, encoding="utf-8")
        return translated_vtt, warnings, False


def cleanup_jobs_locked(now: int | None = None) -> None:
    now = now or int(time.time())
    removable_statuses = {"completed", "failed"}
    for job_id, job in list(_jobs.items()):
        if job.get("status") in removable_statuses and now - int(job.get("updated_at", now)) > JOB_TTL_SECONDS:
            del _jobs[job_id]
    overflow = len(_jobs) - JOB_MAX_COUNT
    if overflow <= 0:
        return
    completed = sorted(
        (
            (int(job.get("updated_at", now)), job_id)
            for job_id, job in _jobs.items()
            if job.get("status") in removable_statuses
        )
    )
    for _, job_id in completed[:overflow]:
        _jobs.pop(job_id, None)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/translate")
def translate(req: TranslateRequest) -> dict:
    translated_vtt, warnings, cache_hit = run_translation(req.vtt_text, req)
    return {"translated_vtt": translated_vtt, "warnings": warnings, "cache_hit": cache_hit}


def _run_job(job_id: str, req: TranslateAsyncRequest) -> None:
    def on_progress(current: int, total: int, line: str) -> None:
        with _jobs_lock:
            job = _jobs.get(job_id)
            if not job:
                return
            job["status"] = "running"
            job["progress"] = {"current": current, "total": total, "line": line}
            job["updated_at"] = int(time.time())

    try:
        translated_vtt, warnings, cache_hit = run_translation(
            req.vtt_text,
            req,
            force_refresh=req.force_refresh,
            progress_callback=on_progress,
        )
        with _jobs_lock:
            job = _jobs.get(job_id)
            if not job:
                return
            job["status"] = "completed"
            job["result"] = {
                "translated_vtt": translated_vtt,
                "warnings": warnings,
                "cache_hit": cache_hit,
            }
            job["updated_at"] = int(time.time())
    except Exception as exc:
        with _jobs_lock:
            job = _jobs.get(job_id)
            if not job:
                return
            job["status"] = "failed"
            job["error"] = str(exc)
            job["updated_at"] = int(time.time())


@app.post("/translate-async")
def translate_async(req: TranslateAsyncRequest) -> dict:
    job_id = uuid.uuid4().hex
    with _jobs_lock:
        cleanup_jobs_locked()
        _jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "progress": {"current": 0, "total": 0, "line": ""},
            "result": None,
            "error": "",
            "created_at": int(time.time()),
            "updated_at": int(time.time()),
        }
    worker = threading.Thread(target=_run_job, args=(job_id, req), daemon=True)
    worker.start()
    return {"job_id": job_id}


@app.get("/translate-async/{job_id}")
def translate_async_status(job_id: str) -> dict:
    with _jobs_lock:
        cleanup_jobs_locked()
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="job not found")
        return job
