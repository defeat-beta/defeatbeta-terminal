/**
 * News screen — Earnings call transcripts + financial news.
 * Two sub-modes (Transcripts / News) share a master/detail layout:
 *   left = list of items, right = detail content.
 *
 * Reading mode toggles the meaning of ↑/↓:
 *   - list mode: ↑/↓ selects an item (and auto-loads detail at top)
 *   - reading mode: ↑/↓ scrolls the detail one visual line at a time
 * Enter enters reading mode, Esc returns to list mode.
 */

import { createSignal, createEffect, createMemo, onMount, onCleanup, For, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";
import {
  getTranscriptsList,
  getTranscript,
  getNewsListMeta,
  getNews,
  getInfo,
} from "../bridge/api";

// ─── Color palette ────────────────────────────────────────────────────────────

const C_AMBER     = "#FFA028";
const C_CYAN      = "cyan";
const C_GRAY      = "gray";
const C_PANEL_BG  = "#1a1a1a";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  ticker:     string;
  searchMode: boolean;
}

interface TranscriptParagraph {
  paragraph_number: number;
  speaker:          string;
  content:          string;
}

interface TranscriptItem {
  symbol:          string;
  fiscal_year:     number;
  fiscal_quarter:  number;
  report_date:     string;
}

interface NewsItem {
  uuid:            string;
  related_symbols: string;
  title:           string;
  publisher:       string;
  report_date:     string;
  type:            string;
  link:            string;
  summary?:        string;
}

interface NewsParagraph {
  paragraph_number: number;
  highlight:        string;
  paragraph:        string;
}

type SubMode = "transcripts" | "news";

interface KeyboardEventLike {
  sequence?: string;
  name?:     string;
  ctrl?:     boolean;
  meta?:     boolean;
}

// ─── Detail visual line types (after word-wrap & coloring) ───────────────────

