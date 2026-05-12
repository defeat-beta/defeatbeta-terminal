/**
 * Financials screen — Bloomberg FA-style financial statements.
 * Shows Income Statement, Balance Sheet, and Cash Flow with
 * hierarchical rows (indent levels + section headers).
 * Supports quarterly/annual toggle and row/column scrolling.
 *
 * Revenue Breakdown Panel (Income Statement + Quarterly only):
 *   On load, Total Revenue is auto-highlighted.
 *   Enter (or ↓) expands a segment/geo breakdown directly below it;
 *   the statement rows below Total Revenue are hidden while expanded.
 *   When expanded: Tab toggles Segment ↔ Geography, ←/→ scrolls columns,
 *   Enter or ↓ closes. Any ↑/↓ that leaves the highlight drops selection
 *   and enters row-by-row scroll mode; pressing ↑ at row 0 re-selects.
 */

import { createSignal, createEffect, createMemo, onMount, onCleanup, For, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import {
  getQuarterlyIncomeStatement,
  getAnnualIncomeStatement,
  getQuarterlyBalanceSheet,
  getAnnualBalanceSheet,
  getQuarterlyCashFlow,
  getAnnualCashFlow,
  getInfo,
  getRevenueBySegment,
  getRevenueByGeography,
} from "../bridge/api";

// ─── Color palette ────────────────────────────────────────────────────────────

const C_AMBER = "#FFA028";
const C_PANEL_BG = "#1a1a1a";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StatementRow {
  label:      string;
  indent:     number;
  is_section: boolean;
  values:     (number | null)[];
  show_yoy:   boolean;
}

interface StatementData {
  currency:    string;
  period_type: string;
  periods:     string[];
  statement:   StatementRow[];
}

/** Internal flat item (statement only — panel is rendered separately) */
type FlatItem =
  | { kind: "data";  label: string; indent: number; is_section: boolean; show_yoy: boolean; values: (number | null)[] }
  | { kind: "yoy";   values: (number | null)[] };

// Revenue breakdown raw data (rows = report dates, columns = segment/geo names)
interface RevenueBreakdownData {
  columns: string[];
  periods: string[];
  /** values[periodIndex][columnIndex] */
  values: (number | null)[][];
}

/** Aligned breakdown: rows = segment/geo, values aligned to statement periods */
interface AlignedBreakdown {
  rowLabels: string[];
  /** values[rowIndex][stmtPeriodIndex] */
  values: (number | null)[][];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STMT_LABELS = ["Income Statement", "Balance Sheet", "Cash Flow"] as const;

// Each value column: 12 chars content + 1 space separator = 13 total
const VALUE_COL_W = 13;

const FETCHERS = [
  [getQuarterlyIncomeStatement, getAnnualIncomeStatement],
  [getQuarterlyBalanceSheet,    getAnnualBalanceSheet],
  [getQuarterlyCashFlow,        getAnnualCashFlow],
] as const;

const FETCHER_NAMES = [
  ["quarterly_income_statement()", "annual_income_statement()"],
  ["quarterly_balance_sheet()",    "annual_balance_sheet()"],
  ["quarterly_cash_flow()",        "annual_cash_flow()"],
] as const;

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(1)}%`;
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !isFinite(n as number)) return "—";
  const abs  = Math.abs(n as number);
  const sign = (n as number) < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9)  return `${sign}${(abs / 1e9 ).toFixed(2)}B`;
  if (abs >= 1e6)  return `${sign}${(abs / 1e6 ).toFixed(2)}M`;
  if (abs >= 1e3)  return `${sign}${(abs / 1e3 ).toFixed(2)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

// ─── Revenue Breakdown Parser ─────────────────────────────────────────────────

function parseRevenueBreakdown(data: unknown): RevenueBreakdownData | null {
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return null;

  const first = rows[0] as Record<string, unknown>;
  const exclude = new Set(["symbol", "report_date", "period_type"]);
  const columns = Object.keys(first).filter(k => !exclude.has(k));

  const periods: string[] = [];
  const values: (number | null)[][] = [];

  for (const row of rows) {
    const r = row as Record<string, unknown>;
    periods.push((r.report_date as string)?.slice(0, 10) ?? "");
    values.push(columns.map(col => {
      const v = r[col];
      // Treat 0 as missing — segment/geo schemas often add/drop columns and
      // backfill old rows with 0 instead of null, which would skew YoY.
      if (typeof v !== "number" || !isFinite(v) || v === 0) return null;
      return v;
    }));
  }

  return { columns, periods, values };
}

// ─── Keyboard type ────────────────────────────────────────────────────────────

interface KeyboardEventLike {
  sequence?: string;
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  ticker:     string;
  searchMode: boolean;
}

export default function Financials(props: Props) {
  const dims = useTerminalDimensions();

  const [stmtIdx,     setStmtIdx]     = createSignal(0);
  const [isQuarterly, setIsQuarterly] = createSignal(true);
  const [loading,       setLoading]       = createSignal(true);
  const [error,         setError]         = createSignal("");
  const [progressLines, setProgressLines] = createSignal<string[]>([]);
  const [data,        setData]        = createSignal<StatementData | null>(null);
  const [rowOffset,   setRowOffset]   = createSignal(0);
  const [colOffset,   setColOffset]   = createSignal(0);
  /** Selected row index within the flat statement list. -1 = no selection (page-scroll mode) */
  const [selectedFlatIdx, setSelectedFlatIdx] = createSignal(-1);
  const [sector,      setSector]      = createSignal("");
  const [industry,    setIndustry]    = createSignal("");

  // ─── Revenue breakdown ─────────────────────────────────────────────────────
  const [isExpanded,      setIsExpanded]      = createSignal(false);
  const [breakdown,       setBreakdown]       = createSignal<"segment" | "geo">("segment");
  const [breakdownData,   setBreakdownData]   = createSignal<RevenueBreakdownData | null>(null);
  const [breakdownLoading, setBreakdownLoading] = createSignal(false);

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

  // Fetch statement
  let fetchGen = 0;
  createEffect(() => {
    const t   = props.ticker;
    const idx = stmtIdx();
    const q   = isQuarterly();
    if (!t) return;

    const gen = ++fetchGen;
    setLoading(true);
    setError("");
    setData(null);
    setRowOffset(0);
    setColOffset(0);
    setIsExpanded(false);
    setSelectedFlatIdx(-1);

    const label = FETCHER_NAMES[idx][q ? 0 : 1];
    setProgressLines([`Fetching ${label}…`]);
    const t0 = Date.now();
    const fn = (q ? FETCHERS[idx][0] : FETCHERS[idx][1]) as (s: string) => Promise<unknown>;
    fn(t)
      .then(result => {
        if (gen !== fetchGen) return;
        const s = ((Date.now() - t0) / 1000).toFixed(1);
        setProgressLines([`✓ ${label}  ${s}s`]);
        setData(result as StatementData);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (gen !== fetchGen) return;
        setError(String(e));
        setLoading(false);
      });
  });

  /** Auto-select Total Revenue once when Income Statement data first loads */
  let autoSelectedForGen = -1;
  createEffect(() => {
    const d = data();
    if (!d || stmtIdx() !== 0 || !isQuarterly()) return;
    if (autoSelectedForGen === fetchGen) return;
    const idx = revFlatIdx();
    if (idx >= 0) {
      setSelectedFlatIdx(idx);
      autoSelectedForGen = fetchGen;
    }
  });

  createEffect(() => {
    const t = props.ticker;
    if (!t) return;
    getInfo(t)
      .then((rows: unknown) => {
        const info = Array.isArray(rows) ? rows as { sector?: string; industry?: string }[] : [];
        if (info.length) {
          setSector(info[0].sector ?? "");
          setIndustry(info[0].industry ?? "");
        }
      })
      .catch(() => {});
  });

  // Fetch revenue breakdown
  let breakdownFetchGen = 0;
  createEffect(() => {
    const t = props.ticker;
    if (!t || !isExpanded()) return;
    const gen = ++breakdownFetchGen;
    setBreakdownLoading(true);
    setBreakdownData(null);
    const fn = breakdown() === "segment" ? getRevenueBySegment : getRevenueByGeography;
    fn(t)
      .then((result: unknown) => {
        if (gen !== breakdownFetchGen) return;
        setBreakdownData(parseRevenueBreakdown(result));
        setBreakdownLoading(false);
      })
      .catch(() => {
        if (gen !== breakdownFetchGen) return;
        setBreakdownData(null);
        setBreakdownLoading(false);
      });
  });

  // ─── Layout ────────────────────────────────────────────────────────────────
  // Fixed rows: border(2)+tabbar(1)+div×2(2)+status(1)+padding(1)+header(1)
  //            +sub-tabs(1)+div(1)+period-hdr(1)+div(1)+scroll-ind(1) = 13

  const innerW = createMemo(() => Math.max(40, dims().width - 4));

  const labelColW = createMemo(() => {
    const d = data();
    if (!d?.statement.length) return 30;
    const maxLen = Math.max(...d.statement.map(r => r.indent * 2 + r.label.length)) + 1;
    return Math.min(maxLen, Math.floor(innerW() * 0.42));
  });

  const statement = createMemo(() => data()?.statement ?? []);
  const periods   = createMemo(() => data()?.periods   ?? []);
  const displayCurrency = createMemo(() => data()?.currency ?? "USD");

  /** Aligned breakdown: rows = segment/geo, values reordered to match statement periods */
  const alignedBreakdown = createMemo<AlignedBreakdown | null>(() => {
    const bd = breakdownData();
    const stmtPeriods = periods();
    if (!bd || stmtPeriods.length === 0) return null;
    // Match by YYYY-MM (same fiscal quarter may have different exact end dates,
    // e.g. NVDA income: 2026-01-31 vs segment: 2026-01-25)
    const ym = (s: string) => s.slice(0, 7);
    const ymToIdx = new Map<string, number>();
    bd.periods.forEach((p, i) => ymToIdx.set(ym(p), i));
    const rowLabels = bd.columns;
    const values: (number | null)[][] = rowLabels.map((_, colIdx) =>
      stmtPeriods.map(p => {
        const rawRowIdx = ymToIdx.get(ym(p));
        if (rawRowIdx == null) return null;
        return bd.values[rawRowIdx]?.[colIdx] ?? null;
      })
    );
    return { rowLabels, values };
  });

  /** Panel height in rows (0 if collapsed). Chrome = header(1) only. */
  const panelH = createMemo(() => {
    if (!isExpanded()) return 0;
    const ab = alignedBreakdown();
    const dataRows = ab ? ab.rowLabels.length * 2 : 1; // each segment row has a YoY sub-row
    return 1 + Math.max(1, dataRows);
  });

  /** Number of rows visible for the statement */
  const numVisRows = createMemo(() => Math.max(1, dims().height - 13 - panelH()));

  const numVisCols = createMemo(() =>
    Math.max(1, Math.floor((innerW() - labelColW()) / VALUE_COL_W))
  );

  /** Build the statement-only flat list (panel is rendered separately) */
  const flatStatement = createMemo<FlatItem[]>(() => {
    const step = isQuarterly() ? 4 : 1;
    const items: FlatItem[] = [];
    for (const r of statement()) {
      items.push({
        kind: "data", label: r.label, indent: r.indent,
        is_section: r.is_section, show_yoy: r.show_yoy, values: r.values,
      });
      if (r.show_yoy) {
        const yoyVals = r.values.map((curr, i) => {
          const prev = r.values[i + step];
          if (curr == null || prev == null || prev === 0) return null;
          return (curr - prev) / Math.abs(prev);
        });
        items.push({ kind: "yoy", values: yoyVals });
      }
    }
    return items;
  });

  const maxColOffset = createMemo(() => Math.max(0, periods().length - numVisCols()));
  const maxRowOffset = createMemo(() => Math.max(0, flatStatement().length - numVisRows()));

  /** Flat index of the Total Revenue row (-1 if absent) */
  const revFlatIdx = createMemo(() =>
    flatStatement().findIndex(e => e.kind === "data" && e.label === "Total Revenue")
  );

  /** Slice the flat statement to visible rows with selection info */
  const displayRows = createMemo(() => {
    const entries = flatStatement();
    const co = colOffset();
    const nc = numVisCols();
    const ro = rowOffset();
    const sel = selectedFlatIdx();

    // When the breakdown panel is expanded, truncate the statement so it
    // ends right after Total Revenue — the panel renders directly below it.
    let endIdx = ro + numVisRows();
    if (isExpanded() && revFlatIdx() >= 0) {
      endIdx = Math.min(endIdx, revFlatIdx() + 1);
    }
    return entries.slice(ro, endIdx).map((entry, visIdx) => {
      const flatIdx = ro + visIdx;
      if (entry.kind === "data") {
        return {
          ...entry,
          displayValues: entry.values.slice(co, co + nc),
          isSelected: flatIdx === sel,
        } as const;
      }
      return {
        ...entry,
        displayValues: entry.values.slice(co, co + nc),
      } as const;
    });
  });

  const periodHeader = createMemo(() =>
    " ".repeat(labelColW()) +
    periods().slice(colOffset(), colOffset() + numVisCols()).map(p => p.padStart(VALUE_COL_W)).join("")
  );

  // ─── Keyboard ──────────────────────────────────────────────────────────────

  useKeyboard((key: KeyboardEventLike) => {
    if (props.searchMode) return;
    const seq  = key.sequence ?? "";
    const name = key.name    ?? "";

    // Tab toggles segment/geography (only when panel is expanded)
    if (isExpanded() && (name === "tab" || seq === "\t")) {
      setBreakdown(b => b === "segment" ? "geo" : "segment");
      return;
    }

    // Enter toggles panel when selection is on Total Revenue
    if (name === "return" || name === "enter") {
      const entry = flatStatement()[selectedFlatIdx()];
      if (isQuarterly() && entry?.kind === "data" && entry.label === "Total Revenue") {
        if (isExpanded()) {
          setIsExpanded(false);
        } else {
          setIsExpanded(true);
          setRowOffset(0);
        }
      }
      return;
    }

    if (name === "escape") {
      if (isExpanded()) { setIsExpanded(false); return; }
    }

    if (seq === "s")      { setStmtIdx(i => (i + 1) % 3); return; }
    else if (seq === "p") { setIsQuarterly(q => !q); return; }
    else if (name === "up" || name === "down") {
      // While the breakdown panel is open, ↓ closes it (same as Enter toggle).
      if (name === "down" && isExpanded()) {
        setIsExpanded(false);
        return;
      }
      // Leaving the Total Revenue highlight: jump straight to top/bottom,
      // then subsequent presses scroll one row at a time.
      if (selectedFlatIdx() >= 0) {
        setSelectedFlatIdx(-1);
        setIsExpanded(false);
      } else if (name === "up" && rowOffset() === 0 && stmtIdx() === 0 && isQuarterly()) {
        // Already at top — re-highlight Total Revenue if present
        const idx = revFlatIdx();
        if (idx >= 0) { setSelectedFlatIdx(idx); return; }
      }
      setRowOffset(r => {
        const next = name === "up" ? r - 1 : r + 1;
        return Math.max(0, Math.min(maxRowOffset(), next));
      });
      return;
    }
    else if (name === "left")  { setColOffset(c => Math.max(0, c - 1)); return; }
    else if (name === "right") { setColOffset(c => Math.min(maxColOffset(), c + 1)); return; }
  });

  // ─── Render ────────────────────────────────────────────────────────────────

  const divider = createMemo(() => "─".repeat(innerW()));

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>

      {/* Header */}
      <box flexDirection="row" height={1}>
        <text style={{ fg: C_AMBER }}>{`${props.ticker} US EQUITY`}</text>
        {sector()   && <text style={{ fg: "white" }}>{`  ·  ${sector()}`}</text>}
        {industry() && <text style={{ fg: "white" }}>{`  ·  ${industry()}`}</text>}
        <text style={{ fg: "white" }}>{`  ·  ${dateTime().date}  ${dateTime().time}`}</text>
      </box>

      {/* Sub-tab bar */}
      <box flexDirection="row" height={1}>
        {STMT_LABELS.map((label, i) => (
          <text
            style={{ fg: stmtIdx() === i ? "black" : "gray", bg: stmtIdx() === i ? C_AMBER : undefined }}
            marginRight={2}
          >{stmtIdx() === i ? ` ${label} ` : label}</text>
        ))}
        <text style={{ fg: "white" }}>{"  ·  "}</text>
        <text
          style={{ fg: isQuarterly() ? "black" : "gray", bg: isQuarterly() ? C_AMBER : undefined }}
          marginRight={2}
        >{isQuarterly() ? " Quarterly " : "Quarterly"}</text>
        <text
          style={{ fg: !isQuarterly() ? "black" : "gray", bg: !isQuarterly() ? C_AMBER : undefined }}
          marginRight={2}
        >{!isQuarterly() ? " Annual " : "Annual"}</text>
        <text style={{ fg: "white" }}>{"  ·  "}</text>
        <text style={{ fg: "white" }}>{displayCurrency()}</text>
      </box>

      <text style={{ fg: "gray" }}>{divider()}</text>

      {/* Loading state */}
      <Show when={loading()}>
        <text style={{ fg: C_AMBER }}>{`Loading ${props.ticker}…`}</text>
        <For each={progressLines()}>
          {(line) => {
            const done = line.startsWith("✓");
            return <text style={{ fg: done ? "green" : "gray" }}>{`  ${line}`}</text>;
          }}
        </For>
      </Show>

      {/* Error state */}
      <Show when={!!error()}>
        <text style={{ fg: "red" }}>{`Error: ${error()}`}</text>
      </Show>

      <Show when={!loading() && !error() && !!data()}>

        {/* ─── Statement table ─── */}
        {!loading() && !error() && !!data() && (
          <box flexDirection="column">

            {/* Period header row */}
            <box flexDirection="row" height={1}>
              <text style={{ fg: C_AMBER }}>{periodHeader()}</text>
            </box>

            <text style={{ fg: "gray" }}>{divider()}</text>

            {/* Statement rows (includes panel rows inline) */}
            <For each={displayRows()}>
              {(entry) => {
                // ─── YoY sub-row ───────────────────────────────────────────
                if (entry.kind === "yoy") {
                  return (
                    <box flexDirection="row" height={1}>
                      <text style={{ fg: "gray" }}>{"  % YoY".padEnd(labelColW())}</text>
                      <For each={entry.displayValues}>
                        {(v: number | null) => (
                          <text style={{ fg: v == null ? "gray" : v >= 0 ? "green" : "red" }}>
                            {fmtPct(v).padStart(VALUE_COL_W)}
                          </text>
                        )}
                      </For>
                    </box>
                  );
                }

                // ─── Normal data row ───────────────────────────────────────
                const lw       = labelColW();
                const rawLabel = " ".repeat(entry.indent * 2) + (entry.label ?? "");
                const label    = rawLabel.length > lw
                  ? rawLabel.slice(0, lw - 1) + "…"
                  : rawLabel.padEnd(lw);
                const isRev = entry.label === "Total Revenue";
                const sel = entry.isSelected;
                const baseFg = sel ? "black" : (isRev || entry.show_yoy ? C_AMBER : "white");
                const baseBg = sel ? C_AMBER : undefined;
                const nc = numVisCols();
                const filled = entry.displayValues.length;
                const padCols = Math.max(0, nc - filled);
                // Hint: show "⏎ segment/geo" on Total Revenue when collapsed and on quarterly IS
                const showRevHint = isRev && stmtIdx() === 0 && isQuarterly() && !isExpanded();
                const hintText = "  ⏎ segment / geo";
                const labelWithHint = (() => {
                  if (!showRevHint) return label;
                  const avail = Math.max(0, lw - hintText.length);
                  return rawLabel.length > avail
                    ? rawLabel.slice(0, Math.max(0, avail - 1)) + "…"
                    : rawLabel.padEnd(avail);
                })();
                return (
                  <box flexDirection="row" height={1}>
                    <text style={{ fg: baseFg, bg: baseBg }}>{labelWithHint}</text>
                    <Show when={showRevHint}>
                      <text style={{ fg: sel ? "black" : "gray", bg: baseBg }}>{hintText}</text>
                    </Show>
                    <For each={entry.displayValues}>
                      {(val: number | null) => (
                        <text style={{ fg: sel ? "black" : val == null ? "gray" : "white", bg: baseBg }}>
                          {fmtMoney(val).padStart(VALUE_COL_W)}
                        </text>
                      )}
                    </For>
                    <Show when={sel && padCols > 0}>
                      <text style={{ bg: baseBg }}>{" ".repeat(padCols * VALUE_COL_W)}</text>
                    </Show>
                  </box>
                );
              }}
            </For>

            {/* ─── Revenue breakdown panel (Total Revenue expansion) ─── */}
            <Show when={isExpanded()}>
              {(() => {
                // Width consumed by label + visible value cells; pad rest with bg.
                const usedW = () => labelColW() + numVisCols() * VALUE_COL_W;
                const tailW = () => Math.max(0, innerW() - usedW());

                // Header row — indented like a sub-row of Total Revenue
                const HINT_PREFIX = "  ├ ";
                const HINT_SEG_A  = "[Segment]";
                const HINT_SEG_B  = " Segment ";
                const HINT_GEO_A  = "[Geography]";
                const HINT_GEO_B  = " Geography ";
                const HINT_SEP    = "  ";
                const HINT_TAIL   = `  ·  ${displayCurrency()}  ·  ⇥: switch  ·  ⏎/↓: close  ·  ←→: cols`;
                const headerContentW = createMemo(() =>
                  HINT_PREFIX.length
                    + (breakdown() === "segment" ? HINT_SEG_A : HINT_SEG_B).length
                    + HINT_SEP.length
                    + (breakdown() === "geo" ? HINT_GEO_A : HINT_GEO_B).length
                    + HINT_TAIL.length
                );
                const HeaderRow = () => (
                  <box flexDirection="row" height={1}>
                    <text style={{ bg: C_PANEL_BG, fg: "gray" }}>{HINT_PREFIX}</text>
                    <text style={{ bg: C_PANEL_BG, fg: breakdown() === "segment" ? C_AMBER : "gray" }}>
                      {breakdown() === "segment" ? HINT_SEG_A : HINT_SEG_B}
                    </text>
                    <text style={{ bg: C_PANEL_BG, fg: "gray" }}>{HINT_SEP}</text>
                    <text style={{ bg: C_PANEL_BG, fg: breakdown() === "geo" ? C_AMBER : "gray" }}>
                      {breakdown() === "geo" ? HINT_GEO_A : HINT_GEO_B}
                    </text>
                    <text style={{ bg: C_PANEL_BG, fg: "gray" }}>{HINT_TAIL}</text>
                    <text style={{ bg: C_PANEL_BG }}>{" ".repeat(Math.max(0, innerW() - headerContentW()))}</text>
                  </box>
                );

                return <>
                  <HeaderRow />
                  <Show
                    when={!breakdownLoading() && alignedBreakdown() && alignedBreakdown()!.rowLabels.length > 0}
                    fallback={
                      <box flexDirection="row" height={1}>
                        <text style={{ bg: C_PANEL_BG, fg: "gray" }}>
                          {(breakdownLoading() ? "  └ Loading breakdown…" : "  └ No breakdown data").padEnd(innerW())}
                        </text>
                      </box>
                    }
                  >
                    <For each={alignedBreakdown()!.rowLabels}>
                      {(rowLabel, ri) => {
                        const fullValues = createMemo(() => alignedBreakdown()?.values[ri()] ?? []);
                        const display = createMemo(() =>
                          fullValues().slice(colOffset(), colOffset() + numVisCols())
                        );
                        const yoyValues = createMemo(() => {
                          const vs = fullValues();
                          // statement is newest-first, step = 4 for quarterly YoY
                          return vs.map((curr, i) => {
                            const prev = vs[i + 4];
                            if (curr == null || prev == null || prev === 0) return null;
                            return (curr - prev) / Math.abs(prev);
                          });
                        });
                        const yoyDisplay = createMemo(() =>
                          yoyValues().slice(colOffset(), colOffset() + numVisCols())
                        );
                        const isLast = createMemo(() =>
                          ri() === (alignedBreakdown()?.rowLabels.length ?? 0) - 1
                        );
                        const labelPrefix = createMemo(() => "  " + (isLast() ? "└ " : "├ "));
                        const labelName = createMemo(() => {
                          const lw = labelColW();
                          const avail = lw - labelPrefix().length;
                          return rowLabel.length > avail
                            ? rowLabel.slice(0, avail - 1) + "…"
                            : rowLabel.padEnd(avail);
                        });
                        const yoyLabel = createMemo(() => {
                          const lw = labelColW();
                          const prefix = "  " + (isLast() ? "  " : "│ ");
                          return (prefix + "  % YoY").padEnd(lw);
                        });
                        return (
                          <>
                            <box flexDirection="row" height={1}>
                              <text style={{ bg: C_PANEL_BG, fg: "gray" }}>{labelPrefix()}</text>
                              <text style={{ bg: C_PANEL_BG, fg: "white" }}>{labelName()}</text>
                              <For each={display()}>
                                {(v: number | null) => (
                                  <text style={{ bg: C_PANEL_BG, fg: v == null ? "gray" : "white" }}>
                                    {fmtMoney(v).padStart(VALUE_COL_W)}
                                  </text>
                                )}
                              </For>
                              <text style={{ bg: C_PANEL_BG }}>{" ".repeat(tailW())}</text>
                            </box>
                            <box flexDirection="row" height={1}>
                              <text style={{ bg: C_PANEL_BG, fg: "gray" }}>{yoyLabel()}</text>
                              <For each={yoyDisplay()}>
                                {(v: number | null) => (
                                  <text style={{ bg: C_PANEL_BG, fg: v == null ? "gray" : v >= 0 ? "green" : "red" }}>
                                    {fmtPct(v).padStart(VALUE_COL_W)}
                                  </text>
                                )}
                              </For>
                              <text style={{ bg: C_PANEL_BG }}>{" ".repeat(tailW())}</text>
                            </box>
                          </>
                        );
                      }}
                    </For>
                  </Show>
                </>;
              })()}
            </Show>

            {/* Statement scroll indicators (hidden when panel is open — merged into panel header) */}
            <Show when={!isExpanded() && flatStatement().length > numVisRows()}>
              <box flexDirection="row" height={1}>
                <text style={{ fg: "gray" }}>
                  {[
                    colOffset() > 0              ? "← " : "",
                    colOffset() < maxColOffset() ? "→ " : "",
                    `  rows ${rowOffset() + 1}–${Math.min(rowOffset() + numVisRows(), flatStatement().length)}/${flatStatement().length}`,
                  ].join("")}
                </text>
              </box>
            </Show>

          </box>
        )}

      </Show>

    </box>
  );
}
