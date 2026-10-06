# Spark Arena Tech Blog

This directory contains markdown posts and a static site generator for a Spark Arena-themed tech blog.

## Structure

- `index.md`: landing content for the blog home page
- `*/**.md`: post content files
- `scripts/build.mjs`: markdown -> static HTML builder
- `dist/`: generated static site output (deploy this)
- `worker.js`: Cloudflare Worker entrypoint
- `wrangler.toml`: Worker + assets config

## Build Static HTML

From repo root:

```bash
node scripts/build.mjs
```

This generates:

- `dist/index.html`
- `dist/posts/<slug>/index.html`

## Local Preview

Build first, then run the Worker and its static assets locally:

```bash
node scripts/build.mjs
npx wrangler dev --ip 127.0.0.1 --port 8791
```

Open http://127.0.0.1:8791/. Rebuild after editing Markdown or the template;
Wrangler serves the updated generated assets. Stop the preview with Ctrl+C.

Run the Markdown renderer checks with `node --test scripts/build.test.mjs`.
Posts may set a plain-text `description` in frontmatter for their home-page
excerpt. Diagrams are static SVG assets in each post's `img/` directory.

## Deploy to Cloudflare Worker

From the repository root:

```bash
npx wrangler deploy
```

`wrangler.toml` is configured to serve static assets from `./dist` via the `ASSETS` binding.

## Notes

- Theme styling is aligned with Spark Arena visual direction (dark + NVIDIA green accents).
- Links in markdown render as external links by default.
