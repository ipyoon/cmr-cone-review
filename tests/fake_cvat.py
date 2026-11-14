"""A stand-in for CVAT so the review page can be tested without a real login.

It replaces the `cvat_sdk` package with the few calls this repo uses, and serves
the real frames/ images with the real sam3_labels/ boxes as task 3. It holds
nothing from your real CVAT and never talks to it. Test login: tester / test-pass

SAM3 found no unknown cones in these frames, so every 6th box is made
unknown_cone here to give the Cones screen something to sort.

Try the page against it:  venv/bin/python tests/fake_cvat.py   (http://localhost:8091)
"""

import io
import json
import zipfile
import os
import sys
import tempfile
import types
from pathlib import Path
from types import SimpleNamespace as NS

REPO = Path(__file__).resolve().parents[1]
CHUNK = 4
LABEL_NAMES = ["blue_cone", "yellow_cone", "orange_cone", "large_orange_cone", "unknown_cone"]


class ApiException(Exception):
    def __init__(self, status):
        super().__init__(f"HTTP {status}")
        self.status = status


def box(shape_id, frame, label_id, points):
    return NS(id=shape_id, frame=frame, label_id=label_id, points=list(points), occluded=False,
              outside=False, z_order=0, rotation=0.0, group=0, source="auto", attributes=[],
              score=1.0, type=NS(value="rectangle"))


class FakeTask:
    id = 3
    name = "fake task (real frames, real SAM3 boxes)"

    def __init__(self):
        self.paths = sorted((REPO / "frames").glob("*.jpg"))
        self.size = len(self.paths)
        self.shapes = []
        self.chunk_requests = 0
        for i, path in enumerate(self.paths):
            doc = json.loads((REPO / "sam3_labels" / f"{path.stem}.json").read_text())
            for p in doc["predictions"]:
                if p["label"] in LABEL_NAMES:
                    shape_id = len(self.shapes) + 100
                    label = 5 if shape_id % 6 == 0 else LABEL_NAMES.index(p["label"]) + 1
                    self.shapes.append(box(shape_id, i, label, p["bbox"]))

    def get_annotations(self):
        return NS(shapes=self.shapes, tracks=[], tags=[])

    def get_meta(self):
        return NS(frames=[NS(name=p.name, width=1920, height=1200) for p in self.paths], chunk_size=CHUNK)

    @property
    def api(self):
        # Like CVAT: a chunk is a zip of CHUNK consecutive frames
        def retrieve_data(task_id, type, number, quality=None):
            self.chunk_requests += 1
            out = io.BytesIO()
            with zipfile.ZipFile(out, "w") as archive:
                for i, path in enumerate(self.paths[number * CHUNK:(number + 1) * CHUNK]):
                    archive.writestr(f"{i:06d}.jpeg", path.read_bytes())
            return None, NS(data=out.getvalue())
        return NS(retrieve_data=retrieve_data)

    def update_annotations(self, data, action="update"):
        # Like CVAT: update replaces the stored box with the same id
        for sent in data.shapes:
            if action == "create":
                self.shapes.append(box(max(s.id for s in self.shapes) + 1, sent.frame, sent.label_id, sent.points))
                continue
            i = next(i for i, s in enumerate(self.shapes) if s.id == sent.id)
            if action == "delete":
                del self.shapes[i]
            else:
                self.shapes[i] = box(sent.id, sent.frame, sent.label_id, sent.points)

    def get_labels(self):
        return [NS(id=i + 1, name=n, color="#ffffff", attributes=[]) for i, n in enumerate(LABEL_NAMES)]

    def get_jobs(self):
        return [JOB]

    def get_frame(self, index, quality=None):
        return io.BytesIO(self.paths[index].read_bytes())


class FakeJob:
    id = 30
    start_frame = 0

    def __init__(self, size):
        self.stop_frame = size - 1
        self.state = "new"
        self.assignee = None
        self.issues = []

    def update(self, values):
        if "state" in values:
            self.state = values["state"]
        if "assignee" in values:
            self.assignee = next(u for u in USERS if u.id == values["assignee"])

    def get_issues(self):
        return list(self.issues)


class FakeIssue:
    def __init__(self, spec, owner):
        self.__dict__.update(spec, owner=NS(username=owner), resolved=False)

    def update(self, values):
        self.resolved = values["resolved"]

    def remove(self):
        JOB.issues.remove(self)


USERS = [NS(id=1, username="tester"), NS(id=2, username="alex")]
TASK = FakeTask()
JOB = FakeJob(TASK.size)


