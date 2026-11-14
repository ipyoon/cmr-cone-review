"""Review website for CVAT: approve frames, fix cones, export approved ones.

Run: venv/bin/python review_web.py, then open http://localhost:8092
"""

import asyncio
import io
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
import zipfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import uvicorn
from PIL import Image
from cvat_sdk import make_client
from cvat_sdk.api_client import models
from cvat_sdk.core.progress import BaseProgressReporter
from cvat_sdk.core.proxies.annotations import AnnotationUpdateAction
from cvat_sdk.exceptions import ApiException
from starlette.applications import Starlette
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

import task_boxes
from cvat_fingerprint import calculate_hashes, frame_names
from verification_tracker import (
    deleted_shape, get_assignments, log_cone_change, mark_verified, register_frames, set_assignments,
    set_status, task_statuses,
)

HOST = os.getenv("CVAT_HOST", "http://localhost:8080")
CVAT_LINK = os.getenv("CVAT_PUBLIC_URL", HOST)  # where the browser opens CVAT
WEB = Path(__file__).with_name("web")  # the page: index.html, style.css and js/
COOKIE = "review_session"
THUMB_WIDTH = 480
EXPORT_CLASSES = ["blue_cone", "yellow_cone", "orange_cone", "large_orange_cone", "unknown_cone"]
CONE_COLOURS = {"blue_cone": "#2f7bff", "yellow_cone": "#f5c400", "orange_cone": "#ff7a1a",
                "large_orange_cone": "#e0218a", "unknown_cone": "#ffffff"}  # labels for new tasks

# Images get their own threads so slow chunk downloads don't block other requests
IMAGE_POOL = ThreadPoolExecutor(max_workers=2)


# ---------------------------------------------------------------- logged-in people

class Session:
    """Everything we keep for one logged-in person, in memory."""

    def __init__(self, client, image_client, upload_client, username):
        self.client = client                # for boxes, reviews and everything else
        self.image_client = image_client    # only for pictures, so they never wait behind a big download
        self.upload_client = upload_client  # only for creating tasks: an upload can take minutes
        self.username = username
        self.lock = threading.Lock()        # a CVAT client can only do one thing at a time
        self.image_lock = threading.Lock()
        self.frames = {}       # (task, frame number) -> JPEG bytes
        self.thumbs = {}       # same, but small, for the gallery and previews
        self.chunk_sizes = {}  # task -> how many frames CVAT puts in one chunk
        self.task_sizes = {}   # task -> how many frames the task has
        self.summaries = {}    # task -> (version, time, progress) for the home page
        self.version = 0       # goes up with every change, so old progress isn't reused
        self.uploads = {}      # upload id -> how creating that task is going (see new_task)


SESSIONS = {}  # cookie value -> Session


def current_session(request):
    session = SESSIONS.get(request.cookies.get(COOKIE))
    if session is None:
        raise HTTPException(401, "Please log in.")
    return session


def connect(username, password):
    client = make_client(host=HOST)
    try:
        client.login((username, password))
    except Exception:
        client.close()
        raise
    return client


async def login(request):
    body = await request.json()
    username, password = body.get("username", ""), body.get("password", "")
    try:
        client = await run_in_threadpool(connect, username, password)
        image_client = await run_in_threadpool(connect, username, password)
        upload_client = await run_in_threadpool(connect, username, password)
        user, _ = client.api_client.users_api.retrieve_self()
    except ApiException as exc:
        if exc.status in (400, 401, 403):
            raise HTTPException(401, "Wrong CVAT username or password.")
        raise
    except OSError as exc:  # CVAT isn't running
        raise HTTPException(502, f"Can't reach CVAT at {HOST}. Is Docker running?") from exc
    token = secrets.token_urlsafe(32)
    SESSIONS[token] = Session(client, image_client, upload_client, user.username)
    response = JSONResponse({"username": user.username})
    response.set_cookie(COOKIE, token, httponly=True, samesite="strict")
    return response


def logout(request):
    session = SESSIONS.pop(request.cookies.get(COOKIE), None)
    if session:
        for client in (session.client, session.image_client, session.upload_client):
            client.close()
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE)
    return response


def me(request):
    return JSONResponse({"username": current_session(request).username})


# ---------------------------------------------------------------- reading from CVAT

def load_task(session, task_id):
    """A task's frames and boxes, straight from CVAT (never cached, so always up to date)."""
    with session.lock:
        task = session.client.tasks.retrieve(task_id)
        annotations = task.get_annotations()
        meta = task.get_meta()
        labels = task.get_labels()
        jobs = task.get_jobs()
    names = frame_names(task, meta)
    return task, annotations, meta, labels, jobs, names, calculate_hashes(annotations, names)


def frame_size(meta, frame):
    return meta.frames[min(frame, len(meta.frames) - 1)]  # a video lists one size for every frame


def job_for(jobs, frame):
    return next((j for j in jobs if j.start_frame <= frame <= j.stop_frame), None)


def unknown_label(labels):
    """The id of the "unknown cone" class (or None)."""
    return next((x.id for x in labels if "unknown" in x.name.lower()), None)


