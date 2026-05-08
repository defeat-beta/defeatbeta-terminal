/**
 * Overview screen: Bloomberg GP-style price chart via matplotlib + iTerm2.
 * Price line chart is rendered by Python/matplotlib and piped as an iTerm2
 * inline image. Volume panel remains ASCII/braille.
 */

import { createSignal, createEffect, createMemo, onMount, onCleanup, on, For, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions, useRenderer } from "@opentui/solid";
import fsSync from "fs";
import {
  getPrice,
  getInfo,
  getTtmPE,
  getMarketCapitalization,
  renderPriceChart,
  getBeta,
  getCalendar,
  getDividends,
  getSplits,
} from "../bridge/api";

// ─── Bloomberg-style color palette ───────────────────────────────────────────

const C_AMBER    = "#FFA028";   // Bloomberg amber accent

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtNum(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (abs >= 1e9)  return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6)  return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "";
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
}

function fmtMultiple(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "N/A";
  return `${n.toFixed(1)}x`;
}

function updown(val: number | null | undefined): string {
  return (val ?? 0) >= 0 ? "green" : "red";
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface OHLCV {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface KeyboardEventLike {
  sequence?: string;
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
}

interface PriceApiResponse {
  report_date?: string;
  date?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface InfoApiResponse {
  sector?: string;
  industry?: string;
}

interface BetaRow {
  beta?: number | string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PRICE_AXIS_W = 8;

const DAY_OPTIONS  = [30, 90, 180, 365, 1095, 1825, 9999];
const PERIOD_LABELS: Record<number, string> = {
  30: "1M", 90: "3M", 180: "6M", 365: "1Y", 1095: "3Y", 1825: "5Y", 9999: "MAX",
};
// Map calendar-day range to beta API period string; MAX (9999) is excluded.
const BETA_PERIOD: Record<number, string> = {
  30: "1m", 90: "3m", 180: "6m", 365: "1y", 1095: "3y", 1825: "5y",
};


// Extract latest numeric field from a data array returned by the API.
function pick(data: unknown, key: string): number | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const v = (data[data.length - 1] as Record<string, unknown>)[key];
  return typeof v === "number" && isFinite(v) ? v : null;
}

// ─── Overview screen ──────────────────────────────────────────────────────────

interface OverviewProps {
  ticker: string;
  searchMode: boolean;
}

export default function Overview(props: OverviewProps) {
  const renderer = useRenderer();
  // Guard to skip setState after unmount (async chart/beta callbacks)
  const [isUnmounted, setIsUnmounted] = createSignal(false);
  // Holds the latest iTerm2 escape sequence; written to terminal after each renderNative call
  let currentEscSeq = "";
  // Signal bump to trigger a SolidJS reactive update → forces opentui to render a new frame
  const [_imgReady, setImgReady] = createSignal(0);

  const [loading,       setLoading]       = createSignal(true);
  const [error,         setError]         = createSignal("");
  const [progressLines, setProgressLines] = createSignal<string[]>([]);

  const [priceData, setPriceData] = createSignal<OHLCV[]>([]);
  const [days,   setDays]   = createSignal(365);
  const [offset, setOffset] = createSignal(0);

  const [sector,   setSector]   = createSignal("");
  const [industry, setIndustry] = createSignal("");

  const [pe,      setPe]      = createSignal<number | null>(null);
  const [mktCap,  setMktCap]  = createSignal<number | null>(null);
  const [chartRenderErr, setChartRenderErr] = createSignal("");

  const [betaValue,   setBetaValue]   = createSignal<number | null>(null);
  const [betaLoading, setBetaLoading] = createSignal(false);

  // Historical earnings release dates (from ticker.calendar())
  const [earningsDates, setEarningsDates] = createSignal<Array<{ date: string; fqe: string }>>([]);
  // Historical dividend payments (from ticker.dividends())
  const [dividends, setDividends] = createSignal<Array<{ date: string; amount: number }>>([]);
  // Historical stock splits (from ticker.splits())
  const [splits, setSplits] = createSignal<Array<{ date: string; factor: string }>>([]);

  // Mouse hover — terminal column → nearest data point index within chartData
  const [xsCols, setXsCols] = createSignal<number[]>([]);
  const [hoverIdx, setHoverIdx] = createSignal<number | null>(null);

  // Terminal dimensions
  // App chrome: border(2) + tabbar(1) + divider×2(2) + statusbar(1) = 6
  // Overview:   paddingTop(1) + header(1) + periodBar(1) + hoverStrip(1) = 4
  // Total fixed rows: 10
  const dims   = useTerminalDimensions();
  const chartH = createMemo(() => Math.max(6, dims().height - 10));
  // Image width = chartW + PRICE_AXIS_W = dims().width - 4 (full inner width)
  const chartW = createMemo(() => Math.max(20, dims().width - 4 - PRICE_AXIS_W));
  const imgW   = createMemo(() => chartW() + PRICE_AXIS_W);

  // Header price info
  const last   = createMemo(() => { const d = priceData(); return d.length ? d[d.length - 1] : null; });
  const prev   = createMemo(() => { const d = priceData(); return d.length > 1 ? d[d.length - 2] : null; });
  const chg    = createMemo(() => { const l = last(), p = prev(); return l && p ? l.close - p.close : null; });
  const chgPct = createMemo(() => { const l = last(), p = prev(); return l && p ? (l.close - p.close) / p.close : null; });

  // Visible data window — filter by calendar days, not trading-day count
  const chartData = createMemo(() => {
    const data = priceData();
    const off  = offset();
    const d    = days();

    if (!data.length) return [];

    // Apply pan offset (shift end by trading-day count).
    // Guard against negative endIdx when offset exceeds data length.
    const endIdx = Math.max(0, off > 0 ? data.length - off : data.length);
    const sliced = data.slice(0, endIdx);
    if (!sliced.length) return [];

    // MAX: return everything
    if (d === 9999) return sliced;

    // Compute cutoff date = last visible date minus d calendar days.
    // Use UTC arithmetic on the ISO date string to avoid local-timezone drift.
    const lastIso = sliced[sliced.length - 1].date.slice(0, 10);
    const [ly, lm, ld] = lastIso.split("-").map(Number);
    const cutoff = new Date(Date.UTC(ly, lm - 1, ld));
    cutoff.setUTCDate(cutoff.getUTCDate() - d);
    const startStr = cutoff.toISOString().slice(0, 10);

    return sliced.filter(p => p.date >= startStr);
  });

  // Earnings dates within the current chart window
  const visibleEarnings = createMemo(() => {
    const cd = chartData();
    if (!cd.length) return [];
    const from = cd[0].date.slice(0, 10);
    const to   = cd[cd.length - 1].date.slice(0, 10);
    return earningsDates().filter(e => e.date >= from && e.date <= to);
  });

  // Dividend dates within the current chart window
  const visibleDividends = createMemo(() => {
    const cd = chartData();
    if (!cd.length) return [];
    const from = cd[0].date.slice(0, 10);
    const to   = cd[cd.length - 1].date.slice(0, 10);
    return dividends().filter(d => d.date >= from && d.date <= to);
  });

  // Stock splits within the current chart window
  const visibleSplits = createMemo(() => {
    const cd = chartData();
    if (!cd.length) return [];
    const from = cd[0].date.slice(0, 10);
    const to   = cd[cd.length - 1].date.slice(0, 10);
    return splits().filter(s => s.date >= from && s.date <= to);
  });

  // Clear old chart image when a new ticker starts loading.
  // Use `on(loading)` so this only fires when `loading` actually changes,
  // not when imgW/chartH change during a resize.
  createEffect(on(loading, (l) => {
    if (!l) return;
    currentEscSeq = "";
    let clearSeq = "";
    const blankLine = " ".repeat(imgW());
    for (let row = 0; row < chartH(); row++) {
      clearSeq += `\x1b[${CHART_ROW + row};${CHART_COL}H${blankLine}`;
    }
    fsSync.writeSync(1, clearSeq);
  }));

  // Render price chart via Python/matplotlib → iTerm2 inline image.
  // Layout above chart (1-based terminal rows):
  //   row1: app top border
  //   row2: tab bar
  //   row3: divider
  //   row4: info header (Overview paddingTop=1 is consumed here? check below)
  //   row5: ticker header
  //   row6: period bar
  //   row7: chart start  ← try row 7 first; if off by 1 try row 8
  // Col 3: app left border(1) + paddingLeft(1) + content starts col 3
  const CHART_ROW = 7;   // adjust if image appears at wrong vertical position
  const CHART_COL = 3;

  // Generation counter: discard results from superseded renders
  let renderGen = 0;

  createEffect(() => {
    const data = chartData();
    if (!data.length) return;
    const w = imgW();
    const h = chartH();
    const ev = visibleEarnings().map(e => e.date);
    const dv = visibleDividends().map(d => d.date);
    const sp = visibleSplits();
    const gen = ++renderGen;
    setChartRenderErr("");
    renderPriceChart(data, w, h, ev, dv, sp).then((res) => {
      if (gen !== renderGen) return; // stale render, discard
      if (isUnmounted()) return;      // component unmounted, skip setState
      currentEscSeq = `\x1b[${CHART_ROW};${CHART_COL}H${res.image}`;
      setXsCols(res.xs_cols ?? []);
      setImgReady(n => n + 1);
    }).catch((err: unknown) => {
      if (gen !== renderGen) return;
      if (isUnmounted()) return;
      const msg = String(err);
      process.stderr.write(`[renderPriceChart error] ${msg}\n`);
      setChartRenderErr(msg);
    });
  });

  // ── Hover OHLC strip: rendered as a real opentui row below the chart ──
  // Falls back to the latest data point when nothing is hovered.
  const hoverData = createMemo(() => {
    const cd = chartData();
    if (!cd.length) return null;
    const idx = hoverIdx();
    const i = idx != null && idx >= 0 && idx < cd.length ? idx : cd.length - 1;
    const d = cd[i];
    const prev = i > 0 ? cd[i - 1] : null;
    return { d, prev, isHover: idx != null };
  });

  const fmtVol = (v: number) =>
    v >= 1e9 ? `${(v/1e9).toFixed(2)}B` :
    v >= 1e6 ? `${(v/1e6).toFixed(1)}M` :
    v >= 1e3 ? `${(v/1e3).toFixed(0)}K` : String(v);

  const weekdayOf = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  };

  // Write iTerm2 image after opentui finishes rendering.
  // We debounce: schedule a write 50ms after the last renderNative call.
  // This ensures we only write when the renderer is idle, preventing corrupted
  // OSC sequences from rapid frame writes during key events.
  onMount(() => {
    let writeTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleImageWrite = () => {
      if (writeTimer) clearTimeout(writeTimer);
      writeTimer = setTimeout(() => {
        if (currentEscSeq) fsSync.writeSync(1, currentEscSeq);
      }, 50);
    };

    // Patch renderNative to schedule a write after each frame.
    // Guard against stacked patches (HMR / multiple instances): remember
    // our wrapper so cleanup only unwraps if it's still the current one.
    const origRenderNative = (renderer as any).renderNative.bind(renderer);
    const patchedRenderNative = function() {
      origRenderNative();
      scheduleImageWrite();
    };
    (renderer as any).renderNative = patchedRenderNative;

    // Also schedule a write when image first becomes available
    // (renderer may already be idle when renderPriceChart resolves)
    createEffect(() => {
      _imgReady(); // track signal
      scheduleImageWrite();
    });

    onCleanup(() => {
      setIsUnmounted(true);
      if (writeTimer) clearTimeout(writeTimer);
      // Only restore if nobody else has re-patched on top of us.
      if ((renderer as any).renderNative === patchedRenderNative) {
        (renderer as any).renderNative = origRenderNative;
      }
      // Erase the iTerm2 image from the terminal when leaving Overview
      currentEscSeq = "";
      const blankLine = " ".repeat(imgW());
      let clearSeq = "";
      for (let row = 0; row < chartH(); row++) {
        clearSeq += `\x1b[${CHART_ROW + row};${CHART_COL}H${blankLine}`;
      }
      fsSync.writeSync(1, clearSeq);
    });
  });

  // Keyboard navigation
  useKeyboard((key: KeyboardEventLike) => {
    if (props.searchMode) return;
    const seq  = key.sequence ?? "";
    const name = key.name ?? "";
    if (seq === "[" || name === "down") {
      setDays(d => { const i = DAY_OPTIONS.indexOf(d); return i > 0 ? DAY_OPTIONS[i - 1] : d; });
    } else if (seq === "]" || name === "up") {
      setDays(d => { const i = DAY_OPTIONS.indexOf(d); return i < DAY_OPTIONS.length - 1 ? DAY_OPTIONS[i + 1] : d; });
    } else if (name === "left") {
      // Clamp using trading-day count of visible window, not calendar days
      setOffset(o => Math.min(o + 10, Math.max(0, priceData().length - chartData().length - 1)));
    } else if (name === "right") {
      setOffset(o => Math.max(o - 10, 0));
    }
  });

  createEffect(on(() => props.ticker, () => setOffset(0)));

  // Beta fetch — re-runs when ticker or range changes; MAX range is excluded
  let betaGen = 0;
  createEffect(() => {
    const t = props.ticker;
    const d = days();
    const period = BETA_PERIOD[d];
    if (!t || !period) { setBetaValue(null); setBetaLoading(false); return; }
    const gen = ++betaGen;
    setBetaLoading(true);
    setBetaValue(null);
    getBeta(t, period, "SPY")
      .then((rows: unknown) => {
        if (gen !== betaGen) return;
        if (!Array.isArray(rows) || rows.length === 0) { setBetaLoading(false); return; }
        const v = (rows[rows.length - 1] as BetaRow)?.beta;
        const num = typeof v === "string" ? parseFloat(v) : v;
        setBetaValue(typeof num === "number" && isFinite(num) ? num : null);
        setBetaLoading(false);
      })
      .catch(() => {
        if (isUnmounted()) return;
        if (gen === betaGen) { setBetaValue(null); setBetaLoading(false); }
      });
  });

  // Data fetch — generation counter discards stale results on rapid ticker switch.
  let fetchGen = 0;
  createEffect(() => {
    const t = props.ticker;
    if (!t) return;
    const gen = ++fetchGen;
    setLoading(true);
    setError("");
    // Reset per-ticker state so the header doesn't flash stale data from the
    // previous ticker during the loading window.
    setPriceData([]);
    setPe(null);
    setMktCap(null);
    setSector("");
    setIndustry("");
    setEarningsDates([]);
    setDividends([]);
    setSplits([]);
    setXsCols([]);
    setHoverIdx(null);
    setChartRenderErr("");
    const _labels = ["price()", "info()", "ttm_pe()", "market_capitalization()", "calendar()", "dividends()", "splits()"];
    setProgressLines(_labels.map(l => `Fetching ${l}…`));
    const _t0s = _labels.map(() => Date.now());
    const _done = (i: number) => {
      const s = ((Date.now() - _t0s[i]) / 1000).toFixed(1);
      setProgressLines(ls => ls.map((l, j) => j === i ? `✓ ${_labels[i]}  ${s}s` : l));
    };
    Promise.all([
      getPrice(t).then(r => { _done(0); return r; }),
      getInfo(t).then(r => { _done(1); return r; }),
      getTtmPE(t).then(r => { _done(2); return r; }),
      getMarketCapitalization(t).then(r => { _done(3); return r; }),
      getCalendar(t).then(r => { _done(4); return r; }).catch(() => []),
      getDividends(t).then(r => { _done(5); return r; }).catch(() => []),
      getSplits(t).then(r => { _done(6); return r; }).catch(() => []),
    ])
      .then(([priceArr, infoArr, peArr, mktArr, calArr, divArr, splitArr]) => {
        if (gen !== fetchGen || isUnmounted()) return;
        const prices = Array.isArray(priceArr) ? priceArr as PriceApiResponse[] : [];
        setPriceData(prices.map((p) => ({
          date:   p.report_date ?? p.date ?? "",
          open:   p.open, high: p.high, low: p.low, close: p.close,
          volume: p.volume ?? 0,
        })));
        const info = Array.isArray(infoArr) ? infoArr as InfoApiResponse[] : [];
        if (info.length) {
          setSector(info[0].sector ?? "");
          setIndustry(info[0].industry ?? "");
        }
        setPe(     pick(peArr,     "ttm_pe"));
        setMktCap( pick(mktArr,    "market_capitalization"));
        const calRows = Array.isArray(calArr) ? calArr as Array<{ report_date?: string }> : [];
        setEarningsDates(
          calRows
            .map(r => ({
              date: (r.report_date ?? "").slice(0, 10),
              fqe: ((r as Record<string, unknown>).fiscal_quarter_ending as string ?? "").slice(0, 10),
            }))
            .filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e.date))
            .sort((a, b) => a.date.localeCompare(b.date))
        );
        const divRows = Array.isArray(divArr) ? divArr as Array<{ report_date?: string; amount?: number | string }> : [];
        setDividends(
          divRows
            .map(r => ({
              date: (r.report_date ?? "").slice(0, 10),
              amount: typeof r.amount === "string" ? parseFloat(r.amount) : (r.amount ?? NaN),
            }))
            .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && isFinite(d.amount))
            .sort((a, b) => a.date.localeCompare(b.date))
        );
        const splitRows = Array.isArray(splitArr) ? splitArr as Array<{ report_date?: string; split_factor?: string }> : [];
        setSplits(
          splitRows
            .map(r => ({
              date: (r.report_date ?? "").slice(0, 10),
              factor: r.split_factor ?? "",
            }))
            .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s.date) && s.factor)
            .sort((a, b) => a.date.localeCompare(b.date))
        );
        setLoading(false);
      })
      .catch(e => {
        if (gen !== fetchGen || isUnmounted()) return;
        setError(String(e));
        setLoading(false);
      });
  });

  // Live clock — single combined signal to avoid double rerenders
  const [dateTime, setDateTime] = createSignal({ date: "", time: "" });
  onMount(() => {
    const update = () => {
      const now = new Date();
      setDateTime({
        date: now.toISOString().slice(0, 10),
        time: now.toTimeString().slice(0, 8),
      });
    };
    update();
    const clockId = setInterval(update, 1000);
    onCleanup(() => clearInterval(clockId));
  });

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>

      {/* ── Row 1: merged header ── */}
      <box flexDirection="row">
        <text style={{ fg: C_AMBER }}>{`${props.ticker} US EQUITY`}</text>
        <text style={{ fg: "white" }}>{last() ? `  $${last()!.close.toFixed(2)}` : "  $—"}</text>
        <text style={{ fg: updown(chg()) }}>
          {chg() != null
            ? `  ${chg()! >= 0 ? "▲" : "▼"} ${Math.abs(chg()!).toFixed(2)}  ${fmtPct(chgPct())}`
            : "  —"}
        </text>
        <text style={{ fg: "gray" }}>{"  P/E "}</text>
        <text style={{ fg: C_AMBER }}>{pe() != null ? fmtMultiple(pe()) : "—"}</text>
        <text style={{ fg: "gray" }}>{"  MKT CAP "}</text>
        <text style={{ fg: C_AMBER }}>{mktCap() != null ? fmtNum(mktCap()) : "—"}</text>
        <text style={{ fg: "white" }}>{`  ·  ${sector() || "—"}`}</text>
        <text style={{ fg: "white" }}>{`  ·  ${industry() || "—"}`}</text>
        <text style={{ fg: "white" }}>{`  ·  ${dateTime().date}  ${dateTime().time}`}</text>
      </box>

      <Show when={loading()}>
        <text style={{ fg: C_AMBER }}>{`Loading ${props.ticker}…`}</text>
        <For each={progressLines()}>
          {(line) => {
            const done = line.startsWith("✓");
            return <text style={{ fg: done ? "green" : "gray" }}>{`  ${line}`}</text>;
          }}
        </For>
      </Show>
      <Show when={!!error()}>
        <text style={{ fg: "red" }}>{`Error: ${error()}`}</text>
      </Show>

      {!loading() && !error() && chartData().length > 0 && (
        <box flexDirection="column">

          {/* ── Row 3: Period selector + date range ── */}
          <box flexDirection="row">
            <For each={DAY_OPTIONS}>
              {(d) => (
                <text
                  style={{ fg: days() === d ? C_AMBER : "gray" }}
                  marginRight={2}
                >{PERIOD_LABELS[d]}</text>
              )}
            </For>
              {offset() > 0 && (
                <text style={{ fg: "gray" }}>{`  −${offset()}d`}</text>
              )}
              {(() => {
                const cd = chartData();
                const fromIso = cd[0]?.date?.slice(0, 10) ?? "";
                const toIso   = cd[cd.length - 1]?.date?.slice(0, 10) ?? "";
                if (!fromIso || !toIso) return null;
                const fmt = (iso: string) => {
                  const [y, m, d] = iso.split("-");
                  return `${m}/${d}/${y.slice(2)}`;
                };
                return (
                  <>
                    <text style={{ fg: "white" }}>{"  ·  "}</text>
                    <text style={{ fg: C_AMBER }}>{"Range  "}</text>
                    <text style={{ fg: "black", bg: C_AMBER }}>{` ${fmt(fromIso)} `}</text>
                    <text style={{ fg: "gray" }}>{" - "}</text>
                    <text style={{ fg: "black", bg: C_AMBER }}>{` ${fmt(toIso)} `}</text>
                    <text style={{ fg: "white" }}>{"  ·  "}</text>
                    <text style={{ fg: C_AMBER }}>{"Period  "}</text>
                    <text style={{ fg: "black", bg: C_AMBER }}>{" Daily  ▼ "}</text>
                    {days() !== 9999 && BETA_PERIOD[days()] && (
                      <>
                        <text style={{ fg: "white" }}>{"  ·  "}</text>
                        <text style={{ fg: C_AMBER }}>{`beta_${BETA_PERIOD[days()]}  `}</text>
                        <text style={{ fg: "black", bg: betaLoading() ? "gray" : C_AMBER }}>
                          {betaLoading() ? " … " : betaValue() != null ? ` ${betaValue()!.toFixed(2)} ` : " N/A "}
                        </text>
                        <text style={{ fg: "gray" }}>{" (vs SPY)"}</text>
                      </>
                    )}
                  </>
                );
              })()}
            </box>

            {/* ── Chart area: placeholder filled by matplotlib iTerm2 image ── */}
            {/* Subscribe to _imgReady so SolidJS rerenders when the image is ready */}
            <box
              width={imgW()}
              height={chartH()}
              onMouseMove={(e: { x: number; y: number }) => {
                const cols = xsCols();
                if (!cols.length) return;
                const localCol = e.x - CHART_COL;
                // Binary search nearest
                let lo = 0, hi = cols.length - 1;
                while (lo < hi) {
                  const mid = (lo + hi) >> 1;
                  if (cols[mid] < localCol) lo = mid + 1;
                  else hi = mid;
                }
                let idx = lo;
                if (idx > 0 && Math.abs(cols[idx - 1] - localCol) < Math.abs(cols[idx] - localCol)) {
                  idx = idx - 1;
                }
                setHoverIdx(idx);
              }}
              onMouseOut={() => setHoverIdx(null)}
            >
              <Show when={chartRenderErr()}>
                <text style={{ fg: "red" }}>{`Chart render error: ${chartRenderErr()}`}</text>
              </Show>
            </box>

            {/* ── Hover OHLC strip (follows mouse, falls back to latest bar) ── */}
            <Show when={hoverData()}>
              {(() => {
                const hd = hoverData()!;
                const d = hd.d;
                const prev = hd.prev;
                const iso = d.date.slice(0, 10);
                const chg = prev ? d.close - prev.close : 0;
                const chgPct = prev ? chg / prev.close : 0;
                // Match events within ±3 calendar days (event dates may fall on non-trading days)
                const isoMs = new Date(iso + "T00:00:00Z").getTime();
                const RANGE = 3 * 86400000; // 3 days in ms
                const nearest = <T extends { date: string }>(arr: T[]): T | undefined =>
                  arr
                    .filter(x => Math.abs(new Date(x.date + "T00:00:00Z").getTime() - isoMs) <= RANGE)
                    .sort((a, b) =>
                      Math.abs(new Date(a.date + "T00:00:00Z").getTime() - isoMs) -
                      Math.abs(new Date(b.date + "T00:00:00Z").getTime() - isoMs)
                    )[0];
                const evMatch = nearest(earningsDates());
                const div = nearest(dividends());
                const sp = nearest(splits());
                const spLabel = sp ? (() => {
                  const [a, b] = sp.factor.split(":").map(Number);
                  if (!a || !b) return `Split ${sp.factor}`;
                  return a >= b ? `Split ${sp.factor}` : `Reverse Split ${sp.factor}`;
                })() : "";
                const sep = "  │  ";
                return (
                  <box flexDirection="row" height={1}>
                    <text style={{ fg: hd.isHover ? C_AMBER : "gray" }}>{hd.isHover ? "◆ " : "  "}</text>
                    <text style={{ fg: "white" }}>{`${iso} ${weekdayOf(iso)}`}</text>
                    <text style={{ fg: "gray" }}>{sep}</text>
                    <text style={{ fg: "gray" }}>{"Open "}</text><text style={{ fg: "white" }}>{d.open.toFixed(2)}</text>
                    <text style={{ fg: "gray" }}>{"  High "}</text><text style={{ fg: "white" }}>{d.high.toFixed(2)}</text>
                    <text style={{ fg: "gray" }}>{"  Low "}</text><text style={{ fg: "white" }}>{d.low.toFixed(2)}</text>
                    <text style={{ fg: "gray" }}>{"  Close "}</text><text style={{ fg: "white" }}>{d.close.toFixed(2)}</text>
                    <text style={{ fg: updown(chg) }}>
                      {prev ? `  ${chg >= 0 ? "▲" : "▼"} ${Math.abs(chg).toFixed(2)} ${fmtPct(chgPct)}` : ""}
                    </text>
                    <text style={{ fg: "gray" }}>{sep}</text>
                    <text style={{ fg: "gray" }}>{"Vol "}</text><text style={{ fg: "white" }}>{fmtVol(d.volume)}</text>
                    <Show when={evMatch || div || sp}>
                      <text style={{ fg: "gray" }}>{sep}</text>
                      <Show when={evMatch}>
                        <text style={{ fg: "#FF6EC7" }}>{`⚑ Earnings Date${evMatch?.fqe ? ` for ${evMatch.fqe}` : ""}`}</text>
                      </Show>
                      <Show when={evMatch && (div || sp)}>
                        <text style={{ fg: "gray" }}>{"  "}</text>
                      </Show>
                      <Show when={div}>
                        <text style={{ fg: "#00FF87" }}>{`Dividend $${div!.amount.toFixed(2)}`}</text>
                      </Show>
                      <Show when={div && sp}>
                        <text style={{ fg: "gray" }}>{"  "}</text>
                      </Show>
                      <Show when={sp}>
                        <text style={{ fg: "#FFD700" }}>{`⇅ ${spLabel}`}</text>
                      </Show>
                    </Show>
                  </box>
                );
              })()}
            </Show>

        </box>
      )}

    </box>
  );
}
