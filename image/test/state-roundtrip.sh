#!/usr/bin/env bash
#
# Round-trip test for the guest state helpers, run inside a throwaway Ubuntu
# container: baseline the "image", make the kinds of change the bug report
# named (a file in $HOME, one in ~/persist, a directory in /opt, a new user and
# group, an ACL, a cron job, a deleted /etc file), pack, undo everything, then
# unpack and check it all came back.
#
#   usage: image/test/state-roundtrip.sh              # runs itself in docker
#          IN_CONTAINER=1 image/test/state-roundtrip.sh
set -euo pipefail

if [ "${IN_CONTAINER:-}" != 1 ]; then
  HERE="$(cd "$(dirname "$0")/../.." && pwd)"
  # native arch on purpose: this exercises python/tar/acl semantics, not the
  # guest's architecture, and amd64-under-emulation has no statx for tar.
  # SYS_ADMIN, and no AppArmor veto on mount(2), so the #70 checks can give
  # pack a private mount namespace with a read-only root.
  exec docker run --rm -e IN_CONTAINER=1 \
    --cap-add SYS_ADMIN --security-opt apparmor=unconfined \
    -v "$HERE:/src:ro" ubuntu:26.04 /bin/bash -c \
    'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq python3 acl cron >/dev/null 2>&1 && exec /src/image/test/state-roundtrip.sh'
fi

SEED=/src/image/seed
install -D -m755 "$SEED/usr/local/lib/bashtion/state.py" /usr/local/lib/bashtion/state.py
for f in pack unpack baseline; do
  install -D -m755 "$SEED/usr/local/sbin/bashtion-$f" "/usr/local/sbin/bashtion-$f"
done

