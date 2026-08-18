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

Recently, Saiyam Pathakpublished [Running Qwen3.8-27B on DGX Spark](https://blog.kubesimplify.com/qwen3-8-27b-on-dgx-spark) — an excellent day-zero writeup. The weights landed on August 14; the model was serving within the hour and four engines were
measured by the time most people had finished reading the model card. If you have a Spark, go read it.

The post used [sparkrun](https://sparkrun.dev) for the vLLM leg, and said something nice about it that I want to take
seriously rather than just enjoy:

> sparkrun recipes made a day-zero model a config-file edit, not an afternoon of dependency fighting.

That's the idea! But it only landed for one of the four engines in that post. The llama.cpp leg was a
hand-written `docker run` with a bind mount and an `--entrypoint` override. The benchmarks were three different tools:
`llama-bench` inside a container for llama.cpp, `llama-benchy` over HTTP for vLLM and SGLang, `curl | jq` against
Ollama's eval counters. Every leg had its own start command, its own teardown, and its own definition of "prefill".

None of that was wrong. It is what everyone has always done. But three of those four engines are ones sparkrun already drives, and
the config-file-edit property the post liked about the vLLM leg was available for all of them. So this post is the
follow-up: **the same comparison, expressed as three recipes and one command.**

So let's start with the end first: the three commands that reproduce the original post's tables.

```bash
sparkrun benchmark perf @community/blog-qwen3.8-27b-fp8-vllm-dbsci        --profile @community/blog-qwen3.8-27b-dbsci
sparkrun benchmark perf @community/blog-qwen3.8-27b-fp8-sglang-dbsci      --profile @community/blog-qwen3.8-27b-dbsci
sparkrun benchmark perf @community/blog-qwen3.8-27b-q4kxl-llama-cpp-dbsci --profile @community/blog-qwen3.8-27b-dbsci
```

Three lines. One reference changed between them. That's it.

Each one launches the workload, waits for it to come up healthy, runs the benchmark ladder against it, stops the workload, and
writes the results.

And that's the point. sparkrun is meant to make running inference or doing this kind of benchmarking far easier. The other benefit of the standardization of recipes in sparkrun is that it becomes easier to do parametric studies and optimization without
having to rewrite the same sort of scripts and boilerplate every time. And of course, we've got skills for your agent, so you can get your agent to help
with preparing recipes, managing your spark(s), and optimizing your models.

The `@community/blog-qwen3.8-27b-dbsci` profile is a companion profile that ships beside the recipes that captures the benchmarking configuration; it is shown in full below.

The recipes are [in the community registry](https://github.com/spark-arena/community-recipe-registry/tree/main/recipes/blog-qwen3.8-27b/dbsci).
Note that they are transcriptions of the original post's configuration, not re-tunings of it.

Before we get started, sparkrun is a relatively young open source project, so updates are frequent. Make sure that you're 
using the latest version whether for this article or whenever you might encounter issues. 

Installing sparkrun: `uvx sparkrun setup` (requires uv)
Updating sparkrun: `sparkrun update`

Now back to the article.

## What actually changes between engines

Writing three recipes instead of three `docker run` lines forces you to be explicit about what you are *not* holding
constant. Here is the whole set, side by side — everything above the rule is identical by construction, everything below
it is the actual answer to "what changes".

|                       | vLLM                           | SGLang                                                  | llama.cpp                          |
|-----------------------|--------------------------------|---------------------------------------------------------|------------------------------------|
| `port`                | 8000                           | 8000                                                    | 8000                               |
| `served_model_name`   | `qwen3.8-27b`                  | `qwen3.8-27b`                                           | `qwen3.8-27b`                      |
| `benchmark.tokenizer` | `Qwen/Qwen3.8-27B`             | `Qwen/Qwen3.8-27B`                                      | `Qwen/Qwen3.8-27B`                 |
| nodes                 | 1                              | 1                                                       | 1                                  |
| —                     | —                              | —                                                       | —                                  |
| `runtime`             | `vllm`                         | `sglang`                                                | `llama-cpp`                        |
| `model`               | `Qwen/Qwen3.8-27B-FP8`         | `Qwen/Qwen3.8-27B-FP8`                                  | `unsloth/Qwen3.8-27B-GGUF:Q4_K_XL` |
| weights on the wire   | 28.75 GB                       | 28.75 GB                                                | 16.68 GiB                          |
| `container`           | `dgx-vllm-eugr-nightly:latest` | `lmsysorg/sglang:latest-cu130`                          | `dgx-llama-cpp:latest`             |
| `max_model_len`       | 131072                         | 131072                                                  | 409600 (total, ÷ 10 slots)         |
| memory knob           | `gpu_memory_utilization: 0.8`  | `gpu_memory_utilization: 0.8` → `--mem-fraction-static` | `n_gpu_layers: 99`                 |
| KV                    | `kv_cache_dtype: fp8`          | `kv_cache_dtype: fp8`                                   | GGUF default                       |
| speculation           | none                           | NEXTN, 3 steps, 4 draft tokens                          | none                               |

And the profile all three are pointed at, which is a transcription of the original post's own llama-benchy call:

```yaml
# benchmarking/blog-qwen3.8-27b-dbsci.yaml
framework: llama-benchy
category: performance
args:
  depth: [ 0, 16384, 32768 ]
  pp: [ 2048 ]
  tg: [ 128 ]
  concurrency: [ 1, 2, 5, 10 ]
  prefix_caching: true
```

Twelve cells. Naming it is what makes these runs land *beside* the original post's tables instead of beside a different
experiment that happens to use the same model.

Three of those rows deserve a sentence each — two because forcing parity would mean benchmarking a configuration nobody
runs, and one because leaving it out breaks the comparison without breaking anything visible.

**Different weights, on purpose.** A Q4 GGUF is what people run under llama.cpp and an FP8 one does not exist. On a
bandwidth-bound box this dominates single-stream decode — every token streams the entire weight set, so at GB10's ~273
GB/s the 16.7 GB quant has a ceiling near 16 t/s where the FP8 checkpoint sits near 9. llama.cpp leading single-stream
is arithmetic, not engine quality, and the original post is careful about this too.

**Speculative Decoding on for exactly one of them.** NEXTN roughly doubles SGLang's single-stream decode and it is the
configuration you would actually serve, so it ships on. That makes the SGLang column not-comparable to the vLLM one as
shipped; the recipe README documents the four lines to delete for the strictly matched run.

**`benchmark.tokenizer` is the confusing hidden detail.** llama-benchy builds depth prompts by tokenizing,
and resolves a tokenizer from the served model name. `qwen3.8-27b` is not a Hugging Face id, so it falls back to GPT-2.
Nothing errors, you get a full results table, and "32768 tokens deep" now means a different quantity of text in each
run. It's not really needed for vllm and sglang because they use the Hugging Face id (sparkrun would infer it); however,
for llama.cpp, it would be a failure point where the GGUF repo carries no HF tokenizer at all. We add the line to all the recipes
to keep them aligned with each other. It's not a bad practice anyway to be explicit about inputs. 

### The one value we had to derive rather than copy

sparkrun already translates the cross-runtime `max_model_len` key to llama.cpp's `--ctx-size`, so all three recipes
spell it the same way. They do not *mean* the same thing, and no amount of translation can fix that: in llama-server
`--ctx-size` is the total context divided evenly across `--parallel` slots, where vLLM's `--max-model-len` is a
per-request limit independent of concurrency.

So the profile's deepest cell — depth 32768 at concurrency 10 — needs each of ten slots to hold about 32768 + 2048 +
128 ≈ 34,944 tokens. Hence `parallel: 10` and `max_model_len: 409600`, which have to move together: raise one alone and
you fail either the deep cells or the concurrent ones.

The original post never hit this and could not have, because its llama.cpp leg was measured with `llama-bench`, which
has no concurrency dimension at all. That makes this the one number in the set that is derived rather than transcribed,
and correspondingly the one most likely to be wrong. Before pointing `--arena` at the llama.cpp recipe, redo it — the
Spark Arena profile reaches deeper, and at ten slots that is roughly 1.3M total context.

The KV bill is affordable for an architectural reason the original post explains well: only 16 of Qwen3.8-27B's 64
layers are full attention, the rest are Gated DeltaNet with constant-size state, so KV grows at roughly a quarter of the
rate a conventional 64-layer model's would. That same property is why decode is nearly flat in context depth — 8.2 t/s
at depth 0 against 7.9 t/s at 32K on vLLM FP8.

## Contributing Benchmarks

[Spark Arena](https://spark-arena.com) is a public leaderboard for DGX Spark inference benchmarks. It is free to use, and you can submit results from any
DGX Spark setup. The idea is to share recipes and performance results (and more kinds of results soon) 
with the community, and to make it easy for people to reproduce them. It's a huge help to everyone to know what works and what doesn't, 
and to have a place to compare results across different configurations.

The general process for a [Spark Arena](https://spark-arena.com) leaderboard submission rather than a reproduction is:

```bash
sparkrun arena login
sparkrun benchmark perf @community/blog-qwen3.8-27b-fp8-vllm-dbsci --arena
```

Using `--arena` means that it does the standardized benchmark and uploads the results to the Spark Arena leaderboard. 

To sign up for a free account, goto: https://spark-arena.com/join. By the way, we require accounts because the Internet
isn't really the safest place. We tried open submissions, and it didn't work out so great... So we require accounts to keep the leaderboard honest and useful.

Also, quick note: these benchmarks can take time depending on the model, benchmark, and hardware. Be prepared for that. To try to make
that a little better, sparkrun decomposes the benchmark work into smaller blocks to enable resumable runs, so if you have to stop or if you 
have a hardware failure, you can resume the benchmark from where it left off.

## Links

- Original post: [Running Qwen3.8-27B on DGX Spark](https://blog.kubesimplify.com/qwen3-8-27b-on-dgx-spark) by Saiyam Pathak
- Recipes: [`recipes/blog-qwen3.8-27b/dbsci/`](https://github.com/spark-arena/community-recipe-registry/tree/main/recipes/blog-qwen3.8-27b/dbsci)
- [sparkrun](https://sparkrun.dev) 
- [Spark Arena](https://spark-arena.com)
