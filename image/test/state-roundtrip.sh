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
mkdir -p /home/user/persist /opt /srv /root /var/spool/cron/crontabs
printf 'baseline\n' > /etc/bashtion-will-be-deleted
printf 'original\n' > /etc/bashtion-config

echo "==> baseline"
bashtion-baseline

echo "==> make a session's worth of change"
echo canary-home   > /home/user/marker.txt
echo canary-persist > /home/user/persist/marker.txt
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
rm -rf /home/user/marker.txt /home/user/persist/marker.txt /opt/example
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
ck "#51 ~/persist file restored"       "grep -qx canary-persist /home/user/persist/marker.txt"
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

exit $fail
