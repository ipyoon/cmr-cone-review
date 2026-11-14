import csv
import argparse
import math
from cvat_auth import login
from cvat_sdk import make_client
from cvat_sdk.api_client.models import LabeledShapeRequest, LabeledDataRequest, ShapeType

# Choose the CSV file and CVAT task
parser = argparse.ArgumentParser()
parser.add_argument("--csv", required=True)
parser.add_argument("--task", type=int, required=True)
args = parser.parse_args()

with make_client(host="http://localhost:8080") as client:
    login(client)
    task = client.tasks.retrieve(args.task)

    # Don't erase existing annotations
    old = task.get_annotations()
    if old.shapes or old.tracks or old.tags:
        raise ValueError("Task already has annotations!")

    labels = {label.name: label.id for label in task.get_labels()}
    frame_count = task.size
    boxes = []
    skipped = 0

    # Read each box from the CSV
    with open(args.csv) as file:
        for row in csv.DictReader(file):
            frame = int(row["frame"])
            color = row["colour"].strip().lower()
            label = color + "_cone"

            if frame < 0 or frame >= frame_count:
                raise ValueError(f"Invalid frame number: {frame}")
            if label not in labels:
                raise ValueError(f"Missing label: {label}")

            # Get box coordinates
            x1 = float(row["x0"])
            y1 = float(row["y0"])
            x2 = float(row["x1"])
            y2 = float(row["y1"])

            if not all(math.isfinite(v) for v in (x1, y1, x2, y2)):
                skipped += 1
                continue

            # Keep boxes inside the 1920 x 1200 image
            x1 = max(0, min(1920, x1))
            x2 = max(0, min(1920, x2))
            y1 = max(0, min(1200, y1))
            y2 = max(0, min(1200, y2))

            if x1 >= x2 or y1 >= y2:
                skipped += 1
                continue

            # Add an editable rectangle
            boxes.append(LabeledShapeRequest(
                type=ShapeType("rectangle"),
                frame=frame,
                label_id=labels[label],
                points=[x1, y1, x2, y2],
                occluded=False,
                outside=False,
                z_order=0
            ))

    print(f"Ready: {len(boxes)} boxes, skipped: {skipped}")

    if input("Import? Type YES: ") == "YES":
        task.set_annotations(LabeledDataRequest(
            version=0, tags=[], shapes=boxes, tracks=[]
        ))
        print("Import complete!")