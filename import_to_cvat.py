import os
import json
from pathlib import Path
from getpass import getpass
from cvat_auth import login
from cvat_sdk import make_client
from cvat_sdk.api_client.models import LabeledDataRequest, LabeledShapeRequest, ShapeType

TASK_ID = int(os.getenv("CVAT_TASK_ID", "3"))
HOST = os.getenv("CVAT_HOST", "http://localhost:8080")
LABELS_DIR = Path(os.getenv("LABELS_DIR", "sam3_labels"))

with make_client(host=HOST) as client:
    login(client)
    task = client.tasks.retrieve(TASK_ID)

    # Don't overwrite existing annotations
    old = task.get_annotations()
    if old.shapes or old.tracks or old.tags:
        raise RuntimeError("Task already has annotations. Import cancelled.")

    labels = {label.name: label.id for label in task.get_labels()}
    frames = task.get_meta().frames
    shapes = []

    if not frames:
        raise ValueError("Task has no frames")

    if len(list(LABELS_DIR.glob("*.json"))) != len(frames):
        raise ValueError("Number of JSON files doesn't match frames")

    # Read each frame's predictions
    for i, frame in enumerate(frames):
        path = LABELS_DIR / f"{Path(frame.name).stem}.json"
        data = json.loads(path.read_text())

        if data["image"] != frame.name:
            raise ValueError(f"Wrong image: {frame.name}")

        for prediction in data["predictions"]:
            label = prediction["label"]
            if label not in labels:
                raise ValueError(f"Unknown label: {label}")

            x1, y1, x2, y2 = prediction["bbox"]
            w, h = data["width"], data["height"]

            # Keep boxes inside the image
            x1, x2 = max(0, x1), min(w, x2)
            y1, y2 = max(0, y1), min(h, y2)

            if x1 >= x2 or y1 >= y2:
                continue

            shapes.append(LabeledShapeRequest(
                type=ShapeType("rectangle"),
                frame=i,
                label_id=labels[label],
                points=[x1, y1, x2, y2],
                occluded=False,
                outside=False,
                z_order=0
            ))

    print(f"Prepared {len(shapes)} boxes for Task #{TASK_ID}")

    # Ask before importing
    if input("Import annotations? Type YES: ") == "YES":
        task.set_annotations(LabeledDataRequest(
            version=0, tags=[], shapes=shapes, tracks=[]
        ))
        print("Import successful!")
    else:
        print("Cancelled.")
