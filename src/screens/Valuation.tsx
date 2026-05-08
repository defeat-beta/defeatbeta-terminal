/**
 * Valuation screen — Multiples (EQRV-style) + Fundamentals in one scrollable view.
 * Press ↑↓ to select a multiples row, Enter to expand inline chart, ←→ to scroll columns.
 */

import { createSignal, createEffect, createMemo, onMount, onCleanup, For, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions, useRenderer } from "@opentui/solid";
import {
  getValuationMultiples,
  getValuationFundamentals,
  renderMetricChart,
  renderFundBarChart,
  getInfo,
} from "../bridge/api";

// ─── Color palette ────────────────────────────────────────────────────────────

const C_AMBER = "#FFA028";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MultiplesRow {
  label:           string;
  current:         number | null;
  avg1m:           number | null;
  avg3m:           number | null;
  avg6m:           number | null;
  avg1y:           number | null;
  avg2y:           number | null;
  avg5y:           number | null;
  industry_avg:    number | null;
  series:          Array<{ date: string; value: number }>;
  industry_series: Array<{ date: string; value: number }>;
}

interface FundRow {
  label:           string;
  is_pct:          boolean;
  values:          (number | null)[];
  series:          Array<{ date: string; value: number }>;
  industry_series: Array<{ date: string; value: number }>;
}

interface FundamentalsData {
  periods: string[];
  rows:    FundRow[];
}

// ─── Flat list entry types ────────────────────────────────────────────────────

type FlatEntry =
  | { kind: "mult-hdr" }
  | { kind: "divider" }
  | { kind: "mult";       row: MultiplesRow; idx: number; isSelected: boolean }
  | { kind: "chart" }
  | { kind: "blank" }
  | { kind: "fund-hdr" }
  | { kind: "fund-row";  row: FundRow; fundIdx: number; isSelected: boolean }
  | { kind: "fund-chart" };

// ─── Layout constants ─────────────────────────────────────────────────────────

// Fixed rows consumed above the flat list:
//   App chrome: border(2) + tabbar(1) + divider×2(2) + statusbar(1) = 6
//   Valuation:  paddingTop(1) + header(1) + divider(1) = 3
//   Total = 9
const HEADER_TERM_ROWS = 9;

const CHART_COL = 3;

// Multiples column widths
const COL_LABEL   = 20;
const COL_CURRENT =  9;
const COL_AVG     =  8;  // avg value column per group
const COL_DIFF    =  8;  // % diff column per group

// Fundamentals column widths
const FUND_LW = 20;
const FUND_VW = 13;  // matches Financials VALUE_COL_W

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtRatio(v: number | null | undefined): string {
  if (v == null || !isFinite(v as number)) return "—";
  return `${(v as number).toFixed(2)}x`;
}

function fmtFund(v: number | null, isPct: boolean): string {
  if (v == null) return "     —  ";
  if (isPct) return `${(v * 100).toFixed(1)}%`;
  return `${v.toFixed(2)}x`;
}

// ─── Module-level constants ───────────────────────────────────────────────────

const GROUPS: Array<{ hdr: string; key: keyof MultiplesRow }> = [
  { hdr: "1M Avg", key: "avg1m" },
  { hdr: "3M Avg", key: "avg3m" },
  { hdr: "6M Avg", key: "avg6m" },
  { hdr: "1Y Avg", key: "avg1y" },
  { hdr: "2Y Avg", key: "avg2y" },
  { hdr: "5Y Avg", key: "avg5y" },
  { hdr: "Ind Avg", key: "industry_avg" },
];

// Width of one group column: "  " prefix + avg value + % diff
const COL_GROUP_W = 2 + COL_AVG + COL_DIFF;

// ─── Component ────────────────────────────────────────────────────────────────

interface Props { ticker: string; searchMode: boolean; }

