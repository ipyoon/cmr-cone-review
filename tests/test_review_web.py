"""Run:  venv/bin/python -m unittest tests/test_review_web.py -v

Runs the real review server and export script against tests/fake_cvat.py.
"""

import http.cookiejar
import io
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).parent))
TMP = Path(tempfile.mkdtemp())
os.environ["VERIFICATION_DB"] = str(TMP / "test.db")
os.environ["CVAT_TASK_ID"] = "3"

import fake_cvat  # noqa: E402

fake_cvat.install()

import uvicorn  # noqa: E402

import review_web  # noqa: E402

PORT = 8097
BASE = f"http://127.0.0.1:{PORT}"


class Browser:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(BASE + path, data=data, headers={"Content-Type": "application/json"})
        try:
            with self.opener.open(request) as res:
                raw = res.read()
                return res.status, json.loads(raw) if res.headers["content-type"].startswith("application/json") else raw
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read() or b"{}")

    def upload(self, fields, files):
        """POST a form with files, like the New task dialog: files is [(field, name, bytes)]."""
        boundary = "----test"
        parts = [(n, None, v.encode()) for n, v in fields.items()] + files
        body = b"".join(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{n}"'.encode()
            + (f'; filename="{f}"\r\nContent-Type: application/octet-stream'.encode() if f else b"")
            + b"\r\n\r\n" + data + b"\r\n" for n, f, data in parts) + f"--{boundary}--\r\n".encode()
        request = urllib.request.Request(BASE + "/api/tasks/new", data=body,
                                         headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        try:
            with self.opener.open(request) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read() or b"{}")

    def wait_for(self, upload):
        for _ in range(50):  # tasks are created in the background
            status = self.call(f"/api/uploads/{upload}")[1]
            if status["state"] in ("done", "failed"):
                return status
            time.sleep(0.1)
        return status

    def login(self):
        self.call("/api/login", {"username": "tester", "password": "test-pass"})
        return self


def frame_row(browser, name):
    return next(f for f in browser.call("/api/tasks/3/frames")[1]["frames"] if f["name"] == name)


class ReviewWebTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = uvicorn.Server(uvicorn.Config(review_web.app, host="127.0.0.1", port=PORT, log_level="error"))
        threading.Thread(target=cls.server.run, daemon=True).start()
        while not cls.server.started:
            time.sleep(0.02)

    @classmethod
    def tearDownClass(cls):
        cls.server.should_exit = True

    def test_requires_login_and_rejects_wrong_password(self):
        b = Browser()
        self.assertEqual(b.call("/api/tasks")[0], 401)
        self.assertEqual(b.call("/api/tasks/3/frames")[0], 401)
        self.assertEqual(b.call("/api/tasks/3/frames/0/image")[0], 401)
        status, body = b.call("/api/login", {"username": "tester", "password": "nope"})
        self.assertEqual(status, 401)
        self.assertIn("Wrong", body["detail"])
        self.assertEqual(b.call("/api/me")[0], 401)

    def test_page_and_frames_load(self):
        b = Browser().login()
        self.assertIn(b"<title>Sammie", b.call("/")[1])
        self.assertEqual(b.call("/api/me")[1]["username"], "tester")
        data = b.call("/api/tasks/3/frames")[1]
        self.assertEqual(len(data["frames"]), 15)
        self.assertGreater(len(data["frames"][0]["boxes"]), 0)
        status, image = b.call("/api/tasks/3/frames/0/image")
        self.assertEqual(status, 200)
        self.assertEqual(image[:2], b"\xff\xd8")  # JPEG
        status, thumb = b.call("/api/tasks/3/frames/0/image?size=small")  # gallery size
        self.assertEqual((status, thumb[:2]), (200, b"\xff\xd8"))
        self.assertLess(len(thumb), len(image))

    def test_gallery_loads_frames_a_chunk_at_a_time(self):
        b = Browser().login()
        before = fake_cvat.TASK.chunk_requests
        for i in range(8, 12):  # one chunk of 4 frames
            status, image = b.call(f"/api/tasks/3/frames/{i}/image?size=small")
            self.assertEqual((status, image[:2]), (200, b"\xff\xd8"))
        status, image = b.call("/api/tasks/3/frames/9/image")  # full size, from the same chunk
        self.assertEqual(image, fake_cvat.TASK.paths[9].read_bytes())
        time.sleep(0.3)  # let the next chunk (12-14) finish loading in the background
        self.assertEqual(fake_cvat.TASK.chunk_requests - before, 2)  # this chunk + the next one, nothing more
        b.call("/api/tasks/3/frames/12/image")  # already there; and it's the last chunk, so nothing more to fetch
        time.sleep(0.3)
        self.assertEqual(fake_cvat.TASK.chunk_requests - before, 2)

    def test_approve_then_edit_makes_it_stale(self):
        b = Browser().login()
        row = frame_row(b, "frame_0002.jpg")
        self.assertEqual(b.call("/api/tasks/3/review", {"frame": row["name"], "decision": "approve", "hash": row["hash"]})[0], 200)
        row = frame_row(b, "frame_0002.jpg")
        self.assertEqual((row["status"], row["reviewer"]), ("verified", "tester"))
        # Someone moves a box in CVAT: the approval no longer holds
        shape = next(s for s in fake_cvat.TASK.shapes if s.frame == 2)
        shape.points[0] += 5
        self.addCleanup(lambda: shape.points.__setitem__(0, shape.points[0] - 5))
        self.assertEqual(frame_row(b, "frame_0002.jpg")["status"], "needs_reverification")

    def test_cannot_approve_boxes_you_did_not_see(self):
        b = Browser().login()
        seen = frame_row(b, "frame_0003.jpg")["hash"]
        shape = next(s for s in fake_cvat.TASK.shapes if s.frame == 3)
        shape.points[0] += 5
        self.addCleanup(lambda: shape.points.__setitem__(0, shape.points[0] - 5))
        status, body = b.call("/api/tasks/3/review", {"frame": "frame_0003.jpg", "decision": "approve", "hash": seen})
        self.assertEqual(status, 409)
        self.assertIn("changed", body["detail"])
        self.assertEqual(frame_row(b, "frame_0003.jpg")["status"], "pending")

    def test_needs_fix_and_undo(self):
        b = Browser().login()
        b.call("/api/tasks/3/review", {"frame": "frame_0004.jpg", "decision": "needs_fix"})
        self.assertEqual(frame_row(b, "frame_0004.jpg")["status"], "needs_fix")
        b.call("/api/tasks/3/review", {"frame": "frame_0004.jpg", "decision": "reset"})
        self.assertEqual(frame_row(b, "frame_0004.jpg")["status"], "pending")
        self.assertEqual(b.call("/api/tasks/3/review", {"frame": "nope.jpg", "decision": "reset"})[0], 404)
        self.assertEqual(b.call("/api/tasks/3/review", {"frame": "frame_0004.jpg", "decision": "x"})[0], 422)
        for i in list(fake_cvat.JOB.issues):  # keep other tests' issue checks clean
            if i.frame == 4:
                fake_cvat.JOB.issues.remove(i)

    def test_relabel_cone_changes_cvat_logs_it_and_unapproves_frame(self):
        b = Browser().login()
        shape = next(s for s in fake_cvat.TASK.shapes if s.label_id == 5 and s.frame >= 8)
        name = fake_cvat.TASK.paths[shape.frame].name
        row = frame_row(b, name)
        b.call("/api/tasks/3/review", {"frame": name, "decision": "approve", "hash": row["hash"]})
        self.assertEqual(frame_row(b, name)["status"], "verified")

        status, _ = b.call(f"/api/tasks/3/cones/{shape.id}", {"action": "relabel", "label": 1, "expected": 5})
        self.assertEqual(status, 200)
        changed = next(s for s in fake_cvat.TASK.shapes if s.id == shape.id)
        self.addCleanup(lambda: fake_cvat.TASK.update_annotations(NS(shapes=[shape])))
        self.assertEqual(changed.label_id, 1)
        self.assertEqual(changed.points, shape.points)  # only the class changed
        self.assertEqual(frame_row(b, name)["status"], "needs_reverification")
        with sqlite3.connect(os.environ["VERIFICATION_DB"]) as db:
            log = db.execute("SELECT action, old_label, new_label, reviewer FROM cone_changes"
                             " WHERE shape_id = ?", (shape.id,)).fetchall()
        self.assertEqual(log, [("relabel", 5, 1, "tester")])

        # Someone else already changed it: the old view must not overwrite it
        status, body = b.call(f"/api/tasks/3/cones/{shape.id}", {"action": "relabel", "label": 2, "expected": 5})
        self.assertEqual(status, 409)
        self.assertEqual(next(s for s in fake_cvat.TASK.shapes if s.id == shape.id).label_id, 1)
        self.assertEqual(b.call("/api/tasks/3/cones/1", {"action": "relabel", "label": 2, "expected": 5})[0], 404)
        self.assertEqual(b.call(f"/api/tasks/3/cones/{shape.id}", {"action": "relabel", "label": 99, "expected": 1})[0], 422)

    def test_not_a_cone_deletes_box_in_cvat_and_undo_puts_it_back(self):
        b = Browser().login()
        shape = next(s for s in fake_cvat.TASK.shapes if s.frame == 12)
        name = fake_cvat.TASK.paths[12].name
        row = frame_row(b, name)
        b.call("/api/tasks/3/review", {"frame": name, "decision": "approve", "hash": row["hash"]})

        self.assertEqual(b.call(f"/api/tasks/3/cones/{shape.id}", {"action": "not_a_cone"})[0], 200)
        self.assertNotIn(shape.id, [s.id for s in fake_cvat.TASK.shapes])
        self.assertEqual(frame_row(b, name)["status"], "needs_reverification")

        status, body = b.call(f"/api/tasks/3/cones/{shape.id}", {"action": "undo_not_a_cone"})
        self.assertEqual(status, 200)
        back = next(s for s in fake_cvat.TASK.shapes if s.id == body["restored"][str(shape.id)])
        self.assertEqual((back.frame, back.label_id, back.points), (shape.frame, shape.label_id, shape.points))
        self.assertEqual(frame_row(b, name)["status"], "verified")  # same boxes as approved
        self.assertEqual(b.call(f"/api/tasks/3/cones/{shape.id}", {"action": "undo_not_a_cone"})[0], 404)

    def test_needs_fix_opens_cvat_issue_and_job_state_follows(self):
        b = Browser().login()
        name = "frame_0005.jpg"
        b.call("/api/tasks/3/review", {"frame": name, "decision": "needs_fix", "note": "missed a cone"})
        issues = [i for i in fake_cvat.JOB.issues if i.frame == 5 and not i.resolved]
        self.assertEqual([i.message for i in issues], ["Needs fix: missed a cone"])
        self.assertEqual(fake_cvat.JOB.state, "rejected")

        row = frame_row(b, name)
        b.call("/api/tasks/3/review", {"frame": name, "decision": "approve", "hash": row["hash"]})
        self.assertTrue(all(i.resolved for i in fake_cvat.JOB.issues if i.frame == 5))
        self.assertNotEqual(fake_cvat.JOB.state, "rejected")

        b.call("/api/tasks/3/review", {"frame": name, "decision": "needs_fix"})
        b.call("/api/tasks/3/review", {"frame": name, "decision": "reset"})  # undo removes the issue
        self.assertFalse([i for i in fake_cvat.JOB.issues if i.frame == 5 and not i.resolved])

        for row in b.call("/api/tasks/3/frames")[1]["frames"]:
            b.call("/api/tasks/3/review", {"frame": row["name"], "decision": "approve", "hash": row["hash"]})
        self.assertEqual(fake_cvat.JOB.state, "completed")

    def test_assign_frames_to_reviewers(self):
        b = Browser().login()
        self.assertEqual(b.call("/api/users")[1], ["alex", "tester"])
        split = [{"username": "tester", "start": 0, "stop": 7}, {"username": "alex", "start": 8, "stop": 14}]
        self.assertEqual(b.call("/api/tasks/3/assignments", {"assignments": split}), (200, {"warning": None}))
        self.assertEqual(b.call("/api/tasks/3/frames")[1]["assignments"], split)
        self.assertIsNone(fake_cvat.JOB.assignee)  # the one job spans both reviewers

        everything = [{"username": "alex", "start": 0, "stop": 14}]
        b.call("/api/tasks/3/assignments", {"assignments": everything})
        self.assertEqual(fake_cvat.JOB.assignee.username, "alex")  # assigned in CVAT too

        overlap = [{"username": "tester", "start": 0, "stop": 8}, {"username": "alex", "start": 8, "stop": 14}]
        self.assertEqual(b.call("/api/tasks/3/assignments", {"assignments": overlap})[0], 422)
        self.assertEqual(b.call("/api/tasks/3/assignments", {"assignments": [{"username": "x", "start": 0, "stop": 99}]})[0], 422)
        b.call("/api/tasks/3/assignments", {"assignments": []})
        self.assertEqual(b.call("/api/tasks/3/frames")[1]["assignments"], [])

    def test_a_change_touches_only_the_chosen_box(self):
        b = Browser().login()
        b.call("/api/tasks/3/frames")  # registers the frames
        # The orange cone at the bottom left; the same cone in other frames must stay as it is
        start = next(s for s in fake_cvat.TASK.shapes if s.frame == 5 and s.label_id == 3)
        chain = [s for s in review_web.same_cone(review_web.boxes_by_frame(fake_cvat.TASK.shapes), start) if s.label_id == 3]
        self.assertGreater(len(chain), 5)

        status, body = b.call(f"/api/tasks/3/cones/{start.id}", {"action": "relabel", "label": 4, "expected": 3, "follow": True})
        self.assertEqual((status, body["ids"]), (200, [start.id]))
        labels = {s.id: s.label_id for s in fake_cvat.TASK.shapes}
        self.assertEqual([labels[s.id] for s in chain if s.id != start.id], [3] * (len(chain) - 1))
        b.call(f"/api/tasks/3/cones/{start.id}", {"action": "relabel", "label": 3, "expected": 4})

        # Delete it, then put it back
        status, body = b.call(f"/api/tasks/3/cones/{start.id}", {"action": "not_a_cone", "follow": True})
        self.assertEqual(body["ids"], [start.id])
        status, back = b.call(f"/api/tasks/3/cones/{start.id}", {"action": "undo_not_a_cone", "ids": body["ids"]})
        self.assertEqual(len(back["restored"]), 1)

    def test_move_a_box(self):
        b = Browser().login()
        b.call("/api/tasks/3/frames")
        shape = next(s for s in fake_cvat.TASK.shapes if s.frame == 2)
        old = [float(v) for v in shape.points]
        moved = {"x1": old[0] + 5, "y1": old[1] + 5, "x2": old[2] + 10, "y2": old[3] + 10}

        status, body = b.call(f"/api/tasks/3/cones/{shape.id}", {"action": "move", "expected": old, **moved})
        self.assertEqual(status, 200)
        now = next(s for s in fake_cvat.TASK.shapes if s.id == shape.id)
        self.assertEqual([float(v) for v in now.points], [moved[k] for k in ("x1", "y1", "x2", "y2")])
        self.assertEqual(now.label_id, shape.label_id)

        # Someone else moved it since: refuse
        self.assertEqual(b.call(f"/api/tasks/3/cones/{shape.id}", {"action": "move", "expected": old, **moved})[0], 409)

        # A box dragged past the edge stays inside the picture
        expected = [float(v) for v in now.points]
        status, _ = b.call(f"/api/tasks/3/cones/{shape.id}", {"action": "move", "expected": expected,
                                                               "x1": -50, "y1": old[1], "x2": old[2], "y2": old[3]})
        now = next(s for s in fake_cvat.TASK.shapes if s.id == shape.id)
        self.assertEqual((status, float(now.points[0])), (200, 0))

    def test_unknown_cones_get_suggestions_and_auto_sort(self):
        b = Browser().login()
        boxes = [x for f in b.call("/api/tasks/3/frames")[1]["frames"] for x in f["boxes"]]
        unknown = [x for x in boxes if x["label"] == 5]
        suggested = [x for x in unknown if x["suggest"]]
        self.assertGreater(len(suggested), len(unknown) // 2)
        self.assertTrue(all(x["suggest"] is None for x in boxes if x["label"] != 5))

        sure = [x for x in suggested if x["suggest"]["votes"] == x["suggest"]["of"] >= 3]
        status, body = b.call("/api/tasks/3/auto_sort", {"ids": [x["id"] for x in unknown]})
        self.assertEqual(status, 200)
        self.assertEqual(sorted(c["id"] for c in body["changes"]), sorted(x["id"] for x in sure))
        labels = {s.id: s.label_id for s in fake_cvat.TASK.shapes}
        for c in body["changes"]:
            self.assertEqual(labels[c["id"]], c["label"])
            fake_cvat.TASK.update_annotations(NS(shapes=[NS(id=c["id"], frame=next(s.frame for s in fake_cvat.TASK.shapes if s.id == c["id"]),
                                                            label_id=5, points=next(s.points for s in fake_cvat.TASK.shapes if s.id == c["id"]))]))

    def test_draw_a_new_box(self):
        b = Browser().login()
        row = frame_row(b, "frame_0006.jpg")
        status, body = b.call("/api/tasks/3/boxes", {"frame": 6, "label": 2, "x1": 500, "y1": 600, "x2": 530, "y2": 650})
        self.assertEqual(status, 200)
        added = next(s for s in fake_cvat.TASK.shapes if s.id == body["id"])
        self.assertEqual((added.frame, added.label_id, added.points), (6, 2, [500.0, 600.0, 530.0, 650.0]))
        self.assertNotEqual(frame_row(b, "frame_0006.jpg")["hash"], row["hash"])  # the frame's boxes changed
        b.call(f"/api/tasks/3/cones/{body['id']}", {"action": "not_a_cone"})  # undo
        self.assertEqual(b.call("/api/tasks/3/boxes", {"frame": 6, "label": 2, "x1": 5, "y1": 5, "x2": 6, "y2": 6})[0], 422)
        self.assertEqual(b.call("/api/tasks/3/boxes", {"frame": 99, "label": 2, "x1": 0, "y1": 0, "x2": 50, "y2": 50})[0], 422)

    def test_home_page_overview_and_progress(self):
        b = Browser().login()
        b.call("/api/tasks/3/assignments", {"assignments": [{"username": "tester", "start": 0, "stop": 9}]})
        self.addCleanup(lambda: b.call("/api/tasks/3/assignments", {"assignments": []}))
        tasks = b.call("/api/overview")[1]["tasks"]
        self.assertEqual(tasks[0]["assignments"], [{"username": "tester", "start": 0, "stop": 9}])
        row = frame_row(b, "frame_0001.jpg")
        b.call("/api/tasks/3/review", {"frame": row["name"], "decision": "approve", "hash": row["hash"]})
        progress = b.call("/api/tasks/3/summary")[1]
        mine = progress["assignments"][0]
        self.assertEqual(mine["frames"], 10)
        self.assertGreaterEqual(mine["approved"], 1)
        unknown = sum(1 for s in fake_cvat.TASK.shapes if s.label_id == 5 and s.frame <= 9)
        self.assertEqual(mine["unknown"], unknown)
        self.assertEqual(progress["task"]["frames"], 15)

    def test_export_includes_approved_frame_when_frame_0_is_not(self):
        """Regression: export used to fail unless the first frame was approved."""
        b = Browser().login()
        row = frame_row(b, "frame_0007.jpg")
        b.call("/api/tasks/3/review", {"frame": row["name"], "decision": "approve", "hash": row["hash"]})
        self.assertNotEqual(frame_row(b, "frame_0000.jpg")["status"], "verified")
        archive = zipfile.ZipFile(io.BytesIO(b.call("/api/tasks/3/export.zip")[1]))
        self.assertTrue(archive.read("labels/frame_0007.txt").strip())

    def test_export_download_has_images_labels_and_yaml(self):
        """The page's download holds the approved frames with YOLO labels."""
        b = Browser().login()
        row = frame_row(b, "frame_0009.jpg")
        b.call("/api/tasks/3/review", {"frame": row["name"], "decision": "approve", "hash": row["hash"]})
        status, raw = b.call("/api/tasks/3/export.zip")
        self.assertEqual(status, 200)
        archive = zipfile.ZipFile(io.BytesIO(raw))
        files = set(archive.namelist())
        self.assertIn("images/frame_0009.jpg", files)
        self.assertIn("labels/frame_0009.txt", files)
        self.assertIn("data.yaml", files)
        self.assertEqual(archive.read("images/frame_0009.jpg")[:2], b"\xff\xd8")
        labels = archive.read("labels/frame_0009.txt").decode().split("\n")
        boxes = [s for s in fake_cvat.TASK.shapes if s.frame == 9]
        self.assertEqual(len([line for line in labels if line]), len(boxes))
        for line in filter(None, labels):
            cls, *xywh = line.split()
            self.assertTrue(0 <= int(cls) <= 4)
            self.assertTrue(all(0 <= float(v) <= 1 for v in xywh))


    def test_create_a_task_from_uploaded_pictures(self):
        b = Browser().login()
        self.assertEqual(b.call("/api/projects")[1], [{"id": 1, "name": "Driverless"}])
        boundary = "----test"
        parts = [("name", None, b"Night run 2"), ("prepare", None, b"on"), ("segment_size", None, b"100")]
        parts += [("files", p.name, p.read_bytes()) for p in fake_cvat.TASK.paths[:3]]
        body = b"".join(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{n}"'.encode()
            + (f'; filename="folder/{f}"\r\nContent-Type: image/jpeg'.encode() if f else b"")
            + b"\r\n\r\n" + data + b"\r\n" for n, f, data in parts) + f"--{boundary}--\r\n".encode()
        request = urllib.request.Request(BASE + "/api/tasks/new", data=body,
                                         headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        with b.opener.open(request) as res:
            upload = json.loads(res.read())["upload"]
        for _ in range(50):  # created in the background
            status = b.call(f"/api/uploads/{upload}")[1]
            if status["state"] in ("done", "failed"):
                break
            time.sleep(0.1)
        self.assertEqual(status["state"], "done", status)
        task = fake_cvat.CREATED[-1]
        spec, names, settings = task.spec, task.files, task.data_params
        self.assertEqual(spec["name"], "Night run 2")
        self.assertEqual(spec["segment_size"], 100)
        self.assertEqual([x["name"] for x in spec["labels"]], ["blue_cone", "yellow_cone", "orange_cone", "large_orange_cone", "unknown_cone"])
        self.assertEqual(names, [p.name for p in fake_cvat.TASK.paths[:3]])  # original names, no folders
        self.assertFalse(settings["use_cache"])  # "prepare all chunks now"
        self.assertEqual(status["sent"], status["total"])
        self.assertEqual(b.call("/api/tasks/new", {})[0], 422)  # no name, no files

    def test_add_people_and_assign_anyone(self):
        b = Browser().login()
        status, _ = b.call("/api/users", {"username": "sam", "email": "sam@example.com", "password": "a-long-password-1"})
        self.addCleanup(lambda: fake_cvat.USERS.__setitem__(slice(None), [u for u in fake_cvat.USERS if u.username != "sam"]))
        self.assertEqual(status, 200)
        self.assertIn("sam", b.call("/api/users")[1])
        self.assertEqual(b.call("/api/users", {"username": "sam", "email": "x@example.com", "password": "p"})[0], 422)  # taken
        self.assertEqual(b.call("/api/users", {"username": "kim"})[0], 422)  # needs email and password

        # Someone without a CVAT account can still be given frames on this page
        split = [{"username": "sam", "start": 0, "stop": 7}, {"username": "new person", "start": 8, "stop": 14}]
        status, body = b.call("/api/tasks/3/assignments", {"assignments": split})
        self.assertEqual(status, 200)
        self.assertIn("new person has no CVAT account yet", body["warning"])
        self.assertEqual(b.call("/api/tasks/3/frames")[1]["assignments"], split)
        b.call("/api/tasks/3/assignments", {"assignments": []})


    def pictures(self, n=3):
        return [("files", p.name, p.read_bytes()) for p in fake_cvat.TASK.paths[:n]]

    def test_new_task_boxes_from_sam3_json_match_pictures_by_name(self):
        b = Browser().login()
        jsons = [("boxes", f"{p.stem}.json", (fake_cvat.REPO / "sam3_labels" / f"{p.stem}.json").read_bytes())
                 for p in fake_cvat.TASK.paths[:3]]
        status, body = b.upload({"name": "With boxes"}, self.pictures() + jsons)
        self.assertEqual(status, 200, body)
        self.assertIn("of 3 pictures", body["boxes"])
        done = b.wait_for(body["upload"])
        self.assertEqual(done["state"], "done", done)
        task = fake_cvat.CREATED[-1]
        labels = {x.id: x.name for x in task.labels}
        for i, name in enumerate(task.files):  # every box sits on the frame CVAT gave its picture
            doc = json.loads((fake_cvat.REPO / "sam3_labels" / name.replace(".jpg", ".json")).read_text())
            want = sorted((p["label"], round(p["bbox"][0])) for p in doc["predictions"])
            got = sorted((labels[sh.label_id], round(sh.points[0])) for sh in task.shapes if sh.frame == i)
            self.assertEqual(got, want, name)
        self.assertIn("boxes added", done["boxes"])

    def test_new_task_boxes_from_csv_match_frame_numbers(self):
        b = Browser().login()
        csv_text = ("frame,time_s,prompt,colour,score,x0,y0,x1,y1\n"
                    "0,0,traffic cone,blue,0.9,10,20,30,60\n2,0,traffic cone,unknown,0.5,100,100,120,140\n"
                    "2,0,traffic cone,yellow,0.5,nan,1,2,3\n")
        status, body = b.upload({"name": "Csv boxes"}, self.pictures() + [("boxes", "boxes.csv", csv_text.encode())])
        self.assertEqual(status, 200, body)
        done = b.wait_for(body["upload"])
        task = fake_cvat.CREATED[-1]
        labels = {x.id: x.name for x in task.labels}
        self.assertEqual(sorted((sh.frame, labels[sh.label_id], sh.points) for sh in task.shapes),
                         [(0, "blue_cone", [10, 20, 30, 60]), (2, "unknown_cone", [100, 100, 120, 140])])
        self.assertIn("1 skipped", done["boxes"])  # the "nan" row

    def test_new_task_refuses_boxes_that_dont_match(self):
        b = Browser().login()
        before = len(fake_cvat.CREATED)
        csv_head = "frame,colour,x0,y0,x1,y1\n"
        status, body = b.upload({"name": "x"}, self.pictures() + [("boxes", "boxes.csv", (csv_head + "9,blue,1,1,5,5\n").encode())])
        self.assertEqual(status, 422)
        self.assertIn("frame 9", body["detail"])
        self.assertIn("3 frames", body["detail"])
        status, body = b.upload({"name": "x"}, self.pictures() + [("boxes", "boxes.csv", (csv_head + "0,purple,1,1,5,5\n").encode())])
        self.assertIn("purple_cone", body["detail"])
        stray = json.dumps({"image": "somewhere_else.jpg", "predictions": []}).encode()
        status, body = b.upload({"name": "x"}, self.pictures() + [("boxes", "a.json", stray)])
        self.assertIn("somewhere_else.jpg", body["detail"])
        self.assertEqual(len(fake_cvat.CREATED), before)  # nothing was created in CVAT

    def test_new_task_hands_cvat_xml_to_cvat(self):
        b = Browser().login()
        status, body = b.upload({"name": "Xml"}, self.pictures() + [("boxes", "annotations.xml", b"<annotations/>")])
        self.assertEqual(b.wait_for(body["upload"])["state"], "done")
        self.assertEqual(fake_cvat.CREATED[-1].cvat_import, ("annotations.xml", "CVAT 1.1"))


if __name__ == "__main__":
    unittest.main()
