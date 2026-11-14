import os
import json
import hashlib

from cvat_sdk import make_client
from cvat_auth import login

TASK_ID = int(os.getenv("CVAT_TASK_ID", "3"))
HOST = os.getenv("CVAT_HOST", "http://localhost:8080")


# Calculate a fingerprint for each frame
def calculate_hashes(annotations, frames):
    hashes = {}

    # Group boxes by frame first, so big tasks don't scan every box for every frame
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


# Get annotations from CVAT
def get_frame_hashes(client, task_id=TASK_ID):
    task = client.tasks.retrieve(task_id)
    annotations = task.get_annotations()
    return calculate_hashes(annotations, frame_names(task, task.get_meta()))


if __name__ == "__main__":
    hashes = get_frame_hashes()
    print(f"Calculated {len(hashes)} frame fingerprints")
    print("First frame:", next(iter(hashes)))