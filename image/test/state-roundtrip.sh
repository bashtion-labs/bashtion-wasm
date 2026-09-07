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
  exec docker run --rm -e IN_CONTAINER=1 \
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

exit $fail
