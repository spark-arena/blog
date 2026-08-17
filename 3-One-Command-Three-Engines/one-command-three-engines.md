---
authors:
  - dbsci
tags:
  - sparkrun
  - benchmarking
  - recipes
  - vllm
  - sglang
  - llama.cpp
  - dgx-spark
---

# One Command, Three Engines: Turning a Day-Zero Model Post Into Three Recipes

by [@dbsci](https://forums.developer.nvidia.com/u/dbsci/summary)

A few days ago Saiyam Pathak published [Running Qwen3.8-27B on DGX Spark](https://blog.kubesimplify.com/qwen3-8-27b-on-dgx-spark) — a genuinely excellent day-zero writeup. The weights landed on August 14; the model was serving within the hour and four engines were measured by the time most people had finished reading the model card. If you have a Spark, go read it.

The post used [sparkrun](https://sparkrun.dev) for the vLLM leg, and said something nice about it that I want to take seriously rather than just enjoy:

> sparkrun recipes made a day-zero model a config-file edit, not an afternoon of dependency fighting.

That is exactly the intent. But it only landed for one of the four engines in that post. The llama.cpp leg was a hand-written `docker run` with a bind mount and an `--entrypoint` override. The benchmarks were three different tools: `llama-bench` inside a container for llama.cpp, `llama-benchy` over HTTP for vLLM and SGLang, `curl | jq` against Ollama's eval counters. Every leg had its own start command, its own teardown, and its own definition of "prefill".

None of that was wrong. It is what everyone does. But three of those four engines are ones sparkrun already drives, and the config-file-edit property the post liked about the vLLM leg was available for all of them. So this post is the follow-up: **the same comparison, expressed as three recipes and one command.**

## The shape of the thing

Here is the entire experiment.

```bash
sparkrun benchmark perf @community/blog-qwen3.8-27b-fp8-vllm-dbsci        --profile blog-qwen3.8-27b-dbsci
sparkrun benchmark perf @community/blog-qwen3.8-27b-fp8-sglang-dbsci      --profile blog-qwen3.8-27b-dbsci
sparkrun benchmark perf @community/blog-qwen3.8-27b-q4kxl-llama-cpp-dbsci --profile blog-qwen3.8-27b-dbsci
```

Three lines. One word different between them.

Each one launches the workload, waits for it to come up healthy, runs the ladder against it, stops the workload, and writes the results.

`blog-qwen3.8-27b-dbsci` is a companion profile that ships beside the recipes, and it is a transcription of the original post's own llama-benchy call — pp 2048, tg 128, depths 0 / 16384 / 32768, concurrency 1/2/5/10, prefix caching on. Twelve cells. Naming it is what makes these runs land *beside* the post's tables instead of beside a different experiment that happens to use the same model.

If what you want is a leaderboard submission rather than a reproduction, don't name a profile at all:

```bash
sparkrun arena login
sparkrun benchmark perf @community/blog-qwen3.8-27b-fp8-vllm-dbsci --arena
```

`--arena` picks the current Spark Arena profile itself and uploads the result. That is deliberately better than spelling a version out in a blog post, because the blog post does not get updated when the profile is revised.

The recipes are [in the community registry](https://github.com/spark-arena/community-recipe-registry/tree/main/recipes/blog-qwen3.8-27b/dbsci). They are transcriptions of the original post's configuration, not retunings of it.

## What actually changes between engines

This is the interesting part, and it is where the "just write three recipes" framing earns its keep — because writing them forces you to be explicit about what you are *not* holding constant.

Here is the vLLM one, essentially verbatim from the original post:

```yaml
recipe_version: "2"
model: Qwen/Qwen3.8-27B-FP8
runtime: vllm
container: ghcr.io/spark-arena/dgx-vllm-eugr-nightly:latest

defaults:
  port: 8000
  served_model_name: qwen3.8-27b
  gpu_memory_utilization: 0.8
  max_model_len: 131072
  load_format: instanttensor
  kv_cache_dtype: fp8
  attention_backend: flashinfer

benchmark:
  tokenizer: Qwen/Qwen3.8-27B
```

The SGLang one differs in `runtime`, `container`, and the flag spellings SGLang wants (`--mem-fraction-static` rather than `--gpu-memory-utilization`, `--context-length` rather than `--max-model-len`). The llama.cpp one differs in `runtime`, `container`, and the model — which is the first thing worth being loud about.

### Asymmetry 1: llama.cpp is not serving the same weights

vLLM and SGLang serve `Qwen/Qwen3.8-27B-FP8`, about 28.75 GB. llama.cpp serves `unsloth/Qwen3.8-27B-GGUF:Q4_K_XL`, 16.68 GiB. Not because anyone chose to handicap the comparison, but because a Q4 GGUF is what people run under llama.cpp and an FP8 one does not exist.

On a GB10 that single difference explains most of the headline. Decode is bandwidth-bound: every generated token streams the entire weight set through ~273 GB/s of unified memory. That puts the theoretical single-stream ceiling near 16 t/s for the 16.7 GB quant and near 9 for the 28.75 GB checkpoint. The original post measured 11.6 t/s for llama.cpp against 8.2 for vLLM FP8 — llama.cpp "winning" single-stream is arithmetic, not engine quality, and the post says so clearly.

You cannot make this symmetric. What you *can* do is put it in the recipe metadata so that nobody reads the table without it.

### Asymmetry 2: speculation is on for exactly one of them

The SGLang recipe inherits NEXTN speculative decoding from the qwen3.5-27b recipe it was adapted from. It roughly doubles single-stream decode — 7.7 → 13.4 t/s in the original measurements — and it is the configuration you would actually serve.

That makes it not-comparable to the plain-FP8 vLLM sibling. Both numbers are worth having, so the recipe ships with speculation on and the README documents the four lines to delete for the strictly matched run.

### The one that quietly ruins everything

`benchmark.tokenizer`.

llama-benchy builds its depth prompts by tokenizing, and it resolves a tokenizer from the served model name. The served name here is `qwen3.8-27b`, which is not a Hugging Face id, so it falls back to GPT-2. Nothing errors. You get a full results table. It is just that "32768 tokens deep" now means a different quantity of text than it does in the run you are comparing against, and the depth axis has silently stopped being an axis.

It bites hardest on llama.cpp, where the GGUF repo carries no HF tokenizer at all. One line in each recipe fixes it for all three:

```yaml
benchmark:
  tokenizer: Qwen/Qwen3.8-27B
```

This is the class of thing that makes recipes worth writing down. It is not a performance tweak and it will never show up as a slow number — it shows up as three tables that look fine and cannot legitimately be put beside each other. Credit where due: this failure mode was already documented as a pitfall by [@banana_baeee](https://github.com/spark-arena/community-recipe-registry/tree/main/recipes/qwen3.5-27b/banana_baeee) in an earlier community recipe README, which is the entire argument for recipes carrying prose.

### The one number we had to derive rather than copy

The original post ran llama.cpp at `-c 32768`. Ours runs at 409600, and that is not a bigger window — it is the same window, ten times over.

In llama-server, `--ctx-size` is the *total* context, divided evenly across `--parallel` slots. It is not a per-request limit like vLLM's `--max-model-len`. So the deepest cell of the profile — depth 32768 at concurrency 10 — needs each of ten slots to hold about 32768 + 2048 + 128 ≈ 34,944 tokens. `-c 32768` would not serve one such request, let alone ten. Hence `parallel: 10` and `ctx_size: 409600`, which have to move together: raise one alone and you fail either the deep cells or the concurrent ones.

The original post never hit this, and could not have, because its llama.cpp leg was measured with `llama-bench` — which has no concurrency dimension at all. That is the whole reason this is the one number in the set that is derived rather than transcribed, and correspondingly the one most likely to be wrong.

The KV bill is affordable for an architectural reason the post explains well: only 16 of Qwen3.8-27B's 64 layers are full attention, the rest are Gated DeltaNet with constant-size state, so KV grows at roughly a quarter of the rate a conventional 64-layer model's would. Order-of-magnitude, ~26 GiB of KV on top of 16.68 GiB of weights, inside GB10's 121.7 GiB.

That same architecture is why decode is nearly flat in context depth: 8.2 t/s at depth 0 versus 7.9 t/s at 32K on vLLM FP8. For long-document and agentic work on local hardware that flatness matters more than the headline number, and it is the finding I would most want re-measured across all three engines on one ladder.

Worth knowing before you point `--arena` at the llama.cpp recipe: the Spark Arena profile reaches deeper than the blog-parity one, which at ten slots is roughly 1.3M total context and will not fit. Redo the arithmetic first. The vLLM and SGLang siblings have no such coupling — their per-request limit is independent of concurrency, which is itself a real operational difference between the engines and not just a config detail.

## The part I want to underline

There is a scary story in the original post that deserves more attention than it got.

The first SGLang attempt used the container image pinned in the qwen3.5-27b recipe — a dev build created before Qwen3.8 existed. It loaded the day-zero checkpoint without a single warning. The health check went green. The API answered every request. And it produced complete token soup: *"visit visit visits 訪...逻辑逻辑logic..."*. Disabling speculation changed nothing, because speculation was never the problem. Swapping to upstream `lmsysorg/sglang:latest-cu130` fixed it instantly.

> The scary part is that the health check was green and the API answered every request the whole time — a crash at least tells you something is wrong, silent garbage does not.

This is the strongest argument in the whole post for the recipe-plus-registry model, and it cuts against the instinct to pin everything. A pinned image is normally the reproducible choice. On a checkpoint that is four hours old, the pin is the hazard: it is the one thing guaranteed to predate the model. So the SGLang recipe here deliberately tracks a floating upstream tag and says why in its own metadata, which is a thing a `docker run` in a blog post cannot do for you six weeks later.

It is also why sparkrun's benchmark flow runs a coherence check before it starts measuring, and why `-b skip_coherence=true` is the wrong reflex on a day-zero model. A benchmark harness that will happily measure the throughput of token soup is measuring the wrong thing very precisely.

## What we did not port

Ollama, deliberately. It was the single-stream champion in the original post at 26.5 t/s, and the reason is worth repeating — the Ollama build ships the model's multi-token-prediction head and turns speculative decoding on by default, so each weight-streaming pass validates up to four drafted tokens. But it is not a sparkrun runtime, so there is no recipe to write. Read the original for that leg.

Likewise the DSpark draft-model results and the vLLM MTP numbers: those are peak-throughput configurations, and mixing them into a matched comparison would defeat the purpose. If peak is what you want, `@official/qwen3.8-27b-fp8-mtp-vllm` and the NVFP4 and DSpark official recipes already exist and are all faster than anything in this set. Note the original post's warning before you run MTP at depth, though — it hard-rebooted that Spark twice at the same benchmark cell.

## Numbers

I have not re-measured any of this. The recipes are validated for schema and command rendering; they have not been booted on a GB10 by me, and the tables below are the original post's, taken at those settings rather than through this set.

| Engine | Weights | Prefill c=1 | Decode c=1 | Decode c=10 agg |
|---|---|---:|---:|---:|
| vLLM FP8 | 28.75 GB | 1,914 t/s | 8.2 t/s | 57.9 t/s |
| SGLang FP8 | 28.75 GB | 1,225 t/s | 7.7 t/s | 54.3 t/s |
| SGLang FP8 + NEXTN | 28.75 GB | — | 13.4 t/s | 71.0 t/s |
| llama.cpp Q4_K_XL | 16.68 GiB | 837 t/s | 11.6 t/s | n/a |

That last cell is the point in miniature. It is empty because llama.cpp's leg was measured with `llama-bench`, which has no concurrency dimension — a different tool answering a different question, so the row cannot be completed. Run all three through one ladder and it fills in.

Which is the actual ask. If you have a Spark, the three commands at the top of this post produce a comparison none of us has yet — and if you would rather it landed somewhere permanent than in a table in a blog post, drop the `--profile` and add `--arena`.

## Links

- Original post: [Running Qwen3.8-27B on DGX Spark](https://blog.kubesimplify.com/qwen3-8-27b-on-dgx-spark) by Saiyam Pathak
- Recipes: [`recipes/blog-qwen3.8-27b/dbsci/`](https://github.com/spark-arena/community-recipe-registry/tree/main/recipes/blog-qwen3.8-27b/dbsci)
- [sparkrun](https://sparkrun.dev) · [Spark Arena](https://spark-arena.com) · [llama-benchy](https://pypi.org/project/llama-benchy/)
- Model: [Qwen/Qwen3.8-27B-FP8](https://huggingface.co/Qwen/Qwen3.8-27B-FP8) · [unsloth/Qwen3.8-27B-GGUF](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF)
