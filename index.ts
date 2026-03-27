import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import formatFromString from "@quilicicf/markdown-formatter/lib/formatFromString.js";
import TurndownService from "turndown";

const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const MARKDOWN_MARKER = "Markdown Content:";
const TOC_START = "<!-- TOC START min:2 max:4 -->";
const TOC_END = "<!-- TOC END -->";
const DEFAULT_OUTPUT_MODE = "toc-only";
const CACHE_DIR_NAME = ".md";

const WebfetchParams = Type.Object({
  url: Type.String({
    description: "Target URL. If the scheme is missing, https:// is assumed.",
  }),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Per-attempt timeout in milliseconds.",
      minimum: MIN_TIMEOUT_MS,
      maximum: MAX_TIMEOUT_MS,
    }),
  ),
  outputMode: Type.Optional(
    StringEnum(["all", "path-only", "toc-only"] as const, {
      description:
        "How much content to return to the agent. `all` returns the cache path plus full markdown, `path-only` returns only the cache path, `toc-only` returns the cache path plus the generated TOC and falls back to `path-only` when the TOC is empty.",
      default: DEFAULT_OUTPUT_MODE,
    }),
  ),
});

type SourceName = "jina-reader" | "defuddle" | "markdown-new" | "raw-html-turndown";
type OutputMode = "all" | "path-only" | "toc-only";

type WebfetchParamsShape = {
  outputMode?: OutputMode;
  url: string;
  timeoutMs?: number;
};

type AttemptDetails = {
  source: SourceName;
  requestUrl: string;
  ok: boolean;
  status?: number;
  contentType?: string | null;
  error?: string;
};

type ToolDetails = {
  attempts: AttemptDetails[];
  cache: CacheDetails;
  normalization: NormalizationDetails;
  output: OutputDetails;
  normalizedUrl: string;
  source: SourceName;
  timeoutMs: number;
};

type CacheDetails = {
  absolutePath: string;
  domain: string;
  fileName: string;
  hash: string;
  relativePath: string;
  timestamp: string;
  title: string;
};

type NormalizationDetails = {
  ok: boolean;
  changed: boolean;
  formatterMessages: string[];
  tocInjected: boolean;
  error?: string;
};

type OutputDetails = {
  effectiveMode: OutputMode;
  requestedMode: OutputMode;
  tocAvailable: boolean;
};

const requestHeaders = {
  Accept: "text/markdown,text/plain,text/html;q=0.9,*/*;q=0.1",
  "User-Agent": "pi-webfetch-extension/0.1",
};

const turndown = new TurndownService({
  codeBlockStyle: "fenced",
  headingStyle: "atx",
});

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("URL is required.");
  }

  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(candidate).toString();
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

function looksLikeHtml(text: string): boolean {
  return /^\s*(<!doctype html|<html\b|<head\b|<body\b)/i.test(text);
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) {
    if (!text.startsWith("+++\n")) {
      return text;
    }

    const endToml = text.indexOf("\n+++\n", 4);
    if (endToml === -1) {
      return text;
    }

    return text.slice(endToml + 5).trim();
  }

  const end = text.indexOf("\n---\n", 4);
  if (end === -1) {
    return text;
  }

  return text.slice(end + 5).trim();
}

function isBlankMarkdown(text: string): boolean {
  return stripFrontmatter(text).trim().length === 0;
}

function extractMarkdownPayload(text: string): string {
  const normalized = normalizeText(text);
  const markerIndex = normalized.indexOf(MARKDOWN_MARKER);
  if (markerIndex === -1) {
    return normalized;
  }

  return normalized.slice(markerIndex + MARKDOWN_MARKER.length).trim();
}

function ensureServiceMarkdown(text: string, source: SourceName): string {
  const markdown = extractMarkdownPayload(text);
  if (!markdown || isBlankMarkdown(markdown)) {
    throw new Error(`${source} returned blank markdown.`);
  }
  if (looksLikeHtml(markdown)) {
    throw new Error(`${source} returned HTML instead of markdown.`);
  }
  return markdown;
}

