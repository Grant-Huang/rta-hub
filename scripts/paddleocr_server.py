#!/usr/bin/env python3
"""Minimal local HTTP wrapper around PaddleOCR — the OCR side of the
PaddleOCR + VL floor-plan pipeline (see src/floorplan/paddleocr.ts).

Same deployment shape as the existing Ollama vision setup: run this as a
small local service, point RTA-Hub's Node process at it via `OCR_BASE_URL`
(see .env.example). Not started by `npm run dev` — it's an optional, separate
process, same as Ollama.

Setup:
    pip install paddleocr paddlepaddle
    python scripts/paddleocr_server.py [--port 8891] [--lang en]

Contract (matches PaddleOcrServerResponse in src/floorplan/paddleocr.ts):
    POST /ocr   body: {"image": "<base64, data-URL prefix optional>"}
    ->          {"width": int, "height": int,
                 "texts": [{"text": str, "score": float,
                            "box": [[x,y],[x,y],[x,y],[x,y]]}, ...]}

`enable_mkldnn=False` below trades a little CPU speed for portability: some
CPU/oneDNN combinations (seen in this repo's own sandboxed test run) crash
PP-OCR's default MKL-DNN path with a PIR runtime error. If your machine's
MKL-DNN works fine, feel free to drop that flag for a speed bump.
"""
import argparse
import base64
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np
from paddleocr import PaddleOCR

_ocr: PaddleOCR | None = None


def get_ocr(lang: str) -> PaddleOCR:
    global _ocr
    if _ocr is None:
        _ocr = PaddleOCR(
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            lang=lang,
            enable_mkldnn=False,
        )
    return _ocr


def strip_data_url(b64: str) -> str:
    if b64.startswith("data:"):
        comma = b64.find(",")
        if comma >= 0:
            return b64[comma + 1 :]
    return b64


def run_ocr(image_b64: str, lang: str) -> dict:
    raw = base64.b64decode(strip_data_url(image_b64))
    buf = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        return {"error": "could not decode image"}
    height, width = img.shape[:2]

    ocr = get_ocr(lang)
    texts: list[dict] = []
    for page in ocr.predict(img):
        rec_texts = page.get("rec_texts", [])
        rec_scores = page.get("rec_scores", [])
        rec_boxes = page.get("rec_boxes", [])
        for text, score, box in zip(rec_texts, rec_scores, rec_boxes):
            x0, y0, x1, y1 = [int(v) for v in box]
            texts.append({
                "text": text,
                "score": float(score),
                "box": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
            })
    return {"width": int(width), "height": int(height), "texts": texts}


class Handler(BaseHTTPRequestHandler):
    lang = "en"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - stdlib signature
        sys.stderr.write("[paddleocr-server] " + (fmt % args) + "\n")

    def do_POST(self) -> None:  # noqa: N802 - stdlib signature
        if self.path != "/ocr":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        try:
            payload = json.loads(body)
            result = run_ocr(payload["image"], self.lang)
            status = 200 if "error" not in result else 400
        except Exception as exc:  # noqa: BLE001 - report to caller, don't crash the server
            result = {"error": str(exc)}
            status = 500
        out = json.dumps(result).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8891)
    parser.add_argument("--lang", default="en", help="PaddleOCR language, e.g. en / ch")
    args = parser.parse_args()

    Handler.lang = args.lang
    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"[paddleocr-server] listening on :{args.port} (lang={args.lang})")
    server.serve_forever()


if __name__ == "__main__":
    main()
