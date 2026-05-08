/**
 * Profitability screen — margin metrics for key financial measures.
 * Shows Gross Margin, Operating Margin, EBITDA Margin, Net Margin, FCF Margin.
 * Each metric displays the margin % row and a numerator (absolute value) row.
 * Supports quarterly/annual toggle, column scrolling (←→), row selection (↑↓), and chart (Enter).
 * Newest periods are shown first; scroll right to view older data.
 */

import { createSignal, createEffect, createMemo, onMount, onCleanup, For, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions, useRenderer } from "@opentui/solid";
import {
  getQuarterlyGrossMargin, getAnnualGrossMargin,
  getQuarterlyOperatingMargin, getAnnualOperatingMargin,
  getQuarterlyEbitdaMargin, getAnnualEbitdaMargin,
  getQuarterlyNetMargin, getAnnualNetMargin,
  getQuarterlyFcfMargin, getAnnualFcfMargin,
  getIndustryGrossMargin, getIndustryEbitdaMargin, getIndustryNetMargin,
  renderFundBarChart,
  getInfo,
} from "../bridge/api";

// ─── Color palette ────────────────────────────────────────────────────────────

const C_AMBER = "#FFA028";

// ─── Layout constants ─────────────────────────────────────────────────────────

const LABEL_COL_W = 20;
const VALUE_COL_W = 13;
const CHART_COL   = 3;

// Total fixed chrome rows:
//   App: border(2) + tabbar(1) + divider×2(2) + statusbar(1) = 6
//   Profitability: paddingTop(1) + header(1) + sub-tabs(1) + divider(1)
//                + period-header(1) + divider(1) + scroll-indicator(1) = 7
//   Total = 13
const CHROME_HEIGHT = 13;

// Rows above the flat list (for chart terminal-row positioning)
const HEADER_TERM_ROWS = 11;

// ─── Types ────────────────────────────────────────────────────────────────────

interface DataPoint {
  period: string;
  margin: number | null;
  numerator: number | null;
  revenue: number | null;
}

interface MetricData {
  label:          string;
  numeratorLabel: string;
  points:         DataPoint[];
}

type ValueEntry = { kind: "margin"; label: string; displayValues: (number | null)[]; metricIdx: number; isSelected: boolean };
type FlatEntry =
  | ValueEntry
  | { kind: "numerator"; label: string; displayValues: (number | null)[] }
  | { kind: "revenue"; displayValues: (number | null)[] }
  | { kind: "sep" }
  | { kind: "chart" };

// ─── Metric configs ───────────────────────────────────────────────────────────

interface MetricConfig {
  label:          string;
  numeratorLabel: string;
  marginField:    string;
  numeratorField: string;
  apiName:        string;
  fetcher:        (symbol: string) => Promise<unknown>;
}

const QUARTERLY_METRICS: MetricConfig[] = [
  { label: "Gross Margin",     numeratorLabel: "Gross Profit",  marginField: "gross_margin",     numeratorField: "gross_profit",                   apiName: "quarterly_gross_margin()",     fetcher: getQuarterlyGrossMargin },
  { label: "Operating Margin", numeratorLabel: "Operating Income",   marginField: "operating_margin", numeratorField: "operating_income",               apiName: "quarterly_operating_margin()", fetcher: getQuarterlyOperatingMargin },
  { label: "EBITDA Margin",    numeratorLabel: "EBITDA",        marginField: "ebitda_margin",    numeratorField: "ebitda",                         apiName: "quarterly_ebitda_margin()",    fetcher: getQuarterlyEbitdaMargin },
  { label: "Net Margin",       numeratorLabel: "Net Income",    marginField: "net_margin",       numeratorField: "net_income_common_stockholders", apiName: "quarterly_net_margin()",       fetcher: getQuarterlyNetMargin },
  { label: "FCF Margin",       numeratorLabel: "FCF",           marginField: "fcf_margin",       numeratorField: "free_cash_flow",                 apiName: "quarterly_fcf_margin()",       fetcher: getQuarterlyFcfMargin },
];

