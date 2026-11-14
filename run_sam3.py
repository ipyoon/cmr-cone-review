"""Run SAM3 with cone-colour text prompts on every image in a folder.

Uses the sam3-mac shim so it runs on Apple Silicon (pip install sam3-mac).

Usage:
    python run_sam3.py --frames frames/ --out out_sam3/
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

import sam3_mac
sam3_mac.install()  # auto-picks mps/cpu, patches around the triton import

# One prompt per cone colour
CONCEPTS = ["blue cone", "yellow cone", "orange cone"]

MASK_COLORS = {
    "blue cone": (60, 120, 255),
    "yellow cone": (255, 220, 60),
    "orange cone": (255, 140, 40),
}


def to_cpu_numpy(x):
    """Convert a tensor or plain value to numpy/python."""
    if hasattr(x, "detach"):
        x = x.detach()
    if hasattr(x, "cpu"):
        x = x.cpu()
    if hasattr(x, "numpy"):
        x = x.numpy()
    return np.asarray(x)


def overlay_masks(image: Image.Image, masks, boxes, scores, concept: str):
    color = MASK_COLORS.get(concept, (255, 0, 0))

    masks = [to_cpu_numpy(m) for m in masks]
    boxes = [to_cpu_numpy(b) for b in boxes]
    scores = [float(to_cpu_numpy(s)) for s in scores]

    # Pass 1: draw every mask's translucent fill
    img = image.convert("RGBA")
    for mask in masks:
        mask_np = mask.astype(bool)
        if mask_np.ndim > 2:
            mask_np = mask_np.squeeze()
        colored = np.zeros((*mask_np.shape, 4), dtype=np.uint8)
        colored[mask_np] = (*color, 110)  # semi-transparent fill
        img = Image.alpha_composite(img, Image.fromarray(colored, "RGBA"))

    # Pass 2: draw boxes and labels on the final image
    draw = ImageDraw.Draw(img)
    for box, score in zip(boxes, scores):
        x0, y0, x1, y1 = box
        draw.rectangle([x0, y0, x1, y1], outline=color, width=2)
        draw.text((x0, max(0, y0 - 12)), f"{concept} {score:.2f}", fill=color)

    return img.convert("RGB")


def main(frames_dir: str, out_dir: str, concepts: list, confidence_threshold: float):
    print(f"Loading SAM3 model (confidence_threshold={confidence_threshold})...")
    model, processor = sam3_mac.build_image_model(confidence_threshold=confidence_threshold)

    Path(out_dir).mkdir(parents=True, exist_ok=True)
    labels_dir = Path("sam3_labels")
    labels_dir.mkdir(parents=True, exist_ok=True)

    frame_paths = sorted(Path(frames_dir).glob("*.jpg")) + sorted(Path(frames_dir).glob("*.png"))
    if not frame_paths:
        raise SystemExit(f"No .jpg/.png images found in {frames_dir}")

    for fp in frame_paths:
        image = Image.open(fp).convert("RGB")
        annotated = image.copy()
        total = 0
        predictions = []

        for concept in concepts:
            inference_state = processor.set_image(image)
            output = processor.set_text_prompt(state=inference_state, prompt=concept)
            masks, boxes, scores = output["masks"], output["boxes"], output["scores"]
            for box, score in zip(boxes, scores):
                predictions.append({
                    "label": concept.replace(" ", "_"),
                    "bbox": to_cpu_numpy(box).tolist(),
                    "confidence": float(to_cpu_numpy(score))
                })
            
            total += len(masks)
            # Print every raw score, even below the threshold
            score_list = [round(float(to_cpu_numpy(s)), 3) for s in scores]
            print(f"    '{concept}': {len(masks)} matches, scores={score_list}")
            if len(masks) > 0:
                annotated = overlay_masks(annotated, masks, boxes, scores, concept)

        json_path = labels_dir / f"{fp.stem}.json"

        with open(json_path, "w") as f:
            json.dump({
                "image": fp.name,
                "width": image.width,
                "height": image.height,
                "predictions": predictions
            }, f, indent=2)
        
        out_path = Path(out_dir) / fp.name
        annotated.save(out_path)
        print(f"{fp.name}: {total} total instances across {len(concepts)} concepts -> {out_path}")

    print(f"\nDone. Annotated frames written to {out_dir}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", required=True, help="folder of extracted frames")
    ap.add_argument("--out", default="out_sam3")
    ap.add_argument(
        "--confidence-threshold", type=float, default=0.5,
        help="lower this (try 0.1) if you're getting zero detections, to see "
             "whether SAM3 is finding low-confidence matches that are just "
             "being filtered out",
    )
    ap.add_argument(
        "--concepts", default=",".join(CONCEPTS),
        help="comma-separated text prompts, e.g. 'cone' or 'traffic cone' "
             "if the color-specific ones ('blue cone') aren't matching well",
    )
    args = ap.parse_args()
    concepts = [c.strip() for c in args.concepts.split(",") if c.strip()]
    main(args.frames, args.out, concepts, args.confidence_threshold)