def tasks(request):
    session = current_session(request)
    with session.lock:
        found = session.client.tasks.list()
    return JSONResponse([{"id": t.id, "name": t.name, "size": t.size} for t in found])


def users(request):
    session = current_session(request)
    with session.lock:
        found = session.client.users.list()
    return JSONResponse(sorted(u.username for u in found))


def overview(request):
    """Every task and who reviews which frames, for the home page."""
    session = current_session(request)
    with session.lock:
        found = session.client.tasks.list()
    return JSONResponse({"cvat_url": CVAT_LINK, "tasks": [
        {"id": t.id, "name": t.name, "size": t.size,
         "assignments": [{"username": u, "start": a, "stop": b} for u, a, b in get_assignments(t.id)]}
        for t in found]})


def summary(request):
    """Task progress per reviewer and per frame, cached until something changes."""
    session = current_session(request)
    task_id = request.path_params["task_id"]
    saved = session.summaries.get(task_id)
    if saved and saved[0] == session.version and time.time() - saved[1] < 60:
        return JSONResponse(saved[2])

    version = session.version
    _, annotations, _, labels, _, names, hashes = load_task(session, task_id)
    register_frames(names, task_id)
    statuses = task_statuses(hashes, task_id)
    status = [statuses.get(name, {}).get("status", "pending") for name in names]
    boxes = [s for s in annotations.shapes if s.type.value == "rectangle"]
    unknown = unknown_label(labels)
    unknown_at = Counter(s.frame for s in boxes if s.label_id == unknown)
    cones_at = Counter(s.frame for s in boxes)

    def stats(start, stop):
        frames = range(start, min(stop, len(names) - 1) + 1)
        return {"frames": len(frames),
                "approved": sum(status[i] == "verified" for i in frames),
                "needs_fix": sum(status[i] == "needs_fix" for i in frames),
                "unknown": sum(unknown_at[i] for i in frames),
                "cones": sum(cones_at[i] for i in frames)}

    letter = {"verified": "a", "needs_fix": "f", "needs_reverification": "c"}  # anything else: "."
    result = {
        "task": stats(0, len(names) - 1),
        "timeline": "".join(letter.get(s, ".") for s in status),
        "unsorted": "".join("1" if unknown_at[i] else "0" for i in range(len(names))),
        "assignments": [{"username": u, "start": a, "stop": b, **stats(a, b)} for u, a, b in get_assignments(task_id)],
    }
    session.summaries[task_id] = (version, time.time(), result)
    return JSONResponse(result)


def frames(request):
    """Everything the review screens need about a task: every frame, its boxes and its status."""
    session = current_session(request)
    task_id = request.path_params["task_id"]
    task, annotations, meta, labels, jobs, names, hashes = load_task(session, task_id)
    register_frames(names, task_id)
    statuses = task_statuses(hashes, task_id)
    suggested = suggestions(annotations.shapes, labels)

    boxes = [[] for _ in names]
    other_shapes = [0] * len(names)
    for shape in annotations.shapes:
        if shape.type.value == "rectangle":
            x1, y1, x2, y2 = map(float, shape.points)
            boxes[shape.frame].append({"id": shape.id, "label": shape.label_id, "suggest": suggested.get(shape.id),
                                       "x1": x1, "y1": y1, "x2": x2, "y2": y2})
        else:
            other_shapes[shape.frame] += 1

    rows = []
    for i, name in enumerate(names):
        size = frame_size(meta, i)
        info = statuses.get(name, {"status": "pending", "reviewer": None})
        rows.append({"index": i, "name": name, "width": size.width, "height": size.height, "hash": hashes[name],
                     "status": info["status"], "reviewer": info["reviewer"],
                     "boxes": boxes[i], "other_shapes": other_shapes[i]})

    return JSONResponse({
        "task": {"id": task.id, "name": task.name, "size": task.size},
        "cvat_url": CVAT_LINK,
        "labels": [{"id": x.id, "name": x.name, "color": x.color} for x in labels],
        "jobs": [{"id": j.id, "start": j.start_frame, "stop": j.stop_frame} for j in jobs],
        "assignments": [{"username": u, "start": a, "stop": b} for u, a, b in get_assignments(task_id)],
        "tracks": len(annotations.tracks),
        "frames": rows,
    })


# ---------------------------------------------------------------- pictures

CACHE_LOCK = threading.Lock()


def remember(cache, key, value, limit):
    """Store in a dict, forgetting the oldest entries past the limit."""
    with CACHE_LOCK:  # two image threads may store at the same moment
        cache[key] = value
        while len(cache) > limit:
            cache.pop(next(iter(cache)))


def thumbnail(jpeg):
    image = Image.open(io.BytesIO(jpeg))
    image.draft("RGB", (THUMB_WIDTH, THUMB_WIDTH))  # let the JPEG decoder shrink it: much faster
    image.thumbnail((THUMB_WIDTH, THUMB_WIDTH * 4))
    out = io.BytesIO()
    image.convert("RGB").save(out, "JPEG", quality=80)
    return out.getvalue()


