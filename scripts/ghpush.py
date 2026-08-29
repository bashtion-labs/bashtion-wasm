#!/usr/bin/env python3
"""Push staged changes as a single squash-merged, GitHub-signed commit.

Commits created through the plain Git Database API are unsigned; commits that
GitHub itself creates (web flow, PR merges) are signed and show as Verified.
This script therefore: builds a tree from the staged index, creates a commit on
a scratch branch, opens a PR, squash-merges it, deletes the branch, and resets
the local checkout onto the new remote main.

Usage: scripts/ghpush.py "Commit title" [-b BODY_FILE]
Requires: gh (authenticated), staged changes in the local index.
Submodules: staged gitlinks are carried through with their pinned sha.
"""
import argparse, base64, json, subprocess, sys

def sh(*a, inp=None):
    r = subprocess.run(a, capture_output=True, text=True, input=inp)
    if r.returncode != 0:
        sys.exit(f"FAILED: {' '.join(a[:4])}...\n{r.stderr[:800]}")
    return r.stdout

def gh(args, inp=None):
    out = sh("gh", "api", *args, inp=inp)
    return json.loads(out) if out.strip() else {}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("title")
    ap.add_argument("-b", "--body-file", help="file containing the commit body")
    args = ap.parse_args()

    remote = sh("git", "remote", "get-url", "origin").strip()
    owner_repo = remote.split("github.com/")[1].removesuffix(".git")
    body = open(args.body_file).read() if args.body_file else ""

    head = gh([f"repos/{owner_repo}/git/ref/heads/main"])["object"]["sha"]

    # staged entries (mode, sha-unused, path) — read content from the index
    entries = []
    for line in sh("git", "diff", "--cached", "--name-only", "-z").split("\0"):
        if not line:
            continue
        mode = sh("git", "ls-files", "--cached", "--format=%(objectmode)", "--", line).strip()
        if mode == "160000":
            sha = sh("git", "ls-files", "--cached", "--format=%(objectname)", "--", line).strip()
            entries.append({"path": line, "mode": mode, "type": "commit", "sha": sha})
        else:
            content = base64.b64encode(
                subprocess.run(["git", "show", f":{line}"], capture_output=True).stdout
            ).decode()
            blob = gh([f"repos/{owner_repo}/git/blobs", "-f", f"content={content}",
                       "-f", "encoding=base64"])
            entries.append({"path": line, "mode": mode, "type": "blob", "sha": blob["sha"]})
    if not entries:
        sys.exit("nothing staged")

    tree = gh([f"repos/{owner_repo}/git/trees", "--input", "-"],
              inp=json.dumps({"base_tree": head, "tree": entries}))
    commit = gh([f"repos/{owner_repo}/git/commits", "--input", "-"],
                inp=json.dumps({"message": args.title, "tree": tree["sha"],
                                "parents": [head]}))
    branch = f"push-{commit['sha'][:8]}"
    gh([f"repos/{owner_repo}/git/refs", "--input", "-"],
       inp=json.dumps({"ref": f"refs/heads/{branch}", "sha": commit["sha"]}))
    pr = gh([f"repos/{owner_repo}/pulls", "--input", "-"],
            inp=json.dumps({"title": args.title, "head": branch, "base": "main",
                            "body": body or args.title}))
    merged = gh([f"repos/{owner_repo}/pulls/{pr['number']}/merge", "-X", "PUT",
                 "--input", "-"],
                inp=json.dumps({"merge_method": "squash",
                                "commit_title": f"{args.title} (#{pr['number']})",
                                "commit_message": body}))
    gh([f"repos/{owner_repo}/git/refs/heads/{branch}", "-X", "DELETE"])

    final = gh([f"repos/{owner_repo}/commits/{merged['sha']}"])
    v = final["commit"]["verification"]
    print(f"merged {merged['sha'][:10]} verified={v['verified']} ({v['reason']})")

    sh("git", "fetch", "-q", "origin")
    sh("git", "reset", "-q", "--mixed", "origin/main")
    print("local reset to origin/main")

if __name__ == "__main__":
    main()
