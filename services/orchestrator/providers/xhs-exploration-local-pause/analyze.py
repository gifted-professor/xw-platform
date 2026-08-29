"""Conservative local navigation provider for the offline five-route corpus.

For one explicitly bound page/role pair this provider can emit only a single
generic navigation candidate.  It never emits OCR text, business controls,
raw action commands, or tap authority.  The JavaScript process adapter binds
the input frame, page, requested role, and model; this script verifies those
bindings again before decoding the PNG.  Runtime live authority remains a
separate allowlist limited to VIDEO_NOTE/PAUSE_VIDEO_SAFE_ZONE.

The implementation uses only the Python standard library.  That keeps the
pinned model a real, single-file rules model and avoids silently depending on
the machine-local, license-unverified PaddleOCR/OpenCV environment.
"""

from __future__ import annotations

import argparse
import binascii
import hashlib
import json
import os
import struct
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MODEL_SCHEMA = "xw.xhs.exploration-local-navigation-model.v1"
RESULT_SCHEMA = "xw.xhs.exploration-vision-process-result.v1"
ROUTE_LABELS = {
    ("HOME_FEED", "OPEN_CONTENT_CARD"): "打开内容卡片安全区",
    ("SEARCH_RESULTS", "OPEN_CONTENT_CARD"): "打开内容卡片安全区",
    ("IMAGE_NOTE", "OPEN_COMMENT_PANEL"): "打开评论面板导航区",
    ("VIDEO_NOTE", "OPEN_COMMENT_PANEL"): "打开评论面板导航区",
    ("VIDEO_NOTE", "PAUSE_VIDEO_SAFE_ZONE"): "暂停视频安全区",
    ("COMMENT_PANEL", "BACK"): "返回导航区",
}
MAX_MODEL_BYTES = 64 * 1024
MAX_COMPRESSED_PNG_BYTES = 12 * 1024 * 1024