def video_to_jpegs(raw):
    """Every frame of a short video file, as JPEGs."""
    import cv2  # only needed for video tasks

    with tempfile.NamedTemporaryFile(suffix=".mp4") as file:
        file.write(raw)
        file.flush()
        video = cv2.VideoCapture(file.name)
        jpegs = []
        while True:
            ok, image = video.read()
            if not ok:
                break
            jpegs.append(cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 90])[1].tobytes())
        video.release()
    return jpegs


def chunk_size(session, task_id):
    if task_id not in session.chunk_sizes:  # ask CVAT once per task, not for every picture
        task = session.image_client.tasks.retrieve(task_id)
        session.chunk_sizes[task_id] = getattr(task, "data_chunk_size", None) or task.get_meta().chunk_size
        session.task_sizes[task_id] = task.size
    return session.chunk_sizes[task_id]


def chunk_frames(session, task_id, index, quality="compressed"):
    """All frames in the CVAT chunk holding frame `index`, as {frame: JPEG}. Hold session.image_lock."""
    size = chunk_size(session, task_id)
    if not size:
        return {}
    number = index // size
    task = session.image_client.tasks.retrieve(task_id)
    _, response = task.api.retrieve_data(task.id, type="chunk", number=number, quality=quality)
    raw = response.data
    try:
        if zipfile.is_zipfile(io.BytesIO(raw)):
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                jpegs = [archive.read(name) for name in sorted(archive.namelist())]
        else:
            jpegs = video_to_jpegs(raw)
    except Exception:
        return {}
    return {number * size + i: jpeg for i, jpeg in enumerate(jpegs)}


def full_frame(session, task_id, index):
    """One frame as a JPEG, downloading its whole chunk the first time."""
    key = (task_id, index)
    if key not in session.frames:
        with session.image_lock:
            if key not in session.frames:  # someone else may have just downloaded it
                got = chunk_frames(session, task_id, index)
                if index not in got:  # no chunks for this task: ask for the single frame
                    task = session.image_client.tasks.retrieve(task_id)
                    got = {index: task.get_frame(index, quality="compressed").read()}
                for i, jpeg in got.items():
                    remember(session.frames, (task_id, i), jpeg, limit=400)
    return session.frames[key]


def small_frame(session, task_id, index):
    key = (task_id, index)
    if key not in session.thumbs:
        remember(session.thumbs, key, thumbnail(full_frame(session, task_id, index)), limit=3000)
    return session.thumbs[key]


