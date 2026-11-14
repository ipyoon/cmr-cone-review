import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from cvat_fingerprint import get_frame_hashes
from cvat_sdk import make_client
from cvat_auth import login

DB = os.getenv("VERIFICATION_DB", "verification.db")
TASK_ID = int(os.getenv("CVAT_TASK_ID", "3"))
_wal = set()          # databases already switched to WAL by this process
_registered = set()   # (database, task, frame names) already registered by this process


@contextmanager
def connect():
    """One transaction: committed on success, rolled back on error, always closed.

    The review page reads and writes from several threads at once. WAL lets reads go
    on while one write is happening, and the timeout makes a write wait its turn
    instead of failing with "database is locked".
    """
    db = sqlite3.connect(DB, timeout=30)
    try:
        if DB not in _wal:
            db.execute("PRAGMA journal_mode=WAL")
            _wal.add(DB)
        with db:
            yield db
    finally:
        db.close()


# Create the table if needed and register frames as pending
def register_frames(names, task_id=TASK_ID):
    key = (DB, task_id, hash(tuple(names)))
    if key in _registered:  # nothing new to write: the page asks for this on every load
        return
    with connect() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS frame_reviews (
                task_id INTEGER,
                frame_name TEXT,
                status TEXT DEFAULT 'pending',
                reviewer TEXT,
                reviewed_at TEXT,
                annotation_hash TEXT,
                PRIMARY KEY (task_id, frame_name)
            )
        """)

        # Support older databases
        columns = [c[1] for c in db.execute("PRAGMA table_info(frame_reviews)")]
        if "annotation_hash" not in columns:
            db.execute("ALTER TABLE frame_reviews ADD COLUMN annotation_hash TEXT")

        db.executemany("""
            INSERT OR IGNORE INTO frame_reviews (task_id, frame_name)
            VALUES (?, ?)
        """, [(task_id, name) for name in names])
    _registered.add(key)


def setup():
    with make_client(host=os.getenv("CVAT_HOST", "http://localhost:8080")) as client:
        login(client)
        hashes = get_frame_hashes(client)
    register_frames(hashes)
    print(f"Ready! {len(hashes)} frames registered.")


# Save approval and fingerprint
def mark_verified(frame_name, hashes, reviewer, task_id=TASK_ID):
    if frame_name not in hashes:
        raise ValueError("Frame not found in CVAT")

    with connect() as db:
        result = db.execute("""
            UPDATE frame_reviews
            SET status = 'verified', reviewer = ?,
                reviewed_at = ?, annotation_hash = ?
            WHERE task_id = ? AND frame_name = ?
        """, (
            reviewer,
            datetime.now(timezone.utc).isoformat(),
            hashes[frame_name],
            task_id,
            frame_name
        ))

        if result.rowcount == 0:
            raise ValueError("Frame not registered")

    print(f"Verified: {frame_name}")


# Mark a frame as needing a fix, or put it back to pending (no fingerprint kept)
def set_status(frame_name, status, reviewer, task_id=TASK_ID):
    with connect() as db:
        result = db.execute("""
            UPDATE frame_reviews
            SET status = ?, reviewer = ?, reviewed_at = ?, annotation_hash = NULL
            WHERE task_id = ? AND frame_name = ?
        """, (status, reviewer, datetime.now(timezone.utc).isoformat(), task_id, frame_name))

        if result.rowcount == 0:
            raise ValueError("Frame not registered")


# Every frame's current status, for showing a whole task at once
def task_statuses(hashes, task_id=TASK_ID):
    with connect() as db:
        rows = db.execute("""
            SELECT frame_name, status, reviewer, annotation_hash FROM frame_reviews
            WHERE task_id = ?
        """, (task_id,)).fetchall()

    statuses = {}
    for name, status, reviewer, saved_hash in rows:
        if status == "verified" and saved_hash != hashes.get(name):
            status = "needs_reverification"
        statuses[name] = {"status": status, "reviewer": reviewer}
    return statuses


# Every cone class change and deleted box, so each one can be traced and undone.
# action is 'relabel', 'add', 'not_a_cone' (box deleted; shape keeps it) or 'undo_not_a_cone'.
def log_cone_change(task_id, frame_name, shape_id, action, old_label, new_label,
                    reviewer, shape=None):
    with connect() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS cone_changes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER, frame_name TEXT, shape_id INTEGER,
                action TEXT, old_label INTEGER, new_label INTEGER,
                previous_status TEXT, reviewer TEXT, changed_at TEXT, shape_json TEXT
            )
        """)

        # Support older databases
        columns = [c[1] for c in db.execute("PRAGMA table_info(cone_changes)")]
        if "shape_json" not in columns:
            db.execute("ALTER TABLE cone_changes ADD COLUMN shape_json TEXT")

        db.execute("""
            INSERT INTO cone_changes (task_id, frame_name, shape_id, action, old_label,
                new_label, reviewer, changed_at, shape_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (task_id, frame_name, shape_id, action, old_label, new_label, reviewer,
              datetime.now(timezone.utc).isoformat(), json.dumps(shape) if shape else None))


# The box deleted as "not a cone", to put it back; None if there's none or it's already back
def deleted_shape(task_id, shape_id):
    with connect() as db:
        row = db.execute("""
            SELECT action, shape_json FROM cone_changes
            WHERE task_id = ? AND shape_id = ? AND action IN ('not_a_cone', 'undo_not_a_cone')
            ORDER BY id DESC LIMIT 1
        """, (task_id, shape_id)).fetchone()
    if row and row[0] == "not_a_cone" and row[1]:
        return json.loads(row[1])
    return None


# Who reviews which frames: [(username, first frame, last frame)]
def _assignments_table(db):
    db.execute("""
        CREATE TABLE IF NOT EXISTS assignments (
            task_id INTEGER, username TEXT, frame_start INTEGER, frame_stop INTEGER
        )
    """)


def set_assignments(task_id, ranges):
    with connect() as db:
        _assignments_table(db)
        db.execute("DELETE FROM assignments WHERE task_id = ?", (task_id,))
        db.executemany("INSERT INTO assignments VALUES (?, ?, ?, ?)",
                       [(task_id, user, start, stop) for user, start, stop in ranges])


def get_assignments(task_id):
    with connect() as db:
        _assignments_table(db)
        return db.execute("""
            SELECT username, frame_start, frame_stop FROM assignments
            WHERE task_id = ? ORDER BY frame_start
        """, (task_id,)).fetchall()


# Check whether approval is still valid
def check_verification(frame_name, hashes, task_id=TASK_ID):
    with connect() as db:
        row = db.execute("""
            SELECT status, annotation_hash FROM frame_reviews
            WHERE task_id = ? AND frame_name = ?
        """, (task_id, frame_name)).fetchone()

    if row is None:
        return "not_registered"

    status, saved_hash = row

    if status == "verified" and saved_hash != hashes.get(frame_name):
        return "needs_reverification"

    return status


if __name__ == "__main__":
    setup()