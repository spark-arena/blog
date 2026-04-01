---
authors:
  - eugr
  - dbsci
tags:
  - clustering
  - networking
  - sparkrun
  - spark-vllm-docker
  - dgx-spark
---

# 3-Node Mesh Networking on DGX Spark with spark-vllm-docker and sparkrun

by [@eugr](https://forums.developer.nvidia.com/u/eugr/summary) and [@dbsci](https://forums.developer.nvidia.com/u/dbsci/summary)

Our community vLLM Docker (also known as [spark-vllm-docker](https://github.com/eugr/spark-vllm-docker)) and [sparkrun](https://github.com/spark-arena/sparkrun) (via community Docker builds) now support 3-node mesh configuration!

Original NVIDIA forums post:
[Three node Spark clusters (without a switch) are now supported in spark-vllm-docker and sparkrun](https://forums.developer.nvidia.com/t/three-node-spark-clusters-without-a-switch-are-now-supported-in-spark-vllm-docker-and-sparkrun/365296)

## Background

NVIDIA DGX Spark systems ship with a ConnectX-7 (CX7) network adapter that provides two QSFP ports, each with two
logical partitions — giving four RoCE network interfaces per machine. In a typical 2-node setup, you connect a single
cable between the two Sparks and configure static IPs on a shared subnet. Simple.

But what if you have three DGX Sparks? With two QSFP ports per machine and three machines, you can build a full
mesh — every node directly connected to every other node with a dedicated cable. No switch required.

```text
           Spark 1
    Port 0       Port 1
      |           |
    Port 1       Port 0
   Spark 2       Spark 3
    Port 0  ---  Port 1
```

This mesh topology gives each node up to 200 Gbps link to its two peers, enabling pipeline-parallel
inference workloads that split a model across all three machines.

## Why Mesh?

On DGX Spark, each node has one GPU with 128 GB of unified memory. For larger models that don't fit on a single node,
you need multi-node inference with tensor parallelism (TP) or pipeline parallelism (PP). The mesh topology works well
for 3-node PP because:

- Does not require a switch — each inter-node link is a dedicated point-to-point cable
- Flexible bandwidth — each node has 200 Gbps of CX7 bandwidth shared across its two ports; either link can burst up
to the full 200 Gbps when the other is underutilized
- Low latency — direct connections with no switch hops

## Physical Cabling

You need three QSFP cables. Each cable connects Port 0 on one Spark to Port 1 on another:

![3-node DGX Spark mesh topology](/posts/2-three-node-mesh/img/mesh-topology.svg)

| Cable | From | To |
| --- | --- | --- |
| 1 | Spark 1 Port 0 | Spark 2 Port 1 |
| 2 | Spark 2 Port 0 | Spark 3 Port 1 |
| 3 | Spark 3 Port 0 | Spark 1 Port 1 |

It's important to "cross-connect" between port0-port1, otherwise the mesh may not work properly.

Each port has two logical partitions (visible as two network interfaces), so each cable carries two independent L3
subnets. With 3 cables × 2 subnets each, the mesh uses 6 unique subnets total.

Tip: You can use [sparkrun](https://github.com/spark-arena/sparkrun)'s topology detection to automatically configure IP addresses on all interfaces.

IMPORTANT! Mesh setup requires all Sparks to be connected to a common network via it's Ethernet port, as unlike 2-node systems, it won't be able to use it's QSFP ports for NCCL OOB communications.

OOB interface is only required for initialization, discovery and high-level coordination, but the actual workloads will still use fast QSFP connections.

## Requirements

- 3× NVIDIA DGX Spark systems.
- 3× QSFP56 cables.
- Sparks connected as described above.
- All sparks connected to common network via an Ethernet port (wifi may work but not recommended).
- SSH access from your control machine to all three Sparks.
- latest version of [sparkrun](https://github.com/spark-arena/sparkrun) installed on the control machine (or on one of the Sparks) or [Community vLLM Docker](https://github.com/eugr/spark-vllm-docker) repo checked out on one of the Sparks.
- vLLM image built using the latest version of [Community vLLM Docker](https://github.com/eugr/spark-vllm-docker) (it won't work with NGC or any other images due to non-standard NCCL build requirements).
- sudo access on the Sparks (for initial netplan configuration; subsequent runs don't need it).

## Setup and usage

For new users, it's recommended to use sparkrun as it takes care of initial network setup and provides more sophisticated orchestration capabilities.

Existing spark-vllm-docker users or those who want more low-level control over vLLM may follow the instructions below:

## Quick start with spark-vllm-docker

Before you begin, make sure you follow the Networking Guide to set up wiring and IP addresses.

Check out the repository on the head node.

```bash
git clone https://github.com/eugr/spark-vllm-docker.git
cd spark-vllm-docker
```

Run the included recipe.

```bash
./run-recipe.sh --discover # configure cluster
./run-recipe.sh recipes/3x-spark-cluster/qwen3.5-397b-int4-autoround.yaml --setup --no-ray --force-build # you can drop --setup and --force-build on subsequent calls
```

It will run Intel/Qwen3.5-397B-Int4-Autoround on all 3 nodes in Pipeline Parallel mode.

Expected performance (as of 3/31/2026):

| model | test | t/s | peak t/s | ttfr (ms) | est_ppt (ms) | e2e_ttft (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| Intel/Qwen3.5-397B-A17B-int4-AutoRound | pp2048 | 901.27 ± 75.84 |  | 2296.92 ± 196.74 | 2289.99 ± 196.74 | 2297.10 ± 196.73 |
| Intel/Qwen3.5-397B-A17B-int4-AutoRound | tg32 | 17.86 ± 0.16 | 18.33 ± 0.47 |  |  |  |
| Intel/Qwen3.5-397B-A17B-int4-AutoRound | ctx_pp @ d8192 | 1165.46 ± 70.82 |  | 7063.95 ± 446.99 | 7057.01 ± 446.99 | 7064.08 ± 447.00 |
| Intel/Qwen3.5-397B-A17B-int4-AutoRound | ctx_tg @ d8192 | 17.63 ± 0.04 | 18.33 ± 0.47 |  |  |  |
| Intel/Qwen3.5-397B-A17B-int4-AutoRound | pp2048 @ d8192 | 372.73 ± 2.33 |  | 5501.79 ± 34.19 | 5494.85 ± 34.19 | 5501.95 ± 34.22 |
| Intel/Qwen3.5-397B-A17B-int4-AutoRound | tg32 @ d8192 | 17.58 ± 0.02 | 18.00 ± 0.00 |  |  |  |
| Intel/Qwen3.5-397B-A17B-int4-AutoRound | ctx_pp @ d16384 | 1239.28 ± 48.23 |  | 13248.92 ± 529.88 | 13241.98 ± 529.88 | 13249.11 ± 529.80 |
| Intel/Qwen3.5-397B-A17B-int4-AutoRound | ctx_tg @ d16384 | 17.44 ± 0.05 | 18.00 ± 0.00 |  |  |  |
| Intel/Qwen3.5-397B-A17B-int4-AutoRound | pp2048 @ d16384 | 348.75 ± 1.07 |  | 5879.40 ± 17.93 | 5872.47 ± 17.93 | 5879.53 ± 18.00 |
| Intel/Qwen3.5-397B-A17B-int4-AutoRound | tg32 @ d16384 | 17.46 ± 0.04 | 18.00 ± 0.00 |  |  |  |
| Intel/Qwen3.5-397B-A17B-int4-AutoRound | ctx_pp @ d32768 | 1161.66 ± 1.61 |  | 28215.72 ± 39.00 | 28208.79 ± 39.00 | 28215.86 ± 38.97 |
| Intel/Qwen3.5-397B-A17B-int4-AutoRound | ctx_tg @ d32768 | 17.25 ± 0.03 | 18.00 ± 0.00 |  |  |  |
| Intel/Qwen3.5-397B-A17B-int4-AutoRound | pp2048 @ d32768 | 311.32 ± 1.67 |  | 6585.57 ± 35.44 | 6578.64 ± 35.44 | 6585.70 ± 35.48 |
| Intel/Qwen3.5-397B-A17B-int4-AutoRound | tg32 @ d32768 | 17.37 ± 0.29 | 18.33 ± 0.47 |  |  |  |

llama-benchy (0.3.5)
date: 2026-03-31 18:03:15 | latency mode: api

## Setup with sparkrun

### Step 1: Create a cluster

```bash
sparkrun cluster create mesh \
  --hosts 10.0.0.11,10.0.0.12,10.0.0.13 \
  --default
```

Replace the IPs with your Sparks' management network addresses.

### Step 2: Run the setup wizard

```bash
sparkrun setup wizard --cluster mesh
```

The wizard walks through everything:

- SSH mesh — ensures all nodes can SSH to each other (required for multi-node inference)
- CX7 detection — discovers all ConnectX-7 interfaces on each host
- Topology detection — uses IPv6 multicast neighbor discovery to map which port connects to which peer, then classifies the topology as mesh
- Network configuration — assigns static IPs and jumbo frames (MTU 9000) via netplan, with a unique subnet pair per cable
- Host key distribution — registers the new CX7 IPs in known_hosts so SSH works over the high-speed interfaces
- Saves topology — records topology: ring in the cluster definition so sparkrun run automatically applies the right NCCL settings

The wizard auto-detects everything. You don't need to know which cable connects which ports — sparkrun discovers the physical topology and assigns subnets accordingly.

### Step 2 (alternative): Manual CX7 setup

If you prefer to run just the CX7 step:

```bash
sparkrun setup cx7 --cluster mesh
```

This detects interfaces, discovers topology, shows the planned configuration, and asks for confirmation before applying.

## What sparkrun configures

On each Spark, sparkrun writes a netplan file (`/etc/netplan/40-cx7.yaml`) that configures all four CX7 interfaces with:

- Static IPs on the correct subnets for each cable
- MTU 9000 (jumbo frames) for maximum throughput
- No link-local addresses (avoids NCCL routing confusion)

Example for Spark 1 (connected to Spark 2 on port 0, Spark 3 on port 1):

```yaml
network:
  version: 2
  ethernets:
    enp1s0f0np0:
      dhcp4: no
      dhcp6: no
      link-local: [ ]
      mtu: 9000
      addresses: [ 192.168.177.11/24 ]
    enP2p1s0f0np0:
      dhcp4: no
      dhcp6: no
      link-local: [ ]
      mtu: 9000
      addresses: [ 192.168.178.11/24 ]
    enp1s0f1np1:
      dhcp4: no
      dhcp6: no
      link-local: [ ]
      mtu: 9000
      addresses: [ 192.168.187.11/24 ]
    enP2p1s0f1np1:
      dhcp4: no
      dhcp6: no
      link-local: [ ]
      mtu: 9000
      addresses: [ 192.168.188.11/24 ]
```

## Idempotent and safe

Running `sparkrun setup cx7` again on an already-configured mesh is safe — it detects the existing configuration,
validates it against the detected topology, and reports "All hosts already configured" without making changes. Use
`--force` if you need to reconfigure.

## Running Inference on the Mesh

Once the mesh is configured, sparkrun automatically applies the right NCCL environment variables when launching
inference on the cluster:

```bash
sparkrun run <recipe> --cluster mesh
# -- or --
sparkrun run <recipe>
```

(We don't need to specify the cluster name because we already set it as our default cluster in the first step.)

Because the cluster definition has `topology: ring`, sparkrun injects the following NCCL environment variables:

- `NCCL_NET_PLUGIN=none`
- `NCCL_IB_SUBNET_AWARE_ROUTING=1`
- `NCCL_IB_MERGE_NICS=0`

Sparkrun doesn't require other changes to any other NCCL environment variables because the existing autodetection
functionality handles the rest.

These changes ensure that we're properly setup for using the mesh with the latest patched versions of NCCL that are
included as part of @eugr's latest builds.

## Pipeline parallel recipes

Here is a sparkrun version to run the recipe sample from the new spark-vllm-docker release:

```bash
sparkrun run @experimental/qwen3.5-397b-a17b-int4-autoround-3x-vllm
```

And here is the recipe file:

```yaml
# qwen3.5-397b-a17b-int4-autoround-3x-vllm.yaml
recipe_version: "2"
model: Intel/Qwen3.5-397B-A17B-int4-AutoRound
runtime: vllm

# this recipe is specific to 3-node mesh, so we set min/max nodes to 3
min_nodes: 3
max_nodes: 3

# using the Spark Arena eugr nightly container will signal sparkrun to use @eugr's latest release
container: ghcr.io/spark-arena/dgx-vllm-eugr-nightly-tf5:latest

metadata:
  description: Recipe for Qwen3.5-397B-INT4-Autoround to run on 3-node mesh in pipeline-parallel mode

# sparkrun knows to use "--tf5" flag when using the 'dgx-vllm-eugr-nightly-tf5' container, but we add it for completeness
build_args:
  - --tf5

# Mod required to fix ROPE syntax error
mods:
  - mods/fix-qwen3.5-autoround
  - mods/fix-qwen3.5-chat-template

# Ideally all command arguments should be specified in the defaults section
defaults:
  port: 8000
  host: 0.0.0.0
  pipeline_parallel: 3
  tensor_parallel: 1
  gpu_memory_utilization: 0.7
  max_model_len: 262144
  max_num_batched_tokens: 16384
  max_num_seqs: 10
  kv_cache_dtype: fp8
  tool_call_parser: qwen3_coder
  reasoning_parser: qwen3

# Environment variables
env:
  PYTORCH_CUDA_ALLOC_CONF: "expandable_segments:True"
  VLLM_MARLIN_USE_ATOMIC_ADD: 1

# The vLLM serve command template
command: |
  vllm serve {model} \
    --max-model-len {max_model_len} \
    --max-num-seqs {max_num_seqs} \
    --kv-cache-dtype {kv_cache_dtype} \
    --gpu-memory-utilization {gpu_memory_utilization} \
    --port {port} \
    --host {host} \
    --enable-prefix-caching \
    --enable-auto-tool-choice \
    --tool-call-parser {tool_call_parser} \
    --reasoning-parser {reasoning_parser} \
    --max-num-batched-tokens {max_num_batched_tokens} \
    --trust-remote-code \
    --chat-template unsloth.jinja \
    --load-format fastsafetensors \
    -tp {tensor_parallel} \
    -pp {pipeline_parallel}
```

More mesh pipeline-parallel recipe examples are coming soon to the official sparkrun registries.

## Troubleshooting

"ring topology requires 2 physical ports (4 interfaces)" — Your Sparks only have one active CX7 port (2 interfaces).
Mesh requires both ports connected. Check that all three cables are plugged in and that both ports show as active (`ip link`).

"ring topology requires exactly 3 hosts" — Mesh/ring is specifically for 3-node configurations. For 2 nodes, use the
default switch/direct topology. For 4+ nodes, use a switch.

"Topology detected as 'switch' instead of 'ring'" — This means some interfaces can see more than one peer, indicating
a switch is in the path. Verify your cables are direct point-to-point connections (not going through a switch).

"passwordless sudo not available" — Initial netplan configuration requires sudo. The wizard will prompt for a
password. After the first setup, re-runs don't need sudo (idempotency check works without it).