type DetailLine =
  | { kind: "title";       text: string }
  | { kind: "panel-title"; text: string }
  | { kind: "panel-date";  text: string }
  | { kind: "meta";        text: string }
  | { kind: "link";        text: string; url: string }
  | { kind: "speaker";     text: string; isOperator: boolean }
  | { kind: "highlight";   text: string }
  | { kind: "content";     text: string }
  | { kind: "blank" };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function wordWrap(text: string, width: number): string[] {
  if (!text) return [];
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (!rawLine) { out.push(""); continue; }
    const words = rawLine.split(" ");
    let cur = "";
    for (const w of words) {
      const candidate = cur ? cur + " " + w : w;
      if (candidate.length <= width) {
        cur = candidate;
      } else {
        if (cur) { out.push(cur); cur = ""; }
        // Hard-break a word longer than the width
        if (w.length > width) {
          let rem = w;
          while (rem.length > width) { out.push(rem.slice(0, width)); rem = rem.slice(width); }
          cur = rem;
        } else {
          cur = w;
        }
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  if (max <= 0) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTHS_LONG  = ["January","February","March","April","May","June",
                      "July","August","September","October","November","December"];

/** "2025-11-04" → "Nov 04" */
function formatShortDate(iso: string): string {
  if (!iso) return "";
  const d = iso.slice(0, 10);
  const parts = d.split("-");
  if (parts.length < 3) return d;
  const m = parseInt(parts[1], 10);
  if (!isFinite(m) || m < 1 || m > 12) return d;
  return `${MONTHS_SHORT[m - 1]} ${parts[2]}`;
}

/** "2025-11-04" → "November 4, 2025" */
function formatLongDate(iso: string): string {
  if (!iso) return "";
  const d = iso.slice(0, 10);
  const parts = d.split("-");
  if (parts.length < 3) return d;
  const y = parts[0];
  const m = parseInt(parts[1], 10);
  if (!isFinite(m) || m < 1 || m > 12) return d;
  const dd = parseInt(parts[2], 10);
  return `${MONTHS_LONG[m - 1]} ${dd}, ${y}`;
}

/** Build a sliding window of page numbers (1-based) centered on `current`. */
function paginatorWindow(current: number, total: number, windowSize = 10): {
  pages: number[]; showPrev: boolean; showNext: boolean;
} {
  if (total <= 0) return { pages: [], showPrev: false, showNext: false };
  let start = Math.max(1, current - Math.floor(windowSize / 2) + 1);
  if (start + windowSize - 1 > total) start = Math.max(1, total - windowSize + 1);
  const end = Math.min(total, start + windowSize - 1);
  const pages: number[] = [];
  for (let i = start; i <= end; i++) pages.push(i);
  return { pages, showPrev: start > 1, showNext: end < total };
}

function buildTranscriptLines(
  item: TranscriptItem | undefined,
  paragraphs: TranscriptParagraph[] | null,
  width: number,
): DetailLine[] {
  if (!item) return [];
  const lines: DetailLine[] = [];
  // Panel header card: title + date on a darker background (mimics web card)
  lines.push({ kind: "panel-title", text: `Fiscal Year (FY) ${item.fiscal_year}, Quarter ${item.fiscal_quarter}` });
  lines.push({ kind: "panel-date",  text: formatLongDate(item.report_date ?? "") });
  lines.push({ kind: "blank" });
  if (paragraphs == null) return lines; // body still loading; header only
  for (const p of paragraphs) {
    const speaker = (p.speaker ?? "").trim();
    if (speaker) {
      lines.push({
        kind: "speaker",
        text: speaker,
        isOperator: speaker.toLowerCase() === "operator",
      });
    }
    const wrapped = wordWrap(p.content ?? "", Math.max(10, width - 2));
    for (const w of wrapped) lines.push({ kind: "content", text: "  " + w });
    lines.push({ kind: "blank" });
  }
  return lines;
}

function buildNewsLines(meta: NewsItem | undefined, paragraphs: NewsParagraph[] | null, width: number): DetailLine[] {
  if (!meta) return [];
  const lines: DetailLine[] = [];
  for (const w of wordWrap(meta.title ?? "", width)) lines.push({ kind: "title", text: w });
  const metaLine = [meta.publisher, meta.report_date].filter(Boolean).join("  ·  ");
  if (metaLine) lines.push({ kind: "meta", text: metaLine });
  if (meta.link) {
    const url = meta.link;
    for (const w of wordWrap(url, width)) {
      lines.push({ kind: "link", text: w, url });
    }
  }
  lines.push({ kind: "blank" });
  if (paragraphs && paragraphs.length > 0) {
    for (const p of paragraphs) {
      if (p.highlight) {
        for (const w of wordWrap(p.highlight, width)) lines.push({ kind: "highlight", text: w });
      }
      if (p.paragraph) {
        // Yahoo's `paragraph` field often packs multiple logical paragraphs
        // separated by single \n's. Split on those, wrap each sub-paragraph,
        // and insert a blank line between them for readability.
        const subParas = p.paragraph
          .split("\n")
          .map((s: string) => s.trim())
          .filter(Boolean);
        subParas.forEach((sub: string, idx: number) => {
          if (idx > 0) lines.push({ kind: "blank" });
          for (const w of wordWrap(sub, width)) lines.push({ kind: "content", text: w });
        });
      }
      lines.push({ kind: "blank" });
    }
  } else if (paragraphs) {
    // Empty array — body was fetched but the source has no paragraphs (data gap).
    lines.push({ kind: "meta", text: "(No article body — open the link above to read)" });
  }
  return lines;
}

function shortenType(t: string): string {
  if (!t) return "STORY";
  if (t === "PRESS_RELEASE") return "PRESS";
  return t;
}

/** Render a single detail line (transcript paragraph or news article line). */
function renderDetailLine(line: DetailLine, dw: number) {
  if (line.kind === "blank") {
    return <box height={1}><text>{""}</text></box>;
  }
  if (line.kind === "title") {
    return (
      <box flexDirection="row" height={1}>
        <text style={{ fg: C_AMBER }}>{line.text}</text>
      </box>
    );
  }
  if (line.kind === "panel-title") {
    const padded = ` ${line.text} `.padEnd(dw).slice(0, dw);
    return (
      <box flexDirection="row" height={1}>
        <text style={{ fg: C_AMBER, bg: C_PANEL_BG }}>{padded}</text>
      </box>
    );
  }
  if (line.kind === "panel-date") {
    const padded = ` ${line.text} `.padEnd(dw).slice(0, dw);
    return (
      <box flexDirection="row" height={1}>
        <text style={{ fg: C_GRAY, bg: C_PANEL_BG }}>{padded}</text>
      </box>
    );
  }
  if (line.kind === "meta") {
    return (
      <box flexDirection="row" height={1}>
        <text style={{ fg: C_GRAY }}>{line.text}</text>
      </box>
    );
  }
  if (line.kind === "link") {
    // <a href> emits an OSC 8 hyperlink escape. The underline attribute
    // is set on the outer <text> so SolidJS reuses the prop reliably across
    // re-renders (setting it on <a> directly was lost after the first article).
    // mergeStyles propagates the attribute down to the inner <a>'s span.
    return (
      <box flexDirection="row" height={1}>
        <text style={{ fg: C_CYAN, attributes: TextAttributes.UNDERLINE }}>
          <a href={line.url}>{line.text}</a>
        </text>
      </box>
    );
  }
  if (line.kind === "speaker") {
    const icon = line.isOperator ? "📞" : "💬";
    return (
      <box flexDirection="row" height={1}>
        <text style={{ fg: C_CYAN }}>{`${icon}  ${line.text}`}</text>
      </box>
    );
  }
  if (line.kind === "highlight") {
    return (
      <box flexDirection="row" height={1}>
        <text style={{ fg: C_CYAN }}>{line.text}</text>
      </box>
    );
  }
  return (
    <box flexDirection="row" height={1}>
      <text style={{ fg: "white" }}>{line.text}</text>
    </box>
  );
}

/** Render a single news card (3 content rows + 1 divider).
 *  Selected card: amber bg covers the 3 content rows; divider stays neutral. */
function renderNewsCard(item: NewsItem, summary: string, isSel: boolean, w: number) {
  const tag    = `[${shortenType(item.type ?? "")}]`;
  const tagW   = tag.length + 2;             // tag + 2-space gap before title
  const indent = " ".repeat(tagW);
  // Right-aligned date in ISO form (fixed 10-char width keeps the column tidy).
  const date   = (item.report_date ?? "").slice(0, 10);
  // Row 1: [TYPE]  Title …                     2026-05-02
  const titleW = Math.max(10, w - tagW - date.length - 2);
  const title  = truncate(item.title ?? "", titleW);
  const left1  = `${tag}  ${title}`;
  const pad1   = Math.max(1, w - left1.length - date.length);
  const line1  = (left1 + " ".repeat(pad1) + date).padEnd(w).slice(0, w);
  // Row 2: indent + summary
  const sumW   = Math.max(10, w - tagW);
  const line2  = (indent + truncate(summary, sumW)).padEnd(w).slice(0, w);
  // Row 3: indent + publisher
  const line3  = (indent + (item.publisher ?? "")).padEnd(w).slice(0, w);
  // Row 4: divider (always neutral)
  const line4  = "─".repeat(w);

  const bg     = isSel ? C_AMBER : undefined;
  const titleFg   = isSel ? "black" : "white";
  const summaryFg = isSel ? "black" : C_GRAY;
  const pubFg     = isSel ? "black" : C_CYAN;

  return (
    <box flexDirection="column">
      <box flexDirection="row" height={1}>
        <text style={{ fg: titleFg, bg }}>{line1}</text>
      </box>
      <box flexDirection="row" height={1}>
        <text style={{ fg: summaryFg, bg }}>{line2}</text>
      </box>
      <box flexDirection="row" height={1}>
        <text style={{ fg: pubFg, bg }}>{line3}</text>
      </box>
      <box flexDirection="row" height={1}>
        <text style={{ fg: C_GRAY }}>{line4}</text>
      </box>
    </box>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function News(props: Props) {
  const dims = useTerminalDimensions();

  const [subMode,         setSubMode]         = createSignal<SubMode>("transcripts");
  const [readingMode,     setReadingMode]     = createSignal(false);
  const [readingScroll,   setReadingScroll]   = createSignal(0);

  // Transcripts (list = metadata only since defeatbeta-api 0.0.53; bodies are
  // lazy-loaded per (year, quarter) when selection changes).
  const [transcripts,         setTranscripts]         = createSignal<TranscriptItem[]>([]);
  const [transcriptsLoading,  setTranscriptsLoading]  = createSignal(true);
  const [transcriptsError,    setTranscriptsError]    = createSignal("");
  const [tIdx,                setTIdx]                = createSignal(0);

  // Transcript body (lazy-loaded for the currently selected quarter).
  const [transcriptBody,         setTranscriptBody]         = createSignal<TranscriptParagraph[] | null>(null);
  const [transcriptBodyLoading,  setTranscriptBodyLoading]  = createSignal(false);
  const [transcriptBodyError,    setTranscriptBodyError]    = createSignal("");

  // News list (metadata only)
  const [newsList,            setNewsList]            = createSignal<NewsItem[]>([]);
  const [newsListLoading,     setNewsListLoading]     = createSignal(true);
  const [newsListError,       setNewsListError]       = createSignal("");
  // News uses page-based navigation: pageIdx (0-based) + pageSel (0-based within page).
  // Global news idx is derived: nIdx = pageIdx * pageSize + pageSel.
  const [newsPageIdx,         setNewsPageIdx]         = createSignal(0);
  const [newsPageSel,         setNewsPageSel]         = createSignal(0);

  // News body (lazy-loaded for selected article)
  const [newsBody,            setNewsBody]            = createSignal<NewsParagraph[] | null>(null);
  const [newsBodyLoading,     setNewsBodyLoading]     = createSignal(false);
  const [newsBodyError,       setNewsBodyError]       = createSignal("");

  // News summaries — fetched lazily per visible page (uuid → first paragraph
  // truncated to ~200 chars). Empty string ("") flags either "in-flight" or
  // "fetched but no body", preventing duplicate fetches for the same uuid.
  const [newsSummaries, setNewsSummaries] = createSignal<Map<string, string>>(new Map());

  const [sector,   setSector]   = createSignal("");
  const [industry, setIndustry] = createSignal("");

  // List scroll offset (sticky — only moves when selection escapes the viewport)
  const [listOffset, setListOffset] = createSignal(0);

  // Live clock
  const [dateTime, setDateTime] = createSignal({ date: "", time: "" });
  onMount(() => {
    const tick = () => {
      const now = new Date();
      setDateTime({
        date: now.toISOString().slice(0, 10),
        time: now.toTimeString().slice(0, 8),
      });
    };
    tick();
    const id = setInterval(tick, 1000);
    onCleanup(() => clearInterval(id));
  });

  // ─── Layout ──────────────────────────────────────────────────────────────
  // Fixed rows: border(2)+tab-bar(1)+div×2(2)+status(1)+padding(1)+header(1)
  //            +divider(1)+footer-hint(1) = 10. Content area = remaining.
  const innerW = createMemo(() => Math.max(40, dims().width - 4));
  const contentH = createMemo(() => Math.max(3, dims().height - 10));
  const listW = createMemo(() => {
    const w = innerW();
    // Transcripts: short rows ("▶ Q3  Nov 04") + section headers ("FY 2025")
    return Math.min(18, Math.max(14, Math.floor(w * 0.16)));
  });
  // Detail pane width:
  //   Transcripts → right-side panel beside the FY list (innerW - listW - 3)
  //   News reading → full-width article view (innerW)
  const detailW = createMemo(() => {
    if (subMode() === "transcripts") return Math.max(20, innerW() - listW() - 3);
    return innerW();
  });

  // News pagination — each card is 4 visual rows (3 content + 1 divider).
  // Reserve 1 row at the bottom of the news area for the paginator.
  const NEWS_CARD_ROWS = 4;
  const newsPageSize = createMemo(() =>
    Math.max(2, Math.floor((contentH() - 1) / NEWS_CARD_ROWS))
  );
  const newsPageCount = createMemo(() =>
    Math.max(1, Math.ceil(newsList().length / newsPageSize()))
  );
  /** Global newsList index of the currently selected card (derived). */
  const nIdx = createMemo(() => newsPageIdx() * newsPageSize() + newsPageSel());

  // ─── Fetch transcripts + news list when ticker changes ────────────────────
  let fetchGen = 0;
  createEffect(() => {
    const t = props.ticker;
    if (!t) return;
    const gen = ++fetchGen;
    setTranscripts([]);   setTranscriptsLoading(true); setTranscriptsError("");
    setTranscriptBody(null); setTranscriptBodyError(""); setTranscriptBodyLoading(false);
    setNewsList([]);      setNewsListLoading(true);    setNewsListError("");
    setNewsBody(null);    setNewsBodyError("");        setNewsBodyLoading(false);
    setNewsSummaries(new Map());
    setReadingMode(false); setReadingScroll(0);
    setTIdx(0); setNewsPageIdx(0); setNewsPageSel(0); setListOffset(0);

    getTranscriptsList(t)
      .then((rows: unknown) => {
        if (gen !== fetchGen) return;
        const arr = Array.isArray(rows) ? (rows as TranscriptItem[]) : [];
        // Sort newest first (list is metadata-only since defeatbeta-api 0.0.53)
        const parsed = [...arr];
        parsed.sort((a, b) => {
          if (a.fiscal_year !== b.fiscal_year) return b.fiscal_year - a.fiscal_year;
          return b.fiscal_quarter - a.fiscal_quarter;
        });
        setTranscripts(parsed);
        setTranscriptsLoading(false);
      })
      .catch((e: unknown) => {
        if (gen !== fetchGen) return;
        setTranscriptsError(String(e));
        setTranscriptsLoading(false);
      });

    getNewsListMeta(t)
      .then((rows: unknown) => {
        if (gen !== fetchGen) return;
        const arr = Array.isArray(rows) ? (rows as NewsItem[]) : [];
        setNewsList(arr);
        setNewsListLoading(false);
      })
      .catch((e: unknown) => {
        if (gen !== fetchGen) return;
        setNewsListError(String(e));
        setNewsListLoading(false);
      });

    getInfo(t)
      .then((rows: unknown) => {
        if (gen !== fetchGen) return;
        const info = Array.isArray(rows) ? rows as { sector?: string; industry?: string }[] : [];
        if (info.length) {
          setSector(info[0].sector ?? "");
          setIndustry(info[0].industry ?? "");
        }
      })
      .catch(() => {});
  });

  // ─── Lazy-load paragraphs for selected transcript ──────────────────────────
  // Fires whenever the selection changes in the Transcripts sub-mode, since the
  // right pane shows the full transcript inline (not a card list like News).
  let transcriptBodyGen = 0;
  createEffect(() => {
    if (subMode() !== "transcripts") return;
    const list = transcripts();
    const i = tIdx();
    const item = list[i];
    if (!item) return;
    const gen = ++transcriptBodyGen;
    setTranscriptBody(null);
    setTranscriptBodyError("");
    setTranscriptBodyLoading(true);
    getTranscript(props.ticker, item.fiscal_year, item.fiscal_quarter)
      .then((rows: unknown) => {
        if (gen !== transcriptBodyGen) return;
        const arr = Array.isArray(rows) ? (rows as TranscriptParagraph[]) : [];
        setTranscriptBody(arr);
        setTranscriptBodyLoading(false);
      })
      .catch((e: unknown) => {
        if (gen !== transcriptBodyGen) return;
        setTranscriptBodyError(String(e));
        setTranscriptBodyLoading(false);
      });
  });

  // ─── Lazy-load body for selected news article ──────────────────────────────
  // Only fires when the user enters reading mode — list browsing relies on
  // the inline `summary` field and never needs to hit get_news(uuid).
  let bodyGen = 0;
  createEffect(() => {
    if (subMode() !== "news" || !readingMode()) return;
    const list = newsList();
    const i = nIdx();
    const item = list[i];
    if (!item) return;
    const gen = ++bodyGen;
    setNewsBody(null);
    setNewsBodyError("");
    setNewsBodyLoading(true);
    getNews(props.ticker, item.uuid)
      .then((rows: unknown) => {
        if (gen !== bodyGen) return;
        const arr = Array.isArray(rows) ? rows : [];
        let body: NewsParagraph[] = [];
        if (arr.length > 0) {
          const first = arr[0] as Record<string, unknown>;
          if ("paragraph_number" in first) {
            // get_news returned the paragraph rows directly
            body = arr as NewsParagraph[];
          } else if ("news" in first) {
            const raw = first.news;
            body = typeof raw === "string"
              ? (JSON.parse(raw) as NewsParagraph[])
              : ((raw as NewsParagraph[]) ?? []);
          }
        }
        setNewsBody(body);
        setNewsBodyLoading(false);
      })
      .catch((e: unknown) => {
        if (gen !== bodyGen) return;
        setNewsBodyError(String(e));
        setNewsBodyLoading(false);
      });
  });

  // ─── Lazy-load summaries for the current News page ────────────────────────
  // Issued in parallel for every uuid on the page that has not been requested
  // yet. The fetchGen guard ensures stale ticker fetches do not pollute the
  // summaries map after a ticker switch.
  createEffect(() => {
    if (subMode() !== "news") return;
    const list = newsList();
    if (list.length === 0) return;
    const ps   = newsPageSize();
    const off  = newsPageIdx() * ps;
    const page = list.slice(off, off + ps);
    if (page.length === 0) return;

    const have = newsSummaries();
    const todo = page.filter(item => !have.has(item.uuid));
    if (todo.length === 0) return;

    // Reserve placeholders so concurrent renders don't kick off duplicate fetches.
    const reserved = new Map(have);
    for (const item of todo) reserved.set(item.uuid, "");
    setNewsSummaries(reserved);

    const gen = fetchGen;
    for (const item of todo) {
      getNews(props.ticker, item.uuid)
        .then((rows: unknown) => {
          if (gen !== fetchGen) return;
          let summary = "";
          const arr = Array.isArray(rows) ? rows : [];
          if (arr.length > 0) {
            const first = arr[0] as Record<string, unknown>;
            const raw = first.news;
            const paragraphs: NewsParagraph[] = typeof raw === "string"
              ? JSON.parse(raw)
              : ((raw as NewsParagraph[]) ?? []);
            for (const p of paragraphs) {
              const text = (p.paragraph || "").trim();
              if (text) { summary = text.slice(0, 200); break; }
            }
          }
          setNewsSummaries(prev => {
            const m = new Map(prev);
            m.set(item.uuid, summary);
            return m;
          });
        })
        .catch(() => {
          // Leave the empty placeholder; user can still open the link to read.
        });
    }
  });

  // ─── Derived state ─────────────────────────────────────────────────────────
  /** Sticky scroll for the Transcripts list (News uses page-based nav, no
   *  per-row scroll). Uses *visual* row index because the list interleaves
   *  section headers ("FY 2025") with quarter rows. */
  createEffect(() => {
    if (subMode() !== "transcripts") return;
    const sel = selectedVisualIdx();
    if (sel < 0) return;
    const off = listOffset();
    const vh  = contentH();
    if (sel < off) setListOffset(sel);
    else if (sel >= off + vh) setListOffset(sel - vh + 1);
  });

  /** Detail lines for the currently-selected item. */
  const detailLines = createMemo<DetailLine[]>(() => {
    const w = detailW();
    if (subMode() === "transcripts") {
      const item = transcripts()[tIdx()];
      return buildTranscriptLines(item, transcriptBody(), w);
    }
    const item = newsList()[nIdx()];
    return buildNewsLines(item, newsBody(), w);
  });

  /** Visible slice of detail (after scroll). */
  const detailSlice = createMemo<DetailLine[]>(() => {
    const lines = detailLines();
    const off = readingScroll();
    return lines.slice(off, off + contentH());
  });

  const maxReadingScroll = createMemo(() =>
    Math.max(0, detailLines().length - contentH())
  );

  /** Clamp readingScroll if detail shrinks (e.g. ticker change). */
  createEffect(() => {
    const max = maxReadingScroll();
    if (readingScroll() > max) setReadingScroll(max);
  });

  // ─── Keyboard ──────────────────────────────────────────────────────────────
  useKeyboard((key: KeyboardEventLike) => {
    if (props.searchMode) return;
    const seq  = key.sequence ?? "";
    const name = key.name     ?? "";

    // Tab: switch sub-mode
    if (name === "tab" || seq === "\t") {
      setSubMode(m => m === "transcripts" ? "news" : "transcripts");
      setReadingMode(false);
      setReadingScroll(0);
      setListOffset(0);
      return;
    }

    if (name === "escape") {
      if (readingMode()) {
        setReadingMode(false);
        setReadingScroll(0);
      }
      return;
    }

    if (name === "return" || name === "enter") {
      if (!readingMode() && detailLines().length > 0) {
        setReadingMode(true);
        setReadingScroll(0);
      }
      return;
    }

    if (readingMode()) {
      // Detail scroll
      if (name === "up") {
        setReadingScroll(s => Math.max(0, s - 1));
      } else if (name === "down") {
        setReadingScroll(s => Math.min(maxReadingScroll(), s + 1));
      } else if (seq === "g") {
        setReadingScroll(0);
      } else if (seq === "G") {
        setReadingScroll(maxReadingScroll());
      }
      return;
    }

    // ── List mode keyboard ──────────────────────────────────────────────────
    if (subMode() === "news") {
      const len = newsList().length;
      if (len <= 0) return;
      const ps  = newsPageSize();
      const pc  = newsPageCount();
      const pIdx = newsPageIdx();
      // Items in the current page (last page may be short)
      const itemsInPage = Math.min(ps, len - pIdx * ps);

      if (name === "up") {
        setNewsPageSel(s => Math.max(0, s - 1));
      } else if (name === "down") {
        setNewsPageSel(s => Math.min(itemsInPage - 1, s + 1));
      } else if (name === "left") {
        if (pIdx > 0) {
          setNewsPageIdx(pIdx - 1);
          setNewsPageSel(0);
        }
      } else if (name === "right") {
        if (pIdx < pc - 1) {
          setNewsPageIdx(pIdx + 1);
          setNewsPageSel(0);
        }
      } else if (seq === "g") {
        setNewsPageIdx(0); setNewsPageSel(0);
      } else if (seq === "G") {
        setNewsPageIdx(pc - 1); setNewsPageSel(0);
      }
      return;
    }

    // Transcripts list: ↑/↓ moves selection
    if (name === "up" || name === "down") {
      const dir = name === "up" ? -1 : 1;
      const len = transcripts().length;
      if (len <= 0) return;
      setTIdx(i => Math.max(0, Math.min(len - 1, i + dir)));
      setReadingScroll(0);
    }
  });

  // ─── Render helpers ───────────────────────────────────────────────────────

  const newsLabel = (it: NewsItem, lw: number): string => {
    // Reserve: arrow(2) + date(10) + 2 spaces = 14; rest for title
    const reserved = 14;
    const titleW = Math.max(8, lw - reserved);
    const title = truncate(it.title ?? "", titleW);
    return `${(it.report_date ?? "").slice(0, 10)}  ${title}`;
  };

  /**
   * Full list rows including FY section headers (Transcripts only). Re-derived
   * via createMemo so every reactive update produces fresh object references —
   * forces SolidJS <For> to re-run the row callback. (Without this, <For>'s
   * referential keying leaves stale closures from the first render, causing
   * every visible row to appear selected after a sticky-scroll shift.)
   */
  type ListRow =
    | { kind: "section"; text: string }
    | { kind: "item"; label: string; isSel: boolean };

  const displayList = createMemo<ListRow[]>(() => {
    const sm = subMode();
    if (sm === "transcripts") {
      const items = transcripts();
      const sel = tIdx();
      const rows: ListRow[] = [];
      let curYear: number | null = null;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.fiscal_year !== curYear) {
          rows.push({ kind: "section", text: `FY ${it.fiscal_year}` });
          curYear = it.fiscal_year;
        }
        rows.push({
          kind: "item",
          label: `Q${it.fiscal_quarter}  ${formatShortDate(it.report_date ?? "")}`,
          isSel: i === sel,
        });
      }
      return rows;
    }
    const items = newsList();
    const sel = nIdx();
    const lw = listW();
    return items.map((item, i) => ({
      kind: "item" as const,
      label: newsLabel(item, lw),
      isSel: i === sel,
    }));
  });

  /** Visual index (in displayList) of the currently selected item, accounting
   *  for FY section headers above it. -1 if no item is selected. */
  const selectedVisualIdx = createMemo(() => {
    const rows = displayList();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.kind === "item" && r.isSel) return i;
    }
    return -1;
  });

  // ─── Render ────────────────────────────────────────────────────────────────
  const divider = createMemo(() => "─".repeat(innerW()));
  const cardDivider = createMemo(() => "─".repeat(innerW()));

  const headerInfo = createMemo(() =>
    subMode() === "transcripts"
      ? `${transcripts().length} calls`
      : `${newsList().length} news`
  );

  const isLoadingCurrent = () =>
    subMode() === "transcripts" ? transcriptsLoading() : newsListLoading();
  const errorCurrent = () =>
    subMode() === "transcripts" ? transcriptsError() : newsListError();

  // News card slice for the current page (with lazy-loaded summary)
  const newsPageItems = createMemo(() => {
    const list = newsList();
    const ps   = newsPageSize();
    const off  = newsPageIdx() * ps;
    const sel  = newsPageSel();
    const summaries = newsSummaries();
    return list.slice(off, off + ps).map((item, i) => ({
      item,
      isSel: i === sel,
      summary: summaries.get(item.uuid) ?? "",
    }));
  });

  // Paginator window for the current state
  const paginator = createMemo(() =>
    paginatorWindow(newsPageIdx() + 1, newsPageCount(), 10)
  );

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>

      {/* Header (single line: ticker · sector · industry · date time   ·   sub-tabs   ·   counts) */}
      <box flexDirection="row" height={1}>
        <text style={{ fg: C_AMBER }}>{`${props.ticker} US EQUITY`}</text>
        {sector()   && <text style={{ fg: "white" }}>{`  ·  ${sector()}`}</text>}
        {industry() && <text style={{ fg: "white" }}>{`  ·  ${industry()}`}</text>}
        <text style={{ fg: "white" }}>{`  ·  ${dateTime().date}  ${dateTime().time}    ·    `}</text>
        <text
          style={{
            fg: subMode() === "transcripts" ? "black" : "gray",
            bg: subMode() === "transcripts" ? C_AMBER : undefined,
          }}
          marginRight={1}
        >{subMode() === "transcripts" ? " Transcripts " : "Transcripts"}</text>
        <text
          style={{
            fg: subMode() === "news" ? "black" : "gray",
            bg: subMode() === "news" ? C_AMBER : undefined,
          }}
        >{subMode() === "news" ? " News " : "News"}</text>
        <text style={{ fg: "white" }}>{`    ·    ${headerInfo()}`}</text>
      </box>

      <text style={{ fg: "gray" }}>{divider()}</text>

      {/* Main content: master/detail */}
      <Show when={isLoadingCurrent()}>
        <text style={{ fg: C_AMBER }}>{`Loading ${props.ticker}…`}</text>
      </Show>

      <Show when={!!errorCurrent()}>
        <text style={{ fg: "red" }}>{`Error: ${errorCurrent()}`}</text>
      </Show>

      <Show when={!isLoadingCurrent() && !errorCurrent()}>

        {/* ── Transcripts: master/detail double-pane ─────────────────────── */}
        <Show when={subMode() === "transcripts"}>
          <box flexDirection="row" height={contentH()}>

            {/* Left: FY/Quarter list */}
            <box flexDirection="column" width={listW()}>
              <Show when={transcripts().length === 0}>
                <text style={{ fg: C_GRAY }}>{"  No transcripts available"}</text>
              </Show>
              <Show when={transcripts().length > 0}>
                <For each={displayList().slice(listOffset(), listOffset() + contentH())}>
                  {(row) => {
                    const lw = listW();
                    if (row.kind === "section") {
                      return (
                        <box flexDirection="row" height={1}>
                          <text style={{ fg: C_GRAY }}>{row.text.padEnd(lw).slice(0, lw)}</text>
                        </box>
                      );
                    }
                    const arrow = row.isSel ? "▶ " : "  ";
                    const indent = "  "; // Quarter rows indented under FY header
                    const text = (arrow + indent + row.label).padEnd(lw).slice(0, lw);
                    return (
                      <box flexDirection="row" height={1}>
                        <text style={{
                          fg: row.isSel ? "black" : "white",
                          bg: row.isSel ? C_AMBER : undefined,
                        }}>{text}</text>
                      </box>
                    );
                  }}
                </For>
              </Show>
            </box>

            {/* Vertical separator */}
            <box flexDirection="column" width={3}>
              <For each={Array.from({ length: contentH() })}>
                {() => <text style={{ fg: "gray" }}>{" │ "}</text>}
              </For>
            </box>

            {/* Right: transcript detail */}
            <box flexDirection="column" flexGrow={1}>
              <For each={detailSlice()}>
                {(line) => renderDetailLine(line, detailW())}
              </For>
              <Show when={transcriptBodyLoading()}>
                <text style={{ fg: C_AMBER }}>{"  Loading transcript…"}</text>
              </Show>
              <Show when={!!transcriptBodyError()}>
                <text style={{ fg: "red" }}>{`  Error: ${transcriptBodyError()}`}</text>
              </Show>
            </box>

          </box>
        </Show>

        {/* ── News list mode: full-width cards + paginator ───────────────── */}
        <Show when={subMode() === "news" && !readingMode()}>
          <box flexDirection="column" height={contentH()}>
            <Show when={newsList().length === 0}>
              <text style={{ fg: C_GRAY }}>{"  No news available"}</text>
            </Show>
            <Show when={newsList().length > 0}>
              <box flexGrow={1} flexDirection="column">
                <For each={newsPageItems()}>
                  {(entry) => renderNewsCard(entry.item, entry.summary, entry.isSel, innerW())}
                </For>
              </box>
              <box flexDirection="row" height={1}>
                {(() => {
                  const p = paginator();
                  return (
                    <>
                      <text style={{ fg: "white" }}>{"  "}</text>
                      <Show when={p.showPrev}>
                        <text style={{ fg: C_CYAN }}>{"Prev  "}</text>
                      </Show>
                      <For each={p.pages}>
                        {(pn) => {
                          const isCur = pn === newsPageIdx() + 1;
                          return (
                            <text style={{
                              fg: isCur ? "black" : C_CYAN,
                              bg: isCur ? C_AMBER : undefined,
                            }}>{` ${pn} `}</text>
                          );
                        }}
                      </For>
                      <Show when={p.showNext}>
                        <text style={{ fg: C_CYAN }}>{"  Next"}</text>
                      </Show>
                    </>
                  );
                })()}
              </box>
            </Show>
          </box>
        </Show>

        {/* ── News reading mode: full-width article ──────────────────────── */}
        <Show when={subMode() === "news" && readingMode()}>
          <box flexDirection="column" height={contentH()}>
            <Show when={newsBodyLoading()}>
              <text style={{ fg: C_AMBER }}>{"Loading article…"}</text>
            </Show>
            <Show when={!!newsBodyError()}>
              <text style={{ fg: "red" }}>{`Error: ${newsBodyError()}`}</text>
            </Show>
            <Show when={!newsBodyLoading() && !newsBodyError()}>
              <For each={detailSlice()}>
                {(line) => renderDetailLine(line, detailW())}
              </For>
            </Show>
          </box>
        </Show>

        {/* Footer hint */}
        <box flexDirection="row" height={1}>
          <Show when={readingMode()}>
            <text style={{ fg: "gray" }}>
              {`reading mode  ·  ↑↓: scroll  ·  g/G: top/end  ·  Esc: back  ·  line ${readingScroll() + 1}/${detailLines().length}`}
            </text>
          </Show>
          <Show when={!readingMode()}>
            <text style={{ fg: "gray" }}>
              {(() => {
                if (subMode() === "transcripts") {
                  const len = transcripts().length;
                  const sel = tIdx();
                  const pos = len > 0 ? `${sel + 1}/${len}` : `0/0`;
                  return `list mode  ·  ↑↓: select  ·  ⏎: read  ·  Tab: → News  ·  ${pos}`;
                }
                // News list mode
                const pi = newsPageIdx() + 1;
                const pc = newsPageCount();
                return `list mode  ·  ↑↓: select  ·  ←→: page  ·  ⏎: read  ·  Tab: → Transcripts  ·  page ${pi}/${pc}`;
              })()}
            </text>
          </Show>
        </box>
      </Show>

    </box>
  );
}
