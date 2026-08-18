#!/usr/bin/env python3
"""Extract unique CNY amount from a WeChat Services screenshot (read-only).

Uses the visual-tap resolver PaddleOCR venv when available.
Prints one JSON object to stdout. Never opens wallet payment UI.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("PADDLE_PDX_DISABLE_MKLDNN", "1")

AMOUNT_RE = re.compile(r"¥\s*(\d{1,7}(?:\.\d{1,2})?)")
AMOUNT_BARE_RE = re.compile(r"(?<![.\d])(\d{1,7}\.\d{2})(?![.\d])")


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "code": "IMAGE_PATH_REQUIRED"}))
        return 2
    image_path = Path(sys.argv[1])
    if not image_path.is_file():
        print(json.dumps({"ok": False, "code": "IMAGE_NOT_FOUND", "path": str(image_path)}))
        return 2

    try:
        import cv2
        from paddleocr import PaddleOCR
    except Exception as exc:  # pragma: no cover
        print(json.dumps({"ok": False, "code": "OCR_RUNTIME_UNAVAILABLE", "message": str(exc)}))
        return 3

    img = cv2.imread(str(image_path))
    if img is None:
        print(json.dumps({"ok": False, "code": "IMAGE_UNREADABLE", "path": str(image_path)}))
        return 2

    h, w = img.shape[:2]
    # Services page: amount sits under 钱包 on the green card (upper band).
    y1, y2 = int(h * 0.08), int(h * 0.35)
    x1, x2 = int(w * 0.35), int(w * 0.98)
    crop = img[y1:y2, x1:x2]
    ocr = PaddleOCR(
        lang="ch",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        enable_mkldnn=False,
    )
    result = ocr.predict(crop)
    texts: list[str] = []
    if result:
        record = result[0]
        texts = [str(t).strip() for t in (record.get("rec_texts") or []) if str(t).strip()]

    joined = " ".join(texts)
    yen = AMOUNT_RE.findall(joined)
    bare = AMOUNT_BARE_RE.findall(joined) if not yen else []
    candidates = []
    seen = set()
    for raw in yen + bare:
        norm = raw.replace(",", "").strip()
        if not norm or norm in seen:
            continue
        seen.add(norm)
        candidates.append(norm)

    # Prefer amounts that appear with yen sign text nearby in OCR tokens.
    preferred = []
    for text in texts:
        m = AMOUNT_RE.search(text) or (AMOUNT_BARE_RE.search(text) if "¥" in joined else None)
        if m:
            preferred.append(m.group(1).replace(",", ""))

    unique_pref = []
    for item in preferred:
        if item not in unique_pref:
            unique_pref.append(item)
    final_candidates = unique_pref or candidates

    if len(final_candidates) == 0:
        print(json.dumps({
            "ok": False,
            "code": "AMOUNT_NOT_FOUND",
            "texts": texts,
            "amountCandidates": [],
            "crop": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
        }, ensure_ascii=False))
        return 4
    if len(final_candidates) > 1:
        print(json.dumps({
            "ok": False,
            "code": "AMOUNT_NOT_UNIQUE",
            "texts": texts,
            "amountCandidates": final_candidates,
        }, ensure_ascii=False))
        return 5

    amount = final_candidates[0]
    print(json.dumps({
        "ok": True,
        "amountCny": amount,
        "currency": "CNY",
        "amountCandidates": final_candidates,
        "texts": texts,
        "display": f"¥{amount}",
        "crop": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
        "imagePath": str(image_path),
        "privacy": {"publicKnowledge": False},
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