CREATED = []  # tasks made through the review page (see NewTask)
PROJECT_LABELS = ["blue_cone", "yellow_cone", "orange_cone", "large_orange_cone", "unknown_cone", "car"]
PROJECTS = [NS(id=1, name="Driverless", get_labels=lambda: [NS(id=i + 1, name=n) for i, n in enumerate(PROJECT_LABELS)])]


class NewTask:
    """A task made with create_from_data: remembers what it was given."""

    def __init__(self, spec, resources, data_params, annotation_path, annotation_format):
        self.id, self.name, self.spec, self.data_params = 100 + len(CREATED), spec["name"], spec, data_params
        # Like CVAT with sorting_method="natural": frames in file-name order, reversed upload order or not
        self.files = sorted(os.path.basename(r) for r in resources)
        self.cvat_import = (os.path.basename(annotation_path), annotation_format) if annotation_path else None
        names = [x["name"] for x in spec["labels"]] if "labels" in spec else PROJECT_LABELS
        self.labels = [NS(id=10 + i, name=n) for i, n in enumerate(names)]
        self.shapes = []

    def get_labels(self):
        return self.labels

    def get_meta(self):
        return NS(frames=[NS(name=f) for f in self.files])

    def set_annotations(self, data):
        self.shapes = list(data.shapes)


def create_from_data(spec, resources, data_params=None, pbar=None, annotation_path="", annotation_format="", **_):
    """Like CVAT: report the upload, then return the new task."""
    size = sum(os.path.getsize(r) for r in resources)
    if pbar:
        pbar.start2(size)
        pbar.advance(size)
        pbar.finish()
    task = NewTask(spec, list(reversed(resources)), data_params, annotation_path, annotation_format)
    CREATED.append(task)
    return task


def register(request):
    if any(u.username == request.username for u in USERS):
        raise ApiException(400)
    USERS.append(NS(id=len(USERS) + 1, username=request.username))


class FakeClient:
    tasks = NS(retrieve=lambda task_id: TASK, list=lambda: [TASK], create_from_data=create_from_data)
    users = NS(list=lambda: USERS)
    projects = NS(list=lambda: PROJECTS, retrieve=lambda pid: next(p for p in PROJECTS if p.id == pid))

    def __init__(self):
        self.username = None
        self.issues = NS(create=lambda spec: JOB.issues.append(FakeIssue(spec, self.username)))
        self.api_client = NS(users_api=NS(retrieve_self=lambda: (NS(username=self.username), None)),
                             auth_api=NS(create_register=register))

    def login(self, credentials):
        if credentials != ("tester", "test-pass"):
            raise ApiException(400)
        self.username = credentials[0]

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def install():
    """Make `import cvat_sdk` resolve to this fake."""
    sdk = types.ModuleType("cvat_sdk")
    sdk.make_client = lambda host=None: FakeClient()
    exceptions = types.ModuleType("cvat_sdk.exceptions")
    exceptions.ApiException = ApiException
    sdk.exceptions = exceptions
    api_client = types.ModuleType("cvat_sdk.api_client")
    api_client.models = NS(
        LabeledShapeRequest=lambda **kw: NS(**kw), PatchedLabeledDataRequest=lambda **kw: NS(**kw),
        AttributeValRequest=lambda **kw: NS(**kw), ShapeType=lambda value: value,
        RegisterSerializerExRequest=lambda **kw: NS(**kw), LabeledDataRequest=lambda **kw: NS(**kw),
    )
    annotations = types.ModuleType("cvat_sdk.core.proxies.annotations")
    annotations.AnnotationUpdateAction = NS(CREATE="create", UPDATE="update", DELETE="delete")
    sys.modules["cvat_sdk"] = sdk
    sys.modules["cvat_sdk.core"] = types.ModuleType("cvat_sdk.core")
    sys.modules["cvat_sdk.core.proxies"] = types.ModuleType("cvat_sdk.core.proxies")
    sys.modules["cvat_sdk.core.proxies.annotations"] = annotations
    sys.modules["cvat_sdk.exceptions"] = exceptions
    progress = types.ModuleType("cvat_sdk.core.progress")

    class BaseProgressReporter:
        def start2(self, total, **kwargs): pass
        def advance(self, delta): pass
        def finish(self): pass
    progress.BaseProgressReporter = BaseProgressReporter
    sys.modules["cvat_sdk.core.progress"] = progress
    sys.modules["cvat_sdk.api_client"] = api_client
    sys.path.insert(0, str(REPO))


if __name__ == "__main__":
    os.environ.setdefault("VERIFICATION_DB", str(Path(tempfile.mkdtemp()) / "fake_verification.db"))
    install()
    import uvicorn
    import review_web

    uvicorn.run(review_web.app, host="127.0.0.1", port=int(os.getenv("PORT", "8091")), log_level="warning")
