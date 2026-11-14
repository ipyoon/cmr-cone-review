import os
import cv2
from pathlib import Path
from cvat_sdk import make_client

from cvat_auth import login
from cvat_fingerprint import calculate_hashes
from verification_tracker import check_verification

# Settings
TASK_ID = int(os.getenv("CVAT_TASK_ID", "3"))
HOST = os.getenv("CVAT_HOST", "http://localhost:8080")
VIDEO = os.getenv("VIDEO_PATH")
IMAGES = Path(os.getenv("IMAGES_DIR", "frames"))
OUTPUT = Path(os.getenv("OUTPUT_DIR", "verified_dataset"))

CLASSES = [
    "blue_cone", "yellow_cone", "orange_cone",
    "large_orange_cone", "unknown_cone"
]


# Load a frame from a video or image folder
def load_frame(number, name, video):
    if video:
        video.set(cv2.CAP_PROP_POS_FRAMES, number)
        success, image = video.read()
        if not success:
            raise ValueError(f"Cannot read frame {number}")
    else:
        image = cv2.imread(str(IMAGES / name))
        if image is None:
            raise FileNotFoundError(IMAGES / name)

    return image


# Connect to CVAT
with make_client(host=HOST) as client:
    login(client)
    task = client.tasks.retrieve(TASK_ID)

    annotations = task.get_annotations()
    labels = {label.id: label.name for label in task.get_labels()}
    meta = task.get_meta()

    # Get frame names
    if len(meta.frames) == task.size:
        names = [frame.name for frame in meta.frames]
    else:
        names = [f"frame_{i:06d}.jpg" for i in range(task.size)]

    # Check which frames are still verified
    hashes = calculate_hashes(annotations, names)
    approved = []

    for i, name in enumerate(names):
        if check_verification(name, hashes) == "verified":
            approved.append((i, name))

    if not approved:
        raise ValueError("No verified frames to export")

    # Don't overwrite previous exports
    if OUTPUT.exists() and any(OUTPUT.iterdir()):
        raise ValueError("Output folder is not empty")

    video = cv2.VideoCapture(VIDEO) if VIDEO else None

    if VIDEO and not video.isOpened():
        raise ValueError("Cannot open video")

    results = []

    try:
        # Convert approved frames to YOLO labels
        for i, name in approved:
            image = load_frame(i, name, video)
            height, width = image.shape[:2]
            lines = []

            for box in annotations.shapes:
                if box.frame != i:
                    continue

                if box.type.value != "rectangle":
                    raise ValueError(f"Unsupported shape in {name}")

                label = labels[box.label_id]

                if label not in CLASSES:
                    raise ValueError(f"Unknown class: {label}")

                x1, y1, x2, y2 = map(float, box.points)

                if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
                    raise ValueError(f"Invalid box in {name}")

                xc = (x1 + x2) / (2 * width)
                yc = (y1 + y2) / (2 * height)
                w = (x2 - x1) / width
                h = (y2 - y1) / height

                lines.append(
                    f"{CLASSES.index(label)} {xc:.6f} {yc:.6f} {w:.6f} {h:.6f}"
                )

            results.append((name, image, lines))

    finally:
        if video:
            video.release()

    # Create output folders
    (OUTPUT / "images").mkdir(parents=True, exist_ok=True)
    (OUTPUT / "labels").mkdir(parents=True, exist_ok=True)

    # Save verified frames and labels
    for name, image, lines in results:
        image_path = OUTPUT / "images" / name
        label_path = OUTPUT / "labels" / f"{Path(name).stem}.txt"

        if not cv2.imwrite(str(image_path), image):
            raise ValueError(f"Cannot save {name}")

        label_path.write_text("\n".join(lines) + ("\n" if lines else ""))

    (OUTPUT / "data.yaml").write_text(
        "names:\n" +
        "".join(f"  {i}: {name}\n" for i, name in enumerate(CLASSES))
    )

    print(f"Exported {len(results)} verified frames!")