class ProviderError(Exception):
    """Fail-closed provider error with a non-sensitive stable code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Frame:
    width: int
    height: int
    channels: int
    pixels: bytes

    def rgb(self, x: int, y: int) -> tuple[int, int, int]:
        offset = (y * self.width + x) * self.channels
        if self.channels == 1:
            value = self.pixels[offset]
            return value, value, value
        return self.pixels[offset], self.pixels[offset + 1], self.pixels[offset + 2]


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _exact_keys(value: Any, expected: set[str], code: str) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        raise ProviderError(code)


def _integer(value: Any, low: int, high: int, code: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ProviderError(code)
    return value


def _number(value: Any, low: float, high: float, code: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProviderError(code)
    result = float(value)
    if not low <= result <= high:
        raise ProviderError(code)
    return result


def load_model(path: Path, expected_hash: str) -> dict[str, Any]:
    if not path.is_absolute() or not expected_hash or len(expected_hash) != 64:
        raise ProviderError("MODEL_BINDING_INVALID")
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ProviderError("MODEL_UNREADABLE") from exc
    if not raw or len(raw) > MAX_MODEL_BYTES or _sha256(raw) != expected_hash:
        raise ProviderError("MODEL_HASH_MISMATCH")
    try:
        model = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProviderError("MODEL_JSON_INVALID") from exc

    _exact_keys(model, {"schemaId", "schemaVersion", "frame", "analysis", "routes"}, "MODEL_SHAPE_INVALID")
    if model["schemaId"] != MODEL_SCHEMA or model["schemaVersion"] != 1:
        raise ProviderError("MODEL_SCHEMA_INVALID")
    frame = model["frame"]
    _exact_keys(frame, {"minWidth", "minHeight", "maxWidth", "maxHeight", "maxPixels"}, "MODEL_FRAME_INVALID")
    min_width = _integer(frame["minWidth"], 32, 4096, "MODEL_FRAME_INVALID")
    min_height = _integer(frame["minHeight"], 32, 4096, "MODEL_FRAME_INVALID")
    max_width = _integer(frame["maxWidth"], min_width, 8192, "MODEL_FRAME_INVALID")
    max_height = _integer(frame["maxHeight"], min_height, 8192, "MODEL_FRAME_INVALID")
    _integer(frame["maxPixels"], min_width * min_height, 32 * 1024 * 1024, "MODEL_FRAME_INVALID")
    if max_width * max_height < min_width * min_height:
        raise ProviderError("MODEL_FRAME_INVALID")

    analysis = model["analysis"]
    _exact_keys(
        analysis,
        {
            "sampleStridePx",
            "gradientThreshold",
            "maxSafeEdgeDensity",
            "minControlEdgeDensity",
            "maxPerimeterEdgeDensity",
            "minimumUniquenessGap",
            "minimumSamples",
            "baseConfidence",
            "maxConfidence",
        },
        "MODEL_ANALYSIS_INVALID",
    )
    _integer(analysis["sampleStridePx"], 2, 32, "MODEL_ANALYSIS_INVALID")
    _integer(analysis["gradientThreshold"], 8, 128, "MODEL_ANALYSIS_INVALID")
    _number(analysis["maxSafeEdgeDensity"], 0.01, 0.50, "MODEL_ANALYSIS_INVALID")
    _number(analysis["minControlEdgeDensity"], 0.01, 0.50, "MODEL_ANALYSIS_INVALID")
    _number(analysis["maxPerimeterEdgeDensity"], 0.01, 0.60, "MODEL_ANALYSIS_INVALID")
    _number(analysis["minimumUniquenessGap"], 0.005, 0.25, "MODEL_ANALYSIS_INVALID")
    _integer(analysis["minimumSamples"], 16, 4096, "MODEL_ANALYSIS_INVALID")
    base = _number(analysis["baseConfidence"], 0.90, 0.95, "MODEL_ANALYSIS_INVALID")
    maximum = _number(analysis["maxConfidence"], base, 0.99, "MODEL_ANALYSIS_INVALID")

    routes = model["routes"]
    if not isinstance(routes, list) or len(routes) != len(ROUTE_LABELS):
        raise ProviderError("MODEL_ROUTES_INVALID")
    seen: set[tuple[str, str]] = set()
    for route in routes:
        _exact_keys(
            route,
            {"page", "role", "label", "selection", "searchRegion", "candidate"},
            "MODEL_ROUTE_INVALID",
        )
        key = (route["page"], route["role"])
        if key in seen or ROUTE_LABELS.get(key) != route["label"]:
            raise ProviderError("MODEL_ROUTE_INVALID")
        seen.add(key)
        if route["selection"] not in ("MIN_EDGE", "MAX_EDGE"):
            raise ProviderError("MODEL_ROUTE_INVALID")
        region = route["searchRegion"]
        _exact_keys(region, {"x", "y", "w", "h"}, "MODEL_REGION_INVALID")
        rx = _number(region["x"], 0.0, 0.90, "MODEL_REGION_INVALID")
        ry = _number(region["y"], 0.0, 0.90, "MODEL_REGION_INVALID")
        rw = _number(region["w"], 0.05, 0.90, "MODEL_REGION_INVALID")
        rh = _number(region["h"], 0.05, 0.90, "MODEL_REGION_INVALID")
        if rx + rw > 1.0 or ry + rh > 1.0:
            raise ProviderError("MODEL_REGION_INVALID")
        candidate = route["candidate"]
        _exact_keys(candidate, {"width", "height", "columns", "rows"}, "MODEL_CANDIDATE_INVALID")
        cw = _number(candidate["width"], 0.02, rw, "MODEL_CANDIDATE_INVALID")
        ch = _number(candidate["height"], 0.02, rh, "MODEL_CANDIDATE_INVALID")
        _integer(candidate["columns"], 2, 8, "MODEL_CANDIDATE_INVALID")
        _integer(candidate["rows"], 2, 8, "MODEL_CANDIDATE_INVALID")
        if cw > rw / 2 or ch > rh / 2:
            raise ProviderError("MODEL_CANDIDATE_INVALID")
    if seen != set(ROUTE_LABELS):
        raise ProviderError("MODEL_ROUTES_INVALID")
    return model


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def decode_png(data: bytes, limits: dict[str, Any]) -> Frame:
    if len(data) < 33 or len(data) > MAX_COMPRESSED_PNG_BYTES or not data.startswith(PNG_SIGNATURE):
        raise ProviderError("PNG_INVALID")
    offset = len(PNG_SIGNATURE)
    ihdr: tuple[int, int, int, int, int, int, int] | None = None
    idat = bytearray()
    saw_end = False
    while offset + 12 <= len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        chunk_type = data[offset + 4 : offset + 8]
        end = offset + 12 + length
        if length > MAX_COMPRESSED_PNG_BYTES or end > len(data):
            raise ProviderError("PNG_CHUNK_INVALID")
        payload = data[offset + 8 : offset + 8 + length]
        expected_crc = struct.unpack(">I", data[offset + 8 + length : end])[0]
        if binascii.crc32(chunk_type + payload) & 0xFFFFFFFF != expected_crc:
            raise ProviderError("PNG_CRC_INVALID")
        if chunk_type == b"IHDR":
            if ihdr is not None or length != 13:
                raise ProviderError("PNG_IHDR_INVALID")
            ihdr = struct.unpack(">IIBBBBB", payload)
        elif chunk_type == b"IDAT":
            idat.extend(payload)
            if len(idat) > MAX_COMPRESSED_PNG_BYTES:
                raise ProviderError("PNG_IDAT_LIMIT")
        elif chunk_type == b"IEND":
            if length != 0:
                raise ProviderError("PNG_END_INVALID")
            saw_end = True
            break
        offset = end
    if ihdr is None or not saw_end or not idat:
        raise ProviderError("PNG_INCOMPLETE")
    width, height, bit_depth, color_type, compression, filter_method, interlace = ihdr
    if (
        bit_depth != 8
        or color_type not in (0, 2, 6)
        or compression != 0
        or filter_method != 0
        or interlace != 0
    ):
        raise ProviderError("PNG_FORMAT_UNSUPPORTED")
    if not (
        limits["minWidth"] <= width <= limits["maxWidth"]
        and limits["minHeight"] <= height <= limits["maxHeight"]
        and width * height <= limits["maxPixels"]
    ):
        raise ProviderError("PNG_DIMENSIONS_INVALID")
    channels = {0: 1, 2: 3, 6: 4}[color_type]
    stride = width * channels
    expected_size = (stride + 1) * height
    decoder = zlib.decompressobj()
    raw = decoder.decompress(bytes(idat), expected_size + 1)
    if len(raw) != expected_size or decoder.unconsumed_tail or not decoder.eof:
        raise ProviderError("PNG_INFLATE_INVALID")

    pixels = bytearray(stride * height)
    previous = bytearray(stride)
    raw_offset = 0
    for y in range(height):
        filter_type = raw[raw_offset]
        raw_offset += 1
        if filter_type > 4:
            raise ProviderError("PNG_FILTER_INVALID")
        scan = bytearray(raw[raw_offset : raw_offset + stride])
        raw_offset += stride
        for i in range(stride):
            left = scan[i - channels] if i >= channels else 0
            up = previous[i]
            upper_left = previous[i - channels] if i >= channels else 0
            if filter_type == 1:
                scan[i] = (scan[i] + left) & 0xFF
            elif filter_type == 2:
                scan[i] = (scan[i] + up) & 0xFF
            elif filter_type == 3:
                scan[i] = (scan[i] + ((left + up) >> 1)) & 0xFF
            elif filter_type == 4:
                scan[i] = (scan[i] + _paeth(left, up, upper_left)) & 0xFF
        start = y * stride
        pixels[start : start + stride] = scan
        previous = scan
    return Frame(width=width, height=height, channels=channels, pixels=bytes(pixels))


def _luma(frame: Frame, x: int, y: int) -> int:
    r, g, b = frame.rgb(x, y)
    return (77 * r + 150 * g + 29 * b) >> 8


def _candidate_rectangles(route: dict[str, Any], width: int, height: int) -> list[tuple[int, int, int, int]]:
    region = route["searchRegion"]
    candidate = route["candidate"]
    rx = int(round(region["x"] * width))
    ry = int(round(region["y"] * height))
    rw = int(round(region["w"] * width))
    rh = int(round(region["h"] * height))
    cw = max(8, int(round(candidate["width"] * width)))
    ch = max(8, int(round(candidate["height"] * height)))
    columns = candidate["columns"]
    rows = candidate["rows"]
    rectangles: list[tuple[int, int, int, int]] = []
    for row in range(rows):
        cy = ry + ch // 2 + round(row * (rh - ch) / (rows - 1))
        for column in range(columns):
            cx = rx + cw // 2 + round(column * (rw - cw) / (columns - 1))
            x = max(0, min(width - cw, cx - cw // 2))
            y = max(0, min(height - ch, cy - ch // 2))
            rectangles.append((x, y, cw, ch))
    return rectangles


def _edge_density(
    frame: Frame,
    rect: tuple[int, int, int, int],
    stride: int,
    threshold: int,
) -> tuple[float, int]:
    x, y, width, height = rect
    edges = 0
    samples = 0
    y_end = y + height
    x_end = x + width
    for py in range(y + stride, y_end, stride):
        for px in range(x + stride, x_end, stride):
            value = _luma(frame, px, py)
            left = _luma(frame, px - stride, py)
            up = _luma(frame, px, py - stride)
            if max(abs(value - left), abs(value - up)) >= threshold:
                edges += 1
            samples += 1
    return (edges / samples if samples else 1.0), samples


def _perimeter_density(
    frame: Frame,
    rect: tuple[int, int, int, int],
    stride: int,
    threshold: int,
) -> float:
    x, y, width, height = rect
    comparisons = 0
    edges = 0
    margin = max(1, stride)
    left_x = max(0, x - margin)
    right_x = min(frame.width - 1, x + width - 1 + margin)
    top_y = max(0, y - margin)
    bottom_y = min(frame.height - 1, y + height - 1 + margin)
    for px in range(x, x + width, stride):
        inside_top = _luma(frame, px, y)
        inside_bottom = _luma(frame, px, y + height - 1)
        edges += abs(inside_top - _luma(frame, px, top_y)) >= threshold
        edges += abs(inside_bottom - _luma(frame, px, bottom_y)) >= threshold
        comparisons += 2
    for py in range(y, y + height, stride):
        inside_left = _luma(frame, x, py)
        inside_right = _luma(frame, x + width - 1, py)
        edges += abs(inside_left - _luma(frame, left_x, py)) >= threshold
        edges += abs(inside_right - _luma(frame, right_x, py)) >= threshold
        comparisons += 2
    return edges / comparisons if comparisons else 1.0


def analyze(
    frame: Frame,
    model: dict[str, Any],
    page: str,
    requested_role: str,
) -> list[dict[str, Any]]:
    route = next(
        (candidate for candidate in model["routes"] if candidate["page"] == page and candidate["role"] == requested_role),
        None,
    )
    if route is None:
        raise ProviderError("REQUEST_ROUTE_FORBIDDEN")
    analysis_config = model["analysis"]
    stride = analysis_config["sampleStridePx"]
    threshold = analysis_config["gradientThreshold"]
    scored: list[tuple[float, float, float, tuple[int, int, int, int], int]] = []
    for rect in _candidate_rectangles(route, frame.width, frame.height):
        interior, samples = _edge_density(frame, rect, stride, threshold)
        perimeter = _perimeter_density(frame, rect, stride, threshold)
        risk = interior * 0.75 + perimeter * 0.25
        scored.append((risk, interior, perimeter, rect, samples))
    reverse = route["selection"] == "MAX_EDGE"
    scored.sort(key=lambda row: (row[0], -row[3][1], -row[3][0]), reverse=reverse)
    best = scored[0]
    second = scored[1]
    uniqueness = (best[0] - second[0]) if reverse else (second[0] - best[0])
    density_ok = (
        best[1] >= analysis_config["minControlEdgeDensity"]
        if reverse
        else best[1] <= analysis_config["maxSafeEdgeDensity"]
    )
    if (
        best[4] < analysis_config["minimumSamples"]
        or not density_ok
        or best[2] > analysis_config["maxPerimeterEdgeDensity"]
        or uniqueness < analysis_config["minimumUniquenessGap"]
    ):
        return []
    base = analysis_config["baseConfidence"]
    maximum = analysis_config["maxConfidence"]
    quality = (
        max(0.0, best[1] - analysis_config["minControlEdgeDensity"])
        if reverse
        else max(0.0, analysis_config["maxSafeEdgeDensity"] - best[1])
    ) * 0.10
    confidence = min(maximum, base + uniqueness * 0.75 + quality)
    x, y, width, height = best[3]
    return [
        {
            "label": route["label"],
            "bounds": {"x": x, "y": y, "w": width, "h": height},
            "confidence": round(confidence, 6),
        }
    ]


def run(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("input")
    parser.add_argument("-o", "--output", required=True)
    try:
        args = parser.parse_args(argv)
        input_path = Path(args.input).resolve(strict=True)
        output_path = Path(args.output).resolve(strict=False)
        model_path_raw = os.environ.get("XW_VISION_MODEL_PATH", "")
        model_hash = os.environ.get("XW_VISION_MODEL_SHA256", "")
        frame_hash = os.environ.get("XW_VISION_FRAME_SHA256", "")
        page = os.environ.get("XW_VISION_PAGE", "")
        requested_role = os.environ.get("XW_VISION_REQUESTED_ROLE", "")
        model_path = Path(model_path_raw)
        if not input_path.is_file() or output_path.exists() or output_path.parent != input_path.parent:
            raise ProviderError("STAGING_PATH_INVALID")
        frame_bytes = input_path.read_bytes()
        if len(frame_hash) != 64 or _sha256(frame_bytes) != frame_hash:
            raise ProviderError("FRAME_HASH_MISMATCH")
        model = load_model(model_path, model_hash)
        decoded = decode_png(frame_bytes, model["frame"])
        if (page, requested_role) not in ROUTE_LABELS:
            raise ProviderError("REQUEST_ROUTE_FORBIDDEN")
        elements = analyze(decoded, model, page, requested_role)
        result = {
            "schemaId": RESULT_SCHEMA,
            "schemaVersion": 1,
            "frameHash": frame_hash,
            "modelHash": model_hash,
            "page": page,
            "role": requested_role,
            "elements": elements,
        }
        encoded = (json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        with output_path.open("xb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        return 0
    except ProviderError as exc:
        sys.stderr.write(f"xhs-exploration-local-pause:{exc.code}\n")
        return 2
    except (OSError, ValueError, argparse.ArgumentError):
        sys.stderr.write("xhs-exploration-local-pause:PROVIDER_FAILED\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