const ANNUAL_METRICS: MetricConfig[] = [
  { label: "Gross Margin",     numeratorLabel: "Gross Profit",  marginField: "gross_margin",     numeratorField: "gross_profit",                   apiName: "annual_gross_margin()",     fetcher: getAnnualGrossMargin },
  { label: "Operating Margin", numeratorLabel: "Operating Income",   marginField: "operating_margin", numeratorField: "operating_income",               apiName: "annual_operating_margin()", fetcher: getAnnualOperatingMargin },
  { label: "EBITDA Margin",    numeratorLabel: "EBITDA",        marginField: "ebitda_margin",    numeratorField: "ebitda",                         apiName: "annual_ebitda_margin()",    fetcher: getAnnualEbitdaMargin },
  { label: "Net Margin",       numeratorLabel: "Net Income",    marginField: "net_margin",       numeratorField: "net_income_common_stockholders", apiName: "annual_net_margin()",       fetcher: getAnnualNetMargin },
  { label: "FCF Margin",       numeratorLabel: "FCF",           marginField: "fcf_margin",       numeratorField: "free_cash_flow",                 apiName: "annual_fcf_margin()",       fetcher: getAnnualFcfMargin },
];

// Industry margin configs (quarterly only, available for 3 of the 5 metrics)
interface IndustryConfig {
  metricLabel:  string;
  marginField:  string;
  apiName:      string;
  fetcher:      (symbol: string) => Promise<unknown>;
}

