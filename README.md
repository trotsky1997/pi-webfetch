# pi-webfetch

A pi package that adds one tool: `webfetch`.

`webfetch` fetches a URL as markdown with this responsibility chain:

1. `https://r.jina.ai/{url}`
2. `https://defuddle.md/{url}`
3. `https://markdown.new/{url}`
4. `https://pure.md/{url}`
5. Raw HTML converted to markdown with `turndown`

If one step fails, times out, returns a non-2xx response, or returns blank content, `webfetch` continues to the next step.

The `pure.md` step adds another hosted markdown extractor before the raw HTML fallback, which helps on pages that need stronger browser impersonation or JavaScript-aware rendering.

After a successful fetch, the tool:

- injects a TOC block near the top of the document
- normalizes the markdown with `@quilicicf/markdown-formatter`
- writes a cache file under `.md/`

Cache files use this naming pattern:

- `.md/[escaped-title]-[domain-name]-[timestamp]-[hash].md`

## Install

Once published to GitHub, install with:

```bash
pi install git:github.com/trotsky1997/pi-webfetch
```

Or:

```bash
pi install https://github.com/trotsky1997/pi-webfetch
```

## Tool

Parameters:

- `url`: target URL
- `timeoutMs` (optional): per-attempt timeout in milliseconds, default `20000`
- `outputMode` (optional): `all`, `path-only`, or `toc-only`; default is `toc-only`

Output modes:

- `toc-only`: returns `Path: ...` plus the generated TOC
- `path-only`: returns only the cache path
- `all`: returns `Path: ...` plus the full cached markdown

If `toc-only` is requested but no TOC entries are available, the tool falls back to `path-only`.

## Notes

- The cache file is always written, regardless of `outputMode`.
- The TOC is inserted after leading YAML/TOML frontmatter when frontmatter exists.
- If markdown normalization fails, `webfetch` falls back to the unformatted markdown instead of failing the whole tool call.
