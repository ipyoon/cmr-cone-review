"""Read box files for a new task (SAM3 csv/json, CVAT XML, COCO) and match them to frames."""

import csv
import json
import math

from PIL import Image

IMAGE_TYPES = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
VIDEO_TYPES = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}


class BoxProblem(ValueError):
    """A box file that doesn't fit the pictures. The message says what to fix."""


# The pictures or video

def describe_media(paths):
    """What was uploaded: ("images", {name: (width, height)}) or ("video", frame count, (width, height))."""
    images = [p for p in paths if p.suffix.lower() in IMAGE_TYPES]
    videos = [p for p in paths if p.suffix.lower() in VIDEO_TYPES]
    if videos and (images or len(videos) > 1):
        raise BoxProblem("Upload either pictures or one video, not both.")
    if videos:
        import cv2  # only needed for videos

        video = cv2.VideoCapture(str(videos[0]))
        count = int(video.get(cv2.CAP_PROP_FRAME_COUNT))
        size = (int(video.get(cv2.CAP_PROP_FRAME_WIDTH)), int(video.get(cv2.CAP_PROP_FRAME_HEIGHT)))
        video.release()
        return "video", count, size
    if not images:
        raise BoxProblem("No pictures or video found in the upload.")
    sizes = {}
    for p in images:
        with Image.open(p) as image:  # reads only the header, not the whole picture
            sizes[p.name] = image.size
    return "images", sizes


# Reading box files

def read_boxes(paths):
    """Read box files. Returns (kind, boxes, pictures); kind is "frames", "names" or "cvat"."""
    if not paths:
        return None, [], set()
    suffixes = {p.suffix.lower() for p in paths}
    if suffixes == {".csv"}:
        if len(paths) > 1:
            raise BoxProblem("Upload one boxes.csv at a time.")
        return "frames", read_csv(paths[0]), set()
    if suffixes == {".xml"}:
        return "cvat", "CVAT 1.1", set()
    if suffixes == {".json"}:
        docs = [(p, json.loads(p.read_text())) for p in paths]
        if len(docs) == 1 and {"images", "annotations"} <= set(docs[0][1]):
            return "cvat", "COCO 1.0", set()
        boxes = [box for p, doc in docs for box in read_sam3_json(p, doc)]
        return "names", boxes, {doc.get("image") or f"{p.stem}.jpg" for p, doc in docs}
    raise BoxProblem("Boxes must be a boxes.csv, SAM3 .json files (one per picture), a CVAT .xml, or a COCO .json.")


def read_csv(path):
    boxes = []
    with open(path, newline="") as file:
        reader = csv.DictReader(file)
        missing = {"frame", "colour", "x0", "y0", "x1", "y1"} - set(reader.fieldnames or [])
        if missing:
            raise BoxProblem(f"{path.name} is missing the column(s): {', '.join(sorted(missing))}.")
        for line, row in enumerate(reader, start=2):
            try:
                frame = int(row["frame"])
                x1, y1, x2, y2 = (float(row[k]) for k in ("x0", "y0", "x1", "y1"))
            except ValueError:
                raise BoxProblem(f"{path.name}, line {line}: frame and corners must be numbers.")
            colour = row["colour"].strip().lower().replace(" ", "_")
            boxes.append((frame, f"{colour}_cone", x1, y1, x2, y2))
    return boxes


def read_sam3_json(path, doc):
    if "predictions" not in doc:
        raise BoxProblem(f"{path.name} isn't a SAM3 file (it has no \"predictions\").")
    image = doc.get("image") or f"{path.stem}.jpg"
    return [(image, p["label"], *map(float, p["bbox"])) for p in doc["predictions"]]


# Matching boxes to frames

def check_boxes(kind, boxes, pictures, media, labels):
    """Check every box has a valid frame and label. Raises BoxProblem; returns a summary."""
    if kind in (None, "cvat"):
        return None
    unknown = sorted({b[1] for b in boxes} - set(labels))
    if unknown:
        raise BoxProblem(f"These labels aren't in the task: {', '.join(unknown)}. It has: {', '.join(sorted(labels))}.")
    if kind == "frames":
        count = media[1] if media[0] == "video" else len(media[1])
        bad = sorted({b[0] for b in boxes if not 0 <= b[0] < count})
        if bad:
            raise BoxProblem(f"boxes.csv has boxes on frame {bad[0]}{' and others' if len(bad) > 1 else ''}, "
                             f"but the upload has {count} frames (0 to {count - 1}).")
        return f"{len(boxes):,} boxes on {len({b[0] for b in boxes}):,} of {count:,} frames"
    if media[0] == "video":
        raise BoxProblem("SAM3 .json files match pictures by name, but a video was uploaded. Use boxes.csv for videos.")
    names = media[1]
    stray = sorted(pictures - set(names))  # every json file must be for an uploaded picture
    if stray:
        raise BoxProblem(f"No uploaded picture is called {stray[0]}{f' (and {len(stray) - 1} more)' if len(stray) > 1 else ''}.")
    return f"{len(boxes):,} boxes on {len({b[0] for b in boxes}):,} of {len(names):,} pictures"


def to_cvat_shapes(kind, boxes, frame_of_name, label_ids, size_of_frame, shape):
    """Build CVAT shapes clipped to the picture. Returns (shapes, skipped count)."""
    shapes, skipped = [], 0
    for key, label, x1, y1, x2, y2 in boxes:
        if not all(map(math.isfinite, (x1, y1, x2, y2))):  # "nan" or "inf" in the file
            skipped += 1
            continue
        frame = key if kind == "frames" else frame_of_name[key]
        width, height = size_of_frame(frame)
        x1, x2 = sorted((min(max(x1, 0.0), width), min(max(x2, 0.0), width)))
        y1, y2 = sorted((min(max(y1, 0.0), height), min(max(y2, 0.0), height)))
        if x2 - x1 < 1 or y2 - y1 < 1:
            skipped += 1
            continue
        shapes.append(shape(frame, label_ids[label], [x1, y1, x2, y2]))
    return shapes, skipped