export default function Valuation(props: Props) {
  const dims     = useTerminalDimensions();
  const renderer = useRenderer();
  let currentEscSeq = "";
  const [_imgReady, setImgReady] = createSignal(0);

  const [loadingM,  setLoadingM]  = createSignal(true);
  const [loadingF,  setLoadingF]  = createSignal(true);
  const [errorM,    setErrorM]    = createSignal("");
  const [multiples, setMultiples] = createSignal<MultiplesRow[]>([]);
  const [fundData,      setFundData]      = createSignal<FundamentalsData | null>(null);
  const loading = createMemo(() => loadingM() || loadingF());
  const [progressLines, setProgressLines] = createSignal<string[]>([]);
  const [sector,        setSector]        = createSignal("");
  const [industry,  setIndustry]  = createSignal("");

  // Live clock
  const [dateStr, setDateStr] = createSignal("");
  const [timeStr, setTimeStr] = createSignal("");
  onMount(() => {
    const tick = () => {
      const now = new Date();
      setDateStr(now.toISOString().slice(0, 10));
      setTimeStr(now.toTimeString().slice(0, 8));
    };
    tick();
    const id = setInterval(tick, 1000);
    onCleanup(() => clearInterval(id));
  });

  const [selIdx,         setSelIdx]         = createSignal(0);
  const [expandedIdx,    setExpandedIdx]    = createSignal<number | null>(null);
  const [fundSelIdx,     setFundSelIdx]     = createSignal<number | null>(null);
  const [expandedFundIdx,setExpandedFundIdx]= createSignal<number | null>(null);
  const [rowOffset,      setRowOffset]      = createSignal(0);
  const [colOffset,      setColOffset]      = createSignal(0);

  // ─── Layout ──────────────────────────────────────────────────────────────────

  const innerW = createMemo(() => dims().width - 4);

  const numVisRows = createMemo(() =>
    Math.max(1, dims().height - HEADER_TERM_ROWS)
  );

  // Chart height scales with terminal height: ~40% of available rows, clamped [8, 20]
  const chartH = createMemo(() =>
    Math.max(8, Math.min(20, Math.floor((dims().height - HEADER_TERM_ROWS) * 0.4)))
  );

  // Column layout — Multiples groups
  const numVisGroups = createMemo(() =>
    Math.max(1, Math.floor((innerW() - COL_LABEL - COL_CURRENT) / COL_GROUP_W))
  );
  const visGroups = createMemo(() =>
    GROUPS.slice(colOffset(), colOffset() + numVisGroups())
  );
  const maxGroupColOffset = createMemo(() =>
    Math.max(0, GROUPS.length - numVisGroups())
  );

  // Column layout — Fundamentals periods
  const numVisFundCols = createMemo(() =>
    Math.max(1, Math.floor((innerW() - FUND_LW) / FUND_VW))
  );
  const maxFundColOffset = createMemo(() =>
    Math.max(0, (fundData()?.periods.length ?? 0) - numVisFundCols())
  );

  // Overall max col offset (both tables scroll together)
  const maxColOffset = createMemo(() =>
    Math.max(maxGroupColOffset(), maxFundColOffset())
  );

  // Build the combined flat list
  const flatList = createMemo((): FlatEntry[] => {
    const rows = multiples();
    const fd   = fundData();
    const ei   = expandedIdx();
    const list: FlatEntry[] = [];

    // ── Multiples section ──
    list.push({ kind: "mult-hdr" });
    list.push({ kind: "divider" });
    for (let i = 0; i < rows.length; i++) {
      list.push({ kind: "mult", row: rows[i], idx: i, isSelected: false });
      if (ei === i) {
        for (let j = 0; j < chartH(); j++) list.push({ kind: "chart" });
      }
    }

    // ── Fundamentals section ──
    const efi = expandedFundIdx();
    if (fd) {
      list.push({ kind: "blank" });
      list.push({ kind: "fund-hdr" });
      list.push({ kind: "divider" });
      for (let i = 0; i < fd.rows.length; i++) {
        list.push({ kind: "fund-row", row: fd.rows[i], fundIdx: i, isSelected: false });
        if (efi === i) {
          for (let j = 0; j < chartH(); j++) list.push({ kind: "fund-chart" });
        }
      }
    }
    return list;
  });

  const maxRowOffset = createMemo(() =>
    Math.max(0, flatList().length - numVisRows())
  );

  // Clamp offsets when terminal resizes or data changes
  createEffect(() => { setRowOffset(ro => Math.min(ro, maxRowOffset())); });
  createEffect(() => { setColOffset(co => Math.min(co, maxColOffset())); });

  const displayEntries = createMemo(() => {
    const sel = selIdx();
    const fsi = fundSelIdx();
    const ro  = rowOffset();
    const nv  = numVisRows();
    return flatList().slice(ro, ro + nv).map(e => {
      if (e.kind === "mult")     return { ...e, isSelected: fsi === null && e.idx === sel };
      if (e.kind === "fund-row") return { ...e, isSelected: e.fundIdx === fsi };
      return e;
    });
  });

  // Terminal row for chart start (below the expanded row)
  const chartTermRow = createMemo(() => {
    const ei = expandedIdx();
    if (ei == null) return null;
    const fl = flatList();
    const flatPos = fl.findIndex(e => e.kind === "mult" && e.idx === ei);
    if (flatPos < 0) return null;
    const screenPos = flatPos - rowOffset();
    if (screenPos < 0 || screenPos >= numVisRows()) return null;
    // HEADER_TERM_ROWS includes bottom chrome (statusbar + border = 2 rows).
    // Top chrome only = HEADER_TERM_ROWS - 2; first flat-list row = top_chrome + 1.
    // Chart starts one row below the selected entry.
    return (HEADER_TERM_ROWS - 2) + 1 + screenPos + 1;
  });

  const fundChartTermRow = createMemo(() => {
    const efi = expandedFundIdx();
    if (efi == null) return null;
    const fl = flatList();
    const flatPos = fl.findIndex(e => e.kind === "fund-row" && e.fundIdx === efi);
    if (flatPos < 0) return null;
    const screenPos = flatPos - rowOffset();
    if (screenPos < 0 || screenPos >= numVisRows()) return null;
    return (HEADER_TERM_ROWS - 2) + 1 + screenPos + 1;
  });

  const chartW = createMemo(() => Math.max(60, dims().width - 4));

  // Track the last actual chart start row, height, and width so we can erase precisely when closed
  let lastChartTermRow: number | null = null;
  let lastChartH = 8;
  let lastChartW = 80;
  // Suppress the Enter that was used to confirm the search (same keypress would open chart).
  // isInitialLoad is true for the very first ticker load (no Enter was pressed to get here).
  let skipNextEnter = false;
  let isInitialLoad = true;

  // ─── Data fetch ──────────────────────────────────────────────────────────────
  createEffect(() => {
    const t = props.ticker;
    if (!t) return;
    setLoadingM(true);
    setLoadingF(true);
    setErrorM("");
    // Only suppress Enter when the ticker was switched via search (not on initial mount)
    if (isInitialLoad) {
      isInitialLoad = false;
    } else {
      skipNextEnter = true;
    }
    setExpandedIdx(null);
    setExpandedFundIdx(null);
    setFundSelIdx(null);
    setRowOffset(0);
    setColOffset(0);
    setSelIdx(0);

    // Pre-allocate slots matching _MULTIPLES_CONFIG + _FUNDAMENTALS_CONFIG order in bridge.py
    const _slots = [
      "ttm_pe()", "industry_ttm_pe()",
      "ps_ratio()", "industry_ps_ratio()",
      "pb_ratio()", "industry_pb_ratio()",
      "peg_ratio()",
      "enterprise_to_ebitda()",
      "enterprise_to_revenue()",
      "roe()", "roa()", "roic()", "roce()",
      "equity_multiplier()", "asset_turnover()", "debt_to_equity()",
      "wacc()",
    ];
    setProgressLines(_slots.map(l => `Fetching ${l}…`));

    const _onProgress = (msg: string) => {
      // Only update on completion — initial "Fetching X()…" slots stay until ✓
      if (!msg.startsWith("✓")) return;
      const method = msg.slice(2).split(/\s+/)[0]; // "✓ ttm_pe()  1.2s" → "ttm_pe()"
      const idx = _slots.indexOf(method);
      if (idx >= 0) {
        setProgressLines(ls => ls.map((l, i) => i === idx ? msg : l));
      }
    };

    getValuationMultiples(t, _onProgress)
      .then(d => { setMultiples(d as MultiplesRow[]); setLoadingM(false); })
      .catch((e: unknown) => { setErrorM(String(e)); setLoadingM(false); });

    getValuationFundamentals(t, _onProgress)
      .then(d => { setFundData(d as FundamentalsData); setLoadingF(false); })
      .catch(() => { setLoadingF(false); });

    getInfo(t)
      .then((rows: any) => {
        const info = (rows as any[]) ?? [];
        if (info.length) {
          setSector(info[0].sector ?? "");
          setIndustry(info[0].industry ?? "");
        }
      })
      .catch(() => {});
  });

  // ─── Chart rendering — handles both mult and fund charts ─────────────────────
  createEffect(() => {
    const ei  = expandedIdx();
    const efi = expandedFundIdx();

    if (ei == null && efi == null) { currentEscSeq = ""; return; }

    const h = chartH();
    const w = chartW();

    if (ei != null) {
      const rows = multiples();
      if (ei >= rows.length) return;
      const cRow = chartTermRow();
      if (cRow == null) return;
      lastChartTermRow = cRow; lastChartH = h; lastChartW = w;
      renderMetricChart(rows[ei].series, rows[ei].industry_series, rows[ei].avg1y, rows[ei].label, 1, w, h)
        .then((esc: string) => { currentEscSeq = `\x1b[${cRow};${CHART_COL}H${esc}`; setImgReady(n => n + 1); })
        .catch(() => {});
    } else if (efi != null) {
      const fd = fundData();
      if (!fd || efi >= fd.rows.length) return;
      const cRow = fundChartTermRow();
      if (cRow == null) return;
      lastChartTermRow = cRow; lastChartH = h; lastChartW = w;
      const row = fd.rows[efi];
      renderFundBarChart(fd.periods, row.values, row.industry_series, row.label, row.is_pct, w, h)
        .then((esc: string) => { currentEscSeq = `\x1b[${cRow};${CHART_COL}H${esc}`; setImgReady(n => n + 1); })
        .catch(() => {});
    }
  });

  onMount(() => {
    const fsSync = require("fs");
    let writeTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleWrite = () => {
      if (writeTimer) clearTimeout(writeTimer);
      writeTimer = setTimeout(() => {
        if (currentEscSeq) fsSync.writeSync(1, currentEscSeq);
      }, 50);
    };

    const origRenderNative = (renderer as any).renderNative.bind(renderer);
    (renderer as any).renderNative = function () {
      origRenderNative();
      scheduleWrite();
    };

    createEffect(() => { _imgReady(); scheduleWrite(); });

    onCleanup(() => {
      if (writeTimer) clearTimeout(writeTimer);
      (renderer as any).renderNative = origRenderNative;
      currentEscSeq = "";
      // Erase any chart still painted on the terminal when the tab is switched away
      if (lastChartTermRow != null) {
        const blank = " ".repeat(lastChartW);
        let clear = "";
        for (let r = 0; r < lastChartH; r++) {
          clear += `\x1b[${lastChartTermRow + r};${CHART_COL}H${blank}`;
        }
        fsSync.writeSync(1, clear);
        lastChartTermRow = null;
      }
    });
  });

  // Erase chart precisely at the rows it actually occupied — never touch other rows
  createEffect(() => {
    if (expandedIdx() !== null || expandedFundIdx() !== null) return;
    const startRow = lastChartTermRow;
    lastChartTermRow = null;
    if (startRow == null) return;
    const fsSync = require("fs");
    const blank = " ".repeat(chartW());
    let clear = "";
    for (let r = 0; r < lastChartH; r++) {
      clear += `\x1b[${startRow + r};${CHART_COL}H${blank}`;
    }
    fsSync.writeSync(1, clear);
  });

  // ─── Keyboard ────────────────────────────────────────────────────────────────
  useKeyboard((key: any) => {
    if (props.searchMode) return;
    const name = key.name ?? "";
    const rows = multiples();
    const ei   = expandedIdx();
    const efi  = expandedFundIdx();
    const fsi  = fundSelIdx();

    // Block all navigation while any chart is open
    if (ei !== null) {
      if (name === "return" || name === "enter" || name === "escape") setExpandedIdx(null);
      return;
    }
    if (efi !== null) {
      if (name === "return" || name === "enter" || name === "escape") setExpandedFundIdx(null);
      return;
    }

    if (name === "up") {
      if (fsi !== null) {
        // Navigate within fund section
        if (fsi === 0) {
          setFundSelIdx(null);  // back to last mult row
        } else {
          const next = fsi - 1;
          setFundSelIdx(next);
          const fp = flatList().findIndex(e => e.kind === "fund-row" && e.fundIdx === next);
          if (fp >= 0) setRowOffset(ro => Math.min(ro, fp));
        }
      } else {
        const next = Math.max(0, selIdx() - 1);
        setSelIdx(next);
        const fp = flatList().findIndex(e => e.kind === "mult" && e.idx === next);
        if (fp >= 0) setRowOffset(ro => Math.min(ro, fp));
      }
    } else if (name === "down") {
      if (fsi !== null) {
        // Navigate within fund section
        const fd = fundData();
        if (fd && fsi < fd.rows.length - 1) {
          const next = fsi + 1;
          setFundSelIdx(next);
          const fp = flatList().findIndex(e => e.kind === "fund-row" && e.fundIdx === next);
          if (fp >= 0) {
            const nv = numVisRows();
            setRowOffset(ro => fp >= ro + nv ? fp - nv + 1 : ro);
          }
        }
      } else {
        const last = rows.length - 1;
        if (selIdx() < last) {
          // Move within multiples
          const next = selIdx() + 1;
          setSelIdx(next);
          const fp = flatList().findIndex(e => e.kind === "mult" && e.idx === next);
          if (fp >= 0) {
            const nv = numVisRows();
            setRowOffset(ro => fp >= ro + nv ? fp - nv + 1 : ro);
          }
        } else {
          // At last mult row — transition to fund section
          const fd = fundData();
          if (fd && fd.rows.length > 0) {
            setFundSelIdx(0);
            const fp = flatList().findIndex(e => e.kind === "fund-row" && e.fundIdx === 0);
            if (fp >= 0) {
              const nv = numVisRows();
              setRowOffset(ro => fp >= ro + nv ? fp - nv + 1 : ro);
            }
          }
        }
      }
    } else if (name === "left") {
      setColOffset(c => Math.max(0, c - 1));
    } else if (name === "right") {
      setColOffset(c => Math.min(maxColOffset(), c + 1));
    } else if (name === "return" || name === "enter") {
      if (skipNextEnter) { skipNextEnter = false; return; }
      if (fsi !== null) {
        setExpandedFundIdx(e => e === fsi ? null : fsi);
      } else {
        const si = selIdx();
        setExpandedIdx(e => e === si ? null : si);
      }
    }
  });

  // ─── Render helpers ──────────────────────────────────────────────────────────
  const dividerStr = () => "─".repeat(Math.max(10, innerW()));

  const multHdrLine = createMemo(() => {
    const co   = colOffset();
    const maxCo = maxGroupColOffset();
    const scrollPfx = co > 0    ? "← " : "  ";
    const scrollSfx = co < maxCo ? " →" : "  ";
    return (
      scrollPfx +
      "Valuation Multiples".padEnd(COL_LABEL - 2) +
      "Current".padStart(COL_CURRENT) +
      visGroups().map(g => "  " + g.hdr.padStart(COL_AVG) + "% Diff".padStart(COL_DIFF)).join("") +
      scrollSfx
    );
  });

  const fundHdrLine = () => {
    const fd = fundData();
    if (!fd) return "";
    const co   = colOffset();
    const nv   = numVisFundCols();
    const maxCo = maxFundColOffset();
    const scrollPfx = co > 0    ? "← " : "  ";
    const scrollSfx = co < maxCo ? " →" : "  ";
    return (
      scrollPfx +
      "Valuation Quality".padEnd(FUND_LW - 2) +
      fd.periods.slice(co, co + nv).map(p => p.padStart(FUND_VW)).join("") +
      scrollSfx
    );
  };

  const fundDataLine = (row: FundRow) => {
    const fd = fundData();
    if (!fd) return "";
    const co = colOffset();
    const nv = numVisFundCols();
    return row.label.padEnd(FUND_LW) +
      row.values.slice(co, co + nv).map(v => fmtFund(v ?? null, row.is_pct).padStart(FUND_VW)).join("");
  };

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>

      {/* Fixed header */}
      <box flexDirection="row" height={1}>
        <text style={{ fg: C_AMBER }}>{`${props.ticker} US EQUITY`}</text>
        {sector()   && <text style={{ fg: "white" }}>{`  ·  ${sector()}`}</text>}
        {industry() && <text style={{ fg: "white" }}>{`  ·  ${industry()}`}</text>}
        <text style={{ fg: "white" }}>{`  ·  ${dateStr()}  ${timeStr()}`}</text>
        <Show when={!loading() && expandedIdx() !== null}>
          <text style={{ fg: "gray" }}>{"  ·  Enter:close chart"}</text>
        </Show>
      </box>

      <text style={{ fg: "gray" }}>{dividerStr()}</text>

      {/* Loading / error states */}
      <Show when={loading()}>
        <text style={{ fg: C_AMBER }}>{`Loading ${props.ticker}…`}</text>
        <For each={progressLines()}>
          {(line) => {
            const done = line.startsWith("✓");
            return <text style={{ fg: done ? "green" : "gray" }}>{`  ${line}`}</text>;
          }}
        </For>
      </Show>
      <Show when={!!errorM()}>
        <text style={{ fg: "red" }}>{`Error: ${errorM()}`}</text>
      </Show>

      {/* Scrollable flat list */}
      <Show when={!loading()}>
        <For each={displayEntries()}>
          {(entry) => {
            if (entry.kind === "mult-hdr") {
              return <text style={{ fg: C_AMBER }}>{multHdrLine()}</text>;
            }
            if (entry.kind === "divider") {
              return <text style={{ fg: "gray" }}>{dividerStr()}</text>;
            }
            if (entry.kind === "mult") {
              const sel = entry.isSelected;
              const r   = entry.row;
              const baseFg = sel ? "black" : "white";
              const baseBg = sel ? C_AMBER : undefined;
              return (
                <box flexDirection="row" height={1}>
                  <text style={{ fg: baseFg, bg: baseBg }}>
                    {r.label.slice(0, COL_LABEL).padEnd(COL_LABEL) + fmtRatio(r.current).padStart(COL_CURRENT)}
                  </text>
                  <For each={visGroups()}>
                    {(g) => {
                      const avg  = r[g.key] as number | null;
                      const diff = (r.current != null && avg != null && avg !== 0)
                        ? (r.current - avg) / Math.abs(avg) * 100
                        : null;
                      const diffStr = diff == null ? "—" : `${diff >= 0 ? "+" : ""}${diff.toFixed(1)}%`;
                      const diffFg  = sel ? "black" : diff == null ? "gray" : diff > 0 ? "red" : "green";
                      return (
                        <>
                          <text style={{ fg: baseFg, bg: baseBg }}>{"  " + fmtRatio(avg).padStart(COL_AVG)}</text>
                          <text style={{ fg: diffFg,  bg: baseBg }}>{diffStr.padStart(COL_DIFF)}</text>
                        </>
                      );
                    }}
                  </For>
                </box>
              );
            }
            if (entry.kind === "chart") {
              return <box height={1}><text>{" "}</text></box>;
            }
            if (entry.kind === "blank") {
              return <box height={1}><text>{" "}</text></box>;
            }
            if (entry.kind === "fund-hdr") {
              return <text style={{ fg: C_AMBER }}>{fundHdrLine()}</text>;
            }
            if (entry.kind === "fund-row") {
              const sel   = entry.isSelected;
              const baseFg = sel ? "black" : "white";
              const baseBg = sel ? C_AMBER : undefined;
              return (
                <box height={1}>
                  <text style={{ fg: baseFg, bg: baseBg }}>{fundDataLine(entry.row)}</text>
                </box>
              );
            }
            if (entry.kind === "fund-chart") {
              return <box height={1}><text>{" "}</text></box>;
            }
            return <box height={1} />;
          }}
        </For>
      </Show>

    </box>
  );
}
