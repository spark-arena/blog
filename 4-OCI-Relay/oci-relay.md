---
authors:
  - dbsci
tags:
  - sparkrun
  - oci-relay
  - containers
  - networking
  - dgx-spark
description: How OCI Relay avoids full image archives, reuses layers across Docker storage backends, and overlaps registry pulls with distribution to speed up Sparkrun deployments.
---

<!--
SPDX-FileCopyrightText: 2026 Scitrera LLC
SPDX-License-Identifier: AGPL-3.0-only
SPDX-FileComment: The Sparkrun additional permission in LICENSE_EXCEPTION applies.
-->

# Moving fewer bytes: how OCI Relay speeds up Sparkrun image distribution

*October 6, 2026. Based on the OCI Relay v0.1.0 engine and Sparkrun's
`develop-next` integration, including the latest plugin updates.*

A fast network does not automatically make a large container image quick to
deploy. Before the first byte reaches another machine, the source may need to
download, unpack, reconstruct, or compress layers. After the last byte arrives,
Docker still has to finish importing them. On a cluster running large inference
images, those steps can take much longer than the network transfer itself.

[OCI Relay](https://github.com/scitrera/oci-relay) is our answer to that problem
in Sparkrun. It distributes images from local Docker stores or remote registries,
checks what each destination already has, and transfers the missing layers through
verified, bounded streams. The Sparkrun plugin coordinates the operation; a Go
binary handles the data transfer on participating hosts.

In one local-image comparison, distributing a roughly 25 GB image to two empty
Docker stores fell from about four minutes with SSH save/load to about two
minutes with the native relay source. With most layers already cached, the
improvement can be much larger. The reason starts with the work the old path
had to repeat.

Sparkrun's previous distribution path was straightforward:

```sh
docker save IMAGE | ssh HOST docker load
```

Sparkrun first ensured that the source had the image. It compared image
identities, skipped destinations already holding the complete image, and ran
the remaining host transfers in parallel. That gave us a useful baseline:
streaming transfers, existing SSH access, and no separate registry service to
operate.

The limitation was the archive. Each destination needing an update received a
complete image export through its own pipeline. Docker could reuse existing
layers during import, but their archive bytes still crossed the network. A
destination with a large cached base and one missing layer could therefore
receive nearly the same archive as an empty destination.

When the image came from a remote registry, another dependency came first:
Docker had to pull and import it on the source before Sparkrun could export it
to the other nodes. Source preparation, network transfer, and destination import
all contributed to the delay.

OCI Relay changes the unit of distribution from an image archive to requested
image layers. It resolves the image metadata, establishes which layers each
receiver can reuse, and serves the remaining blobs on demand. Each receiver
provides a temporary loopback registry through which its Docker daemon imports
the image.

![Sparkrun coordinates a source and receiver relays; receivers negotiate cached layers and request missing content over authenticated HTTP/2 before Docker imports locally.](/posts/4-oci-relay/img/oci-relay-topology.svg)

The plugin handles source selection, executable deployment, credentials,
network routes, resource limits, progress, and cleanup. Docker continues to own
image installation. Normal operation requires no daemon restart, storage-driver
migration, or change to Docker's download settings.

For each operation, Sparkrun starts one source relay, plus a receiver relay on each
target, using its existing host connections to stage binaries and session
credentials. The roles can share a machine: a delegated head node can fetch
from a registry and also receive the image into its own Docker store. Receivers
connect to the source; they do not exchange layers with one another. The
operation needs no persistent relay service or cluster-wide peer directory.

The relays use HTTP/2 with mutual TLS: both ends authenticate with certificates
issued for that operation. Multiple requests can share a connection, including
metadata, concurrent layer streams, cache negotiation, and progress reports.
In direct mode, receiver connections reach the source listener over TCP. SSH
forwarding and SSH stdio carry the same authenticated protocol when direct
connectivity is unavailable. Direct data transfers can bypass the controller
when it is not the source; forwarded and stdio traffic is bridged through the
controller.

The conversation between a receiver and the source proceeds in stages:

1. **Identify the image.** The receiver obtains the pinned manifest, config,
   and platform from the source. If its destination tag already resolves to the
   same image after backend-aware comparison, it reports success with zero
   layer bytes transferred.
2. **Agree on what is missing.** Otherwise, the receiver checks its local store
   and sends its proposed image representation and per-layer availability:
   reusable unpacked chain, locally available blob, or missing content. The source
   validates the proposal and acknowledges the exact manifest and missing-byte
   total. Each receiver can reach a different agreement for the same source image.
3. **Request layers as needed.** The receiver starts Docker's pull through its
   loopback registry. Cached content is handled locally; missing blobs are
   requested from the source by digest. A receiver with one missing layer need
   not request the layers another receiver is downloading.
4. **Report completion.** Receivers send progress and final results back to the
   source over authenticated requests. Completion is tied to the pinned image
   and, when used, the negotiated manifest. Sparkrun collects the outcomes and
   cleans up the temporary processes, credentials, and helper resources.

The first major improvement is getting useful source bytes sooner. For a local
image, the plugin detects the source's storage backend and chooses a supported
adapter. On qualified classic `overlay2` stores, the relay reads Docker's
tar-split metadata and layer files through read-only mounts. Using the upstream
tar-split library, it reconstructs the original uncompressed layer tar stream
on demand, including headers, whiteouts, file order, and padding.

That exact reconstruction matters. Creating a new tar archive from the same
extracted files can produce different bytes and a different layer hash. The
native adapter preserves the original byte identity while avoiding Docker's
push-compression pass and a full-image export staging step. Preparation reads
metadata; layer payloads are read when requested. In the large local-image
test, source readiness took about 1.5 seconds.

For Docker's containerd image store, the native adapter reads retained blobs
from its content store. Those blobs may already be compressed, so it can serve
the existing representation without unpacking and recompressing it. Both native
adapters retain the source image for the operation. Public Docker push/export
adapters and OCI-layout input remain available when appropriate; automatic
selection checks capabilities and permissions before choosing a source. Native
access defaults on in the plugin and can be disabled.

Remote images take a different path. The registry source resolves a tag to one
platform's manifest, pins the manifest and configuration, and fetches requested
blobs by digest. It streams the registry's existing compressed bytes to receivers
as they arrive. The source machine does not need to import the image unless it
is also a destination.

This overlaps the registry download with cluster distribution and removes the
source's pull/import/export sequence. Registry credentials stay on the fetching
host. Receivers use separate operation credentials to communicate with the relay.

The integration runs before Sparkrun's ordinary source pull. It handles missing
images, explicit fresh pulls, and controller-local `:latest` refreshes—even when
the controller already has an older copy. That last case closed a visible gap:
a preliminary Docker refresh could previously run for a minute or two before
the relay started reporting progress. Existing versioned local images and
unforced delegated-source copies retain Sparkrun's established local-image
policy, and offline operations stay offline. The [registry-source guide](https://github.com/scitrera/oci-relay/blob/main/docs/registry-source.md)
describes the selection rules and the limited cached-image fallback when a
best-effort refresh cannot resolve registry metadata before transfer begins.

The next improvement is deciding what each receiver actually needs. Consider
an image consisting of a large runtime base plus a small application layer.
If a receiver already has the base, sending the complete archive spends network
and source I/O on content that is already there. OCI Relay inventories local
images, validates reusable content, and negotiates the missing layers for each
receiver independently.

Doing that across Docker storage backends requires care. Several hashes describe
different things:

| Identity | What it identifies |
|---|---|
| Blob digest | The exact transferred bytes, such as a gzip-compressed layer |
| DiffID | The exact uncompressed layer tar stream |
| Layer chain | A layer together with its ordered parent history |
| Config digest | The exact image configuration, including its ordered DiffIDs |
| Manifest digest | The exact document describing the config and layer blobs |

A compressed layer and its uncompressed representation have different blob
digests but the same DiffID. Docker's reported image ID can also mean different
things across the tested backends: a config digest on classic `overlay2`, or a
manifest/index digest on the containerd `overlayfs` image store. The same image
can therefore produce different `docker image inspect` IDs on two nodes. Those
IDs hash different objects; the mismatch does not by itself establish that the
image configuration or layer contents differ.

This could defeat the old whole-image shortcut. Sparkrun also checks shared
registry `RepoDigests`, so different backends do not force a copy when that
common identifier is available. But locally built or save/load-transferred
images may lack it. When the Docker IDs differ and there is no shared registry
digest, the builtin path classifies the target as needing synchronization and
sends the complete `docker save` archive—even if the target already contains
the same image. Loading that archive need not make the backend-specific IDs
equal, so a later run can encounter the same mismatch again.

OCI Relay normalizes the **comparison** by resolving backend-specific metadata
to the image's config identity, target platform, and ordered uncompressed layer
DiffIDs. It keeps the original blob and manifest hashes for verification. That
lets it recognize an already-installed image across `overlay2` and containerd
`overlayfs` without requiring their Docker IDs or layer encodings to match.

For example, consider two nodes using different stores and holding an image
with layers A, B, and C. Assume their Docker IDs differ and they have no shared
`RepoDigest` for the builtin shortcut:

| Destination state | Builtin SSH save/load | OCI Relay with qualified cache access |
|---|---|---|
| Same config and layers A, B, C already installed | Send the complete archive because the IDs differ | Recognize the image and transfer zero layer bytes |
| Updating to A, B, C, D with only D missing | Send the complete updated archive | Reuse A, B, C and transfer D |
| All layers available, but image config/tag needs updating | Send the complete archive | Exchange metadata and install the image using local layers |

Zero layer bytes still allows metadata and coordination traffic. A metadata
update can also require Docker import work. Layer reuse depends on validated
local availability: the relay does not equate different configurations merely
because their extracted files look alike.

Each relay therefore understands its local store. A verified matching parent
chain can let Docker reuse unpacked state. A matching layer found under a
different parent can provide local bytes, while still requiring Docker to unpack
them into the new chain. Discovery can combine layers from several local images;
containerd receivers can also find exact retained blobs directly. The scan has
a time budget, and anything it cannot establish remains a download requirement.

When necessary, a receiver negotiates a manifest describing its available local
layer representations. The image configuration, layer order, and DiffIDs remain
unchanged, while the installed manifest digest may differ from the source's.
Both manifest identities are reported. This supports single-platform tagged
image installation; it does not preserve signatures or referrers attached to a
manifest that has been rewritten. The [storage compatibility guide](https://github.com/scitrera/oci-relay/blob/main/docs/storage-compatibility.md)
documents those boundaries.

Sharing source work provides another benefit. Receivers requesting the same
blob at overlapping times can read from one source acquisition through a bounded
memory ring. This can avoid reconstructing or downloading the same layer once
per destination. Backpressure limits active acquisitions and buffered data, and
lagging readers have a bounded wait before they must retry.

That sharing has a practical limit: the ring eventually discards old bytes. A
late receiver can require a replay or another registry download. Optional disk
retention keeps verified compressed registry blobs for the operation; it defaults
to zero and uses ordinary buffered file I/O. Memory-ring budgets, disk-retention
budgets, Docker's own storage, and the operating system's page cache are separate.
A configured relay buffer limit is not a limit on total process memory.

The implementation reuses small, useful upstream components: Dragonfly's rolling
statistics and adapted OCI reference handling, Moby's Engine client, upstream
tar-split, and a backpressure semaphore that limits concurrent layer acquisitions.
Nydus informed parts of the design, but OCI Relay does not install a new
filesystem or snapshotter.
[Third-party notices](https://github.com/scitrera/oci-relay/blob/main/THIRD_PARTY_NOTICES.md) describe the code reuse.

Transfer concurrency also improves on a single archive stream per destination.
Independent missing layers can move concurrently over authenticated HTTP/2.
The plugin prefers a working direct route and can use SSH forwarding or SSH
stdio when needed. Explicitly configured multiple data paths allow whole-layer
requests to use separate network interfaces without bonding. Additional HTTP/2
connections can also reduce contention on one path.

The current scheduler assigns whole layers. Its 64 KiB buffer frames are not
independently downloaded pieces, and a single large layer is not striped across
both NICs. Actual concurrency depends on missing layers and Docker's download
demand, as well as the relay's limits. RDMA and HTTP Range resume are not
implemented.

The plugin sizes initial concurrency and buffer budgets from network hints,
CPU, and available memory. It accounts for the effective 100 Gbps per-link
limit on detected DGX Spark systems. These are starting limits, not a promise
to saturate the link. More connections or a faster network help only while
transfer is a significant part of the operation.

Our measurements illustrate both the gains and that limit. The following
comparisons used Linux arm64 DGX Spark hosts and two receivers. They measure
image distribution/import, without model startup or inference:

| Workload | Previous SSH save/load path | OCI Relay |
|---|---:|---:|
| Roughly 25 GB image already on the source; empty destinations | 237–239 s | 120 s with the native classic source |
| Fresh registry image; source and destinations initially empty | 381 s, including the source pull | 263 s with no registry disk cache |
| Same registry image with only 313 MB of compressed layers missing | 159 s, with the source already ready | 15 s with no registry disk cache |

The first comparison was roughly a halving of elapsed time. The fresh registry
case saved about 31%. The mostly cached case saved about 90%, even though its
SSH baseline was given a fully populated source and paid no registry-pull cost.
In those registry trials, overlapping receivers shared each needed upstream
blob without a second download. That is an observed result, not an unconditional
single-download guarantee.

Timing boundaries differ between experiments: the local-image row excludes
binary deployment, preliminary probes, and final verification/cleanup; the
registry rows include provider setup and operation cleanup. The local and
registry experiments also used different pinned revisions of the image. Compare
methods within each row. Sample counts were small, registry bandwidth varied,
and OS page caches were not flushed. Independent per-node registry pulls had
comparable latency to the registry relay in the measured trials.

Separate tests covered all four classic/containerd source–receiver combinations
with a four-layer, roughly 1 GiB workload. Across 32 trials, relay elapsed time
was 23–53% lower for empty destinations and 49–70% lower with three layers cached.
Every partial-cache trial transferred only the missing layer, including transfers
between different stores. These are workload-specific measurements; small
transfers can lose time to discovery and setup. The [validation record](https://github.com/scitrera/oci-relay/blob/main/docs/validation.md)
records the tested scope and results.

The large-image tests also showed why network speed alone is an incomplete
target. In the default native-source run, receivers finished downloading at
about 45 seconds, while extraction and registration continued to roughly
112–117 seconds. A separate experiment increasing download concurrency shortened
the download phase without improving total completion time. Two connections
later improved mean complete provider time from 121.29 to 113.58 seconds in a
four-run comparison, much less than the transfer-only improvement suggested.

Integrity checks stay enabled throughout these optimizations. Transferred blobs
must match their declared lengths and SHA-256 digests. Streaming verification
withholds final completion until those checks pass. Receivers verify the imported
configuration, platform, ordered DiffIDs, and expected manifest representation
before assigning the requested tag. Hash failures fail the operation; they do
not authorize switching to a different image. Existing unpacked cache hits rely
on Docker's immutable, previously verified store, rather than rehashing every
cached filesystem before every operation.

Users can now see where the time goes. Sparkrun reports source selection,
preparation, cache discovery, per-host transferred bytes and reuse, import,
verification, and cleanup. Registry download bytes are reported separately from
bytes delivered to receivers. Routine updates and quiet-phase heartbeats use a
30-second cadence; phase changes and completion appear immediately. A full byte
counter still leaves Docker import and final verification to finish.

The bundled plugin defaults on for Sparkrun's alpha channel and off for beta and
stable, with explicit feature overrides available. Native store support currently
requires qualified rootful Linux Docker 29+ classic `overlay2` or containerd
`overlayfs` configurations. The real-engine matrix covers classic Docker
29.1.3/29.2.1 and containerd Docker 29.2.1; accepting a newer version still requires
the layout and integrity checks to pass. See the [plugin guide](https://github.com/scitrera/oci-relay/blob/main/docs/sparkrun-plugin.md)
for configuration and the [development guide](https://github.com/scitrera/oci-relay/blob/main/docs/development.md) for an editable
`source dev.sh` setup.

For Sparkrun, the useful change is visible during everyday iteration: updating
an image can reuse the cluster's existing layers, fetching a new image can overlap
with distribution, and moving a local image can begin without preparing a full
export. The remaining time is measurable—whether it is registry bandwidth, source
I/O, or Docker import—so further optimization can target the work that actually
keeps the next run waiting.
