import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BLOG_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(BLOG_ROOT, "dist");

const SKIP_DIRS = new Set([".git", "dist", "scripts", "node_modules"]);

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "post";
}

function normalizePath(input) {
  return input.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function canonicalDocKey(inputPath) {
  const normalized = normalizePath(inputPath).replace(/\.md$/i, "");
  const parts = normalized.split("/").filter(Boolean).map(slugify);
  return parts.join("/");
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const v = (value || "").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function mergeStringLists(primary = [], secondary = []) {
  return uniqueStrings([...primary, ...secondary]);
}

function parseCsvValues(value) {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseFrontmatter(markdown) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { metadata: {}, body: markdown };
  }

  const endIdx = normalized.indexOf("\n---\n", 4);
  if (endIdx === -1) {
    return { metadata: {}, body: markdown };
  }

  const fmRaw = normalized.slice(4, endIdx);
  const body = normalized.slice(endIdx + 5);
  const metadata = {};

  const lines = fmRaw.split("\n");
  let currentListKey = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem && currentListKey) {
      if (!Array.isArray(metadata[currentListKey])) {
        metadata[currentListKey] = [];
      }
      metadata[currentListKey].push(listItem[1].trim());
      continue;
    }

    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!kv) {
      currentListKey = null;
      continue;
    }

    const key = kv[1].trim().toLowerCase();
    const rawValue = kv[2].trim();

    if (!rawValue) {
      metadata[key] = [];
      currentListKey = key;
      continue;
    }

    currentListKey = null;

    if (key === "authors" || key === "tags") {
      metadata[key] = parseCsvValues(rawValue);
    } else {
      metadata[key] = rawValue;
    }
  }

  if (Array.isArray(metadata.authors)) {
    metadata.authors = uniqueStrings(metadata.authors);
  }
  if (Array.isArray(metadata.tags)) {
    metadata.tags = uniqueStrings(metadata.tags);
  }

  return { metadata, body };
}

function parseIndexEntries(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const entries = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("- ")) continue;

    const linkMatch = line.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (!linkMatch) continue;

    const label = linkMatch[1].trim();
    const pathRef = linkMatch[2].trim();
    const key = canonicalDocKey(pathRef);

    const entry = {
      label,
      pathRef,
      key,
      authors: [],
      tags: [],
    };

    const trailing = line.slice(line.indexOf(linkMatch[0]) + linkMatch[0].length).trim();
    if (trailing.startsWith("|")) {
      const segments = trailing
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);

      for (const segment of segments) {
        const kv = segment.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/);
        if (!kv) continue;

        const keyName = kv[1].trim().toLowerCase();
        const value = kv[2].trim();

        if (keyName === "authors") {
          entry.authors = uniqueStrings(parseCsvValues(value));
        } else if (keyName === "tags") {
          entry.tags = uniqueStrings(parseCsvValues(value));
        }
      }
    }

    entries.push(entry);
  }

  return entries;
}

function escapeHtml(input) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderLink(label, href) {
  const safeLabel = escapeHtml(label);
  const safeHref = escapeHtml(href);
  const isExternal = /^https?:\/\//i.test(href);
  if (isExternal) {
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
  }
  return `<a href="${safeHref}">${safeLabel}</a>`;
}

function renderInline(markdown) {
  const escaped = escapeHtml(markdown);
  return escaped
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
      const safeAlt = escapeHtml(alt || "");
      const safeSrc = escapeHtml(src || "");
      return `<img src="${safeSrc}" alt="${safeAlt}" loading="lazy" />`;
    })
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => renderLink(label, href));
}

function renderMarkdown(markdown) {
  function parseTableRow(line) {
    const trimmed = line.trim();
    let content = trimmed;
    if (content.startsWith("|")) content = content.slice(1);
    if (content.endsWith("|")) content = content.slice(0, -1);
    return content.split("|").map((cell) => cell.trim());
  }

  function isTableSeparator(line) {
    const cells = parseTableRow(line);
    if (cells.length === 0) return false;
    return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
  }

  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    if (/^```/.test(line.trim())) {
      const lang = line.trim().slice(3).trim();
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      out.push(`<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    // GFM table support: header row + separator row + data rows
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const headerCells = parseTableRow(line).map((cell) => renderInline(cell));
      i += 2; // Skip header and separator

      const bodyRows = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        lines[i].includes("|") &&
        !/^(#{1,6})\s+/.test(lines[i]) &&
        !/^```/.test(lines[i].trim())
      ) {
        const rowCells = parseTableRow(lines[i]).map((cell) => renderInline(cell));
        bodyRows.push(rowCells);
        i += 1;
      }

      const thead = `<thead><tr>${headerCells.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${bodyRows
        .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
        .join("")}</tbody>`;
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      out.push("<hr />");
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line.trim())) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i += 1;
      }
      out.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line.trim())) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i += 1;
      }
      out.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ol>`);
      continue;
    }

    const paragraph = [line.trim()];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !/^```/.test(lines[i].trim()) &&
      !/^---+$/.test(lines[i].trim())
    ) {
      paragraph.push(lines[i].trim());
      i += 1;
    }

    out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }

  return out.join("\n");
}

function extractTitle(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function extractExcerpt(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (
      !line ||
      line.startsWith("#") ||
      line.startsWith("-") ||
      /^\d+\./.test(line) ||
      line.startsWith("```") ||
      line.startsWith("![")
    ) {
      continue;
    }
    return line.length > 190 ? `${line.slice(0, 187)}...` : line;
  }
  return "Read this technical deep dive.";
}

