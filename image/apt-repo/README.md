# Local apt repository

The guest has no external network, so package installation is served from a repository
baked into the image at build time. This directory holds the repository *definition*; the
`pool/` and `dists/` trees are generated during the image build and are gitignored.

Populated from the set in `extra-packages.txt`, so that `apt install`, `apt search`,
`apt remove`, `apt purge` and `apt-cache policy` all behave normally offline.

This repository is apt's only source in the guest: `/srv/apt`, listed in
`/etc/apt/sources.list.d/local.list`. The build removes the mirror mmdebstrap configured in
`/etc/apt/sources.list`, and the indexes downloaded from it, and deletes the build-only
`Acquire::Retries "5"` that mmdebstrap leaves in `/etc/apt/apt.conf.d/99mmdebstrap`.
`/etc/apt/apt.conf.d/90-bashtion-offline` then sets `Acquire::Retries "0"` and
`APT::Update::Error-Mode "any"` (#56): apt does not retry a fetch that cannot succeed, and
`apt update` fails when a fetch fails instead of reporting success. A package that is not
here fails at once, with "Unable to locate package".
