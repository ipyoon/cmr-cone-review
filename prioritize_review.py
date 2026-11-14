import json
import csv
from pathlib import Path

LABELS_DIR = Path("sam3_labels")
OUTPUT = Path("review_priority.csv")
CONFIDENCE_THRESHOLD = 0.65

results = []

for path in sorted(LABELS_DIR.glob("*.json")):
    data = json.loads(path.read_text())
    predictions = data["predictions"]

    low_confidence = [
        p for p in predictions
        if p["confidence"] < CONFIDENCE_THRESHOLD
    ]

    # Higher score = more annotations needing attention
    priority_score = sum(
        1 - p["confidence"]
        for p in low_confidence
    )

    results.append({
        "frame": data["image"],
        "total_boxes": len(predictions),
        "suspicious_boxes": len(low_confidence),
        "priority_score": round(priority_score, 3),
    })

results.sort(
    key=lambda row: row["priority_score"],
    reverse=True
)

with OUTPUT.open("w", newline="") as f:
    writer = csv.DictWriter(
        f,
        fieldnames=[
            "frame",
            "total_boxes",
            "suspicious_boxes",
            "priority_score",
        ],
    )
    writer.writeheader()
    writer.writerows(results)

print("\nFrames ranked by review priority:\n")

for rank, row in enumerate(results, start=1):
    print(
        f"{rank:2}. {row['frame']} | "
        f"Suspicious: {row['suspicious_boxes']} | "
        f"Score: {row['priority_score']}"
    )

print(f"\nSaved results to {OUTPUT}")
