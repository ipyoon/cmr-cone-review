import os
import argparse
from cvat_sdk import make_client

from cvat_auth import login
from cvat_fingerprint import get_frame_hashes
from verification_tracker import mark_verified, check_verification

HOST = os.getenv("CVAT_HOST", "http://localhost:8080")

parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["approve", "check"])
parser.add_argument("frame")
args = parser.parse_args()

with make_client(host=HOST) as client:
    login(client)

    # Get the username from CVAT, not from user input
    user, _ = client.api_client.users_api.retrieve_self()
    reviewer = user.username

    hashes = get_frame_hashes(client)

    if args.frame not in hashes:
        parser.error("Frame not found in CVAT")

    if args.action == "check":
        status = check_verification(args.frame, hashes)
        print(f"{args.frame}: {status}")

    else:
        answer = input(f"Approve {args.frame}? Type YES: ")

        if answer == "YES":
            latest = get_frame_hashes(client)

            if hashes[args.frame] != latest[args.frame]:
                print("Annotations changed. Review again.")
            else:
                mark_verified(args.frame, latest, reviewer)
        else:
            print("Cancelled.")