/**
 * Growth screen — YoY growth rates for key financial metrics.
 * Shows Revenue, Operating Income, EBITDA, Net Income, FCF, EPS (Q only), TTM EPS (Q only).
 * Supports quarterly/annual toggle, column scrolling (←→), row selection (↑↓), and chart (Enter).
 * Newest periods are shown first; scroll right to view older data.
 */

import { createSignal, createEffect, createMemo, onMount, onCleanup, For, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions, useRenderer } from "@opentui/solid";
import {
  getAnnualRevenueGrowth, getQuarterlyRevenueGrowth,
  getAnnualOperatingIncomeGrowth, getQuarterlyOperatingIncomeGrowth,
  getAnnualEbitdaGrowth, getQuarterlyEbitdaGrowth,
  getAnnualNetIncomeGrowth, getQuarterlyNetIncomeGrowth,
  getAnnualFcfGrowth, getQuarterlyFcfGrowth,
  getQuarterlyEpsGrowth, getQuarterlyTtmEpsGrowth,
  renderFundBarChart,
  getInfo,
} from "../bridge/api";

// ─── Color palette ────────────────────────────────────────────────────────────

const C_AMBER = "#FFA028";

// ─── Layout constants ─────────────────────────────────────────────────────────

const LABEL_COL_W = 16;
const VALUE_COL_W = 13;
const CHART_COL   = 3;

// Total fixed chrome rows (used for numVisRows):
//   App: border(2) + tabbar(1) + divider×2(2) + statusbar(1) = 6
//   Growth: paddingTop(1) + header(1) + sub-tabs(1) + divider(1)
//         + period-header(1) + divider(1) + scroll-indicator(1) = 7
//   Total = 13
const CHROME_HEIGHT = 13;

// Rows strictly above the flat list — used for chart terminal-row positioning.
//   App top chrome: border_top(1) + tabbar(1) + app_divider(1) = 3
//   Growth inner:   paddingTop(1) + header(1) + sub-tabs(1) + divider(1)
//                 + period-header(1) + divider(1) = 6
//   Bottom chrome:  app_divider(1) + statusbar(1) = 2  (subtracted by -2 in formula)
//   Total = 3 + 6 + 2 = 11
const HEADER_TERM_ROWS = 11;

// ─── Types ────────────────────────────────────────────────────────────────────

interface DataPoint {
  period: string;
  value:  number | null;
  yoy:    number | null;
}

interface MetricData {
  label:   string;
  isMoney: boolean;
  points:  DataPoint[];
}

type ValueEntry = { kind: "value"; label: string; isMoney: boolean; displayValues: (number | null)[]; metricIdx: number; isSelected: boolean };
type FlatEntry  =
  | ValueEntry
  | { kind: "yoy";   displayValues: (number | null)[] }
  | { kind: "sep" }
  | { kind: "chart" };

// ─── Metric configs ───────────────────────────────────────────────────────────

interface MetricConfig {
  label:      string;
  valueField: string;
  apiName:    string;
  isMoney:    boolean;
  fetcher:    (symbol: string) => Promise<unknown>;
}

const QUARTERLY_METRICS: MetricConfig[] = [
  { label: "Revenue",     valueField: "revenue",                        apiName: "quarterly_revenue_yoy_growth()",          isMoney: true,  fetcher: getQuarterlyRevenueGrowth },
  { label: "Oper Income", valueField: "operating_income",               apiName: "quarterly_operating_income_yoy_growth()", isMoney: true,  fetcher: getQuarterlyOperatingIncomeGrowth },
  { label: "EBITDA",      valueField: "ebitda",                         apiName: "quarterly_ebitda_yoy_growth()",           isMoney: true,  fetcher: getQuarterlyEbitdaGrowth },
  { label: "Net Income",  valueField: "net_income_common_stockholders", apiName: "quarterly_net_income_yoy_growth()",       isMoney: true,  fetcher: getQuarterlyNetIncomeGrowth },
  { label: "FCF",         valueField: "free_cash_flow",                 apiName: "quarterly_fcf_yoy_growth()",              isMoney: true,  fetcher: getQuarterlyFcfGrowth },
  { label: "EPS",         valueField: "eps",                            apiName: "quarterly_eps_yoy_growth()",              isMoney: false, fetcher: getQuarterlyEpsGrowth },
  { label: "TTM EPS",     valueField: "ttm_eps",                        apiName: "quarterly_ttm_eps_yoy_growth()",          isMoney: false, fetcher: getQuarterlyTtmEpsGrowth },
];