function convertRawContentToMarkdown(body: string, contentType: string | null): string {
  const normalized = normalizeText(body);
  if (!normalized) {
    throw new Error("raw-html-turndown returned blank content.");
  }

  const lowerType = contentType?.toLowerCase() ?? "";
  if (looksLikeHtml(normalized) || lowerType.includes("html")) {
    const markdown = turndown.turndown(normalized).trim();
    if (!markdown || isBlankMarkdown(markdown)) {
      throw new Error("turndown produced blank markdown.");
    }
    return markdown;
  }

  if (lowerType.includes("markdown") || lowerType.includes("text/plain")) {
    return normalized;
  }

  throw new Error(`unsupported raw content type: ${contentType ?? "unknown"}`);
}

function getFetchSignal(parentSignal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)]);
}

async function fetchAttempt(
  source: SourceName,
  requestUrl: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ markdown: string; attempt: AttemptDetails }> {
  const response = await fetch(requestUrl, {
    headers: requestHeaders,
    redirect: "follow",
    signal: getFetchSignal(signal, timeoutMs),
  });
  const contentType = response.headers.get("content-type");

  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status}`), {
      status: response.status,
      contentType,
    });
  }

  const body = await response.text();
  const markdown =
    source === "raw-html-turndown"
      ? convertRawContentToMarkdown(body, contentType)
      : ensureServiceMarkdown(body, source);

  return {
    markdown,
    attempt: {
      source,
      requestUrl,
      ok: true,
      status: response.status,
      contentType,
    },
  };
}

function formatError(error: unknown): { message: string; status?: number; contentType?: string | null } {
  if (error instanceof Error) {
    const typed = error as Error & { status?: number; contentType?: string | null };
    return {
      message: typed.message,
      status: typed.status,
      contentType: typed.contentType,
    };
  }

  return { message: String(error) };
}

function stripTocBlock(markdown: string): string {
  return markdown.replace(/<!-- TOC START[\s\S]*?<!-- TOC END.*?-->/, "").trim();
}

function extractTocBlock(markdown: string): string {
  const match = markdown.match(/<!-- TOC START[\s\S]*?<!-- TOC END.*?-->/);
  if (!match) {
    return "";
  }

  return normalizeText(match[0]);
}

function tocHasEntries(tocBlock: string): boolean {
  return /\[[^\]]+\]\(#.+\)/.test(tocBlock);
}

function hasTocEligibleHeadings(markdown: string): boolean {
  const withoutFrontmatter = stripFrontmatter(markdown);
  const withoutToc = stripTocBlock(withoutFrontmatter);
  return /^#{2,4}\s+.+$/m.test(withoutToc);
}

function normalizeForFileName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[`*_~#[\]()>!]/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^['"]+|['"]+$/g, "").trim();
}

function extractFrontmatterTitle(markdown: string): string {
  const { frontmatter } = splitLeadingFrontmatter(markdown);
  if (!frontmatter) {
    return "";
  }

  const yamlMatch = frontmatter.match(/^title\s*:\s*(.+)$/im);
  if (yamlMatch?.[1]) {
    return stripWrappingQuotes(yamlMatch[1]);
  }

  const tomlMatch = frontmatter.match(/^title\s*=\s*(.+)$/im);
  if (tomlMatch?.[1]) {
    return stripWrappingQuotes(tomlMatch[1]);
  }

  return "";
}

