#!/usr/bin/env bash
#
# Round-trip test for the guest state helpers, run inside a throwaway Ubuntu
# container: baseline the "image", make the kinds of change the bug report
# named (a file in $HOME, one in ~/persist, a directory in /opt, a new user and
# group, an ACL, a cron job, a deleted /etc file), pack, undo everything, then
# unpack and check it all came back. Then the same again across a rebuild of
# the "image", where only the home directory may come back (#72).
#
#   usage: image/test/state-roundtrip.sh              # runs itself in docker
#          IN_CONTAINER=1 image/test/state-roundtrip.sh
set -euo pipefail

if [ "${IN_CONTAINER:-}" != 1 ]; then
  HERE="$(cd "$(dirname "$0")/../.." && pwd)"
  # native arch on purpose: this exercises python/tar/acl semantics, not the
  # guest's architecture, and amd64-under-emulation has no statx for tar.
  exec docker run --rm -e IN_CONTAINER=1 \
    -v "$HERE:/src:ro" ubuntu:26.04 /bin/bash -c \
    'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq python3 acl cron >/dev/null 2>&1 && exec /src/image/test/state-roundtrip.sh'
fi

SEED=/src/image/seed
install -D -m755 "$SEED/usr/local/lib/bashtion/state.py" /usr/local/lib/bashtion/state.py
for f in pack unpack baseline; do
  install -D -m755 "$SEED/usr/local/sbin/bashtion-$f" "/usr/local/sbin/bashtion-$f"
done
MARKER=/usr/lib/bashtion/archive-format-2    # pack writes it when missing