fail=0
ck() { if eval "$2" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

# match the guest: uid 1000 is `user`
userdel -r ubuntu >/dev/null 2>&1 || true
id user >/dev/null 2>&1 || useradd -m -u 1000 user
mkdir -p /home/user/share /opt /srv /root /var/spool/cron/crontabs
printf 'baseline\n' > /etc/bashtion-will-be-deleted
printf 'original\n' > /etc/bashtion-config

echo "==> baseline"
bashtion-baseline

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
ck "#70 pack cleans up its staging directory" "! compgen -G '/tmp/bashtion-pack-*'"

echo "==> undo everything (as a reloaded page would)"
rm -rf /home/user/marker.txt /home/user/share/marker.txt /opt/example
userdel -r exuser 2>/dev/null || true
groupdel exgroup 2>/dev/null || true
rm -f /var/spool/cron/crontabs/user
printf 'original\n' > /etc/bashtion-config
printf 'baseline\n' > /etc/bashtion-will-be-deleted
printf 'original\n' > /etc/bashtion-config

echo "==> unpack"
bashtion-unpack < /tmp/session.tgz

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
cat > /tmp/eviltree/var/lib/bashtion/session.json <<'JSON'
{"format":1,"created":0,"deleted":[
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
printf 'restored\n' > /etc/bashtion-stale
mkdir -p /tmp/plain/etc && printf 'restored\n' > /tmp/plain/etc/bashtion-stale
# /var/lib/bashtion/session.json is still on disk from the previous unpack
( cd /tmp/plain && printf '%s\0' etc/bashtion-stale     | tar czf /tmp/plain.tgz --no-recursion --null -T - )
rm -f /etc/bashtion-stale
bashtion-unpack < /tmp/plain.tgz 2>&1 | sed 's/^/     /'
ck "the archive's own file survives an unrelated stale list" "test -s /etc/bashtion-stale"

# --- #70: a save has to work when / is full ---------------------------------
# pack used to write session.json into /var/lib/bashtion before archiving it,
# so on a full root filesystem the save - the one thing a user needs at that
# moment - died with a traceback. Run it in a private mount namespace whose /
# is READ-ONLY and whose /tmp is a fresh tmpfs. That refuses every write a
# full disk would, plus the zero-byte ones a full disk still lets through, so
# anything pack writes outside /tmp fails here. (image/test/guest-check.py
# does the literal version: it fills the guest's / to 100% and saves.)
#
#   pack_in_ns SIZE room|full   stdout/stderr are pack's; fd 3 gets whatever
#                               pack left behind in its /tmp; exit 99 means
#                               the namespace itself could not be set up
pack_in_ns() {
  unshare --mount sh -c '
    mount -o remount,bind,ro / && mount -t tmpfs -o size="$1" tmpfs /tmp || exit 99
    if [ "$2" = full ]; then head -c 1048576 /dev/zero > /tmp/fill 2>/dev/null; fi
    bashtion-pack; rc=$?
    ls -A /tmp | grep -vx fill >&3
    exit $rc' sh "$@"
}

echo "==> #70 pack writes nothing to / (a save must work on a full disk)"
printf 'baseline\n' > /etc/bashtion-70-gone
bashtion-baseline >/dev/null
rm -f /etc/bashtion-70-gone
echo canary-70 > /home/user/marker-70.txt
rm -f /var/lib/bashtion/session.json   # the image no longer ships one either
rc=0; pack_in_ns 8m room > /tmp/ro.tgz 2> /tmp/ro.err 3> /tmp/ro.left || rc=$?
sed 's/^/     /' /tmp/ro.err
ck "#70 test setup: a private read-only root (rc=$rc)" "[ $rc != 99 ]"
ck "#70 pack succeeds with nowhere to write but /tmp" "[ $rc = 0 ] && test -s /tmp/ro.tgz"
ck "#70 pack did not write session.json in place"      "! test -e /var/lib/bashtion/session.json"
ck "#70 its staging directory is gone afterwards"       "! test -s /tmp/ro.left"
# listed to a file first: under pipefail, `! tar | grep -q` passes when grep
# exits on a match and tar dies of SIGPIPE
lrc=0; tar tzf /tmp/ro.tgz > /tmp/ro.list 2>/dev/null || lrc=$?
ck "#70 session.json is archived where unpack reads it" "[ $lrc = 0 ] && grep -qx var/lib/bashtion/session.json /tmp/ro.list"
ck "#70 the staging path does not leak into the archive" "[ $lrc = 0 ] && ! grep -q '^tmp/' /tmp/ro.list"

echo "==> #70 ...and that archive restores, deletion list and all"
printf 'baseline\n' > /etc/bashtion-70-gone
rm -f /home/user/marker-70.txt
rc=0; bashtion-unpack < /tmp/ro.tgz > /tmp/ro-unpack.err 2>&1 || rc=$?
sed 's/^/     /' /tmp/ro-unpack.err
ck "#70 unpack accepts it"                       "[ $rc = 0 ]"
ck "#70 a home file saved read-only comes back"  "grep -qx canary-70 /home/user/marker-70.txt"
ck "#70 its deletion list replays"               "! test -e /etc/bashtion-70-gone"
ck "#70 unpack puts session.json back in place"  "grep -q bashtion-70-gone /var/lib/bashtion/session.json"

echo "==> #70 ...and when even /tmp is full, it fails in one clean line"
rc=0; pack_in_ns 4k full > /tmp/nospace.tgz 2> /tmp/nospace.err 3> /tmp/nospace.left || rc=$?
sed 's/^/     /' /tmp/nospace.err
ck "#70 test setup: a private read-only root (rc=$rc)" "[ $rc != 99 ]"
ck "#70 pack reports the failure"                "[ $rc != 0 ]"
ck "#70 the reason is pack's own last line"      "tail -1 /tmp/nospace.err | grep -q '^bashtion-pack: .*No space left on device'"
ck "#70 not a traceback"                         "! grep -q Traceback /tmp/nospace.err"
ck "#70 no archive was emitted"                  "! test -s /tmp/nospace.tgz"
ck "#70 nothing is left behind in /tmp"          "! test -s /tmp/nospace.left"

exit $fail