function extractHeadingTitle(markdown: string, pattern = /^#\s+(.+)$/m): string {
  const withoutFrontmatter = stripFrontmatter(markdown);
  const withoutToc = stripTocBlock(withoutFrontmatter);
  const headingMatch = withoutToc.match(pattern);
  if (!headingMatch?.[1]) {
    return "";
  }

  return headingMatch[1]
    .replace(/`/g, "")
    .replace(/!?\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/[*_~]/g, "")
    .trim();
}

function fallbackTitleFromUrl(normalizedUrl: string): string {
  const url = new URL(normalizedUrl);
  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const lastSegment = segments.at(-1);
  if (lastSegment) {
    return decodeURIComponent(lastSegment);
  }

  return url.hostname;
}

function deriveCacheTitle(markdown: string, normalizedUrl: string): string {
  return (
    extractFrontmatterTitle(markdown) ||
    extractHeadingTitle(markdown, /^#\s+(.+)$/m) ||
    fallbackTitleFromUrl(normalizedUrl) ||
    extractHeadingTitle(markdown, /^#{1,6}\s+(.+)$/m)
  );
}

function buildCacheFileName(markdown: string, normalizedUrl: string): CacheDetails {
  const url = new URL(normalizedUrl);
  const title = deriveCacheTitle(markdown, normalizedUrl);
  const safeTitle = normalizeForFileName(title) || "document";
  const domain = normalizeForFileName(url.hostname.replace(/^www\./, "")) || "site";
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const hash = createHash("sha256").update(`${normalizedUrl}\n${markdown}`).digest("hex").slice(0, 10);
  const fileName = `${safeTitle}-${domain}-${timestamp}-${hash}.md`;

  return {
    absolutePath: "",
    domain,
    fileName,
    hash,
    relativePath: join(CACHE_DIR_NAME, fileName),
    timestamp,
    title,
  };
}

async function writeCacheFile(markdown: string, normalizedUrl: string, cwd: string): Promise<CacheDetails> {
  const cache = buildCacheFileName(markdown, normalizedUrl);
  const cacheDir = resolve(cwd, CACHE_DIR_NAME);
  const absolutePath = resolve(cacheDir, cache.fileName);

  await mkdir(cacheDir, { recursive: true });
  await writeFile(absolutePath, `${normalizeText(markdown)}\n`, "utf8");

  return {
    ...cache,
    absolutePath,
  };
}

function renderOutput(markdown: string, cache: CacheDetails, requestedMode: OutputMode): { text: string; details: OutputDetails } {
  const tocBlock = extractTocBlock(markdown);
  const tocAvailable = tocHasEntries(tocBlock);
  const effectiveMode = requestedMode === "toc-only" && !tocAvailable ? "path-only" : requestedMode;

  if (effectiveMode === "path-only") {
    return {
      text: cache.relativePath,
      details: {
        effectiveMode,
        requestedMode,
        tocAvailable,
      },
    };
  }

  if (effectiveMode === "toc-only") {
    return {
      text: `Path: ${cache.relativePath}\n\n${tocBlock}`,
      details: {
        effectiveMode,
        requestedMode,
        tocAvailable,
      },
    };
  }

  return {
    text: `Path: ${cache.relativePath}\n\n${markdown}`,
    details: {
      effectiveMode,
      requestedMode,
      tocAvailable,
    },
  };
}

function splitLeadingFrontmatter(text: string): { frontmatter: string; body: string } {
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    if (end !== -1) {
      return {
        frontmatter: text.slice(0, end + 5).trimEnd(),
        body: text.slice(end + 5).trimStart(),
      };
    }
  }

  if (text.startsWith("+++\n")) {
    const end = text.indexOf("\n+++\n", 4);
    if (end !== -1) {
      return {
        frontmatter: text.slice(0, end + 5).trimEnd(),
        body: text.slice(end + 5).trimStart(),
      };
    }
  }

  return { frontmatter: "", body: text };
}

function injectTocBlock(markdown: string): { markdown: string; tocInjected: boolean } {
  if (markdown.includes("<!-- TOC START") || markdown.includes("<!-- TOC END")) {
    return { markdown, tocInjected: false };
  }

  if (!hasTocEligibleHeadings(markdown)) {
    return { markdown, tocInjected: false };
  }

  const { frontmatter, body } = splitLeadingFrontmatter(markdown);
  const tocBlock = `${TOC_START}\n\n${TOC_END}`;

  if (frontmatter) {
    return {
      markdown: `${frontmatter}\n\n${tocBlock}${body ? `\n\n${body}` : ""}`,
      tocInjected: true,
    };
  }

  return {
    markdown: `${tocBlock}${body ? `\n\n${body}` : ""}`,
    tocInjected: true,
  };
}

async function normalizeMarkdown(markdown: string): Promise<{ markdown: string; details: NormalizationDetails }> {
  const input = normalizeText(markdown);
  const prepared = injectTocBlock(input);

  try {
    const result = await formatFromString(
      prepared.markdown,
      {
        watermark: "none",
        escapeGithubAdmonitions: false,
      },
      {},
    );

    const normalized = normalizeText(typeof result.value === "string" ? result.value : String(result.value ?? ""));
    if (!normalized || isBlankMarkdown(normalized)) {
      throw new Error("markdown formatter returned blank markdown.");
    }

    return {
      markdown: normalized,
      details: {
        ok: true,
        changed: normalized !== input,
        formatterMessages: result.messages.map((message) => String(message.reason ?? message.message ?? message)),
        tocInjected: prepared.tocInjected,
      },
    };
  } catch (error) {
    return {
      markdown: input,
      details: {
        ok: false,
        changed: false,
        formatterMessages: [],
        tocInjected: false,
        error: formatError(error).message,
      },
    };
  }
}

export default function webfetch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "webfetch",
    label: "Webfetch",
    description:
      "Fetch a URL as markdown, cache it under .md/, and return either the cache path, the TOC plus path, or the full markdown plus path. Responsibility chain: Jina Reader, defuddle.md, markdown.new, then raw HTML converted with turndown. Continue to the next step when a request fails or returns blank content.",
    parameters: WebfetchParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params as WebfetchParamsShape;
      const normalizedUrl = normalizeUrl(input.url);
      const requestedMode = input.outputMode ?? DEFAULT_OUTPUT_MODE;
      const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
      const attempts: AttemptDetails[] = [];
      const cwd = ctx?.cwd ?? process.cwd();
      const sources: Array<{ source: SourceName; requestUrl: string }> = [
        { source: "jina-reader", requestUrl: `https://r.jina.ai/${normalizedUrl}` },
        { source: "defuddle", requestUrl: `https://defuddle.md/${normalizedUrl}` },
        { source: "markdown-new", requestUrl: `https://markdown.new/${normalizedUrl}` },
        { source: "raw-html-turndown", requestUrl: normalizedUrl },
      ];

      for (const source of sources) {
        try {
          const result = await fetchAttempt(source.source, source.requestUrl, timeoutMs, signal);
          const normalized = await normalizeMarkdown(result.markdown);
          const cache = await writeCacheFile(normalized.markdown, normalizedUrl, cwd);
          const output = renderOutput(normalized.markdown, cache, requestedMode);
          attempts.push(result.attempt);
          return {
            content: [{ type: "text", text: output.text }],
            details: {
              attempts,
              cache,
              normalization: normalized.details,
              output: output.details,
              normalizedUrl,
              source: source.source,
              timeoutMs,
            } as ToolDetails,
          };
        } catch (error) {
          const formatted = formatError(error);
          attempts.push({
            source: source.source,
            requestUrl: source.requestUrl,
            ok: false,
            status: formatted.status,
            contentType: formatted.contentType,
            error: formatted.message,
          });
        }
      }

      throw new Error(
        `webfetch failed for ${normalizedUrl}. Attempts: ${attempts
          .map((attempt) => `${attempt.source}: ${attempt.error ?? "unknown error"}`)
          .join(" | ")}`,
      );
    },
  });
}