def prefetch_next_chunk(session, task_id, index):
    """Reviewers move forward, so fetch the next chunk while they look at this one."""
    size = session.chunk_sizes.get(task_id)
    if not size:
        return
    next_start = (index // size + 1) * size
    if next_start < session.task_sizes.get(task_id, 0) and (task_id, next_start) not in session.frames:
        try:
            full_frame(session, task_id, next_start)
        except Exception:
            pass  # CVAT said no: the frame simply loads when it's asked for


async def frame_image(request):
    """A frame as a JPEG. ?size=small gives a thumbnail."""
    session = current_session(request)
    task_id, index = request.path_params["task_id"], request.path_params["index"]
    get = small_frame if request.query_params.get("size") == "small" else full_frame
    jpeg = await run_in_pool(get, session, task_id, index)
    IMAGE_POOL.submit(prefetch_next_chunk, session, task_id, index)
    return Response(jpeg, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


async def run_in_pool(function, *args):
    return await asyncio.get_running_loop().run_in_executor(IMAGE_POOL, function, *args)


# ---------------------------------------------------------------- approving frames

def sync_jobs(session, task_id, frames):
    """Set the CVAT job state from its reviews. Returns a warning if CVAT refuses."""
    *_, jobs, names, hashes = load_task(session, task_id)
    statuses = task_statuses(hashes, task_id)
    refused = []
    for job in {job_for(jobs, f) for f in frames} - {None}:
        seen = [statuses.get(names[i], {}).get("status") for i in range(job.start_frame, job.stop_frame + 1)]
        state = "rejected" if "needs_fix" in seen else "completed" if all(s == "verified" for s in seen) else "in progress"
        if getattr(job.state, "value", job.state) != state:
            try:
                with session.lock:
                    job.update({"state": state})
            except ApiException:
                refused.append(f"job {job.id} to '{state}'")
    return f"Saved, but CVAT didn't let you set {', '.join(refused)}." if refused else None


def update_issues(session, job, frame, decision, note, size):
    """Needs fix opens a CVAT issue on the frame; Approve resolves open ones; Undo removes yours."""
    with session.lock:
        issues = [i for i in job.get_issues() if i.frame == frame and not i.resolved]
    mine = [i for i in issues if i.owner.username == session.username]
    with session.lock:
        if decision == "needs_fix" and not mine:
            session.client.issues.create({
                "frame": frame, "job": job.id, "message": f"Needs fix: {note}" if note else "Needs fix (from the review page)",
                "position": [0.0, 0.0, float(size.width), float(size.height)]})
        elif decision == "approve":
            for issue in issues:
                issue.update({"resolved": True})
        elif decision == "reset":
            for issue in mine:
                issue.remove()


async def review(request):
    """Body: {frame, decision: approve | needs_fix | reset, hash, note}."""
    session = current_session(request)
    task_id = request.path_params["task_id"]
    body = await request.json()
    name, decision = body.get("frame"), body.get("decision")
    if decision not in ("approve", "needs_fix", "reset"):
        raise HTTPException(422, "Unknown decision.")

    def apply():
        _, _, meta, _, jobs, names, hashes = load_task(session, task_id)
        if name not in hashes:
            raise HTTPException(404, "Frame not found in CVAT.")
        if decision == "approve":
            if body.get("hash") != hashes[name]:  # the boxes changed since the reviewer looked
                raise HTTPException(409, "The boxes on this frame changed in CVAT. Look at it again before approving.")
            mark_verified(name, hashes, session.username, task_id)
        else:
            set_status(name, "needs_fix" if decision == "needs_fix" else "pending", session.username, task_id)
        frame = names.index(name)
        job = job_for(jobs, frame)
        if job:
            update_issues(session, job, frame, decision, (body.get("note") or "").strip()[:500], frame_size(meta, frame))
        return sync_jobs(session, task_id, [frame])

    return JSONResponse({"warning": await run_in_threadpool(apply)})


async def assign(request):
    """Body: {assignments: [{username, start, stop}]}. Also assigns whole jobs in CVAT."""
    session = current_session(request)
    task_id = request.path_params["task_id"]
    body = await request.json()
    try:
        ranges = sorted(((str(a["username"]), int(a["start"]), int(a["stop"])) for a in body.get("assignments", [])),
                        key=lambda r: r[1])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(422, "Each assignment needs a reviewer, a first and a last frame.")

    def apply():
        *_, jobs, names, _ = load_task(session, task_id)
        previous_stop = -1
        for user, start, stop in ranges:
            if not user or not previous_stop < start <= stop < len(names):
                raise HTTPException(422, f"Frames for {user or 'a reviewer'} must be within 0-{len(names) - 1} and not overlap.")
            previous_stop = stop
        set_assignments(task_id, ranges)

        with session.lock:
            user_ids = {u.username: u.id for u in session.client.users.list()}
        refused = []
        for job in jobs:
            owner = next((u for u, a, b in ranges if a <= job.start_frame and job.stop_frame <= b), None)
            if owner in user_ids and getattr(job.assignee, "id", None) != user_ids[owner]:
                try:
                    with session.lock:
                        job.update({"assignee": user_ids[owner]})
                except ApiException:
                    refused.append(str(job.id))
        no_account = sorted({u for u, _, _ in ranges} - set(user_ids))
        notes = [f"CVAT didn't let you assign job {', '.join(refused)}." if refused else "",
                 f"{', '.join(no_account)} {'has' if len(no_account) == 1 else 'have'} no CVAT account yet, "
                 "so their CVAT jobs stay unassigned." if no_account else ""]
        return " ".join(n for n in notes if n) or None

    return JSONResponse({"warning": await run_in_threadpool(apply)})


# ---------------------------------------------------------------- changing boxes

def shape_fields(shape):
    """Every field CVAT needs to send a box back or recreate it (plain values, so it can be logged)."""
    fields = dict(
        type=shape.type.value, frame=shape.frame, label_id=shape.label_id, points=[float(v) for v in shape.points],
        group=shape.group, source=shape.source, occluded=shape.occluded, outside=shape.outside,
        z_order=shape.z_order, rotation=shape.rotation,
        attributes=[{"spec_id": a.spec_id, "value": a.value} for a in shape.attributes])
    if getattr(shape, "score", None) is not None:
        fields["score"] = shape.score
    return fields


def shape_request(fields, labels):
    """Turn shape_fields() back into a CVAT box. Attributes the class doesn't have are dropped (CVAT rejects them)."""
    allowed = {a.id for a in next(x for x in labels if x.id == fields["label_id"]).attributes}
    return models.LabeledShapeRequest(**{
        **fields, "type": models.ShapeType(fields["type"]), "elements": [],
        "attributes": [models.AttributeValRequest(**a) for a in fields["attributes"] if a["spec_id"] in allowed]})


def send_shapes(session, task, action, shapes):
    with session.lock:
        task.update_annotations(models.PatchedLabeledDataRequest(shapes=shapes, tags=[], tracks=[]), action=action)


def create_shapes(session, task, labels, fields_list):
    """Add boxes to CVAT and return their new ids, in the same order."""
    with session.lock:
        before = {s.id for s in task.get_annotations().shapes}
    send_shapes(session, task, AnnotationUpdateAction.CREATE, [shape_request(f, labels) for f in fields_list])
    with session.lock:
        new = [s for s in task.get_annotations().shapes if s.id not in before]
    ids = []
    for fields in fields_list:
        match = next(s for s in new if s.frame == fields["frame"] and s.id not in ids
                     and all(abs(float(a) - b) < 0.01 for a, b in zip(s.points, fields["points"])))
        ids.append(match.id)
    return ids


def boxes_by_frame(shapes):
    by_frame = {}
    for s in shapes:
        if s.type.value == "rectangle":
            by_frame.setdefault(s.frame, []).append(s)
    return by_frame


def same_cone(by_frame, start, max_gap=1, memo=None):
    """Follow the same cone into nearby frames (similar size, close by, mutual best match)."""
    memo = {} if memo is None else memo

    def shape_of(s):  # (centre x, centre y, size), worked out once per box
        if id(s) not in memo:
            x1, y1, x2, y2 = map(float, s.points)
            memo[id(s)] = ((x1 + x2) / 2, (y1 + y2) / 2, max(x2 - x1, y2 - y1, 1.0))
        return memo[id(s)]

    def closest(box, frame):  # the best match for `box` in `frame`, or None
        key = (id(box), frame)
        if key not in memo:
            cx, cy, size = shape_of(box)
            best, best_distance = None, 0.75 * size  # anything further away doesn't count
            for s in by_frame.get(frame, []):
                sx, sy, ssize = shape_of(s)
                distance = abs(sx - cx) + abs(sy - cy)
                if 0.5 <= ssize / size <= 2 and (distance < best_distance or (best is None and distance == best_distance)):
                    best, best_distance = s, distance
            memo[key] = best
        return memo[key]

    def link(box, frame):
        match = closest(box, frame)
        return match if match is not None and closest(match, box.frame) is box else None

    chain, seen = [start], {id(start)}
    for direction in (1, -1):
        box = start
        while True:
            match = next((m for gap in range(1, max_gap + 2) if (m := link(box, box.frame + direction * gap))), None)
            if match is None or id(match) in seen:
                break
            chain.append(match)
            seen.add(id(match))
            box = match
    return chain


def suggestions(shapes, labels):
    """Suggest a class for each unknown cone by majority vote across nearby frames."""
    unknown = unknown_label(labels)
    by_frame = boxes_by_frame(shapes)
    memo = {}  # shared by every cone below: following one cone saves work for its neighbours
    found = {}
    for frame_boxes in by_frame.values():
        for box in frame_boxes:
            if box.label_id == unknown:
                votes = Counter(t.label_id for t in same_cone(by_frame, box, memo=memo) if t.label_id != unknown)
                if votes:
                    label, count = votes.most_common(1)[0]
                    found[box.id] = {"label": label, "votes": count, "of": sum(votes.values())}
    return found


async def cone(request):
    """Change one box in CVAT: relabel, not_a_cone (delete) or undo_not_a_cone."""
    session = current_session(request)
    task_id, shape_id = request.path_params["task_id"], request.path_params["shape_id"]
    body = await request.json()
    action = body.get("action")
    if action not in ("relabel", "not_a_cone", "undo_not_a_cone"):
        raise HTTPException(422, "Unknown action.")
    ids = [int(i) for i in body.get("ids") or [shape_id]]

    def apply():
        task, annotations, _, labels, _, names, _ = load_task(session, task_id)

        if action == "undo_not_a_cone":
            saved = {i: fields for i in ids if (fields := deleted_shape(task_id, i)) is not None}
            if not saved:
                raise HTTPException(404, "There's no deleted box to put back.")
            new_ids = create_shapes(session, task, labels, list(saved.values()))
            for old_id, fields in saved.items():
                log_cone_change(task_id, names[fields["frame"]], old_id, action, None, fields["label_id"], session.username)
            return {"restored": dict(zip(saved, new_ids)),
                    "warning": sync_jobs(session, task_id, {f["frame"] for f in saved.values()})}

        shapes = {s.id: s for s in annotations.shapes}
        shape = shapes.get(shape_id)
        if shape is None:
            raise HTTPException(404, "This box is no longer in CVAT.")
        if shape.type.value != "rectangle":
            raise HTTPException(422, "Only boxes can be changed here.")
        if body.get("ids"):
            targets = [shapes[i] for i in ids if i in shapes]
        elif body.get("follow"):
            targets = [t for t in same_cone(boxes_by_frame(annotations.shapes), shape) if t.label_id == shape.label_id]
        else:
            targets = [shape]

        if action == "relabel":
            label, expected = body.get("label"), body.get("expected")
            if label not in {x.id for x in labels}:
                raise HTTPException(422, "Unknown class.")
            if shape.label_id != expected:
                raise HTTPException(409, "This box's class changed in CVAT. Look at it again.")
            targets = [t for t in targets if t.label_id == expected != label]
            if targets:
                send_shapes(session, task, AnnotationUpdateAction.UPDATE,
                            [shape_request({**shape_fields(t), "label_id": label, "id": t.id}, labels) for t in targets])
            for t in targets:
                log_cone_change(task_id, names[t.frame], t.id, action, expected, label, session.username)
        else:
            send_shapes(session, task, AnnotationUpdateAction.DELETE,
                        [shape_request({**shape_fields(t), "id": t.id}, labels) for t in targets])
            for t in targets:
                log_cone_change(task_id, names[t.frame], t.id, action, t.label_id, None, session.username, shape_fields(t))

        return {"ids": [t.id for t in targets], "warning": sync_jobs(session, task_id, {t.frame for t in targets})}

    return JSONResponse(await run_in_threadpool(apply))


async def add_box(request):
    """Body: {frame, label, x1, y1, x2, y2} in picture pixels. Draws a new box in CVAT."""
    session = current_session(request)
    task_id = request.path_params["task_id"]
    body = await request.json()

    def apply():
        task, _, meta, labels, _, names, _ = load_task(session, task_id)
        try:
            frame, label = int(body["frame"]), int(body["label"])
            x1, y1, x2, y2 = (float(body[k]) for k in ("x1", "y1", "x2", "y2"))
        except (KeyError, TypeError, ValueError):
            raise HTTPException(422, "A box needs a frame, a class and its corners.")
        if not 0 <= frame < len(names) or label not in {x.id for x in labels}:
            raise HTTPException(422, "Unknown frame or class.")
        size = frame_size(meta, frame)
        x1, x2 = sorted(min(max(v, 0.0), float(size.width)) for v in (x1, x2))  # keep it inside the picture
        y1, y2 = sorted(min(max(v, 0.0), float(size.height)) for v in (y1, y2))
        if x2 - x1 < 2 or y2 - y1 < 2:
            raise HTTPException(422, "That box is too small.")
        fields = dict(type="rectangle", frame=frame, label_id=label, points=[x1, y1, x2, y2], group=0,
                      source="manual", occluded=False, outside=False, z_order=0, rotation=0.0, attributes=[])
        [new_id] = create_shapes(session, task, labels, [fields])
        log_cone_change(task_id, names[frame], new_id, "add", None, label, session.username)
        return {"id": new_id, "warning": sync_jobs(session, task_id, [frame])}

    return JSONResponse(await run_in_threadpool(apply))


async def auto_sort(request):
    """Body: {ids}. Relabel unknown cones where at least 3 nearby frames agree."""
    session = current_session(request)
    task_id = request.path_params["task_id"]
    wanted = {int(i) for i in (await request.json()).get("ids", [])}

    def apply():
        task, annotations, _, labels, _, names, _ = load_task(session, task_id)
        unknown = unknown_label(labels)
        sure = {i: s for i, s in suggestions(annotations.shapes, labels).items() if i in wanted and s["votes"] == s["of"] >= 3}
        targets = [s for s in annotations.shapes if s.id in sure and s.label_id == unknown]
        if targets:
            send_shapes(session, task, AnnotationUpdateAction.UPDATE,
                        [shape_request({**shape_fields(t), "label_id": sure[t.id]["label"], "id": t.id}, labels) for t in targets])
        for t in targets:
            log_cone_change(task_id, names[t.frame], t.id, "relabel", unknown, sure[t.id]["label"], session.username)
        return {"changes": [{"id": t.id, "label": sure[t.id]["label"]} for t in targets],
                "warning": sync_jobs(session, task_id, {t.frame for t in targets})}

    return JSONResponse(await run_in_threadpool(apply))


# ---------------------------------------------------------------- new tasks and new people

def projects(request):
    session = current_session(request)
    with session.lock:
        found = session.client.projects.list()
    return JSONResponse([{"id": p.id, "name": p.name} for p in found])


class UploadProgress(BaseProgressReporter):
    """Counts the bytes CVAT's library has sent, so the page can show a progress bar."""

    def __init__(self, upload):
        super().__init__()
        self.upload = upload

    def start2(self, total, **kwargs):
        super().start2(total, **kwargs)
        self.upload.update(sent=0, total=total or 0)

    def advance(self, delta):
        super().advance(delta)
        self.upload["sent"] += delta


async def save_uploads(uploads, folder):
    """Save uploaded files under their own names (no folders): CVAT names frames after them."""
    folder.mkdir(parents=True, exist_ok=True)
    for upload in uploads:
        with open(folder / Path(upload.filename).name, "wb") as out:
            await run_in_threadpool(shutil.copyfileobj, upload.file, out)
    return sorted(folder.iterdir())


async def new_task(request):
    """Create a CVAT task from uploaded files, checking any box file first. Returns an upload id."""
    session = current_session(request)
    form = await request.form(max_files=100000)
    name = str(form.get("name", "")).strip()
    if not name:
        raise HTTPException(422, "Give the task a name.")
    media_files = [f for f in form.getlist("files") if getattr(f, "filename", "")]
    if not media_files:
        raise HTTPException(422, "Choose the pictures or the video for this task.")
    folder = Path(tempfile.mkdtemp(prefix="new_task_"))
    media = await save_uploads(media_files, folder / "media")
    box_files = await save_uploads([f for f in form.getlist("boxes") if getattr(f, "filename", "")], folder / "boxes")

    project = int(form["project"]) if form.get("project") else None
    if project:
        with session.lock:
            labels = [x.name for x in session.client.projects.retrieve(project).get_labels()]
    else:
        labels = list(CONE_COLOURS)

    def check():
        found = task_boxes.describe_media(media)
        kind, boxes, pictures = task_boxes.read_boxes(box_files)
        return found, kind, boxes, task_boxes.check_boxes(kind, boxes, pictures, found, labels)

    try:
        found, kind, boxes, summary = await run_in_threadpool(check)
    except (task_boxes.BoxProblem, ValueError, OSError) as exc:  # e.g. a picture or json that can't be read
        shutil.rmtree(folder, ignore_errors=True)
        raise HTTPException(422, str(exc))

    spec = {"name": name}
    if project:
        spec["project_id"] = project  # the project's labels are used
    else:
        spec["labels"] = [{"name": n, "color": c} for n, c in CONE_COLOURS.items()]
    if form.get("segment_size"):
        spec["segment_size"] = int(form["segment_size"])  # frames per CVAT job
    # use_cache=False makes CVAT prepare every chunk now: slower to create, much faster to review
    settings = {"image_quality": 70, "use_cache": form.get("prepare") != "on", "sorting_method": "natural"}
    cvat_import = {"annotation_path": str(box_files[0]), "annotation_format": boxes} if kind == "cvat" else {}

    upload_id = secrets.token_urlsafe(8)
    status = session.uploads[upload_id] = {"state": "sending", "sent": 0, "total": 0, "task_id": None,
                                           "error": None, "boxes": summary}

    def create():
        try:
            task = session.upload_client.tasks.create_from_data(
                spec, media, data_params=settings, pbar=UploadProgress(status), status_check_period=2, **cvat_import)
            if kind in ("frames", "names"):
                status["state"] = "adding boxes"
                add_boxes(task, kind, boxes, found, status)
            status.update(state="done", task_id=task.id)
        except Exception as exc:  # shown to the person who uploaded
            detail = getattr(exc, "body", None) or str(exc)
            status.update(state="failed", error=f"CVAT couldn't create the task: {str(detail)[:300]}")
        finally:
            shutil.rmtree(folder, ignore_errors=True)
            session.version += 1  # the home page should count the new task

    def watch():  # once every byte is sent, CVAT is still unpacking and preparing frames
        while status["state"] == "sending":
            if status["total"] and status["sent"] >= status["total"]:
                status["state"] = "preparing"
            time.sleep(0.5)

    threading.Thread(target=create, daemon=True).start()
    threading.Thread(target=watch, daemon=True).start()
    return JSONResponse({"upload": upload_id, "boxes": summary})


def add_boxes(task, kind, boxes, found, status):
    """Put SAM3's boxes on the new task, each on the frame it belongs to."""
    label_ids = {x.name: x.id for x in task.get_labels()}
    frame_names = [f.name for f in task.get_meta().frames]
    frame_of_name = {n: i for i, n in enumerate(frame_names)}  # CVAT sorted the pictures: ask it for the order

    def size_of_frame(frame):
        if found[0] == "video":
            return found[2]
        return found[1][frame_names[frame]]

    def shape(frame, label_id, points):
        return models.LabeledShapeRequest(type=models.ShapeType("rectangle"), frame=frame, label_id=label_id,
                                          points=points, occluded=False, outside=False, z_order=0)

    shapes, skipped = task_boxes.to_cvat_shapes(kind, boxes, frame_of_name, label_ids, size_of_frame, shape)
    task.set_annotations(models.LabeledDataRequest(version=0, tags=[], shapes=shapes, tracks=[]))
    status["boxes"] = f"{len(shapes):,} boxes added" + (f", {skipped} skipped (no area or not a number)" if skipped else "")


def upload_status(request):
    session = current_session(request)
    status = session.uploads.get(request.path_params["upload_id"])
    if status is None:
        raise HTTPException(404, "No such upload.")
    return JSONResponse(status)


async def add_user(request):
    """Body: {username, email, password}. Create a CVAT account via sign-up."""
    current_session(request)
    body = await request.json()
    username, email, password = (str(body.get(k, "")).strip() for k in ("username", "email", "password"))
    if not (username and email and password):
        raise HTTPException(422, "A new CVAT account needs a username, an email and a password.")

    def register():
        with make_client(host=HOST) as client:  # a fresh connection that isn't logged in as you
            client.api_client.auth_api.create_register(models.RegisterSerializerExRequest(
                username=username, email=email, password1=password, password2=password))

    try:
        await run_in_threadpool(register)
    except ApiException as exc:
        detail = (getattr(exc, "body", None) or "").strip()
        raise HTTPException(422, f"CVAT didn't create the account: {detail[:300] or exc.status}")
    return JSONResponse({"username": username})


# ---------------------------------------------------------------- export (download a zip)

def yolo_lines(boxes, label_names, size, name):
    """A frame's boxes as YOLO label lines: class x-centre y-centre width height (all 0 to 1)."""
    lines = []
    for shape in boxes:
        label = label_names.get(shape.label_id)
        x1, y1, x2, y2 = map(float, shape.points)
        if shape.type.value != "rectangle":
            raise HTTPException(422, f"{name} has a shape that isn't a box. Fix it in CVAT first.")
        if label not in EXPORT_CLASSES:
            raise HTTPException(422, f"{name} has a box of an unknown class ({label}).")
        if not (0 <= x1 < x2 <= size.width and 0 <= y1 < y2 <= size.height):
            raise HTTPException(422, f"{name} has a box outside the picture.")
        lines.append(f"{EXPORT_CLASSES.index(label)} {(x1 + x2) / 2 / size.width:.6f} {(y1 + y2) / 2 / size.height:.6f} "
                     f"{(x2 - x1) / size.width:.6f} {(y2 - y1) / size.height:.6f}")
    return lines


def build_export(session, task_id, path):
    """Zip the still-approved frames as a YOLO dataset. Returns (task name, frame count)."""
    task, annotations, meta, labels, _, names, hashes = load_task(session, task_id)
    statuses = task_statuses(hashes, task_id)
    approved = [i for i, name in enumerate(names) if statuses.get(name, {}).get("status") == "verified"]
    if not approved:
        raise HTTPException(404, "No approved frames to export yet.")

    on_frame = {}
    for shape in annotations.shapes:
        on_frame.setdefault(shape.frame, []).append(shape)
    label_names = {x.id: x.name for x in labels}
    # Check every frame's boxes first, so a problem shows up before the long download
    lines = {i: yolo_lines(on_frame.get(i, []), label_names, frame_size(meta, i), names[i]) for i in approved}

    with zipfile.ZipFile(path, "w") as archive:
        chunk = {}
        for i in approved:
            if i not in chunk:
                with session.image_lock:
                    chunk = chunk_frames(session, task_id, i, quality="original")
            picture = chunk.get(i)
            if picture is None:
                with session.image_lock:
                    picture = session.image_client.tasks.retrieve(task_id).get_frame(i, quality="original").read()
            if picture[:2] != b"\xff\xd8":  # not a JPEG (e.g. PNG): convert, so the dataset is all JPEG
                out = io.BytesIO()
                Image.open(io.BytesIO(picture)).convert("RGB").save(out, "JPEG", quality=95)
                picture = out.getvalue()
            stem = Path(names[i]).stem
            archive.writestr(f"images/{stem}.jpg", picture)
            archive.writestr(f"labels/{stem}.txt", "".join(line + "\n" for line in lines[i]))
        archive.writestr("data.yaml", "names:\n" + "".join(f"  {k}: {n}\n" for k, n in enumerate(EXPORT_CLASSES)))
    return task.name, len(approved)


async def export(request):
    session = current_session(request)
    task_id = request.path_params["task_id"]
    handle, path = tempfile.mkstemp(suffix=".zip")
    os.close(handle)
    try:
        name, count = await run_in_threadpool(build_export, session, task_id, path)
    except BaseException:
        os.unlink(path)
        raise
    filename = f"{re.sub(r'[^A-Za-z0-9._-]+', '_', name).strip('_') or 'task'}_approved_{count}_{date.today()}.zip"
    return FileResponse(path, media_type="application/zip", filename=filename,
                        headers={"X-Frame-Count": str(count)}, background=BackgroundTask(os.unlink, path))


# ---------------------------------------------------------------- the app

def index(_request):
    return HTMLResponse((WEB / "index.html").read_text())


async def http_error(_request, exc):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)


async def cvat_error(_request, exc):
    if exc.status in (401, 403):
        return JSONResponse({"detail": "CVAT rejected the request. Log in again."}, status_code=401)
    return JSONResponse({"detail": f"CVAT returned an error ({exc.status})."}, status_code=502)


async def fresh_answers(request, call_next):
    """Bump the session version on changes and disable caching for API responses."""
    try:
        session = current_session(request) if request.method == "POST" else None
    except HTTPException:
        session = None
    if session:
        session.version += 1
    response = await call_next(request)
    if session:
        session.version += 1
    path = request.url.path
    if path.startswith("/api/") and not path.endswith("/image"):
        response.headers["Cache-Control"] = "no-store"
    elif path == "/" or path.startswith("/web/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


app = Starlette(
    middleware=[Middleware(BaseHTTPMiddleware, dispatch=fresh_answers)],
    exception_handlers={HTTPException: http_error, ApiException: cvat_error},
    routes=[
        Route("/", index),
        Mount("/web", StaticFiles(directory=WEB)),
        Route("/api/login", login, methods=["POST"]),
        Route("/api/logout", logout, methods=["POST"]),
        Route("/api/me", me),
        Route("/api/tasks", tasks),
        Route("/api/users", users),
        Route("/api/users", add_user, methods=["POST"]),
        Route("/api/projects", projects),
        Route("/api/tasks/new", new_task, methods=["POST"]),
        Route("/api/uploads/{upload_id}", upload_status),
        Route("/api/overview", overview),
        Route("/api/tasks/{task_id:int}/summary", summary),
        Route("/api/tasks/{task_id:int}/frames", frames),
        Route("/api/tasks/{task_id:int}/frames/{index:int}/image", frame_image),
        Route("/api/tasks/{task_id:int}/review", review, methods=["POST"]),
        Route("/api/tasks/{task_id:int}/assignments", assign, methods=["POST"]),
        Route("/api/tasks/{task_id:int}/cones/{shape_id:int}", cone, methods=["POST"]),
        Route("/api/tasks/{task_id:int}/boxes", add_box, methods=["POST"]),
        Route("/api/tasks/{task_id:int}/auto_sort", auto_sort, methods=["POST"]),
        Route("/api/tasks/{task_id:int}/export.zip", export),
    ],
)


if __name__ == "__main__":
    port = int(os.getenv("REVIEW_PORT", "8092"))  # not 8090: CVAT already uses it
    print(f"Review page: http://localhost:{port}")
    uvicorn.run(app, host=os.getenv("REVIEW_BIND", "127.0.0.1"), port=port, log_level="warning")