const ANNUAL_METRICS: MetricConfig[] = [
  { label: "Revenue",     valueField: "revenue",                        apiName: "annual_revenue_yoy_growth()",             isMoney: true,  fetcher: getAnnualRevenueGrowth },
  { label: "Oper Income", valueField: "operating_income",               apiName: "annual_operating_income_yoy_growth()",    isMoney: true,  fetcher: getAnnualOperatingIncomeGrowth },
  { label: "EBITDA",      valueField: "ebitda",                         apiName: "annual_ebitda_yoy_growth()",              isMoney: true,  fetcher: getAnnualEbitdaGrowth },
  { label: "Net Income",  valueField: "net_income_common_stockholders", apiName: "annual_net_income_yoy_growth()",          isMoney: true,  fetcher: getAnnualNetIncomeGrowth },
  { label: "FCF",         valueField: "free_cash_flow",                 apiName: "annual_fcf_yoy_growth()",                 isMoney: true,  fetcher: getAnnualFcfGrowth },
];

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(1)}%`;
}

function fmtMoney(n: number | null): string {
  if (n == null || !isFinite(n as number)) return "—";
  const abs  = Math.abs(n as number);
  const sign = (n as number) < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9)  return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6)  return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3)  return `${sign}${(abs / 1e3).toFixed(2)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

function fmtNum(n: number | null): string {
  if (n == null || !isFinite(n as number)) return "—";
  return (n as number).toFixed(2);
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

function toNumOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalize(rows: any[], valueField: string): DataPoint[] {
  return (rows ?? []).map((r: any) => ({
    period: String(r.report_date).slice(0, 10),
    value:  toNumOrNull(r[valueField]),
    yoy:    toNumOrNull(r.yoy_growth),
  }));
}

// Merge multiple metric results onto a shared period axis (newest first).
function buildMetrics(
  results: Array<{ label: string; isMoney: boolean; points: DataPoint[] }>
): { periods: string[]; metrics: MetricData[] } {
  const periodSet = new Set<string>();
  for (const r of results) {
    for (const p of r.points) periodSet.add(p.period);
  }
  const periods = Array.from(periodSet).sort((a, b) => b.localeCompare(a)); // newest first

  const metrics: MetricData[] = results.map(r => {
    const map = new Map<string, DataPoint>(r.points.map(p => [p.period, p]));
    return {
      label:   r.label,
      isMoney: r.isMoney,
      points:  periods.map(period => map.get(period) ?? { period, value: null, yoy: null }),
    };
  });

  return { periods, metrics };
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  ticker:     string;
  searchMode: boolean;
}

export default function Growth(props: Props) {
  const dims     = useTerminalDimensions();
  const renderer = useRenderer();
  let currentEscSeq = "";

  const [_imgReady,     setImgReady]     = createSignal(0);
  const [isQuarterly,   setIsQuarterly]  = createSignal(true);
  const [loading,       setLoading]      = createSignal(true);
  const [error,         setError]        = createSignal("");
  const [progressLines, setProgressLines]= createSignal<string[]>([]);
  const [metrics,       setMetrics]      = createSignal<MetricData[]>([]);
  const [periods,       setPeriods]      = createSignal<string[]>([]);
  const [rowOffset,     setRowOffset]    = createSignal(0);
  const [colOffset,     setColOffset]    = createSignal(0);
  const [selIdx,        setSelIdx]       = createSignal(0);
  const [expandedIdx,   setExpandedIdx]  = createSignal<number | null>(null);
  const [sector,        setSector]       = createSignal("");
  const [industry,      setIndustry]     = createSignal("");

  let lastChartTermRow: number | null = null;
  let lastChartH = 8;
  let lastChartW = 80;
  let skipNextEnter = false;
  let isInitialLoad = true;

  // Date display (daily resolution is enough for Growth)
  const [dateStr, setDateStr] = createSignal(new Date().toISOString().slice(0, 10));
  onMount(() => {
    const id = setInterval(() => setDateStr(new Date().toISOString().slice(0, 10)), 60_000);
    onCleanup(() => clearInterval(id));
  });

  // ─── Data fetch ────────────────────────────────────────────────────────────

  let fetchGen = 0;
  createEffect(() => {
    const t = props.ticker;
    const q = isQuarterly();
    if (!t) return;

    const gen = ++fetchGen;
    setLoading(true);
    setError("");
    setMetrics([]);
    setPeriods([]);
    setRowOffset(0);
    setColOffset(0);
    setExpandedIdx(null);
    setSelIdx(0);

    if (isInitialLoad) {
      isInitialLoad = false;
    } else {
      skipNextEnter = true;
    }

    const configs = q ? QUARTERLY_METRICS : ANNUAL_METRICS;
    setProgressLines(configs.map(c => `Fetching ${c.apiName}…`));

    Promise.all(
      configs.map(async (cfg, i) => {
        try {
          const t0  = Date.now();
          const raw = await cfg.fetcher(t);
          if (gen !== fetchGen) return null;
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          setProgressLines(ls => ls.map((l, j) => j === i ? `✓ ${cfg.apiName}  ${elapsed}s` : l));
          return { label: cfg.label, isMoney: cfg.isMoney, points: normalize(raw as any[], cfg.valueField) };
        } catch {
          if (gen !== fetchGen) return null;
          setProgressLines(ls => ls.map((l, j) => j === i ? `✗ ${cfg.apiName}  error` : l));
          return null;
        }
      })
    ).then(results => {
      if (gen !== fetchGen) return;
      const valid = results.filter(Boolean) as Array<{ label: string; isMoney: boolean; points: DataPoint[] }>;
      if (valid.length === 0) { setError("No data available"); setLoading(false); return; }
      const { periods: ps, metrics: ms } = buildMetrics(valid);
      setPeriods(ps);
      setMetrics(ms);
      setLoading(false);
    }).catch((e: unknown) => {
      if (gen !== fetchGen) return;
      setError(String(e));
      setLoading(false);
    });
  });

  // Fetch sector / industry when ticker changes
  createEffect(() => {
    const t = props.ticker;
    if (!t) return;
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

  // ─── Layout ────────────────────────────────────────────────────────────────

  const innerW     = () => Math.max(40, dims().width - 4);
  const numVisCols = createMemo(() => Math.max(1, Math.floor((innerW() - LABEL_COL_W) / VALUE_COL_W)));
  const maxColOffset = createMemo(() => Math.max(0, periods().length - numVisCols()));

  const chartH = createMemo(() =>
    Math.max(8, Math.min(20, Math.floor((dims().height - CHROME_HEIGHT) * 0.4)))
  );
  const chartW = createMemo(() => Math.max(60, dims().width - 4));

  const visiblePeriods = createMemo(() =>
    periods().slice(colOffset(), colOffset() + numVisCols())
  );

  // Flat list: value row [+ chart rows if expanded] + yoy row + sep
  const flatList = createMemo<FlatEntry[]>(() => {
    const ms  = metrics();
    const co  = colOffset();
    const nc  = numVisCols();
    const ei  = expandedIdx();
    const ch  = chartH();
    const result: FlatEntry[] = [];
    for (let i = 0; i < ms.length; i++) {
      const m     = ms[i];
      const slice = m.points.slice(co, co + nc);
      result.push({ kind: "value", label: m.label, isMoney: m.isMoney, displayValues: slice.map(p => p.value), metricIdx: i, isSelected: false });
      if (ei === i) {
        for (let j = 0; j < ch; j++) result.push({ kind: "chart" });
      }
      result.push({ kind: "yoy", displayValues: slice.map(p => p.yoy) });
      if (i < ms.length - 1) result.push({ kind: "sep" });
    }
    return result;
  });

  const numVisRows   = createMemo(() => Math.max(1, dims().height - CHROME_HEIGHT));
  const maxRowOffset = createMemo(() => Math.max(0, flatList().length - numVisRows()));

  // Inject isSelected into display entries (avoids flatList recompute on navigation)
  const displayRows = createMemo<FlatEntry[]>(() => {
    const sel = selIdx();
    const ro  = rowOffset();
    const nv  = numVisRows();
    return flatList().slice(ro, ro + nv).map(e =>
      e.kind === "value" ? { ...e, isSelected: e.metricIdx === sel } : e
    );
  });

  const periodHeader = createMemo(() =>
    " ".repeat(LABEL_COL_W) +
    visiblePeriods().map(p => p.padStart(VALUE_COL_W)).join("")
  );

  // Terminal row where the chart starts (one row below the selected metric's value row)
  const chartTermRow = createMemo(() => {
    const ei = expandedIdx();
    if (ei == null) return null;
    const fl = flatList();
    const flatPos = fl.findIndex(e => e.kind === "value" && (e as ValueEntry).metricIdx === ei);
    if (flatPos < 0) return null;
    const screenPos = flatPos - rowOffset();
    if (screenPos < 0 || screenPos >= numVisRows()) return null;
    // formula: (HEADER_TERM_ROWS - 2) + 1 + screenPos + 1 = HEADER_TERM_ROWS + screenPos
    return HEADER_TERM_ROWS + screenPos;
  });

  // ─── Chart rendering ───────────────────────────────────────────────────────

  createEffect(() => {
    const ei = expandedIdx();
    if (ei == null) { currentEscSeq = ""; return; }

    const ms = metrics();
    if (ei >= ms.length) return;
    const m = ms[ei];

    // Use chronological order (oldest first) for chart x-axis
    const validPoints = [...m.points].reverse().filter(p => p.yoy != null);
    if (validPoints.length === 0) return;

    const cRow = chartTermRow();
    if (cRow == null) return;

    const h = chartH();
    const w = chartW();
    lastChartTermRow = cRow; lastChartH = h; lastChartW = w;

    renderFundBarChart(
      validPoints.map(p => p.period),
      validPoints.map(p => p.yoy),
      [],
      `${m.label} YoY Growth`,
      true,
      w, h,
    )
      .then((esc: string) => {
        currentEscSeq = `\x1b[${cRow};${CHART_COL}H${esc}`;
        setImgReady(n => n + 1);
      })
      .catch(() => {});
  });

  // Erase chart when closed (expandedIdx → null)
  createEffect(() => {
    if (expandedIdx() !== null) return;
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

  // Patch renderNative to repaint chart after every TUI render
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

  // ─── Keyboard ──────────────────────────────────────────────────────────────

  useKeyboard((key: any) => {
    if (props.searchMode) return;
    const seq  = key.sequence ?? "";
    const name = key.name    ?? "";
    const ei   = expandedIdx();

    // When a chart is open, only allow closing it
    if (ei !== null) {
      if (name === "return" || name === "enter" || name === "escape") setExpandedIdx(null);
      return;
    }

    if (seq === "p") {
      setIsQuarterly(q => !q);
    } else if (name === "up") {
      const next = Math.max(0, selIdx() - 1);
      setSelIdx(next);
      const fp = flatList().findIndex(e => e.kind === "value" && (e as ValueEntry).metricIdx === next);
      if (fp >= 0) setRowOffset(ro => Math.min(ro, fp));
    } else if (name === "down") {
      const last = metrics().length - 1;
      const next = Math.min(last, selIdx() + 1);
      setSelIdx(next);
      const fp = flatList().findIndex(e => e.kind === "value" && (e as ValueEntry).metricIdx === next);
      if (fp >= 0) {
        const nv = numVisRows();
        setRowOffset(ro => fp >= ro + nv ? fp - nv + 1 : ro);
      }
    } else if (name === "left") {
      setColOffset(c => Math.max(0, c - 1));
    } else if (name === "right") {
      setColOffset(c => Math.min(maxColOffset(), c + 1));
    } else if (name === "return" || name === "enter") {
      if (skipNextEnter) { skipNextEnter = false; return; }
      const si = selIdx();
      setExpandedIdx(e => e === si ? null : si);
    }
  });

  // ─── Render ────────────────────────────────────────────────────────────────

  const divider = () => "─".repeat(innerW());

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>

      {/* Header */}
      <box flexDirection="row" height={1}>
        <text style={{ fg: C_AMBER }}>{`${props.ticker} US EQUITY`}</text>
        {sector()   && <text style={{ fg: "white" }}>{`  ·  ${sector()}`}</text>}
        {industry() && <text style={{ fg: "white" }}>{`  ·  ${industry()}`}</text>}
        <text style={{ fg: "white" }}>{`  ·  ${dateStr()}`}</text>
        <Show when={expandedIdx() !== null}>
          <text style={{ fg: "gray" }}>{"  ·  Enter:close chart"}</text>
        </Show>
      </box>

      {/* Q/A sub-tab */}
      <box flexDirection="row" height={1}>
        <text
          style={{ fg: isQuarterly() ? "black" : "gray", bg: isQuarterly() ? C_AMBER : undefined }}
          marginRight={2}
        >{isQuarterly() ? " Quarterly " : "Quarterly"}</text>
        <text
          style={{ fg: !isQuarterly() ? "black" : "gray", bg: !isQuarterly() ? C_AMBER : undefined }}
          marginRight={2}
        >{!isQuarterly() ? " Annual " : "Annual"}</text>
      </box>

      <text style={{ fg: "gray" }}>{divider()}</text>

      {/* Loading */}
      <Show when={loading()}>
        <text style={{ fg: C_AMBER }}>{`Loading ${props.ticker}…`}</text>
        <For each={progressLines()}>
          {(line) => {
            const done = line.startsWith("✓");
            const fail = line.startsWith("✗");
            return <text style={{ fg: done ? "green" : fail ? "red" : "gray" }}>{`  ${line}`}</text>;
          }}
        </For>
      </Show>

      {/* Error */}
      <Show when={!!error()}>
        <text style={{ fg: "red" }}>{`Error: ${error()}`}</text>
      </Show>

      {/* Data */}
      <Show when={!loading() && !error() && metrics().length > 0}>
        <box flexDirection="column">

          {/* Period header row */}
          <box flexDirection="row" height={1}>
            <text style={{ fg: C_AMBER }}>{periodHeader()}</text>
          </box>

          <text style={{ fg: "gray" }}>{divider()}</text>

          {/* Metric rows */}
          <For each={displayRows()}>
            {(entry) => {
              if (entry.kind === "sep") {
                return <box height={1}><text>{" "}</text></box>;
              }
              if (entry.kind === "chart") {
                return <box height={1}><text>{" "}</text></box>;
              }
              if (entry.kind === "yoy") {
                return (
                  <box flexDirection="row" height={1}>
                    <text style={{ fg: "gray" }}>{"  YoY %".padEnd(LABEL_COL_W)}</text>
                    <For each={entry.displayValues}>
                      {(v) => (
                        <text style={{ fg: v == null ? "gray" : v >= 0 ? "green" : "red" }}>
                          {fmtPct(v).padStart(VALUE_COL_W)}
                        </text>
                      )}
                    </For>
                  </box>
                );
              }
              // kind === "value"
              const sel    = entry.isSelected;
              const fmt    = entry.isMoney ? fmtMoney : fmtNum;
              const baseFg = sel ? "black" : C_AMBER;
              const baseBg = sel ? C_AMBER : undefined;
              return (
                <box flexDirection="row" height={1}>
                  <text style={{ fg: baseFg, bg: baseBg }}>{entry.label.padEnd(LABEL_COL_W)}</text>
                  <For each={entry.displayValues}>
                    {(v) => (
                      <text style={{ fg: sel ? "black" : v == null ? "gray" : "white", bg: baseBg }}>
                        {fmt(v).padStart(VALUE_COL_W)}
                      </text>
                    )}
                  </For>
                </box>
              );
            }}
          </For>

          {/* Scroll indicators */}
          <box flexDirection="row" height={1}>
            <text style={{ fg: "gray" }}>
              {[
                colOffset() > 0              ? "← " : "",
                colOffset() < maxColOffset() ? "→ " : "",
                flatList().length > numVisRows()
                  ? `  rows ${rowOffset() + 1}–${Math.min(rowOffset() + numVisRows(), flatList().length)}/${flatList().length}`
                  : "",
              ].join("")}
            </text>
          </box>

        </box>
      </Show>

    </box>
  );
}
