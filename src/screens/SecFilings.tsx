/**
 * SEC Filings screen — paginated card list of EDGAR submissions.
 * Each card shows form_type, description, filing_date, fiscal-period
 * context, and a clickable filing_url that opens the EDGAR archive
 * page in the browser. Enter on the selected card also opens the URL.
 */

import { createSignal, createEffect, createMemo, onMount, onCleanup, For, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";
import { getSecFilings, getInfo } from "../bridge/api";

// ─── Color palette ────────────────────────────────────────────────────────────

const C_AMBER = "#FFA028";
const C_CYAN  = "cyan";
const C_GRAY  = "gray";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  ticker:     string;
  searchMode: boolean;
}

interface SecFiling {
  symbol:                 string;
  cik:                    string;
  accession_number:       string;
  company_name:           string;
  form_type:              string;
  form_type_description:  string;
  filing_date:            string;
  report_date:            string | null;
  acceptance_date_time:   string | null;
  filing_url:             string;
}

interface KeyboardEventLike {
  sequence?: string;
  name?:     string;
  ctrl?:     boolean;
  meta?:     boolean;
}

// Forms commonly tracked by investors / analysts. Everything else (most notably
// Form 4 insider trades, which dwarf real filings on most tickers) is hidden by
// default but available via the `f` toggle.
const IMPORTANT_FORMS = new Set([
  "10-K",   "10-K/A",
  "10-Q",   "10-Q/A",
  "8-K",    "8-K/A",
  "20-F",   "20-F/A",
  "DEF 14A", "DEFA14A",
  "S-1",    "S-1/A",
  "SC 13D", "SC 13D/A",
  "SC 13G", "SC 13G/A",
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (!s || max <= 0) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Open URL in the user's default browser. macOS uses `open`, Linux `xdg-open`. */
function openInBrowser(url: string): void {
  if (!url) return;
  const cmd = process.platform === "darwin" ? "open"
            : process.platform === "win32" ? "start"
            : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // Best effort — silently fail if the launcher binary is missing.
  }
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

// ─── Card renderer ────────────────────────────────────────────────────────────

const CARD_ROWS = 4;

function renderFilingCard(it: SecFiling, isSel: boolean, w: number) {
  // Row 1:  [FORM]  Description …                               filing_date
  const tag    = `[${it.form_type ?? ""}]`;
  const tagW   = Math.max(tag.length, 8) + 2; // align indent for short tags
  const indent = " ".repeat(tagW);
  const date   = (it.filing_date ?? "").slice(0, 10);
  const titleW = Math.max(10, w - tagW - date.length - 2);
  const title  = truncate(it.form_type_description ?? "", titleW);
  const left1  = `${tag.padEnd(tagW - 2)}  ${title}`;
  const pad1   = Math.max(1, w - left1.length - date.length);
  const line1  = (left1 + " ".repeat(pad1) + date).padEnd(w).slice(0, w);
  // Row 2:  fiscal period (or acceptance time fallback)
  const rd = (it.report_date ?? "").slice(0, 10);
  const accept = (it.acceptance_date_time ?? "").slice(0, 16).replace("T", " ");
  const ctx = rd
    ? `Reported for fiscal period ending ${rd}`
    : (accept ? `Accepted ${accept}` : "");
  const sumW  = Math.max(10, w - tagW);
  const line2 = (indent + truncate(ctx, sumW)).padEnd(w).slice(0, w);
  // Row 3:  filing_url (rendered as <a> below; here we just hold the values)
  const url    = it.filing_url ?? "";
  const urlW   = Math.max(10, w - tagW);
  const urlVis = truncate(url, urlW);
  // Row 4: divider
  const line4  = "─".repeat(w);

  const bg     = isSel ? C_AMBER : undefined;
  const titleFg   = isSel ? "black" : "white";
  const ctxFg     = isSel ? "black" : C_GRAY;

  // Tail spaces fill the rest of the row so the selection bg covers full width.
  const urlTailW = Math.max(0, w - tagW - urlVis.length);
  const urlTail  = " ".repeat(urlTailW);

  return (
    <box flexDirection="column">
      <box flexDirection="row" height={1}>
        <text style={{ fg: titleFg, bg }}>{line1}</text>
      </box>
      <box flexDirection="row" height={1}>
        <text style={{ fg: ctxFg, bg }}>{line2}</text>
      </box>
      <box flexDirection="row" height={1}>
        {/* Split into 3 spans so the underline only covers the URL itself,
            not the leading indent or trailing padding. */}
        <text style={{ bg }}>{indent}</text>
        <text style={{ fg: isSel ? "black" : C_CYAN, bg, attributes: TextAttributes.UNDERLINE }}>
          <a href={url}>{urlVis}</a>
        </text>
        <text style={{ bg }}>{urlTail}</text>
      </box>
      <box flexDirection="row" height={1}>
        <text style={{ fg: C_GRAY }}>{line4}</text>
      </box>
    </box>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SecFilings(props: Props) {
  const dims = useTerminalDimensions();

  // Data
  const [filings, setFilings]   = createSignal<SecFiling[]>([]);
  const [loading, setLoading]   = createSignal(true);
  const [error,   setError]     = createSignal("");

  // UI state
  const [importantOnly, setImportantOnly] = createSignal(true);
  const [pageIdx,       setPageIdx]       = createSignal(0);
  const [pageSel,       setPageSel]       = createSignal(0);

  // Header context
  const [sector,   setSector]   = createSignal("");
  const [industry, setIndustry] = createSignal("");

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
  // Mirrors the budget used by News.tsx so both tabs feel identical.
  const innerW   = createMemo(() => Math.max(40, dims().width - 4));
  const contentH = createMemo(() => Math.max(3, dims().height - 10));
  const pageSize = createMemo(() => Math.max(2, Math.floor((contentH() - 1) / CARD_ROWS)));

  // ─── Fetch on ticker change ──────────────────────────────────────────────
  let fetchGen = 0;
  createEffect(() => {
    const t = props.ticker;
    if (!t) return;
    const gen = ++fetchGen;
    setFilings([]); setLoading(true); setError("");
    setPageIdx(0); setPageSel(0);

    getSecFilings(t)
      .then((rows: unknown) => {
        if (gen !== fetchGen) return;
        const arr = Array.isArray(rows) ? (rows as SecFiling[]) : [];
        // API returns ascending by filing_date — flip to newest-first.
        arr.sort((a, b) => (b.filing_date ?? "").localeCompare(a.filing_date ?? ""));
        setFilings(arr);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (gen !== fetchGen) return;
        setError(String(e));
        setLoading(false);
      });

    getInfo(t)
      .then((rows: unknown) => {
        if (gen !== fetchGen) return;
        const info = Array.isArray(rows) ? (rows as { sector?: string; industry?: string }[]) : [];
        if (info.length) {
          setSector(info[0].sector ?? "");
          setIndustry(info[0].industry ?? "");
        }
      })
      .catch(() => {});
  });

  // ─── Filtered view ────────────────────────────────────────────────────────
  const visibleFilings = createMemo<SecFiling[]>(() => {
    const all = filings();
    return importantOnly()
      ? all.filter(f => IMPORTANT_FORMS.has(f.form_type ?? ""))
      : all;
  });
  const totalPages = createMemo(() =>
    Math.max(1, Math.ceil(visibleFilings().length / pageSize()))
  );

  // Clamp page state when filter / data shape changes.
  createEffect(() => {
    const tp = totalPages();
    if (pageIdx() >= tp) {
      setPageIdx(tp - 1);
      setPageSel(0);
    }
  });

  const pageItems = createMemo(() => {
    const list = visibleFilings();
    const ps   = pageSize();
    const off  = pageIdx() * ps;
    const sel  = pageSel();
    return list.slice(off, off + ps).map((item, i) => ({ item, isSel: i === sel }));
  });

  const paginator = createMemo(() => paginatorWindow(pageIdx() + 1, totalPages(), 10));

  // ─── Keyboard ─────────────────────────────────────────────────────────────
  useKeyboard((key: KeyboardEventLike) => {
    if (props.searchMode) return;
    const seq  = key.sequence ?? "";
    const name = key.name     ?? "";

    // Tab: toggle Important / All filter
    if (name === "tab" || seq === "\t") {
      setImportantOnly(v => !v);
      setPageIdx(0); setPageSel(0);
      return;
    }

    // Enter: open the selected filing's EDGAR archive page
    if (name === "return" || name === "enter") {
      const items = pageItems();
      const entry = items[pageSel()];
      if (entry?.item.filing_url) openInBrowser(entry.item.filing_url);
      return;
    }

    const len = visibleFilings().length;
    if (len <= 0) return;
    const ps    = pageSize();
    const pIdx  = pageIdx();
    const tp    = totalPages();
    const onPage = Math.min(ps, len - pIdx * ps);

    if (name === "up") {
      setPageSel(s => Math.max(0, s - 1));
    } else if (name === "down") {
      setPageSel(s => Math.min(onPage - 1, s + 1));
    } else if (name === "left") {
      if (pIdx > 0) { setPageIdx(pIdx - 1); setPageSel(0); }
    } else if (name === "right") {
      if (pIdx < tp - 1) { setPageIdx(pIdx + 1); setPageSel(0); }
    } else if (seq === "g") {
      setPageIdx(0); setPageSel(0);
    } else if (seq === "G") {
      setPageIdx(tp - 1); setPageSel(0);
    }
  });

  // ─── Render ────────────────────────────────────────────────────────────────
  const divider = createMemo(() => "─".repeat(innerW()));

  const headerCount = createMemo(() => {
    const v = visibleFilings().length;
    const t = filings().length;
    return importantOnly() ? `${v} of ${t} filings` : `${v} filings`;
  });

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>

      {/* Header: ticker · sector · industry · date time · filter · counts */}
      <box flexDirection="row" height={1}>
        <text style={{ fg: C_AMBER }}>{`${props.ticker} US EQUITY`}</text>
        {sector()   && <text style={{ fg: "white" }}>{`  ·  ${sector()}`}</text>}
        {industry() && <text style={{ fg: "white" }}>{`  ·  ${industry()}`}</text>}
        <text style={{ fg: "white" }}>{`  ·  ${dateTime().date}  ${dateTime().time}    ·    `}</text>
        <text
          style={{
            fg: importantOnly() ? "black" : "gray",
            bg: importantOnly() ? C_AMBER : undefined,
          }}
          marginRight={1}
        >{importantOnly() ? " Important " : "Important"}</text>
        <text
          style={{
            fg: !importantOnly() ? "black" : "gray",
            bg: !importantOnly() ? C_AMBER : undefined,
          }}
        >{!importantOnly() ? " All " : "All"}</text>
        <text style={{ fg: "white" }}>{`    ·    ${headerCount()}`}</text>
      </box>

      <text style={{ fg: "gray" }}>{divider()}</text>

      <Show when={loading()}>
        <text style={{ fg: C_AMBER }}>{`Loading ${props.ticker}…`}</text>
      </Show>
      <Show when={!!error()}>
        <text style={{ fg: "red" }}>{`Error: ${error()}`}</text>
      </Show>

      <Show when={!loading() && !error()}>
        <box flexDirection="column" height={contentH()}>
          <Show when={visibleFilings().length === 0}>
            <text style={{ fg: C_GRAY }}>{"  No filings available"}</text>
          </Show>
          <Show when={visibleFilings().length > 0}>
            <box flexGrow={1} flexDirection="column">
              <For each={pageItems()}>
                {(entry) => renderFilingCard(entry.item, entry.isSel, innerW())}
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
                        const isCur = pn === pageIdx() + 1;
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

        {/* Footer hint */}
        <box flexDirection="row" height={1}>
          <text style={{ fg: "gray" }}>
            {(() => {
              const pi = pageIdx() + 1;
              const tp = totalPages();
              const filterHint = importantOnly() ? "Tab: → All forms" : "Tab: → Important only";
              return `↑↓: select  ·  ←→: page  ·  ⏎: open in browser  ·  ${filterHint}  ·  page ${pi}/${tp}`;
            })()}
          </text>
        </box>
      </Show>

    </box>
  );
}
