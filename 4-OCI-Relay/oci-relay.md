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

# Moving fewer bytes: how OCI Relay speeds up Sparkrun image distribution

*Updated October 7, 2026 for [OCI Relay v0.1.2](https://github.com/scitrera/oci-relay/releases/tag/v0.1.2)
and Sparkrun's `develop-next` integration.*

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
late receiver can require a replay or another registry download. To reduce that
repeat work, the Sparkrun plugin now enables **up to 16 GiB of registry disk
retention** on the fetcher by default. It checks available space and reduces the
budget to leave **16 GiB free**; low or unknown headroom disables retention.
Setting `registry_cache_bytes: 0` disables it explicitly. The standalone CLI
still defaults to zero. This startup check cannot reserve space against other
processes writing to the same disk.

The cache retains whole compressed blobs for this operation, reserving their
space before writing. The first receiver streams while bytes are written with
buffered I/O. Later readers can use the file after size and digest verification;
Linux replay reads prefer direct I/O, with buffered fallback where unsupported.
There is no full-image staging barrier. Files are removed during cleanup, and
a cache write failure disables retention while verified streaming continues.

This is a first-fit cache, not a persistent or LRU cache: a blob that cannot fit
streams without retention and may be downloaded again for a straggler. That
explains why registry download bytes can exceed the bytes one receiver needs.
Memory buffers, this disk budget, optional decoder scratch space, Docker's own
storage, and the operating system's page cache are separate. A configured relay
buffer limit is not a limit on total process memory. The [registry cache guide](https://github.com/scitrera/oci-relay/blob/main/docs/registry-source.md)
details the limits and counters.

The implementation reuses small, useful upstream components: Dragonfly's rolling
statistics and adapted OCI reference handling, Moby's Engine client, upstream
tar-split, and a backpressure semaphore that limits concurrent layer acquisitions.
Nydus informed parts of the design, but OCI Relay does not install a new
filesystem or snapshotter.
[Third-party notices](https://github.com/scitrera/oci-relay/blob/main/THIRD_PARTY_NOTICES.md) describe the code reuse.

Transfer concurrency also improves on a single archive stream per destination.
Independent missing layers can move concurrently over authenticated HTTP/2.
The plugin prefers a working direct route and can use SSH forwarding or SSH
stdio when needed. Explicitly configured data paths let transfers use separate
network interfaces without bonding. Additional HTTP/2 connections can also
reduce contention on one path.

A handful of large layers can dominate an image, so parallelism now works
**within a layer** at two different stages:

| Stage | Default for layers at least 256 MiB | What it helps |
|---|---|---|
| Registry/CDN to fetching relay | Up to four concurrent 16 MiB HTTP byte-range requests per blob | Downloading a large blob when one upstream response is the bottleneck |
| Source relay to receiver relay | Alternating 1 MiB pieces over up to four qualified connections | Using multiple connections and, when configured, both network links for one large layer |

Sizes refer to the representation used at that stage: upstream blobs are
usually compressed, while native classic-store streams are uncompressed.

The upstream range downloader is new in v0.1.2. It assembles completed ranges
in order into the existing source stream, so receivers can consume bytes while
the rest of the layer downloads. A registry that ignores the initial range and
returns the whole blob can still be used without a second download. Invalid
partial responses fail validation. The final full-layer digest check remains
mandatory, and range downloads require no full-layer disk staging.

Relay-to-receiver striping uses one source acquisition shared by all lanes.
It works with live registry downloads and native layer reconstruction, without
fetching or reconstructing a separate copy for each connection. The receiver
reassembles the pieces in order into its existing cache and SHA-256 verifier.
These are pieces of persistent streams; they are distinct from the cache's
64 KiB frames and the upstream HTTP range requests. The 1 MiB stripe default
can be tuned from 1–64 MiB, independently of the upstream 16 MiB range size.

Striping requires at least two qualified connections. The stripe limit does
not create them: configure multiple data paths or increase
`connections_per_path` on one path. Small layers and single-connection routes
use ordinary streams. Failed acquisitions retry whole layers; piece-level
resume and RDMA transport are not implemented. See the [multi-link and striping configuration](https://github.com/scitrera/oci-relay/blob/main/docs/sparkrun-plugin.md)
and [upstream range settings](https://github.com/scitrera/oci-relay/blob/main/docs/registry-source.md#parallel-upstream-ranges).

The plugin sizes initial concurrency and buffer budgets from network hints,
CPU, and available memory. Qualified direct routes at 100 Gbps or above target
**1 GiB of managed payload memory per process**, reduced for available memory
and colocated roles. For eligible registry layers, the range downloader reserves
one quarter of the source's selected budget, capped at **128 MiB**, within that
budget. It reduces concurrency when fewer pieces fit. HTTP/2, TLS, and socket
buffers remain additional overhead.

The plugin accounts for the effective 100 Gbps per-link limit on detected DGX
Spark systems. These are starting limits, not a promise to saturate the links.
Registry-wide limits, disk I/O, hashing, and Docker import can still dominate;
more connections help only while transfer is a significant part of the operation.

Our measurements illustrate both the gains and that limit. The following
historical comparisons used Linux arm64 DGX Spark hosts and two receivers,
before the newer striping and upstream range optimizations. They measure image
distribution/import, without model startup or inference; they are not fresh
v0.1.2 timings:

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

Recent work also reduces the CPU time spent preparing and verifying source
bytes. Reads and native tar reconstruction overlap hashing and cache writes
through a bounded pipeline: four 64 KiB frames per active acquisition, reserved
inside the source memory budget. Large local files use direct reads on Linux;
small native files stay buffered because opening each tiny file for direct I/O
was slower in testing.

For registry downloads, the downloader and source transfer cache now share one
full-layer SHA-256 result. Previously, both hashed the same incoming blob. The
shared verification barrier waits for the pipeline to finish before publishing
a retained cache entry or completing the source stream. This removes a duplicate
pass over the same bytes; it does not remove the independent receiver check.
Standalone registry fetches still hash their input, disk replays are verified,
and native tar reconstruction retains its CRC checks. The [source I/O guide](https://github.com/scitrera/oci-relay/blob/main/docs/source-selection.md#bulk-reads-and-source-pipelining)
explains the pipeline and direct-read fallback.

Docker import remains a separate cost. On qualified classic `overlay2`
receivers, the plugin can use the release's bundled `unpigz` to decode missing
gzip layers before giving Docker uncompressed layers. This does not require
installing a system helper or reconfiguring the daemon. It verifies both the
compressed blob digest and the uncompressed DiffID, and needs temporary disk
space: the plugin's raw-layer scratch cap defaults to 64 GiB and is reduced by
free-space checks that also account for Docker's import needs. It does not
eliminate filesystem extraction or registration. See the [bundled decoder guide](https://github.com/scitrera/oci-relay/blob/main/docs/bundled-decoder.md)
for eligibility, space limits, and fallback behavior.

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
counter still leaves Docker import and final verification to finish. Verbose
logs include each execution host's verified engine version and commit.

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