const INDUSTRY_METRICS: IndustryConfig[] = [
  { metricLabel: "Gross Margin",  marginField: "industry_gross_margin",  apiName: "industry_quarterly_gross_margin()",  fetcher: getIndustryGrossMargin },
  { metricLabel: "EBITDA Margin", marginField: "industry_ebitda_margin", apiName: "industry_quarterly_ebitda_margin()", fetcher: getIndustryEbitdaMargin },
  { metricLabel: "Net Margin",    marginField: "industry_net_margin",    apiName: "industry_quarterly_net_margin()",    fetcher: getIndustryNetMargin },
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

// ─── Data helpers ─────────────────────────────────────────────────────────────

function toNumOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalize(rows: any[], marginField: string, numeratorField: string): DataPoint[] {
  return (rows ?? []).map((r: any) => ({
    period:    String(r.report_date).slice(0, 10),
    margin:    toNumOrNull(r[marginField]),
    numerator: toNumOrNull(r[numeratorField]),
    revenue:   toNumOrNull(r.total_revenue),
  }));
}

// Merge multiple metric results onto a shared period axis (newest first).
function buildMetrics(
  results: Array<{ label: string; numeratorLabel: string; points: DataPoint[] }>
): { periods: string[]; metrics: MetricData[] } {
  const periodSet = new Set<string>();
  for (const r of results) {
    for (const p of r.points) periodSet.add(p.period);
  }
  const periods = Array.from(periodSet).sort((a, b) => b.localeCompare(a));

  const metrics: MetricData[] = results.map(r => {
    const map = new Map<string, DataPoint>(r.points.map(p => [p.period, p]));
    return {
      label:          r.label,
      numeratorLabel: r.numeratorLabel,
      points: periods.map(period => map.get(period) ?? { period, margin: null, numerator: null, revenue: null }),
    };
  });

  return { periods, metrics };
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  ticker:     string;
  searchMode: boolean;
}

export default function Profitability(props: Props) {
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

  // Industry margin data — map from metric label → Map<period, margin>
  const [industryMargins, setIndustryMargins] = createSignal<Map<string, Map<string, number | null>>>(new Map());

  let lastChartTermRow: number | null = null;
  let lastChartH = 8;
  let lastChartW = 80;
  let skipNextEnter = false;
  let isInitialLoad = true;

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
    setIndustryMargins(new Map());

    if (isInitialLoad) {
      isInitialLoad = false;
    } else {
      skipNextEnter = true;
    }

    const configs = q ? QUARTERLY_METRICS : ANNUAL_METRICS;
    const allLabels = configs.map(c => c.apiName);
    // Append industry labels for quarterly mode
    const indLabels = q ? INDUSTRY_METRICS.map(c => c.apiName) : [];
    setProgressLines([...allLabels, ...indLabels].map(l => `Fetching ${l}…`));

    const stockFetches = configs.map(async (cfg, i) => {
      try {
        const t0  = Date.now();
        const raw = await cfg.fetcher(t);
        if (gen !== fetchGen) return null;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        setProgressLines(ls => ls.map((l, j) => j === i ? `✓ ${cfg.apiName}  ${elapsed}s` : l));
        return { label: cfg.label, numeratorLabel: cfg.numeratorLabel, points: normalize(raw as any[], cfg.marginField, cfg.numeratorField) };
      } catch {
        if (gen !== fetchGen) return null;
        setProgressLines(ls => ls.map((l, j) => j === i ? `✗ ${cfg.apiName}  error` : l));
        return null;
      }
    });

    const industryFetches = q ? INDUSTRY_METRICS.map(async (cfg, i) => {
      const progIdx = configs.length + i;
      try {
        const t0  = Date.now();
        const raw = await cfg.fetcher(t);
        if (gen !== fetchGen) return null;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        setProgressLines(ls => ls.map((l, j) => j === progIdx ? `✓ ${cfg.apiName}  ${elapsed}s` : l));
        const rows = (raw as any[]) ?? [];
        const map = new Map<string, number | null>();
        for (const r of rows) {
          const period = String(r.report_date).slice(0, 10);
          map.set(period, toNumOrNull(r[cfg.marginField]));
        }
        return { metricLabel: cfg.metricLabel, map };
      } catch {
        if (gen !== fetchGen) return null;
        setProgressLines(ls => ls.map((l, j) => j === progIdx ? `✗ ${cfg.apiName}  error` : l));
        return null;
      }
    }) : [];

    Promise.all([Promise.all(stockFetches), Promise.all(industryFetches)])
      .then(([stockResults, indResults]) => {
        if (gen !== fetchGen) return;
        const valid = stockResults.filter(Boolean) as Array<{ label: string; numeratorLabel: string; points: DataPoint[] }>;
        if (valid.length === 0) { setError("No data available"); setLoading(false); return; }
        const { periods: ps, metrics: ms } = buildMetrics(valid);
        setPeriods(ps);
        setMetrics(ms);

        // Build industry margin lookup
        const indMap = new Map<string, Map<string, number | null>>();
        for (const r of indResults) {
          if (r) indMap.set(r.metricLabel, r.map);
        }
        setIndustryMargins(indMap);

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

  // Flat list: margin row [+ chart rows if expanded] + numerator row + industry row (if available) + sep
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
      result.push({ kind: "margin", label: m.label, displayValues: slice.map(p => p.margin), metricIdx: i, isSelected: false });
      if (ei === i) {
        for (let j = 0; j < ch; j++) result.push({ kind: "chart" });
      }
      result.push({ kind: "numerator", label: m.numeratorLabel, displayValues: slice.map(p => p.numerator) });
      result.push({ kind: "revenue", displayValues: slice.map(p => p.revenue) });
      if (i < ms.length - 1) result.push({ kind: "sep" });
    }
    return result;
  });

  const numVisRows   = createMemo(() => Math.max(1, dims().height - CHROME_HEIGHT));
  const maxRowOffset = createMemo(() => Math.max(0, flatList().length - numVisRows()));

  const displayRows = createMemo<FlatEntry[]>(() => {
    const sel = selIdx();
    const ro  = rowOffset();
    const nv  = numVisRows();
    return flatList().slice(ro, ro + nv).map(e =>
      e.kind === "margin" ? { ...e, isSelected: e.metricIdx === sel } : e
    );
  });

  const periodHeader = createMemo(() =>
    " ".repeat(LABEL_COL_W) +
    visiblePeriods().map(p => p.padStart(VALUE_COL_W)).join("")
  );

  const chartTermRow = createMemo(() => {
    const ei = expandedIdx();
    if (ei == null) return null;
    const fl = flatList();
    const flatPos = fl.findIndex(e => e.kind === "margin" && (e as ValueEntry).metricIdx === ei);
    if (flatPos < 0) return null;
    const screenPos = flatPos - rowOffset();
    if (screenPos < 0 || screenPos >= numVisRows()) return null;
    return HEADER_TERM_ROWS + screenPos;
  });

  // ─── Chart rendering ───────────────────────────────────────────────────────

  createEffect(() => {
    const ei = expandedIdx();
    if (ei == null) { currentEscSeq = ""; return; }

    const ms = metrics();
    if (ei >= ms.length) return;
    const m = ms[ei];

    // Chronological order (oldest first) for chart x-axis
    const validPoints = [...m.points].reverse().filter(p => p.margin != null);
    if (validPoints.length === 0) return;

    const cRow = chartTermRow();
    if (cRow == null) return;

    const h = chartH();
    const w = chartW();
    lastChartTermRow = cRow; lastChartH = h; lastChartW = w;

    // Include industry data as comparison if available
    const indMap = industryMargins().get(m.label);
    const indSeries: Array<{ date: string; value: number }> = [];
    if (indMap) {
      for (const p of validPoints) {
        const v = indMap.get(p.period);
        if (v != null) indSeries.push({ date: p.period, value: v });
      }
    }

    renderFundBarChart(
      validPoints.map(p => p.period),
      validPoints.map(p => p.margin),
      indSeries,
      `${m.label}${indSeries.length ? " vs Industry" : ""}`,
      true,
      w, h,
    )
      .then((esc: string) => {
        currentEscSeq = `\x1b[${cRow};${CHART_COL}H${esc}`;
        setImgReady(n => n + 1);
      })
      .catch(() => {});
  });

  // Erase chart when closed
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

    if (ei !== null) {
      if (name === "return" || name === "enter" || name === "escape") setExpandedIdx(null);
      return;
    }

    if (seq === "p") {
      setIsQuarterly(q => !q);
    } else if (name === "up") {
      const next = Math.max(0, selIdx() - 1);
      setSelIdx(next);
      const fp = flatList().findIndex(e => e.kind === "margin" && (e as ValueEntry).metricIdx === next);
      if (fp >= 0) setRowOffset(ro => Math.min(ro, fp));
    } else if (name === "down") {
      const last = metrics().length - 1;
      const next = Math.min(last, selIdx() + 1);
      setSelIdx(next);
      const fp = flatList().findIndex(e => e.kind === "margin" && (e as ValueEntry).metricIdx === next);
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
              if (entry.kind === "revenue") {
                return (
                  <box flexDirection="row" height={1}>
                    <text style={{ fg: "gray" }}>{`  Revenue`.padEnd(LABEL_COL_W)}</text>
                    <For each={entry.displayValues}>
                      {(v) => (
                        <text style={{ fg: v == null ? "gray" : "white" }}>
                          {fmtMoney(v).padStart(VALUE_COL_W)}
                        </text>
                      )}
                    </For>
                  </box>
                );
              }
              if (entry.kind === "numerator") {
                return (
                  <box flexDirection="row" height={1}>
                    <text style={{ fg: "gray" }}>{`  ${entry.label}`.padEnd(LABEL_COL_W)}</text>
                    <For each={entry.displayValues}>
                      {(v) => (
                        <text style={{ fg: v == null ? "gray" : "white" }}>
                          {fmtMoney(v).padStart(VALUE_COL_W)}
                        </text>
                      )}
                    </For>
                  </box>
                );
              }
              // kind === "margin"
              const sel    = entry.isSelected;
              const baseFg = sel ? "black" : C_AMBER;
              const baseBg = sel ? C_AMBER : undefined;
              return (
                <box flexDirection="row" height={1}>
                  <text style={{ fg: baseFg, bg: baseBg }}>{entry.label.padEnd(LABEL_COL_W)}</text>
                  <For each={entry.displayValues}>
                    {(v) => (
                      <text style={{ fg: sel ? "black" : v == null ? "gray" : v >= 0 ? "green" : "red", bg: baseBg }}>
                        {fmtPct(v).padStart(VALUE_COL_W)}
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
