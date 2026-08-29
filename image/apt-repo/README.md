# Local apt repository

The guest has no external network, so package installation is served from a repository
baked into the image at build time. This directory holds the repository *definition*; the
`pool/` and `dists/` trees are generated during the image build and are gitignored.

Populated from the set in `../packages.txt`, so that `apt install`, `apt search`,
`apt remove`, `apt purge` and `apt-cache policy` all behave normally offline.
