import json
import hashlib


# A fingerprint of each frame's boxes. If any box changes, the fingerprint changes.
def calculate_hashes(annotations, frames):
    hashes = {}

    # Group the boxes by frame first (much faster on big tasks)
    by_frame = {}
    for box in annotations.shapes:
        by_frame.setdefault(box.frame, []).append(box)

    for i, frame in enumerate(frames):
        boxes = []

        for box in by_frame.get(i, []):
            boxes.append({
                "label": box.label_id,
                "points": [round(float(x), 4) for x in box.points],
                "occluded": box.occluded
            })

        boxes.sort(key=lambda b: (b["label"], b["points"]))
        data = json.dumps(boxes, sort_keys=True)
        hashes[frame] = hashlib.sha256(data.encode()).hexdigest()

    return hashes


# Image tasks list every frame; video tasks don't, so number them instead
def frame_names(task, meta):
    if len(meta.frames) == task.size:
        return [frame.name for frame in meta.frames]
    return [f"frame_{i:06d}.jpg" for i in range(task.size)]

