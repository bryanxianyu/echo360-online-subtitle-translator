#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VTT subtitle translator.

Supports providers:
- deepl
- openai (Responses API)
- deepseek (OpenAI-compatible Responses API)
- gemini (Gemini generateContent API)
"""

import argparse
import concurrent.futures
import json
import re
import sys
import time
from pathlib import Path
from typing import Callable, List

import requests

DEEPL_DEFAULT_CHUNK_SIZE = 160
DEEPL_DEFAULT_CONCURRENCY = 1
DEEPL_DEFAULT_MAX_RETRIES = 2

OPENAI_DEFAULT_CHUNK_SIZE = 5
OPENAI_DEFAULT_CONCURRENCY = 96
OPENAI_DEFAULT_MAX_RETRIES = 1
OPENAI_DEFAULT_MAX_CHARS = 1200
OPENAI_DEFAULT_MAX_PARAGRAPHS = 6
OPENAI_DEFAULT_MODEL = "gpt-5-nano"
OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses"
OPENAI_REASONING_EFFORT_CHOICES = {"none", "minimal", "low", "medium", "high", "xhigh"}

DEEPSEEK_DEFAULT_CHUNK_SIZE = 5
DEEPSEEK_DEFAULT_CONCURRENCY = 96
DEEPSEEK_DEFAULT_MAX_RETRIES = 1
DEEPSEEK_DEFAULT_MAX_CHARS = 1200
DEEPSEEK_DEFAULT_MAX_PARAGRAPHS = 6
DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash"
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_CHAT_COMPLETIONS_ENDPOINT = f"{DEEPSEEK_BASE_URL}/chat/completions"

GEMINI_DEFAULT_CHUNK_SIZE = 5
GEMINI_DEFAULT_CONCURRENCY = 96
GEMINI_DEFAULT_MAX_RETRIES = 1
GEMINI_DEFAULT_MAX_CHARS = 1200
GEMINI_DEFAULT_MAX_PARAGRAPHS = 6
GEMINI_DEFAULT_MODEL = "gemini-2.5-flash-lite"
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

AI_LINE_SEPARATOR = "\n<<<VTT_TRANSLATOR_LINE_BREAK_8F3B>>>\n"

TIMECODE_RE = re.compile(r"^\s*\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}")
WEBVTT_RE = re.compile(r"^\s*WEBVTT", re.IGNORECASE)
INDEX_RE = re.compile(r"^\s*\d+\s*$")
VOICE_TAG_RE = re.compile(r"^(?P<prefix>\s*<v\b[^>]*>)(?P<body>.*?)(?P<suffix>\s*</v>\s*)?$")


def is_timecode(line: str) -> bool:
    return bool(TIMECODE_RE.match(line))


def is_header(line: str) -> bool:
    return bool(WEBVTT_RE.match(line))


def is_index(line: str) -> bool:
    return bool(INDEX_RE.match(line))


def should_translate(line: str) -> bool:
    if not line.strip():
        return False
    if is_header(line) or is_index(line) or is_timecode(line):
        return False
    if line.strip().startswith(("NOTE", "STYLE", "REGION")):
        return False
    return True


def read_text(path: Path) -> List[str]:
    try:
        return path.read_text(encoding="utf-8").splitlines(keepends=False)
    except UnicodeDecodeError:
        try:
            import chardet

            raw = path.read_bytes()
            enc = chardet.detect(raw).get("encoding") or "utf-8"
            return raw.decode(enc, errors="replace").splitlines(keepends=False)
        except Exception:
            return path.read_text(encoding="utf-8", errors="replace").splitlines(keepends=False)


def batch_indices(total: int, batch_size: int):
    start = 0
    while start < total:
        end = min(start + batch_size, total)
        yield start, end
        start = end


def build_text_batches(
    lines: List[str],
    translatable_idx: list[int],
    chunk_size: int,
    max_chars: int = 0,
    max_paragraphs: int = 0,
    text_for_len: dict[int, str] | None = None,
) -> list[tuple[int, int, list[int]]]:
    if max_chars <= 0 and max_paragraphs <= 0:
        return [
            (start, end, translatable_idx[start:end])
            for start, end in batch_indices(len(translatable_idx), chunk_size)
        ]

    batches: list[tuple[int, int, list[int]]] = []
    current_ids: list[int] = []
    current_chars = 0
    start_ord = 0

    for ordinal, line_idx in enumerate(translatable_idx):
        text_len = len(text_for_len.get(line_idx, lines[line_idx]) if text_for_len else lines[line_idx])
        would_exceed_chars = max_chars > 0 and current_ids and (current_chars + text_len > max_chars)
        would_exceed_paragraphs = max_paragraphs > 0 and len(current_ids) >= max_paragraphs
        if would_exceed_chars or would_exceed_paragraphs:
            batches.append((start_ord, ordinal, current_ids))
            current_ids = []
            current_chars = 0
            start_ord = ordinal

        current_ids.append(line_idx)
        current_chars += text_len

    if current_ids:
        batches.append((start_ord, len(translatable_idx), current_ids))

    return batches


def provider_defaults(provider: str) -> dict[str, int | str]:
    provider_name = (provider or "deepl").strip().lower()
    if provider_name == "openai":
        return {
            "chunk": OPENAI_DEFAULT_CHUNK_SIZE,
            "concurrency": OPENAI_DEFAULT_CONCURRENCY,
            "max_chars": OPENAI_DEFAULT_MAX_CHARS,
            "max_paragraphs": OPENAI_DEFAULT_MAX_PARAGRAPHS,
            "max_retries": OPENAI_DEFAULT_MAX_RETRIES,
            "endpoint": OPENAI_RESPONSES_ENDPOINT,
            "model": OPENAI_DEFAULT_MODEL,
        }
    if provider_name == "deepseek":
        return {
            "chunk": DEEPSEEK_DEFAULT_CHUNK_SIZE,
            "concurrency": DEEPSEEK_DEFAULT_CONCURRENCY,
            "max_chars": DEEPSEEK_DEFAULT_MAX_CHARS,
            "max_paragraphs": DEEPSEEK_DEFAULT_MAX_PARAGRAPHS,
            "max_retries": DEEPSEEK_DEFAULT_MAX_RETRIES,
            "endpoint": DEEPSEEK_CHAT_COMPLETIONS_ENDPOINT,
            "model": DEEPSEEK_DEFAULT_MODEL,
        }
    if provider_name == "gemini":
        return {
            "chunk": GEMINI_DEFAULT_CHUNK_SIZE,
            "concurrency": GEMINI_DEFAULT_CONCURRENCY,
            "max_chars": GEMINI_DEFAULT_MAX_CHARS,
            "max_paragraphs": GEMINI_DEFAULT_MAX_PARAGRAPHS,
            "max_retries": GEMINI_DEFAULT_MAX_RETRIES,
            "endpoint": GEMINI_BASE_URL,
            "model": GEMINI_DEFAULT_MODEL,
        }
    return {
        "chunk": DEEPL_DEFAULT_CHUNK_SIZE,
        "concurrency": DEEPL_DEFAULT_CONCURRENCY,
        "max_retries": DEEPL_DEFAULT_MAX_RETRIES,
        "endpoint": "https://api-free.deepl.com/v2/translate",
        "model": "",
    }


def normalize_openai_compatible_endpoint(endpoint: str, provider: str) -> str:
    ep = (endpoint or "").strip()
    if not ep:
        return OPENAI_RESPONSES_ENDPOINT if provider == "openai" else DEEPSEEK_CHAT_COMPLETIONS_ENDPOINT

    if provider == "deepseek" and ep.startswith("https://api.deepseek.com"):
        if ep.endswith("/chat/completions") or ep.endswith("/v1/chat/completions"):
            return ep
        return DEEPSEEK_CHAT_COMPLETIONS_ENDPOINT

    if ep.endswith("/v1/responses"):
        return ep

    if provider == "openai" and ep.startswith("https://api.openai.com"):
        return ep.rstrip("/") + "/v1/responses"

    return ep


def normalize_gemini_endpoint(endpoint: str, model: str) -> str:
    ep = (endpoint or GEMINI_BASE_URL).strip().rstrip("/")
    if ep.endswith(":generateContent"):
        return ep
    if "/models/" in ep:
        return f"{ep}:generateContent"
    return f"{ep}/models/{model}:generateContent"


def split_voice_tag(line: str) -> tuple[str, str, str]:
    match = VOICE_TAG_RE.match(line)
    if not match:
        return "", line.strip(), ""
    return match.group("prefix") or "", (match.group("body") or "").strip(), match.group("suffix") or ""


def deepl_translate_batch(
    texts: List[str],
    endpoint: str,
    api_key: str,
    target_lang: str,
    formality: str = None,
    max_retries: int = 4,
    base_delay: float = 1.0,
    request_timeout: float = 90.0,
) -> List[str]:
    params = [("text", t) for t in texts]
    data = {
        "target_lang": target_lang,
        "preserve_formatting": "1",
        "split_sentences": "1",
    }
    if formality:
        data["formality"] = formality
    headers = {"Authorization": f"DeepL-Auth-Key {api_key}"}
    req_data = params + list(data.items())

    attempt = 0
    while True:
        try:
            resp = requests.post(endpoint, data=req_data, headers=headers, timeout=request_timeout)
            if resp.status_code == 200:
                j = resp.json()
                return [item.get("text", "") for item in j.get("translations", [])]
            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:500]}")
        except Exception:
            if attempt >= max_retries:
                raise
            attempt += 1
            time.sleep(base_delay * attempt)


def _extract_responses_output_text(resp_json: dict) -> str:
    text = resp_json.get("output_text")
    if isinstance(text, str) and text.strip():
        return text

    output = resp_json.get("output", [])
    if isinstance(output, list):
        chunks = []
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content", [])
            if not isinstance(content, list):
                continue
            for c in content:
                if isinstance(c, dict) and c.get("type") == "output_text":
                    t = c.get("text")
                    if isinstance(t, str):
                        chunks.append(t)
        joined = "".join(chunks).strip()
        if joined:
            return joined

    raise RuntimeError("OpenAI-compatible response missing output_text")


def _strip_code_fence(raw_text: str) -> str:
    text = raw_text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text


def _parse_indexed_json_text(raw_text: str, expected_len: int) -> dict[int, str]:
    text = _strip_code_fence(raw_text)
    parsed = json.loads(text)
    if not isinstance(parsed, list):
        raise RuntimeError("Model output is not a JSON array")

    out: dict[int, str] = {}
    for item in parsed:
        if not isinstance(item, dict):
            continue
        idx = item.get("i")
        val = item.get("text")
        if isinstance(idx, int) and 0 <= idx < expected_len and isinstance(val, str):
            out[idx] = val
    return out


def _build_delimited_prompt(texts: List[str], target_lang: str) -> tuple[str, str]:
    system_text = (
        f"You are a professional {target_lang} native translator who needs to fluently translate text into {target_lang}.\n\n"
        "## Translation Rules\n"
        "1. Output only translated content, with no explanations or extra text.\n"
        "2. Keep exactly the same number of paragraphs/items as input.\n"
        "3. Keep non-translatable content unchanged (proper nouns, code, URLs, course codes).\n"
        "4. Do not merge, split, drop, or reorder any item.\n"
        "5. If input uses the separator token, output must use the same separator token.\n\n"
        "## OUTPUT FORMAT\n"
        "- Single item input: output only one translated item.\n"
        f"- Multi-item input: use '{AI_LINE_SEPARATOR.strip()}' as the separator between translated items."
    )
    user_text = (
        f"Translate to {target_lang}. Return only translation text with exact item count and order.\n"
        "Input:\n"
        f"{AI_LINE_SEPARATOR.join(texts)}"
    )
    return system_text, user_text


def _build_indexed_json_prompt(texts: List[str], target_lang: str) -> tuple[str, str]:
    payload = [{"i": i, "text": t} for i, t in enumerate(texts)]
    system_text = (
        "You are a subtitle translation engine. Output ONLY a JSON array. "
        "Each item must be an object with keys i and text. "
        "Do not drop, merge, reorder, or add items."
    )
    user_text = (
        f"Translate each text to {target_lang}. Keep indexes unchanged.\n"
        f"Input JSON:\n{json.dumps(payload, ensure_ascii=False)}\n"
        "Return JSON array only."
    )
    return system_text, user_text


def _parse_delimited_output(raw_text: str, expected_len: int) -> List[str]:
    text = _strip_code_fence(raw_text).strip()
    parts = [part.strip() for part in text.split(AI_LINE_SEPARATOR)]
    if len(parts) != expected_len:
        compact_separator = AI_LINE_SEPARATOR.strip()
        parts = [part.strip() for part in text.split(compact_separator)]
    if len(parts) != expected_len:
        raise RuntimeError(f"AI output length mismatch: expected {expected_len}, got {len(parts)}")
    return parts


def _openai_call_responses(
    payload: dict,
    api_key: str,
    endpoint: str,
    max_retries: int,
    base_delay: float,
    request_timeout: float,
) -> str:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    attempt = 0
    while True:
        try:
            resp = requests.post(endpoint, json=payload, headers=headers, timeout=request_timeout)
            if resp.status_code == 200:
                return _extract_responses_output_text(resp.json())
            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:500]}")
        except Exception:
            if attempt >= max_retries:
                raise
            attempt += 1
            time.sleep(base_delay * attempt)


def _resolve_openai_reasoning_effort(model: str, requested_effort: str) -> str:
    model_lower = (model or "").strip().lower()
    effort = (requested_effort or "low").strip().lower()
    if effort not in OPENAI_REASONING_EFFORT_CHOICES:
        effort = "low"

    # gpt-5.4 family supports none/low/medium/high/xhigh.
    if model_lower.startswith("gpt-5.4"):
        return effort if effort in {"none", "low", "medium", "high", "xhigh"} else "low"
    # gpt-5-nano family supports minimal/low/medium/high.
    if model_lower.startswith("gpt-5"):
        return effort if effort in {"minimal", "low", "medium", "high"} else "low"
    # non GPT-5 models in this tool use low as the only exposed option.
    return "low"


def _openai_call_chat_completions(
    payload: dict,
    api_key: str,
    endpoint: str,
    max_retries: int,
    base_delay: float,
    request_timeout: float,
) -> str:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    attempt = 0
    while True:
        try:
            resp = requests.post(endpoint, json=payload, headers=headers, timeout=request_timeout)
            if resp.status_code == 200:
                data = resp.json()
                choices = data.get("choices", [])
                if isinstance(choices, list) and choices:
                    message = choices[0].get("message", {})
                    content = message.get("content")
                    if isinstance(content, str) and content.strip():
                        return content
                raise RuntimeError("DeepSeek chat response missing choices[0].message.content")
            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:500]}")
        except Exception:
            if attempt >= max_retries:
                raise
            attempt += 1
            time.sleep(base_delay * attempt)


def _gemini_call_generate_content(
    payload: dict,
    api_key: str,
    endpoint: str,
    max_retries: int,
    base_delay: float,
    request_timeout: float,
) -> str:
    headers = {
        "x-goog-api-key": api_key,
        "Content-Type": "application/json",
    }
    attempt = 0
    while True:
        try:
            resp = requests.post(endpoint, json=payload, headers=headers, timeout=request_timeout)
            if resp.status_code == 200:
                data = resp.json()
                candidates = data.get("candidates", [])
                if isinstance(candidates, list) and candidates:
                    parts = candidates[0].get("content", {}).get("parts", [])
                    text = "".join(part.get("text", "") for part in parts if isinstance(part, dict)).strip()
                    if text:
                        return text
                raise RuntimeError("Gemini response missing candidates[0].content.parts text")
            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:500]}")
        except Exception:
            if attempt >= max_retries:
                raise
            attempt += 1
            time.sleep(base_delay * attempt)


def openai_translate_batch(
    texts: List[str],
    api_key: str,
    target_lang: str,
    model: str = OPENAI_DEFAULT_MODEL,
    endpoint: str = OPENAI_RESPONSES_ENDPOINT,
    max_retries: int = OPENAI_DEFAULT_MAX_RETRIES,
    base_delay: float = 1.0,
    strict_json_fallback: bool = True,
    request_timeout: float = 90.0,
    openai_reasoning_effort: str = "low",
) -> List[str]:
    def call(system_text: str, user_text: str) -> str:
        payload = {
            "model": model,
            "input": [
                {
                    "role": "system",
                    "content": [{"type": "input_text", "text": system_text}],
                },
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": user_text}],
                },
            ],
        }
        resolved_reasoning_effort = _resolve_openai_reasoning_effort(model, openai_reasoning_effort)
        if resolved_reasoning_effort:
            payload["reasoning"] = {"effort": resolved_reasoning_effort}
        return _openai_call_responses(
            payload=payload,
            api_key=api_key,
            endpoint=endpoint,
            max_retries=max_retries,
            base_delay=base_delay,
            request_timeout=request_timeout,
        )

    system_text, user_text = _build_delimited_prompt(texts, target_lang)
    raw = call(system_text, user_text)
    try:
        return _parse_delimited_output(raw, expected_len=len(texts))
    except Exception:
        if not strict_json_fallback:
            raise
        print(f"[fallback] openai batch size={len(texts)} -> indexed-json retry", file=sys.stderr)
        system_text, user_text = _build_indexed_json_prompt(texts, target_lang)
        raw = call(system_text, user_text)
        parsed = _parse_indexed_json_text(raw, expected_len=len(texts))
        if len(parsed) != len(texts):
            raise RuntimeError(f"AI output length mismatch: expected {len(texts)}, got {len(parsed)}")
        return [parsed[i].strip() for i in range(len(texts))]


def deepseek_translate_batch(
    texts: List[str],
    api_key: str,
    target_lang: str,
    model: str = DEEPSEEK_DEFAULT_MODEL,
    endpoint: str = DEEPSEEK_CHAT_COMPLETIONS_ENDPOINT,
    max_retries: int = DEEPSEEK_DEFAULT_MAX_RETRIES,
    base_delay: float = 1.0,
    strict_json_fallback: bool = True,
    request_timeout: float = 90.0,
    no_thinking: bool = True,
) -> List[str]:
    def call(system_text: str, user_text: str) -> str:
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_text},
                {"role": "user", "content": user_text},
            ],
            "temperature": 0,
        }
        if no_thinking:
            payload["thinking"] = {"type": "disabled"}
        return _openai_call_chat_completions(
            payload=payload,
            api_key=api_key,
            endpoint=endpoint,
            max_retries=max_retries,
            base_delay=base_delay,
            request_timeout=request_timeout,
        )

    system_text, user_text = _build_delimited_prompt(texts, target_lang)
    raw = call(system_text, user_text)
    try:
        return _parse_delimited_output(raw, expected_len=len(texts))
    except Exception:
        if not strict_json_fallback:
            raise
        print(f"[fallback] deepseek batch size={len(texts)} -> indexed-json retry", file=sys.stderr)
        system_text, user_text = _build_indexed_json_prompt(texts, target_lang)
        raw = call(system_text, user_text)
        parsed = _parse_indexed_json_text(raw, expected_len=len(texts))
        if len(parsed) != len(texts):
            raise RuntimeError(f"AI output length mismatch: expected {len(texts)}, got {len(parsed)}")
        return [parsed[i].strip() for i in range(len(texts))]


def gemini_translate_batch(
    texts: List[str],
    api_key: str,
    target_lang: str,
    model: str = GEMINI_DEFAULT_MODEL,
    endpoint: str = GEMINI_BASE_URL,
    max_retries: int = GEMINI_DEFAULT_MAX_RETRIES,
    base_delay: float = 1.0,
    strict_json_fallback: bool = True,
    request_timeout: float = 90.0,
) -> List[str]:
    def call(system_text: str, user_text: str) -> str:
        payload = {
            "systemInstruction": {"parts": [{"text": system_text}]},
            "contents": [{"role": "user", "parts": [{"text": user_text}]}],
            "generationConfig": {"temperature": 0},
        }
        return _gemini_call_generate_content(
            payload=payload,
            api_key=api_key,
            endpoint=normalize_gemini_endpoint(endpoint, model),
            max_retries=max_retries,
            base_delay=base_delay,
            request_timeout=request_timeout,
        )

    system_text, user_text = _build_delimited_prompt(texts, target_lang)
    raw = call(system_text, user_text)
    try:
        return _parse_delimited_output(raw, expected_len=len(texts))
    except Exception:
        if not strict_json_fallback:
            raise
        print(f"[fallback] gemini batch size={len(texts)} -> indexed-json retry", file=sys.stderr)
        system_text, user_text = _build_indexed_json_prompt(texts, target_lang)
        raw = call(system_text, user_text)
        parsed = _parse_indexed_json_text(raw, expected_len=len(texts))
        if len(parsed) != len(texts):
            raise RuntimeError(f"AI output length mismatch: expected {len(texts)}, got {len(parsed)}")
        return [parsed[i].strip() for i in range(len(texts))]


def translate_lines_native(
    lines: List[str],
    api_key: str,
    provider: str = "deepl",
    endpoint: str = "https://api-free.deepl.com/v2/translate",
    target_lang: str = "ZH",
    model: str = OPENAI_DEFAULT_MODEL,
    bilingual: bool = False,
    every: int = 10,
    chunk: int = DEEPL_DEFAULT_CHUNK_SIZE,
    concurrency: int = 1,
    max_chars: int = 0,
    max_paragraphs: int = 0,
    rps: float = 0,
    max_retries: int = DEEPL_DEFAULT_MAX_RETRIES,
    progress_callback: Callable[[int, int], None] | None = None,
    stop_check: Callable[[], bool] | None = None,
    batch_error_callback: Callable[[int, int, str], None] | None = None,
    log_progress: bool = True,
    debug_progress: bool = False,
    fallback_mode: str = "immediate",
    request_timeout: float = 90.0,
    slow_split_threshold: float = 0.0,
    repair_concurrency: int = 1,
    no_thinking: bool = True,
    openai_reasoning_effort: str = "low",
) -> List[str]:
    provider_name = (provider or "deepl").strip().lower()
    if provider_name not in {"deepl", "openai", "deepseek", "gemini"}:
        raise ValueError(f"Unsupported provider: {provider_name}")

    translatable_idx = [i for i, ln in enumerate(lines) if should_translate(ln)]
    line_parts = {i: split_voice_tag(lines[i]) for i in translatable_idx}
    source_texts = {i: line_parts[i][1] for i in translatable_idx}
    total = len(translatable_idx)
    out_lines = list(lines)
    batches = build_text_batches(
        lines,
        translatable_idx,
        chunk_size=max(1, chunk),
        max_chars=max(0, max_chars),
        max_paragraphs=max(0, max_paragraphs),
        text_for_len=source_texts,
    )
    workers = max(1, min(int(concurrency or 1), len(batches) or 1))
    fallback_mode = (fallback_mode or "immediate").strip().lower()
    if fallback_mode not in {"immediate", "deferred", "deferred-fastpath"}:
        raise ValueError(f"Unsupported fallback_mode: {fallback_mode}")
    if repair_concurrency < 1:
        repair_concurrency = 1
    fastpath_only_main = fallback_mode == "deferred-fastpath"
    def dbg(msg: str):
        if not debug_progress:
            return
        print(f"[debug] {msg}", flush=True)

    def translate_batch_with_provider(batch_texts: list[str]) -> list[str]:
        if provider_name == "deepl":
            return deepl_translate_batch(
                batch_texts,
                endpoint=endpoint,
                api_key=api_key,
                target_lang=target_lang,
                max_retries=max_retries,
                request_timeout=request_timeout,
            )
        if provider_name == "openai":
            return openai_translate_batch(
                batch_texts,
                api_key=api_key,
                target_lang=target_lang,
                model=model,
                endpoint=normalize_openai_compatible_endpoint(endpoint, provider_name),
                max_retries=max_retries,
                strict_json_fallback=not fastpath_only_main,
                request_timeout=request_timeout,
                openai_reasoning_effort=openai_reasoning_effort,
            )
        if provider_name == "deepseek":
            return deepseek_translate_batch(
                batch_texts,
                api_key=api_key,
                target_lang=target_lang,
                model=model,
                endpoint=normalize_openai_compatible_endpoint(endpoint, provider_name),
                max_retries=max_retries,
                strict_json_fallback=not fastpath_only_main,
                request_timeout=request_timeout,
                no_thinking=no_thinking,
            )
        return gemini_translate_batch(
            batch_texts,
            api_key=api_key,
            target_lang=target_lang,
            model=model,
            endpoint=endpoint,
            max_retries=max_retries,
            strict_json_fallback=not fastpath_only_main,
            request_timeout=request_timeout,
        )

    def translate_batch_with_provider_strict(batch_texts: list[str]) -> list[str]:
        if provider_name == "deepl":
            return deepl_translate_batch(
                batch_texts,
                endpoint=endpoint,
                api_key=api_key,
                target_lang=target_lang,
                max_retries=max_retries,
            )
        if provider_name == "openai":
            return openai_translate_batch(
                batch_texts,
                api_key=api_key,
                target_lang=target_lang,
                model=model,
                endpoint=normalize_openai_compatible_endpoint(endpoint, provider_name),
                max_retries=max_retries,
                strict_json_fallback=True,
                request_timeout=request_timeout,
                openai_reasoning_effort=openai_reasoning_effort,
            )
        if provider_name == "deepseek":
            return deepseek_translate_batch(
                batch_texts,
                api_key=api_key,
                target_lang=target_lang,
                model=model,
                endpoint=normalize_openai_compatible_endpoint(endpoint, provider_name),
                max_retries=max_retries,
                strict_json_fallback=True,
                request_timeout=request_timeout,
                no_thinking=no_thinking,
            )
        return gemini_translate_batch(
            batch_texts,
            api_key=api_key,
            target_lang=target_lang,
            model=model,
            endpoint=endpoint,
            max_retries=max_retries,
            strict_json_fallback=True,
            request_timeout=request_timeout,
        )

    def translate_batch_recursive(batch_texts: list[str]) -> tuple[list[str], bool, str | None]:
        try:
            t0 = time.perf_counter()
            translated = translate_batch_with_provider(batch_texts)
            elapsed = time.perf_counter() - t0
            if (
                provider_name in {"openai", "deepseek", "gemini"}
                and slow_split_threshold > 0
                and len(batch_texts) > 1
                and elapsed > slow_split_threshold
            ):
                raise RuntimeError(
                    f"slow batch {elapsed:.3f}s>{slow_split_threshold:.3f}s, split retry"
                )
            return translated, False, None
        except Exception as e:
            # For AI providers, split-fallback improves strict-mode completion rate.
            if provider_name in {"openai", "deepseek", "gemini"} and len(batch_texts) > 1:
                mid = len(batch_texts) // 2
                left, left_failed, left_err = translate_batch_recursive(batch_texts[:mid])
                right, right_failed, right_err = translate_batch_recursive(batch_texts[mid:])
                combined_err = "; ".join(err for err in [left_err, right_err] if err)
                if left and right and len(left) + len(right) == len(batch_texts):
                    recovered_with_fallback = left_failed or right_failed
                    return left + right, recovered_with_fallback, combined_err
            if provider_name in {"openai", "deepseek", "gemini"} and len(batch_texts) == 1:
                # Keep progress by isolating hard failures to a single line.
                return [batch_texts[0]], True, str(e)
            raise

    def translate_batch(
        bstart: int, bend: int, batch_ids: list[int]
    ) -> tuple[int, int, list[int], list[str], bool, str | None, bool]:
        batch_texts = [source_texts[i] for i in batch_ids]
        t0 = time.perf_counter()
        dbg(f"batch start {bstart+1}-{bend} size={len(batch_ids)}")
        if fallback_mode in {"deferred", "deferred-fastpath"}:
            try:
                translated = translate_batch_with_provider(batch_texts)
                dbg(
                    f"batch done {bstart+1}-{bend} size={len(batch_ids)} "
                    f"elapsed={time.perf_counter()-t0:.3f}s fallback=False"
                )
                return bstart, bend, batch_ids, translated, False, None, False
            except Exception as e:
                dbg(
                    f"batch defer {bstart+1}-{bend} size={len(batch_ids)} "
                    f"elapsed={time.perf_counter()-t0:.3f}s err={str(e)[:120]}"
                )
                return bstart, bend, batch_ids, batch_texts, False, str(e), True
        try:
            translated, had_fallback, warn_text = translate_batch_recursive(batch_texts)
            dbg(
                f"batch done {bstart+1}-{bend} size={len(batch_ids)} "
                f"elapsed={time.perf_counter()-t0:.3f}s fallback={had_fallback}"
            )
            return bstart, bend, batch_ids, translated, had_fallback, warn_text, False
        except Exception as e:
            dbg(
                f"batch fail {bstart+1}-{bend} size={len(batch_ids)} "
                f"elapsed={time.perf_counter()-t0:.3f}s err={str(e)[:120]}"
            )
            return bstart, bend, batch_ids, batch_texts, True, str(e), False

    def apply_batch_result(
        bstart: int,
        bend: int,
        batch_ids: list[int],
        translated: list[str],
        had_fallback: bool,
        error_text: str | None,
        deferred_only: bool,
    ) -> int:
        if deferred_only:
            return len(batch_ids)
        if had_fallback:
            print(f"WARNING: {provider_name} batch failed ({bstart+1}-{bend}): {error_text or 'unknown error'}", file=sys.stderr)
            if batch_error_callback:
                batch_error_callback(bstart + 1, bend, error_text)

        for idx_in_batch, line_idx in enumerate(batch_ids):
            prefix, _body, suffix = line_parts[line_idx]
            if bilingual:
                out_lines[line_idx] = lines[line_idx] + "\n" + f"{prefix}{translated[idx_in_batch]}{suffix}"
            else:
                if prefix or suffix:
                    out_lines[line_idx] = f"{prefix}{translated[idx_in_batch]}{suffix}"
                else:
                    out_lines[line_idx] = translated[idx_in_batch]

        return len(batch_ids)

    completed = 0
    deferred_failures: list[tuple[int, int, list[int], str]] = []

    if workers == 1:
        for bstart, bend, batch_ids in batches:
            if stop_check and not stop_check():
                break

            result = translate_batch(bstart, bend, batch_ids)
            _bstart, _bend, _batch_ids, _translated, _had_fallback, _err_text, _deferred = result
            if _deferred:
                deferred_failures.append((_bstart, _bend, _batch_ids, _err_text or "unknown error"))
            else:
                completed += apply_batch_result(*result)

            if progress_callback:
                progress_callback(completed, total)
            if log_progress and ((completed == total) or (completed % every == 0) or (bstart == 0)):
                print(f"[{completed}/{total}] Translating...", flush=True)

        return out_lines

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        future_to_batch = {}
        next_submit_at = time.perf_counter()
        submit_interval = (1.0 / rps) if rps and rps > 0 else 0.0
        for bstart, bend, batch_ids in batches:
            if stop_check and not stop_check():
                break
            if submit_interval > 0:
                sleep_for = next_submit_at - time.perf_counter()
                if sleep_for > 0:
                    time.sleep(sleep_for)
                next_submit_at = max(next_submit_at + submit_interval, time.perf_counter())
            future = executor.submit(translate_batch, bstart, bend, batch_ids)
            future_to_batch[future] = (bstart, bend)

        for future in concurrent.futures.as_completed(future_to_batch):
            if stop_check and not stop_check():
                break
            result = future.result()
            _bstart, _bend, _batch_ids, _translated, _had_fallback, _err_text, _deferred = result
            if _deferred:
                deferred_failures.append((_bstart, _bend, _batch_ids, _err_text or "unknown error"))
            else:
                completed += apply_batch_result(*result)

            if progress_callback:
                progress_callback(completed, total)
            if log_progress and ((completed == total) or (completed % every == 0) or completed <= chunk):
                print(f"[{completed}/{total}] Translating...", flush=True)

    if fallback_mode == "deferred" and deferred_failures:
        print(
            f"[repair] deferred fallback phase: {len(deferred_failures)} failed batch(es), "
            f"concurrency={repair_concurrency}",
            flush=True,
        )
        def run_deferred_repair(item: tuple[int, int, list[int], str]) -> tuple[int, int, list[int], list[str], bool, str | None]:
            bstart, bend, batch_ids, err_text = item
            dbg(f"repair start {bstart+1}-{bend} size={len(batch_ids)}")
            batch_texts = [source_texts[i] for i in batch_ids]
            translated, had_fallback, warn_text = translate_batch_recursive(batch_texts)
            dbg(f"repair done {bstart+1}-{bend} size={len(batch_ids)}")
            return bstart, bend, batch_ids, translated, had_fallback, (warn_text or err_text)

        with concurrent.futures.ThreadPoolExecutor(max_workers=repair_concurrency) as repair_executor:
            repair_futures = [repair_executor.submit(run_deferred_repair, item) for item in deferred_failures]
            for future in concurrent.futures.as_completed(repair_futures):
                bstart, bend, batch_ids, translated, had_fallback, err_text = future.result()
                completed += apply_batch_result(
                    bstart,
                    bend,
                    batch_ids,
                    translated,
                    had_fallback,
                    err_text,
                    False,
                )
                if progress_callback:
                    progress_callback(completed, total)
                if log_progress:
                    print(f"[{completed}/{total}] Translating...", flush=True)

    if fallback_mode == "deferred-fastpath" and deferred_failures:
        print(
            f"[repair] deferred-fastpath phase: {len(deferred_failures)} failed batch(es), "
            f"concurrency={repair_concurrency}",
            flush=True,
        )
        def run_fastpath_repair(item: tuple[int, int, list[int], str]) -> tuple[int, int, list[int], list[str], bool, str]:
            bstart, bend, batch_ids, err_text = item
            dbg(f"repair start {bstart+1}-{bend} size={len(batch_ids)}")
            batch_texts = [source_texts[i] for i in batch_ids]
            t0 = time.perf_counter()
            try:
                translated = translate_batch_with_provider_strict(batch_texts)
                dbg(
                    f"repair done {bstart+1}-{bend} size={len(batch_ids)} "
                    f"elapsed={time.perf_counter()-t0:.3f}s strict_json=True"
                )
                return bstart, bend, batch_ids, translated, True, err_text
            except Exception as repair_err:
                dbg(
                    f"repair fail {bstart+1}-{bend} size={len(batch_ids)} "
                    f"elapsed={time.perf_counter()-t0:.3f}s err={str(repair_err)[:120]}"
                )
                return (
                    bstart,
                    bend,
                    batch_ids,
                    [source_texts[i] for i in batch_ids],
                    True,
                    str(repair_err),
                )

        with concurrent.futures.ThreadPoolExecutor(max_workers=repair_concurrency) as repair_executor:
            repair_futures = [repair_executor.submit(run_fastpath_repair, item) for item in deferred_failures]
            for future in concurrent.futures.as_completed(repair_futures):
                bstart, bend, batch_ids, translated, had_fallback, err_text = future.result()
                completed += apply_batch_result(
                    bstart,
                    bend,
                    batch_ids,
                    translated,
                    had_fallback,
                    err_text,
                    False,
                )
                if progress_callback:
                    progress_callback(completed, total)
                if log_progress:
                    print(f"[{completed}/{total}] Translating...", flush=True)

    return out_lines


def main():
    ap = argparse.ArgumentParser(description="Translate VTT using DeepL/OpenAI/DeepSeek API.")
    ap.add_argument("input", help="Path to input .vtt")
    ap.add_argument("--out", required=True, help="Path to output .vtt")
    ap.add_argument("--key", required=True, help="API key for selected provider")
    ap.add_argument(
        "--provider",
        default="deepl",
        choices=["deepl", "openai", "deepseek", "gemini"],
        help="Translation provider",
    )
    ap.add_argument(
        "--endpoint",
        default="https://api-free.deepl.com/v2/translate",
        help="Provider endpoint (DeepL Free/Pro or OpenAI-compatible Responses endpoint)",
    )
    ap.add_argument("--model", default="", help="Model name for openai/deepseek")
    ap.add_argument("--target", default="ZH", help="Target language code (e.g. ZH / EN / JA)")
    ap.add_argument("--bilingual", action="store_true", help="Keep original + translated line")
    ap.add_argument("--every", type=int, default=10, help="Print progress every N lines")
    ap.add_argument("--chunk", type=int, default=None, help="Number of lines per API request")
    ap.add_argument("--concurrency", type=int, default=None, help="Concurrent batches for openai/deepseek/deepl")
    ap.add_argument("--max-chars", type=int, default=None, help="Max characters per AI request; 0 disables char batching")
    ap.add_argument("--max-paragraphs", type=int, default=None, help="Max text lines per AI request; 0 disables paragraph batching")
    ap.add_argument("--rps", type=float, default=0, help="Max request submissions per second; 0 disables rate limiting")
    ap.add_argument("--max-retries", type=int, default=None, help="Max retries per request")
    ap.add_argument("--debug-progress", action="store_true", help="Print per-batch debug timing")
    ap.add_argument("--request-timeout", type=float, default=10.0, help="Per-request timeout in seconds")
    ap.add_argument(
        "--openai-reasoning-effort",
        default="low",
        choices=sorted(OPENAI_REASONING_EFFORT_CHOICES),
        help="OpenAI reasoning effort (default: low)",
    )
    ap.add_argument("--no-thinking", action="store_true", help="DeepSeek only: disable thinking mode")
    ap.add_argument("--with-thinking", action="store_true", help="DeepSeek only: enable thinking mode")
    ap.add_argument(
        "--slow-split-threshold",
        type=float,
        default=0.0,
        help="If a batch takes longer than this threshold (seconds), split and retry for AI providers; 0 disables",
    )
    ap.add_argument(
        "--fallback-mode",
        default="immediate",
        choices=["immediate", "deferred", "deferred-fastpath"],
        help="Mismatch fallback strategy: immediate retry or deferred repair after main pass",
    )
    ap.add_argument(
        "--repair-concurrency",
        type=int,
        default=1,
        help="Concurrency for deferred repair phase; 1 means serial repair",
    )
    args = ap.parse_args()

    in_path = Path(args.input).expanduser().resolve()
    out_path = Path(args.out).expanduser().resolve()
    if not in_path.exists():
        print(f"ERROR: Input not found: {in_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Reading: {in_path}")
    lines = read_text(in_path)

    defaults = provider_defaults(args.provider)
    resolved_endpoint = args.endpoint
    if args.provider in {"openai", "deepseek", "gemini"} and resolved_endpoint in {
        "https://api-free.deepl.com/v2/translate",
        "https://api.deepl.com/v2/translate",
    }:
        resolved_endpoint = str(defaults["endpoint"])
    if args.provider in {"openai", "deepseek"}:
        resolved_endpoint = normalize_openai_compatible_endpoint(resolved_endpoint, args.provider)

    resolved_model = args.model or str(defaults["model"])
    if args.provider == "gemini":
        resolved_endpoint = normalize_gemini_endpoint(resolved_endpoint, resolved_model)
    resolved_chunk = max(1, int(args.chunk if args.chunk is not None else defaults["chunk"]))
    resolved_concurrency = max(1, int(args.concurrency if args.concurrency is not None else defaults["concurrency"]))
    resolved_max_chars = max(0, int(args.max_chars if args.max_chars is not None else defaults.get("max_chars", 0)))
    resolved_max_paragraphs = max(0, int(args.max_paragraphs if args.max_paragraphs is not None else defaults.get("max_paragraphs", 0)))
    resolved_max_retries = max(0, int(args.max_retries if args.max_retries is not None else defaults["max_retries"]))

    print(
        f"Translating via provider={args.provider} endpoint={resolved_endpoint} "
        f"target={args.target} chunk={resolved_chunk} concurrency={resolved_concurrency} "
        f"max_chars={resolved_max_chars} max_paragraphs={resolved_max_paragraphs} "
        f"rps={max(0, args.rps)} max_retries={resolved_max_retries} ..."
    )
    failed_batches = 0

    def on_batch_error(_start: int, _end: int, _err: str):
        nonlocal failed_batches
        failed_batches += 1

    out_lines = translate_lines_native(
        lines,
        api_key=args.key,
        provider=args.provider,
        endpoint=resolved_endpoint,
        target_lang=args.target,
        model=resolved_model,
        bilingual=args.bilingual,
        every=max(1, args.every),
        chunk=resolved_chunk,
        concurrency=resolved_concurrency,
        max_chars=resolved_max_chars,
        max_paragraphs=resolved_max_paragraphs,
        rps=max(0, args.rps),
        max_retries=resolved_max_retries,
        batch_error_callback=on_batch_error,
        debug_progress=args.debug_progress,
        fallback_mode=args.fallback_mode,
        request_timeout=max(1.0, float(args.request_timeout)),
        slow_split_threshold=max(0.0, float(args.slow_split_threshold)),
        repair_concurrency=max(1, int(args.repair_concurrency)),
        no_thinking=(False if args.with_thinking else True),
        openai_reasoning_effort=args.openai_reasoning_effort,
    )

    print(f"Writing: {out_path}")
    out_path.write_text("\n".join(out_lines), encoding="utf-8")
    if failed_batches > 0:
        print(
            f"Done with warnings: {failed_batches} batch(es) failed and kept original text.",
            file=sys.stderr,
        )
    print("Done.")


if __name__ == "__main__":
    main()