fail=0
ck() { if eval "$2" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
# this build's id: the first line of the baseline is "#build<TAB><id>"
bid() { head -1 /usr/local/lib/bashtion/baseline.tsv | sed -n 's/^#build\t\([0-9a-f]\{64\}\)$/\1/p'; }
# a field of the session.json inside an archive
meta() { tar xzOf "$1" var/lib/bashtion/session.json | python3 -c "import json,sys; print(json.load(sys.stdin).get('$2'))"; }
# the id state.py computes for the tree as it is now, from the baseline's rows
recompute() {
  python3 -B -c "import sys; sys.path.insert(0, '/usr/local/lib/bashtion'); import state
base, _ = state.read_baseline()
print(state.identity([(p, chr(9).join(v)) for p, v in base.items()]))"
}

# match the guest: uid 1000 is `user`
userdel -r ubuntu >/dev/null 2>&1 || true
id user >/dev/null 2>&1 || useradd -m -u 1000 user
mkdir -p /home/user/share /opt /srv /root /var/spool/cron/crontabs
printf 'baseline\n' > /etc/bashtion-will-be-deleted
printf 'original\n' > /etc/bashtion-config

echo "==> baseline"
bashtion-baseline
ck "#72 the baseline carries a build id"          "[ -n \"\$(bid)\" ]"
ck "#72 ...which describes the tree it was taken of" "[ \"\$(recompute)\" = \"\$(bid)\" ]"

echo "==> make a session's worth of change"
echo canary-home   > /home/user/marker.txt
echo canary-share > /home/user/share/marker.txt
chown -R user:user /home/user
mkdir -p /opt/example/dir
groupadd exgroup
useradd -m exuser
setfacl -m u:exuser:rwx /opt/example/dir
echo '* * * * * true' > /var/spool/cron/crontabs/user
chmod 600 /var/spool/cron/crontabs/user
echo 'edited-by-user' >> /etc/bashtion-config
rm -f /etc/bashtion-will-be-deleted

echo "==> pack"
bashtion-pack > /tmp/session.tgz
ls -l /tmp/session.tgz

echo "==> undo everything (as a reloaded page would)"
rm -rf /home/user/marker.txt /home/user/share/marker.txt /opt/example
userdel -r exuser 2>/dev/null || true
groupdel exgroup 2>/dev/null || true
rm -f /var/spool/cron/crontabs/user
printf 'original\n' > /etc/bashtion-config
printf 'baseline\n' > /etc/bashtion-will-be-deleted
printf 'original\n' > /etc/bashtion-config

echo "==> unpack"
# gone before the restore, so a marker afterwards could only have come from it
rm -f "$MARKER"
bashtion-unpack < /tmp/session.tgz 2>&1 | tee /tmp/full.out

echo "==> check"
ck "#50 home file restored"            "grep -qx canary-home /home/user/marker.txt"
ck "#51 ~/share file restored"       "grep -qx canary-share /home/user/share/marker.txt"
ck "#50 /opt tree restored"            "test -d /opt/example/dir"
ck "#50 new user restored"             "id exuser"
ck "#50 new group restored"            "getent group exgroup"
ck "#50 supplementary shadow restored" "getent shadow exuser"
ck "#50 ACL restored"                  "getfacl -p /opt/example/dir 2>/dev/null | grep -q '^user:exuser:rwx'"
ck "#50 cron job restored"             "grep -q 'true' /var/spool/cron/crontabs/user"
ck "#50 edited /etc file restored"     "grep -q edited-by-user /etc/bashtion-config"
ck "#50 deletion re-applied"           "! test -e /etc/bashtion-will-be-deleted"
ck "#50 home ownership preserved"      "[ \"\$(stat -c %U /home/user/marker.txt)\" = user ]"
ck "#50 cron job mode preserved"       "[ \"\$(stat -c %a /var/spool/cron/crontabs/user)\" = 600 ]"

ck "#72 pack records this build's id"    "[ \"\$(meta /tmp/session.tgz build)\" = \"\$(bid)\" ]"
ck "#72 ...in the format that has one"   "[ \"\$(meta /tmp/session.tgz format)\" = 2 ]"
ck "#72 a same-build archive restores in full" \
   "tail -1 /tmp/full.out | grep -q '^bashtion-unpack: restored; '"
ck "#72 pack adds the marker a format-1 unpacker refuses" \
   "tar tzf /tmp/session.tgz | grep -x ${MARKER#/}"
ck "#72 ...and unpack never writes it"   "! test -e $MARKER"
# ...and a deleted marker does not quietly drop out of the next archive: tar
# skips what it cannot read, so pack has to put it back.
bashtion-pack > /tmp/remarked.tgz 2>/dev/null
ck "#72 pack puts a deleted marker back"  "test -s $MARKER"
ck "#72 ...and it is in the archive"      "tar tzf /tmp/remarked.tgz | grep -x ${MARKER#/}"

echo "==> archive stays small (only changed system files)"
size=$(stat -c %s /tmp/session.tgz)
echo "packed: ${size} bytes"
ck "#48 archive is a delta, not all of /etc" "[ $size -lt 262144 ]"

echo "==> an archive that writes outside the session is refused"
mkdir -p /tmp/evil/usr/bin && echo pwn > /tmp/evil/usr/bin/evil
tar czf /tmp/evil.tgz -C /tmp/evil usr
if bashtion-unpack < /tmp/evil.tgz 2>/dev/null; then echo "FAIL traversal refused"; fail=1; else echo "ok   traversal refused"; fi
ck "nothing was written outside the session" "! test -e /usr/bin/evil"

# --- the deletion list is archive-supplied, and was the real hole -----------
# The member-name check above never saw it: session.json is a legitimate member
# by design, and the paths inside it were matched with a bare startswith, so
# "/etc/../usr/bin/sudo" passed the guard and the kernel resolved the "..".
echo "==> an archive whose deletion list points outside the session is refused"
mkdir -p /tmp/eviltree/home/user /tmp/eviltree/var/lib/bashtion
echo harmless > /tmp/eviltree/home/user/harmless
# It claims THIS build, or the list would never be replayed at all (#72) and
# the containment below would go untested.
cat > /tmp/eviltree/var/lib/bashtion/session.json <<JSON
{"format":2,"build":"$(bid)","created":0,"deleted":[
  "/etc/../usr/bin/bashtion-sentinel",
  "/etc/../usr/local/lib/bashtion/state.py",
  "/etc/../../home/user/keep-me.txt",
  "/etc/../etc/machine-id",
  "/srv/../etc/passwd"]}
JSON
printf '#!/bin/sh\n' > /usr/bin/bashtion-sentinel && chmod 755 /usr/bin/bashtion-sentinel
echo keep-me > /home/user/keep-me.txt
printf 'id\n' > /etc/machine-id
( cd /tmp/eviltree && printf '%s\0' home/user/harmless var/lib/bashtion/session.json     | tar czf /tmp/evil-del.tgz --no-recursion --null -T - )
bashtion-unpack < /tmp/evil-del.tgz 2>&1 | sed 's/^/     /'
ck "a binary outside the roots survives"          "test -x /usr/bin/bashtion-sentinel"
ck "the tool itself survives"                     "test -f /usr/local/lib/bashtion/state.py"
ck "a home file survives"                         "grep -qx keep-me /home/user/keep-me.txt"
ck "a SKIP_EXACT path survives"                   "test -s /etc/machine-id"
ck "/etc/passwd survives"                         "test -s /etc/passwd"

echo "==> a deleted directory is fully removed, not left as a skeleton"
mkdir -p /opt/pkg/sub && echo a > /opt/pkg/a && echo b > /opt/pkg/sub/b
bashtion-baseline
rm -rf /opt/pkg
bashtion-pack > /tmp/deldir.tgz
mkdir -p /opt/pkg/sub && echo a > /opt/pkg/a && echo b > /opt/pkg/sub/b
bashtion-unpack < /tmp/deldir.tgz 2>&1 | sed 's/^/     /'
ck "the directory is gone, not an empty skeleton" "! test -e /opt/pkg"

echo "==> an archive with no deletion list does not replay a stale one"
# The session.json left on disk by an earlier restore lists a file that exists.
# An archive that carries no list of its own must not pick that one up.
printf '{"format":2,"build":"%s","deleted":["/etc/bashtion-stale"]}' "$(bid)" \
  > /var/lib/bashtion/session.json
printf 'still here\n' > /etc/bashtion-stale
mkdir -p /tmp/plain/home/user && printf 'restored\n' > /tmp/plain/home/user/plain.txt
( cd /tmp/plain && printf '%s\0' home/user/plain.txt \
    | tar czf /tmp/plain.tgz --no-recursion --null -T - )
bashtion-unpack < /tmp/plain.tgz 2>&1 | sed 's/^/     /'
ck "the archive's own file is restored"               "grep -qx restored /home/user/plain.txt"
ck "an unrelated stale list on disk is not replayed"  "test -s /etc/bashtion-stale"

# --- #72: an archive applies its system half only to the build it came from --
# Rewrite an archive's session.json as an older (or newer) bashtion would have
# written it. Every other member is carried over untouched.
remeta() {
  python3 - "$@" <<'PY'
import io, json, sys, tarfile
src, dst, expr = sys.argv[1:4]
with tarfile.open(src) as i, tarfile.open(dst, 'w:gz', format=tarfile.PAX_FORMAT) as o:
    for m in i:
        f = i.extractfile(m) if m.isfile() else None
        if m.name == 'var/lib/bashtion/session.json':
            meta = json.load(f)
            exec(expr, {'m': meta})
            b = json.dumps(meta).encode()
            m.size, f = len(b), io.BytesIO(b)
        o.addfile(m, f)
PY
}
# unpack, keeping its output and its status without tripping set -e
unpack() {
  if bashtion-unpack < "$1" > "$2" 2>&1; then rc=0; else rc=$?; fi
  sed 's/^/     /' "$2"
}

echo "==> #72 an archive from an older build restores home only"
# Build 1 ships two files; the session edits one and deletes the other.
printf 'shipped-in-v1\n' > /etc/bashtion-fixed
printf 'shipped-in-v1\n' > /etc/bashtion-dropped
bashtion-baseline
v1=$(bid)
echo 'stale-edit' >> /etc/bashtion-fixed
rm -f /etc/bashtion-dropped
echo home-v1  > /home/user/v1.txt
echo share-v1 > /home/user/share/v1.txt
chown user:user /home/user/v1.txt /home/user/share/v1.txt
bashtion-pack > /tmp/v1.tgz 2>/dev/null
printf '{"marker":"untouched"}' > /var/lib/bashtion/session.json
ck "#72 (the archive does carry the stale system file)" \
   "tar tzf /tmp/v1.tgz | grep -x etc/bashtion-fixed"
ck "#72 (...and the deletion)" \
   "[ \"\$(meta /tmp/v1.tgz deleted)\" = \"['/etc/bashtion-dropped']\" ]"
# Build 2 fixes that same file and needs the deleted one. Then a reloaded page.
rm -f /home/user/v1.txt /home/user/share/v1.txt
printf 'fixed-in-v2\n' > /etc/bashtion-fixed
printf 'needed-in-v2\n' > /etc/bashtion-dropped
bashtion-baseline
v2=$(bid)
ck "#72 a rebuild that changes a system file changes the build id" "[ $v1 != $v2 ]"
unpack /tmp/v1.tgz /tmp/v1.out
ck "#72 the restore succeeds"                         "[ $rc = 0 ]"
ck "#72 the home file comes back"                     "grep -qx home-v1 /home/user/v1.txt"
ck "#72 ~/share comes back"                           "grep -qx share-v1 /home/user/share/v1.txt"
ck "#72 home ownership preserved"                     "[ \"\$(stat -c %U /home/user/v1.txt)\" = user ]"
ck "#72 the newer build's fix is NOT reverted"        "[ \"\$(cat /etc/bashtion-fixed)\" = fixed-in-v2 ]"
ck "#72 the old build's deletion is NOT replayed"     "[ \"\$(cat /etc/bashtion-dropped)\" = needed-in-v2 ]"
ck "#72 its session.json is not extracted either"     "grep -q untouched /var/lib/bashtion/session.json"
ck "#72 the warning names the archive's build"        "grep -q 'archive saved on build: $v1' /tmp/v1.out"
ck "#72 ...and this one"                              "grep -q 'this machine is build:  $v2' /tmp/v1.out"
ck "#72 the last line says home only" \
   "tail -1 /tmp/v1.out | grep -Eq '^bashtion-unpack: restored home only; [0-9]+ system paths and 1 deletions not applied'"

echo "==> #72 an archive that names no build restores home only"
# Exactly what every build before #72 saved: format 1, and no build.
echo 'edited-on-v2' >> /etc/bashtion-fixed
echo home-legacy > /home/user/legacy.txt
bashtion-pack > /tmp/v2.tgz 2>/dev/null
remeta /tmp/v2.tgz /tmp/legacy.tgz "m['format'] = 1; del m['build']"
rm -f /home/user/legacy.txt
printf 'fixed-in-v2\n' > /etc/bashtion-fixed
unpack /tmp/legacy.tgz /tmp/legacy.out
ck "#72 the restore succeeds"                         "[ $rc = 0 ]"
ck "#72 its home file comes back"                     "grep -qx home-legacy /home/user/legacy.txt"
ck "#72 its system edit is NOT applied, even on the same build" \
   "[ \"\$(cat /etc/bashtion-fixed)\" = fixed-in-v2 ]"
ck "#72 it says it cannot tell"                       "grep -q 'does not record which build' /tmp/legacy.out"
ck "#72 the last line says home only" \
   "tail -1 /tmp/legacy.out | grep -q '^bashtion-unpack: restored home only; '"
# ...while the very same archive, still naming its build, applies in full
rm -f /home/user/legacy.txt
unpack /tmp/v2.tgz /tmp/v2.out
ck "#72 (control: the same archive naming this build applies in full)" \
   "grep -q edited-on-v2 /etc/bashtion-fixed && tail -1 /tmp/v2.out | grep -q '^bashtion-unpack: restored; '"

# tar selects members by exact name, and `tar czf x.tgz ./home` - the obvious
# way to make one by hand - spells every member with a leading ./
mkdir -p /tmp/dotted/home/user /tmp/dotted/etc
echo dotted > /tmp/dotted/home/user/dotted.txt
echo dotted > /tmp/dotted/etc/bashtion-dotted
( cd /tmp/dotted && tar czf /tmp/dotted.tgz ./home/user/dotted.txt ./etc/bashtion-dotted )
unpack /tmp/dotted.tgz /tmp/dotted.out
ck "#72 a ./-spelled archive restores its home file"  "[ $rc = 0 ] && grep -qx dotted /home/user/dotted.txt"
ck "#72 ...and still not its system file"             "! test -e /etc/bashtion-dotted"

echo "==> #72 an archive this build cannot read is refused, and nothing is written"
refused() {  # refused NAME ARCHIVE [SAYS]: the unpack fails and writes nothing at all
  rm -f /home/user/legacy.txt
  printf 'fixed-in-v2\n' > /etc/bashtion-fixed
  printf '{"marker":"untouched"}' > /var/lib/bashtion/session.json
  unpack "$2" /tmp/refused.out
  ck "#72 $1: refused"                                "[ $rc != 0 ]"
  ck "#72 $1: says ${3:-nothing was restored}"        "tail -1 /tmp/refused.out | grep -q '${3:-nothing was restored}'"
  ck "#72 $1: no home file written"                   "! test -e /home/user/legacy.txt"
  ck "#72 $1: no system file written"                 "[ \"\$(cat /etc/bashtion-fixed)\" = fixed-in-v2 ]"
  ck "#72 $1: session.json not written"               "grep -q untouched /var/lib/bashtion/session.json"
}
remeta /tmp/v2.tgz /tmp/future.tgz "m['format'] = 3"
refused "a newer format" /tmp/future.tgz
ck "#72 a newer format: says so"                      "tail -1 /tmp/refused.out | grep -q 'newer bashtion (format 3'"
remeta /tmp/v2.tgz /tmp/weird.tgz "m['format'] = '2'"
refused "a format that is not a number" /tmp/weird.tgz
remeta /tmp/v2.tgz /tmp/noformat.tgz "del m['format']"
refused "no format at all" /tmp/noformat.tgz
python3 - <<'PY'
import io, tarfile
with tarfile.open('/tmp/v2.tgz') as i, tarfile.open('/tmp/garbled.tgz', 'w:gz') as o:
    for m in i:
        f = i.extractfile(m) if m.isfile() else None
        if m.name == 'var/lib/bashtion/session.json':
            m.size, f = 9, io.BytesIO(b'{"format"')
        o.addfile(m, f)
PY
refused "an unreadable session.json" /tmp/garbled.tgz

# Archives spelled so that a name check which only strips leading dots and
# slashes, or reads session.json recursively, would let them through.
mktar() {  # mktar OUT NAME[=CONTENT] ...: members exactly as named; NAME/ is a directory
  python3 - "$@" <<'PY'
import io, sys, tarfile
with tarfile.open(sys.argv[1], 'w:gz') as t:
    for spec in sys.argv[2:]:
        name, _, body = spec.partition('=')
        i = tarfile.TarInfo(name.rstrip('/'))
        i.uid = i.gid = 1000
        if name.endswith('/'):
            i.type, i.mode = tarfile.DIRTYPE, 0o755
            t.addfile(i)
        else:
            b = body.encode()
            i.size, i.mode = len(b), 0o644
            t.addfile(i, io.BytesIO(b))
PY
}
ok_meta="{\"format\":2,\"build\":\"$(bid)\"}"
mktar /tmp/alias.tgz "var/lib/bashtion/session.json=$ok_meta" \
      'var/lib/bashtion/./session.json={"format":3}' home/user/legacy.txt=alias
refused "a second session.json spelled differently" /tmp/alias.tgz 'refusing path'
mktar /tmp/sdir.tgz var/lib/bashtion/session.json/ \
      "var/lib/bashtion/session.json/x.json=$ok_meta" home/user/legacy.txt=sdir
refused "a session.json that is a directory" /tmp/sdir.tgz 'unreadable'
mktar /tmp/dots.tgz .../home/user/legacy.txt=dots
refused "a .../home/user spelling" /tmp/dots.tgz 'refusing path'
ck "#72 a .../home/user spelling: nothing under /..." "! test -e /..."

echo "==> #72 the build id sees what a file says, not only its size and mtime"
rows() { tail -n +2 /usr/local/lib/bashtion/baseline.tsv; }
printf 'allow=0\n' > /etc/bashtion-same && touch -d @1700000000 /etc/bashtion-same
bashtion-baseline >/dev/null
a=$(bid); rows > /tmp/rows-a
printf 'allow=1\n' > /etc/bashtion-same && touch -d @1700000000 /etc/bashtion-same
bashtion-baseline >/dev/null
b=$(bid); rows > /tmp/rows-b
ck "#72 (the baseline's own rows cannot tell those two apart)" "cmp -s /tmp/rows-a /tmp/rows-b"
ck "#72 a rebuild that changes only what a file says changes the id" "[ -n \"$a\" ] && [ $a != $b ]"
chown 1000:1000 /etc/bashtion-same
bashtion-baseline >/dev/null
c=$(bid); rows > /tmp/rows-c
ck "#72 (...nor tell an owner change)"                "cmp -s /tmp/rows-b /tmp/rows-c"
ck "#72 a rebuild that changes only an owner changes the id" "[ -n \"$c\" ] && [ $b != $c ]"
order_free() {
  python3 -B -c "import sys; sys.path.insert(0, '/usr/local/lib/bashtion'); import state
base, ident = state.read_baseline()
rows = [(p, chr(9).join(v)) for p, v in base.items()]
sys.exit(0 if state.identity(rows) == state.identity(rows[::-1]) == ident else 1)"
}
ck "#72 the id does not depend on the order a directory is listed in" "order_free"
xattr_collision() {
  python3 -B -c "import os, sys; sys.path.insert(0, '/usr/local/lib/bashtion'); import state
for f in ('/tmp/xa1', '/tmp/xa2'):
    open(f, 'w').write('same')
    os.utime(f, (1700000000, 1700000000))
os.setxattr('/tmp/xa1', 'user.a', b'x' + bytes([0]) + b'user.b=y')
os.setxattr('/tmp/xa2', 'user.a', b'x')
os.setxattr('/tmp/xa2', 'user.b', b'y')
sys.exit(0 if state.fingerprint('/tmp/xa1') != state.fingerprint('/tmp/xa2') else 1)"
}
ck "#72 one xattr cannot pass for two"                "xattr_collision"

echo "==> #72 a format-1 unpacker - every build before #72 - refuses a format-2 archive"
# image/test/fixtures/state-format1.py is that unpacker, byte for byte: it
# never reads format or build, so the marker member is all that stops it.
rm -f /home/user/legacy.txt
printf 'fixed-in-v2\n' > /etc/bashtion-fixed
printf '{"marker":"untouched"}' > /var/lib/bashtion/session.json
if python3 /src/image/test/fixtures/state-format1.py unpack < /tmp/v2.tgz > /tmp/old.out 2>&1
then rc=0; else rc=$?; fi
sed 's/^/     /' /tmp/old.out
ck "#72 format-1 unpacker: refused"                   "[ $rc != 0 ]"
ck "#72 format-1 unpacker: because of the marker"     "grep -q 'outside the session.*archive-format-2' /tmp/old.out"
ck "#72 format-1 unpacker: no home file written"      "! test -e /home/user/legacy.txt"
ck "#72 format-1 unpacker: no system file written"    "[ \"\$(cat /etc/bashtion-fixed)\" = fixed-in-v2 ]"
ck "#72 format-1 unpacker: session.json not written"  "grep -q untouched /var/lib/bashtion/session.json"

exit $fail