function estimateReadMinutes(markdown) {
  const text = markdown.replace(/```[\s\S]*?```/g, " ");
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

async function walkMarkdownFiles(rootDir) {
  const results = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        results.push(path.join(dir, entry.name));
      }
    }
  }

  await walk(rootDir);
  return results;
}

async function copyDirectoryRecursive(srcDir, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

function renderTags(tags) {
  if (!tags || tags.length === 0) return "";
  return `<div class="tag-row">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>`;
}

function pageTemplate({ title, description, content, isPost = false }) {
  const backLink = isPost
    ? '<a class="brand-link" href="/">Back to all stories</a>'
    : '<a class="brand-link" href="https://spark-arena.com/">Spark Arena</a>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} | Spark Arena Tech Blog</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <style>
    :root {
      --bg: #050606;
      --paper: #0f1410;
      --text: #f4f7f4;
      --muted: #95a295;
      --line: #2a332a;
      --brand: #76b900;
      --brand-dark: #5f9700;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Charter, "Bitstream Charter", "Sitka Text", Cambria, serif;
      color: var(--text);
      background:
        radial-gradient(55% 45% at 15% 12%, rgba(88, 220, 90, 0.12), transparent 68%),
        radial-gradient(50% 40% at 80% 18%, rgba(60, 140, 120, 0.08), transparent 70%),
        radial-gradient(60% 60% at 45% 85%, rgba(35, 80, 70, 0.12), transparent 72%),
        linear-gradient(160deg, #050606 0%, #070909 45%, #040505 100%);
      line-height: 1.65;
    }
    .top-nav {
      position: sticky;
      top: 0;
      z-index: 10;
      background: rgba(8, 11, 8, 0.88);
      backdrop-filter: saturate(180%) blur(6px);
      border-bottom: 1px solid #253025;
    }
    .top-nav-inner {
      max-width: 1080px;
      margin: 0 auto;
      padding: 0.85rem 1rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .logo {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", Inter, Arial, sans-serif;
      font-size: 1.1rem;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .logo a {
      color: #f3f7f3;
      text-decoration: none;
    }
    .logo a span { color: var(--brand); }
    .nav-links {
      display: flex;
      align-items: center;
      gap: 0.9rem;
      font-family: "IBM Plex Sans", "Segoe UI", Inter, Arial, sans-serif;
      font-size: 0.9rem;
    }
    .brand-link {
      color: #a9b6a9;
      text-decoration: none;
      border-bottom: 1px solid transparent;
    }
    .brand-link:hover {
      color: #f3f7f3;
      border-color: #4f634f;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      border: 1px solid #334133;
      color: #dbe6db;
      text-decoration: none;
      padding: 0.25rem 0.62rem;
      border-radius: 999px;
      background: rgba(22, 30, 22, 0.75);
    }
    .pill:hover {
      border-color: var(--brand);
      color: #f3f7f3;
    }
    .container {
      max-width: 760px;
      margin: 0 auto;
      padding: 2rem 1rem 4rem;
    }
    .tag-title {
      font-family: "IBM Plex Sans", "Segoe UI", Inter, Arial, sans-serif;
      margin: 0;
      font-size: clamp(2rem, 6vw, 3rem);
      letter-spacing: -0.03em;
      line-height: 1.06;
      color: #f3f7f3;
    }
    .tag-sub {
      margin: 0.6rem 0 0;
      color: #a0aea0;
      font-family: "IBM Plex Sans", "Segoe UI", Inter, Arial, sans-serif;
      font-size: 0.98rem;
    }
    .story-list { margin-top: 1.8rem; }
    .story {
      display: block;
      text-decoration: none;
      color: inherit;
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 1rem 1rem 1.05rem;
      margin: 0 0 0.95rem;
      transition: border-color 130ms ease, transform 130ms ease;
    }
    .story:hover {
      border-color: #4c6241;
      transform: translateY(-1px);
    }
    .story-meta {
      font-family: "IBM Plex Sans", "Segoe UI", Inter, Arial, sans-serif;
      color: #97a497;
      font-size: 0.82rem;
      margin-bottom: 0.35rem;
    }
    .story h2 {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", Inter, Arial, sans-serif;
      font-size: clamp(1.2rem, 3.6vw, 1.55rem);
      line-height: 1.2;
      color: #f1f6f1;
      letter-spacing: -0.01em;
    }
    .story p {
      margin: 0.45rem 0 0;
      color: #c7d1c7;
      font-size: 1rem;
    }
    .tag-row {
      margin-top: 0.62rem;
      display: flex;
      flex-wrap: wrap;
      gap: 0.42rem;
    }
    .tag {
      font-family: "IBM Plex Sans", "Segoe UI", Inter, Arial, sans-serif;
      font-size: 0.74rem;
      line-height: 1;
      color: #caefb0;
      background: rgba(118, 185, 0, 0.12);
      border: 1px solid rgba(118, 185, 0, 0.28);
      padding: 0.28rem 0.5rem;
      border-radius: 999px;
    }
    .article {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 2rem 1.35rem;
    }
    .article-head {
      margin-bottom: 0.8rem;
      padding-bottom: 0.6rem;
      border-bottom: 1px solid #253025;
      font-family: "IBM Plex Sans", "Segoe UI", Inter, Arial, sans-serif;
      color: #9cab9c;
      font-size: 0.88rem;
    }
    .article h1,
    .article h2,
    .article h3,
    .article h4,
    .article h5,
    .article h6 {
      color: #f3f7f3;
      line-height: 1.22;
      margin: 1.3em 0 0.5em;
      font-family: "IBM Plex Sans", "Segoe UI", Inter, Arial, sans-serif;
      letter-spacing: -0.02em;
    }
    .article h1 { margin-top: 0.1em; font-size: clamp(2rem, 6vw, 2.8rem); }
    .article h2 { font-size: clamp(1.3rem, 4vw, 1.9rem); }
    .article h3 { font-size: clamp(1.08rem, 3vw, 1.35rem); }
    .article p,
    .article li { color: #dde4dd; font-size: 1.08rem; }
    .article a { color: #8fda4a; }
    .article a:hover { color: #9fe55f; }
    .article strong { color: #f8fff8; }
    .article code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: #0c130d;
      border: 1px solid #253225;
      border-radius: 5px;
      padding: 0.08rem 0.35rem;
      font-size: 0.9em;
    }
    .article pre {
      background: #0a0f0a;
      color: #f3f3f3;
      border-radius: 9px;
      padding: 0.9rem 1rem;
      overflow-x: auto;
      margin: 1rem 0;
    }
    .article pre code {
      border: 0;
      background: transparent;
      color: inherit;
      padding: 0;
    }
    .article table {
      width: 100%;
      border-collapse: collapse;
      margin: 1rem 0;
      font-size: 0.95rem;
      font-family: "IBM Plex Sans", "Segoe UI", Inter, Arial, sans-serif;
      background: #0c130d;
      border: 1px solid #273227;
      border-radius: 8px;
      overflow: hidden;
      display: block;
      overflow-x: auto;
    }
    .article thead tr {
      background: rgba(118, 185, 0, 0.12);
    }
    .article th,
    .article td {
      border: 1px solid #273227;
      padding: 0.48rem 0.58rem;
      text-align: left;
      white-space: nowrap;
    }
    .article th {
      color: #e8f6d8;
      font-weight: 700;
    }
    .article td {
      color: #dde4dd;
    }
    .article hr { border: 0; border-top: 1px solid #273227; margin: 1.6rem 0; }
    .article img {
      max-width: 100%;
      height: auto;
      border: 1px solid #273227;
      border-radius: 10px;
      background: #0c130d;
      padding: 0.35rem;
      margin: 0.7rem 0 1rem;
    }
    .footer {
      margin-top: 1.8rem;
      color: #8f9f8f;
      text-align: center;
      font-family: "IBM Plex Sans", "Segoe UI", Inter, Arial, sans-serif;
      font-size: 0.85rem;
    }
    @media (max-width: 680px) {
      .container { padding-top: 1.35rem; }
      .article { padding: 1.2rem 0.9rem; }
    }
  </style>
</head>
<body>
  <header class="top-nav">
    <div class="top-nav-inner">
      <h1 class="logo"><a href="/"><span>Spark Arena</span> Tech Blog</a></h1>
      <div class="nav-links">
        ${backLink}
        <a class="pill" href="https://spark-arena.com/leaderboard">Leaderboard</a>
      </div>
    </div>
  </header>
  <main class="container">
    ${content}
    <div class="footer">Spark Arena community technical writing</div>
  </main>
</body>
</html>`;
}

async function ensureCleanDist() {
  await fs.rm(DIST_DIR, { recursive: true, force: true });
  await fs.mkdir(DIST_DIR, { recursive: true });
}

async function main() {
  await ensureCleanDist();

  const markdownFiles = await walkMarkdownFiles(BLOG_ROOT);
  const postFiles = markdownFiles
    .filter((abs) => {
      const rel = normalizePath(path.relative(BLOG_ROOT, abs));
      return rel !== "README.md" && rel !== "index.md";
    })
    .sort();

  let indexEntries = [];
  try {
    const indexMarkdown = await fs.readFile(path.join(BLOG_ROOT, "index.md"), "utf8");
    indexEntries = parseIndexEntries(indexMarkdown);
  } catch {
    // optional
  }
  const indexEntryMap = new Map(indexEntries.map((e) => [e.key, e]));

  const posts = [];

  for (const absPath of postFiles) {
    const rel = normalizePath(path.relative(BLOG_ROOT, absPath));
    const raw = await fs.readFile(absPath, "utf8");

    const { metadata: frontmatter, body } = parseFrontmatter(raw);

    const title = extractTitle(body, path.basename(rel, ".md"));
    const excerpt = extractExcerpt(body);
    const readMinutes = estimateReadMinutes(body);

    const relNoExt = rel.replace(/\.md$/i, "");
    const slugParts = relNoExt.split("/").map(slugify);
    const routePath = `/posts/${slugParts.join("/")}/`;
    const outDir = path.join(DIST_DIR, "posts", ...slugParts);

    const key = canonicalDocKey(rel);
    const indexMeta = indexEntryMap.get(key);
    const authors = mergeStringLists(frontmatter.authors || [], indexMeta?.authors || []);
    const tags = mergeStringLists(frontmatter.tags || [], indexMeta?.tags || []);

    const contentHtml = renderMarkdown(body);
    const articleMetaLine = [
      authors.length > 0 ? `By ${escapeHtml(authors.join(", "))}` : "",
      `${readMinutes} min read`,
    ]
      .filter(Boolean)
      .join(" · ");

    const articleHtml = `<article class="article">
      <div class="article-head">${articleMetaLine}${renderTags(tags)}</div>
      ${contentHtml}
    </article>`;

    const html = pageTemplate({
      title,
      description: excerpt,
      content: articleHtml,
      isPost: true,
    });

    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, "index.html"), html, "utf8");

    // Copy sibling image assets so markdown image paths can resolve in static output.
    const postSourceDir = path.dirname(absPath);
    const sourceImgDir = path.join(postSourceDir, "img");
    const destImgDir = path.join(DIST_DIR, "posts", ...slugParts.slice(0, -1), "img");
    try {
      const imgStats = await fs.stat(sourceImgDir);
      if (imgStats.isDirectory()) {
        await copyDirectoryRecursive(sourceImgDir, destImgDir);
      }
    } catch {
      // No image directory for this post
    }

    posts.push({
      title,
      excerpt,
      readMinutes,
      routePath,
      source: rel,
      key,
      authors,
      tags,
    });
  }

  const sequenceIndex = new Map(indexEntries.map((entry, idx) => [entry.key, idx]));
  posts.sort((a, b) => {
    const ai = sequenceIndex.has(a.key) ? sequenceIndex.get(a.key) : Number.MAX_SAFE_INTEGER;
    const bi = sequenceIndex.has(b.key) ? sequenceIndex.get(b.key) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.source.localeCompare(b.source);
  });

  const storiesHtml = posts
    .map((post) => {
      const sourceLabel = escapeHtml(post.source.replace(/\.md$/i, ""));
      const authorText = post.authors.length > 0 ? ` · ${escapeHtml(post.authors.join(", "))}` : "";
      return `<a class="story" href="${post.routePath}">
        <div class="story-meta">${post.readMinutes} min read · ${sourceLabel}${authorText}</div>
        <h2>${escapeHtml(post.title)}</h2>
        <p>${escapeHtml(post.excerpt)}</p>
        ${renderTags(post.tags)}
      </a>`;
    })
    .join("\n");

  const indexContent = `
    <section>
      <h1 class="tag-title">Tech Blog</h1>
      <p class="tag-sub">Spark Arena engineering notes, benchmarking deep dives, and practical runbooks.</p>
    </section>
    <section class="story-list">
      ${storiesHtml || "<p>No stories published yet.</p>"}
    </section>
  `;

  const indexHtml = pageTemplate({
    title: "Tech Blog",
    description: "Spark Arena technical blog posts.",
    content: indexContent,
  });

  await fs.writeFile(path.join(DIST_DIR, "index.html"), indexHtml, "utf8");

  console.log(`Built ${posts.length} post(s) into ${DIST_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
