/**
 * DCF screen — Discounted Cash Flow valuation model.
 *
 * Single scrollable page. ↑/↓ moves the selection between amber-colored cells
 * and the viewport auto-follows. Tab cycles between editable cells (Growth 1-5Y,
 * Discount Rate); Enter to edit. ←/→ moves columns in the projection table.
 * A formula bar at the bottom shows the formula for the selected cell.
 */

import { createSignal, createEffect, createMemo, For, Show, type JSX } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { getDCFData, getInfo } from "../bridge/api";

// ─── Color palette ────────────────────────────────────────────────────────────

const C_AMBER = "#FFA028";
const C_GREEN = "#51A39A";
const C_RED   = "#DD5E56";
const C_LABEL = "#A1A200"; // formula bar: indicator/concept names highlighted in this color

// ─── Layout constants ─────────────────────────────────────────────────────────

const PROJ_LABEL_W = 14;
const PROJ_COL_W   = 13;
const MAX_PROJ_YEARS = 10;
const PROJ_COL_COUNT = MAX_PROJ_YEARS + 1;

// Inputs section is laid out as 5 evenly-distributed columns on wide terminals:
//   DR-Left | DR-Right | GE-Revenue | GE-EPS | GE-Treasury
// Each column has a fixed content width; remaining horizontal space is shared
// equally between gaps via flexGrow={1}.
const COL_DRL_W  = 28;  // 2 indent + 16 label + 10 value
const COL_DRR_W  = 28;  // 2 mark + 16 label + 10 value
const COL_GREV_W = 32;  // header: 18 label + 10 value; detail: 14 label + 9 num + 9 yoy
const COL_GEPS_W = 30;  // detail: 14 label + 7 num + 9 yoy
const COL_GTR_W  = 30;  // header: 22 label + 8 value; detail: 14 label + 8 value

const NARROW_W = 160; // <160 cols → stack DR above GE

// ─── Zone / selection constants ──────────────────────────────────────────────

const ZONE_DR   = 0;
const ZONE_GE   = 1;
const ZONE_TMPL = 2;
const ZONE_PROJ = 3;
const ZONE_VAL  = 4;
// ZONE_TMPL: 4 left-column cells (sr 0-3) + 3 right-column cells (sr 4-6).
//   sr 0 Growth 1-5Y         | sr 4 Revenue Growth 1-5Y
//   sr 1 Growth 6-10Y        | sr 5 Revenue Growth 6-10Y
//   sr 2 Terminal Rate       | sr 6 TTM Revenue
//   sr 3 Discount Rate       | (empty)
const ZONE_ROW_COUNTS = [6, 3, 7, 4, 4];

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  const abs  = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(1)}T`;
  if (abs >= 1e9)  return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6)  return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3)  return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  return `${(n * 100).toFixed(2)}%`;
}

function fmtPctSigned(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(1)}%`;
}

function fmtNum2(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toFixed(2);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface DCFData {
  symbol: string;
  discount_rate: {
    report_date: string; market_cap: number; beta_5y: number;
    total_debt: number; interest_expense: number; pretax_income: number;
    tax_provision: number; risk_free_rate: number; expected_market_return: number;
    weight_of_debt: number; weight_of_equity: number;
    cost_of_debt: number; cost_of_equity: number; tax_rate: number; wacc: number;
  };
  growth_estimates: {
    currency: string;
    revenue: { details: Array<{ date: string; value: number; yoy: number }>; cagr_3y: number | string };
    eps: { details: Array<{ date: string; value: number; yoy: number }>; cagr_10y: number; cagr_years: number };
    treasury: { details: Array<{ year: number; avg_yield: number }>; avg_5y: number };
  };
  dcf_template: {
    growth_rate_1_5y: number; growth_rate_6_10y: number; growth_rate_terminal: number;
    discount_rate: number; ttm_revenue: number; ttm_revenue_label: string;
    ttm_period: string; base_fcf: number; end_date: string;
    revenue_growth_1_5y: number; revenue_growth_6_10y: number;
    projections: Array<{
      year: number; date: string; fcf: number;
      terminal_value: number; total_value: number; fcf_margin: number;
    }>;
    historical_fcf_margin: Array<{ date: string; margin: number }>;
  };
  dcf_value: {
    report_date: string; enterprise_value: number; cash: number; total_debt: number;
    equity_value: number; shares_outstanding: number; fair_price: number;
    current_price: number; margin_of_safety: number; recommendation: string;
  };
}

// ─── Recalculation engine (mirrors Excel formulas) ────────────────────────────

interface RecalcResult {
  growth_6_10y: number;
  projections: Array<{
    year: number; date: string; fcf: number; revenue: number;
    terminal_value: number; total_value: number; fcf_margin: number;
  }>;
  enterprise_value: number; equity_value: number; fair_price: number;
  margin_of_safety: number; recommendation: string;
}

function recalc(data: DCFData, growth15y: number, discountRate: number): RecalcResult {
  const terminal = data.dcf_template.growth_rate_terminal;
  const baseFcf  = data.dcf_template.base_fcf;
  const ttmRev   = data.dcf_template.ttm_revenue;
  const revGrowth15y = data.dcf_template.revenue_growth_1_5y;

  const growth_year6 = growth15y - (growth15y - terminal) / 5;
  const projections: RecalcResult["projections"] = [];
  const origProj = data.dcf_template.projections;

  const fcfMargin0 = ttmRev !== 0 ? baseFcf / ttmRev : 0;
  projections.push({
    year: 0, date: origProj[0]?.date ?? "", fcf: baseFcf, revenue: ttmRev,
    terminal_value: 0, total_value: baseFcf, fcf_margin: fcfMargin0,
  });

  let prevFcf = baseFcf;
  let prevRev = ttmRev;
  for (let i = 1; i <= 10; i++) {
    const rate = i <= 5 ? growth15y : growth15y - (i - 5) * (growth15y - terminal) / 5;
    const revRate = i <= 5 ? revGrowth15y : revGrowth15y - (i - 5) * (revGrowth15y - terminal) / 5;
    const fcf = prevFcf * (1 + rate);
    const rev = prevRev * (1 + revRate);
    let tv = 0;
    if (i === 10) {
      const denom = discountRate - terminal;
      tv = denom !== 0 ? fcf * (1 + terminal) / denom : 0;
    }
    projections.push({
      year: i, date: origProj[i]?.date ?? `Year ${i}`,
      fcf, revenue: rev, terminal_value: tv, total_value: fcf + tv,
      fcf_margin: rev !== 0 ? fcf / rev : 0,
    });
    prevFcf = fcf;
    prevRev = rev;
  }

  const ev = projections.slice(1).reduce(
    (sum, p, idx) => sum + p.total_value / Math.pow(1 + discountRate, idx + 1), 0
  );
  const cash = data.dcf_value.cash;
  const debt = data.dcf_value.total_debt;
  const shares = data.dcf_value.shares_outstanding;
  const equityValue = ev + cash - debt;
  const fairPrice = shares > 0 ? equityValue / shares : 0;
  const currentPrice = data.dcf_value.current_price;
  const mos = fairPrice !== 0 ? (fairPrice - currentPrice) / fairPrice : 0;

  return {
    growth_6_10y: growth_year6, projections, enterprise_value: ev,
    equity_value: equityValue, fair_price: fairPrice,
    margin_of_safety: mos, recommendation: fairPrice > currentPrice ? "Buy" : "Sell",
  };
}

// ─── Formula parsing ─────────────────────────────────────────────────────────
// Indicator/concept names inside formula text are wrapped with `{...}` so the
// formula bar can render them in C_LABEL while the rest stays in C_AMBER.

interface FormulaSegment { text: string; isLabel: boolean; }

function parseFormula(s: string): FormulaSegment[] {
  const out: FormulaSegment[] = [];
  const re = /\{([^}]+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), isLabel: false });
    out.push({ text: m[1], isLabel: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), isLabel: false });
  return out;
}

// ─── Formula text generation ─────────────────────────────────────────────────

function getFormulaText(
  zone: number, row: number, col: number,
  data: DCFData, computed: RecalcResult,
  effGrowth: number, effDiscount: number,
  overrideGrowth: number | null, overrideDiscount: number | null,
): string {
  if (zone === ZONE_DR) {
    const dr = data.discount_rate;
    switch (row) {
      case 0: return `{Weight of Debt} = {Total Debt} / ({Market Cap} + {Total Debt}) = ${fmtMoney(dr.total_debt)} / (${fmtMoney(dr.market_cap)} + ${fmtMoney(dr.total_debt)}) = ${fmtPct(dr.weight_of_debt)}`;
      case 1: return `{Weight of Equity} = {Market Cap} / ({Market Cap} + {Total Debt}) = ${fmtMoney(dr.market_cap)} / (${fmtMoney(dr.market_cap)} + ${fmtMoney(dr.total_debt)}) = ${fmtPct(dr.weight_of_equity)}`;
      case 2: return `{Cost of Debt} = {Interest Expense} / {Total Debt} = ${fmtMoney(dr.interest_expense)} / ${fmtMoney(dr.total_debt)} = ${fmtPct(dr.cost_of_debt)}`;
      case 3: return `{Cost of Equity} = {Risk-Free} + {Beta} × ({Market Return} − {Risk-Free}) = ${fmtPct(dr.risk_free_rate)} + ${fmtNum2(dr.beta_5y)} × (${fmtPct(dr.expected_market_return)} − ${fmtPct(dr.risk_free_rate)}) = ${fmtPct(dr.cost_of_equity)}`;
      case 4: return `{Tax Rate} = {Tax Provision} / {Pre-Tax Income} = ${fmtMoney(dr.tax_provision)} / ${fmtMoney(dr.pretax_income)} = ${fmtPct(dr.tax_rate)}`;
      case 5: return `{WACC} = {Weight of Debt} × {Cost of Debt} × (1 − {Tax Rate}) + {Weight of Equity} × {Cost of Equity} = ${fmtPct(dr.weight_of_debt)} × ${fmtPct(dr.cost_of_debt)} × (1 − ${fmtPct(dr.tax_rate)}) + ${fmtPct(dr.weight_of_equity)} × ${fmtPct(dr.cost_of_equity)} = ${fmtPct(dr.wacc)}`;
    }
  } else if (zone === ZONE_GE) {
    const ge = data.growth_estimates;
    switch (row) {
      case 0: {
        const rev = ge.revenue.details;
        const cagrVal = typeof ge.revenue.cagr_3y === "number" ? fmtPct(ge.revenue.cagr_3y as number) : String(ge.revenue.cagr_3y);
        if (rev.length >= 2) {
          const oldest = rev[0], newest = rev[rev.length - 1];
          return `{Revenue 3Y CAGR} = ({latest} / {earliest})^(1/3) − 1 = (${fmtMoney(newest.value)} / ${fmtMoney(oldest.value)})^(1/3) − 1 = ${cagrVal}`;
        }
        return `{Revenue 3Y CAGR} = ${cagrVal}`;
      }
      case 1: {
        const eps = ge.eps;
        const d = eps.details;
        if (d.length >= 2) {
          return `{EPS ${eps.cagr_years}Y CAGR} = ({latest} / {earliest})^(1/${eps.cagr_years}) − 1 = (${fmtNum2(d[d.length - 1].value)} / ${fmtNum2(d[0].value)})^(1/${eps.cagr_years}) − 1 = ${fmtPct(eps.cagr_10y)}`;
        }
        return `{EPS CAGR} = ${fmtPct(eps.cagr_10y)}`;
      }
      case 2: {
        const tr = ge.treasury;
        const years = tr.details.map(d => d.year).join(", ");
        return `{5Y Treasury Average} = mean of {yields} [${years}] = ${fmtPct(tr.avg_5y)}`;
      }
    }
  } else if (zone === ZONE_TMPL) {
    const dt = data.dcf_template;
    switch (row) {
      case 0:
        if (overrideGrowth !== null) {
          return `{Growth 1-5Y} = {manual override} = ${fmtPct(effGrowth)}  [editable]`;
        }
        return `{Growth 1-5Y} = {EPS CAGR} clamped to [5%, 20%] = ${fmtPct(effGrowth)}  [editable]`;
      case 1:
        return `{Growth 6-10Y} = {Growth 1-5Y} − ({Growth 1-5Y} − {Terminal Rate}) / 5 = ${fmtPct(effGrowth)} − (${fmtPct(effGrowth)} − ${fmtPct(dt.growth_rate_terminal)}) / 5 = ${fmtPct(computed.growth_6_10y)}    (linear taper of FCF growth toward terminal)`;
      case 2:
        return `{Terminal Rate} = {5Y Treasury Average} = ${fmtPct(dt.growth_rate_terminal)}    (long-run perpetual growth rate)`;
      case 3:
        if (overrideDiscount !== null) {
          return `{Discount Rate} = {manual override} = ${fmtPct(effDiscount)}  [editable]`;
        }
        return `{Discount Rate} = {WACC} = ${fmtPct(effDiscount)}  [editable]`;
      case 4:
        return `{Revenue Growth 1-5Y} = {Revenue 3Y CAGR} clamped to [5%, 20%] = ${fmtPct(dt.revenue_growth_1_5y)}    (used to project revenue for {FCF Margin})`;
      case 5:
        return `{Revenue Growth 6-10Y} = {Revenue Growth 1-5Y} − ({Revenue Growth 1-5Y} − {Terminal Rate}) / 5 = ${fmtPct(dt.revenue_growth_1_5y)} − (${fmtPct(dt.revenue_growth_1_5y)} − ${fmtPct(dt.growth_rate_terminal)}) / 5 = ${fmtPct(dt.revenue_growth_6_10y)}    (linear taper of revenue growth)`;
      case 6:
        return `{TTM Revenue} = trailing 12-month {Revenue} from {Income Statement} = ${fmtMoney(dt.ttm_revenue)}    (base for projected revenue)`;
    }
  } else if (zone === ZONE_PROJ) {
    const p = computed.projections[col];
    if (!p) return "";
    const terminal = data.dcf_template.growth_rate_terminal;
    if (col === 0) {
      switch (row) {
        case 0: return `{FCF} (TTM) = base {Free Cash Flow} from financial statements = ${fmtMoney(p.fcf)}`;
        case 1: return `{Terminal Value} (TTM) = N/A    (terminal value is only computed in {Year 10})`;
        case 2: return `{Total Value} (TTM) = {FCF} + {Terminal Value} = ${fmtMoney(p.fcf)} + 0 = ${fmtMoney(p.total_value)}`;
        case 3: return `{FCF Margin} (TTM) = {FCF} / {TTM Revenue} = ${fmtMoney(p.fcf)} / ${fmtMoney(p.revenue)} = ${fmtPct(p.fcf_margin)}`;
      }
    } else {
      const prev = computed.projections[col - 1];
      const rate = col <= 5 ? effGrowth : effGrowth - (col - 5) * (effGrowth - terminal) / 5;
      const revRate = col <= 5
        ? data.dcf_template.revenue_growth_1_5y
        : data.dcf_template.revenue_growth_1_5y - (col - 5) * (data.dcf_template.revenue_growth_1_5y - terminal) / 5;
      switch (row) {
        case 0: return `{FCF}(${p.date}) = {FCF}(prev) × (1 + {Growth Rate}) = ${fmtMoney(prev.fcf)} × (1 + ${fmtPct(rate)}) = ${fmtMoney(p.fcf)}`;
        case 1:
          if (col < 10) return `{Terminal Value}(${p.date}) = 0    (terminal value is only computed in {Year 10})`;
          return `{Terminal Value} = {FCF} × (1 + {Terminal Rate}) / ({Discount Rate} − {Terminal Rate}) = ${fmtMoney(p.fcf)} × (1 + ${fmtPct(terminal)}) / (${fmtPct(effDiscount)} − ${fmtPct(terminal)}) = ${fmtMoney(p.terminal_value)}`;
        case 2: return `{Total Value}(${p.date}) = {FCF} + {Terminal Value} = ${fmtMoney(p.fcf)} + ${fmtMoney(p.terminal_value)} = ${fmtMoney(p.total_value)}`;
        case 3: return `{FCF Margin}(${p.date}) = {FCF} / {Projected Revenue} = ${fmtMoney(p.fcf)} / ${fmtMoney(p.revenue)} = ${fmtPct(p.fcf_margin)}    ({Revenue} grew at ${fmtPct(revRate)})`;
      }
    }
  } else if (zone === ZONE_VAL) {
    const dv = data.dcf_value;
    switch (row) {
      case 0: return `{Enterprise Value} = Σ {Total Value}_i / (1 + {Discount Rate})^i  for i=1..10 = ${fmtMoney(computed.enterprise_value)}    (sum of present-valued projected {Total Values})`;
      case 1: return `{Equity Value} = {Enterprise Value} + {Cash} − {Total Debt} = ${fmtMoney(computed.enterprise_value)} + ${fmtMoney(dv.cash)} − ${fmtMoney(dv.total_debt)} = ${fmtMoney(computed.equity_value)}`;
      case 2: return `{Fair Price} = {Equity Value} / {Shares Outstanding} = ${fmtMoney(computed.equity_value)} / ${fmtMoney(dv.shares_outstanding)} = ${fmtNum2(computed.fair_price)}`;
      case 3: return `{Margin of Safety} = ({Fair Price} − {Current Price}) / {Fair Price} = (${fmtNum2(computed.fair_price)} − ${fmtNum2(dv.current_price)}) / ${fmtNum2(computed.fair_price)} = ${fmtPct(computed.margin_of_safety)}`;
    }
  }
  return "";
}

// ─── Line builders ────────────────────────────────────────────────────────────
// Each builder returns a flat list of single-line JSX rows. The main component
// concatenates them into one virtualized list and slices by scrollOffset.

const blankLine = (): JSX.Element => <box height={1}><text>{""}</text></box>;

// ─── Highlight dependencies ──────────────────────────────────────────────────
// Returns a set of "input keys" (labels or pseudo-keys with @ prefix) that the
// formula at (zone, row) consumes. Each input row in the screen checks if its
// label is in this set and colors itself C_LABEL when it is.

function getHighlightDeps(
  zone: number,
  row: number,
  ge: DCFData["growth_estimates"],
): Set<string> {
  const s = new Set<string>();
  const epsHeader = ge.eps.cagr_years > 0 ? `EPS ${ge.eps.cagr_years}Y CAGR` : "EPS CAGR";
  if (zone === ZONE_DR) {
    switch (row) {
      case 0: s.add("Total Debt"); s.add("Market Cap"); break;
      case 1: s.add("Market Cap"); s.add("Total Debt"); break;
      case 2: s.add("Interest Expense"); s.add("Total Debt"); break;
      case 3: s.add("Risk-Free (5Y)"); s.add("Beta (5Y)"); s.add("Market Return"); break;
      case 4: s.add("Tax Provision"); s.add("Pre-Tax Income"); break;
      case 5: s.add("Weight of Debt"); s.add("Weight of Equity"); s.add("Cost of Debt"); s.add("Cost of Equity"); s.add("Tax Rate"); break;
    }
  } else if (zone === ZONE_GE) {
    if (row === 0) s.add("@geRevDetails");
    else if (row === 1) s.add("@geEpsDetails");
    else if (row === 2) s.add("@geTrDetails");
  } else if (zone === ZONE_TMPL) {
    switch (row) {
      case 0: s.add(epsHeader); break;
      case 1: s.add("Growth 1-5Y"); s.add("Terminal Rate"); break;
      case 2: s.add("5Y Treasury Average"); break;
      case 3: s.add("WACC"); break;
      case 4: s.add("Revenue 3Y CAGR"); break;
      case 5: s.add("Revenue Growth 1-5Y"); s.add("Terminal Rate"); break;
      // case 6 (TTM Revenue): no upstream input
    }
  } else if (zone === ZONE_PROJ) {
    switch (row) {
      case 0: s.add("Growth 1-5Y"); s.add("Terminal Rate"); s.add("@projFcf"); break;
      case 1: s.add("@projFcf"); s.add("Discount Rate"); s.add("Terminal Rate"); break;
      case 2: s.add("@projFcf"); s.add("@projTerminalValue"); break;
      case 3: s.add("@projFcf"); s.add("Revenue Growth 1-5Y"); s.add("TTM Revenue"); break;
    }
  } else if (zone === ZONE_VAL) {
    switch (row) {
      case 0: s.add("@projTotalValue"); s.add("Discount Rate"); break;
      case 1: s.add("Enterprise Value"); break;
      case 2: s.add("Equity Value"); break;
      case 3: s.add("Fair Price"); break;
    }
  }
  return s;
}

// ─── Inputs section: 5 split column builders ─────────────────────────────────
// Each builder returns its own column's lines as a flat JSX[]. The composer
// places them side-by-side on wide terminals, or stacks them on narrow.

function buildDRLeftLines(dr: DCFData["discount_rate"], hl: Set<string>): JSX.Element[] {
  const W_LBL = 16;
  const W_VAL = 10;
  const rows: Array<[string, string]> = [
    ["Market Cap",       fmtMoney(dr.market_cap)],
    ["Beta (5Y)",        fmtNum2(dr.beta_5y)],
    ["Total Debt",       fmtMoney(dr.total_debt)],
    ["Interest Expense", fmtMoney(dr.interest_expense)],
    ["Pre-Tax Income",   fmtMoney(dr.pretax_income)],
    ["Tax Provision",    fmtMoney(dr.tax_provision)],
    ["Risk-Free (5Y)",   fmtPct(dr.risk_free_rate)],
    ["Market Return",    fmtPct(dr.expected_market_return)],
  ];
  const lines: JSX.Element[] = [
    <box height={1}><text style={{ fg: C_AMBER }}>Discount Rate</text></box>,
  ];
  for (const [lbl, val] of rows) {
    const isHl = hl.has(lbl);
    lines.push(
      <box height={1}>
        <text style={{ fg: isHl ? C_LABEL : undefined }}>
          {`  ${lbl.padEnd(W_LBL)}${val.padStart(W_VAL)}`}
        </text>
      </box>
    );
  }
  return lines;
}

function buildDRRightLines(
  dr: DCFData["discount_rate"],
  selZone: number,
  selRow: number,
  hl: Set<string>,
): JSX.Element[] {
  const W_LBL = 16;
  const W_VAL = 10;
  type Row = { sr: number; lbl: string; val: string } | null;
  // Aligned with DR-Left rows: 5 selectable, then blank (Tax Provision), WACC, blank (Market Return).
  const rows: Row[] = [
    { sr: 0, lbl: "Weight of Debt",   val: fmtPct(dr.weight_of_debt) },
    { sr: 1, lbl: "Weight of Equity", val: fmtPct(dr.weight_of_equity) },
    { sr: 2, lbl: "Cost of Debt",     val: fmtPct(dr.cost_of_debt) },
    { sr: 3, lbl: "Cost of Equity",   val: fmtPct(dr.cost_of_equity) },
    { sr: 4, lbl: "Tax Rate",         val: fmtPct(dr.tax_rate) },
    null,
    { sr: 5, lbl: "WACC",             val: fmtPct(dr.wacc) },
    null,
  ];
  const lines: JSX.Element[] = [blankLine()];
  for (const r of rows) {
    if (r === null) {
      lines.push(blankLine());
    } else {
      const isSel = selZone === ZONE_DR && selRow === r.sr;
      const isHl  = !isSel && hl.has(r.lbl);
      const mark  = isSel ? "► " : "  ";
      lines.push(
        <box height={1}>
          <text style={{ fg: isHl ? C_LABEL : C_AMBER }}>{`${mark}${r.lbl.padEnd(W_LBL - 2)}${r.val.padStart(W_VAL)}`}</text>
        </box>
      );
    }
  }
  return lines;
}

function buildGERevLines(
  ge: DCFData["growth_estimates"],
  selZone: number,
  selRow: number,
  hl: Set<string>,
): JSX.Element[] {
  const W_HDR_LBL = 22;
  const W_HDR_VAL = 10;
  const W_DET_LBL = 14;
  const W_DET_NUM = 9;
  const W_DET_PCT = 9;
  const cagrVal = typeof ge.revenue.cagr_3y === "number"
    ? fmtPct(ge.revenue.cagr_3y as number) : String(ge.revenue.cagr_3y);
  const isSel = selZone === ZONE_GE && selRow === 0;
  const isHdrHl = !isSel && hl.has("Revenue 3Y CAGR");
  const isDetHl = hl.has("@geRevDetails");
  const mark = isSel ? "► " : "  ";
  const lines: JSX.Element[] = [
    <box height={1}><text style={{ fg: C_AMBER }}>Growth Estimates</text></box>,
    <box height={1}>
      <text style={{ fg: isHdrHl ? C_LABEL : C_AMBER }}>{`${mark}Revenue 3Y CAGR`.padEnd(W_HDR_LBL) + cagrVal.padStart(W_HDR_VAL)}</text>
    </box>,
  ];
  for (const r of ge.revenue.details) {
    lines.push(
      <box height={1}>
        <text style={{ fg: isDetHl ? C_LABEL : undefined }}>{`  Revenue ${r.date.slice(0, 4)}`.padEnd(W_DET_LBL) + fmtMoney(r.value).padStart(W_DET_NUM) + fmtPctSigned(r.yoy).padStart(W_DET_PCT)}</text>
      </box>
    );
  }
  return lines;
}

function buildGEEpsLines(
  ge: DCFData["growth_estimates"],
  selZone: number,
  selRow: number,
  hl: Set<string>,
): JSX.Element[] {
  const W_HDR_LBL = 20;
  const W_HDR_VAL = 10;
  const W_DET_LBL = 14;
  const W_DET_NUM = 7;
  const W_DET_PCT = 9;
  const epsLabel = ge.eps.cagr_years > 0 ? `EPS ${ge.eps.cagr_years}Y CAGR` : "EPS CAGR";
  const isSel = selZone === ZONE_GE && selRow === 1;
  const isHdrHl = !isSel && hl.has(epsLabel);
  const isDetHl = hl.has("@geEpsDetails");
  const mark = isSel ? "► " : "  ";
  const lines: JSX.Element[] = [
    blankLine(),
    <box height={1}>
      <text style={{ fg: isHdrHl ? C_LABEL : C_AMBER }}>{`${mark}${epsLabel}`.padEnd(W_HDR_LBL) + fmtPct(ge.eps.cagr_10y).padStart(W_HDR_VAL)}</text>
    </box>,
  ];
  for (const e of ge.eps.details) {
    lines.push(
      <box height={1}>
        <text style={{ fg: isDetHl ? C_LABEL : undefined }}>{`  EPS ${e.date.slice(0, 4)}`.padEnd(W_DET_LBL) + fmtNum2(e.value).padStart(W_DET_NUM) + fmtPctSigned(e.yoy).padStart(W_DET_PCT)}</text>
      </box>
    );
  }
  return lines;
}

function buildGETrLines(
  ge: DCFData["growth_estimates"],
  selZone: number,
  selRow: number,
  hl: Set<string>,
): JSX.Element[] {
  const W_HDR_LBL = 22;
  const W_HDR_VAL = 8;
  const W_DET_LBL = 14;
  const W_DET_VAL = 8;
  const isSel = selZone === ZONE_GE && selRow === 2;
  const isHdrHl = !isSel && hl.has("5Y Treasury Average");
  const isDetHl = hl.has("@geTrDetails");
  const mark = isSel ? "► " : "  ";
  const lines: JSX.Element[] = [
    blankLine(),
    <box height={1}>
      <text style={{ fg: isHdrHl ? C_LABEL : C_AMBER }}>{`${mark}5Y Treasury Average`.padEnd(W_HDR_LBL) + fmtPct(ge.treasury.avg_5y).padStart(W_HDR_VAL)}</text>
    </box>,
  ];
  for (const t of ge.treasury.details) {
    lines.push(
      <box height={1}>
        <text style={{ fg: isDetHl ? C_LABEL : undefined }}>{`  ${String(t.year)}`.padEnd(W_DET_LBL) + fmtPct(t.avg_yield).padStart(W_DET_VAL)}</text>
      </box>
    );
  }
  return lines;
}

interface TmplBuildOpts {
  dt: DCFData["dcf_template"];
  computed: RecalcResult;
  effectiveGrowth: number;
  effectiveDiscount: number;
  overrideGrowth: number | null;
  overrideDiscount: number | null;
  selZone: number;
  selRow: number;
  selCol: number;
  editing: boolean;
  editBuffer: string;
  colOffset: number;
  numProjCols: number;
  maxColOffset: number;
  hl: Set<string>;
}

function buildTMPLLines(o: TmplBuildOpts): JSX.Element[] {
  const TMPL_LBL_W = 22;
  const TMPL_VAL_W = 14;
  const TMPL_GAP   = 4;

  const isZ = o.selZone === ZONE_TMPL;
  const mark = (idx: number) => isZ && o.selRow === idx ? "►" : " ";

  type TmplRowDef = {
    leftSr: number; leftLabel: string; leftValue: string; leftFg: string;
    rightSr: number; rightLabel?: string; rightValue?: string;
  };
  // Color: override (cyan) > highlighted dependency (C_LABEL) > default (C_AMBER).
  const colorFor = (label: string, sr: number, override: boolean): string => {
    if (override) return "cyan";
    const isSel = isZ && o.selRow === sr;
    if (!isSel && o.hl.has(label)) return C_LABEL;
    return C_AMBER;
  };

  const tmplRows: TmplRowDef[] = [
    {
      leftSr: 0,
      leftLabel: "Growth 1-5Y",
      leftValue: isZ && o.selRow === 0 && o.editing
        ? `[${o.editBuffer}_]` : `[${fmtPct(o.effectiveGrowth)}]`,
      leftFg: colorFor("Growth 1-5Y", 0, o.overrideGrowth !== null),
      rightSr: 4,
      rightLabel: "Revenue Growth 1-5Y",
      rightValue: fmtPct(o.dt.revenue_growth_1_5y),
    },
    {
      leftSr: 1,
      leftLabel: "Growth 6-10Y",
      leftValue: fmtPct(o.computed.growth_6_10y),
      leftFg: colorFor("Growth 6-10Y", 1, false),
      rightSr: 5,
      rightLabel: "Revenue Growth 6-10Y",
      rightValue: fmtPct(o.dt.revenue_growth_6_10y),
    },
    {
      leftSr: 2,
      leftLabel: "Terminal Rate",
      leftValue: fmtPct(o.dt.growth_rate_terminal),
      leftFg: colorFor("Terminal Rate", 2, false),
      rightSr: 6,
      rightLabel: "TTM Revenue",
      rightValue: fmtMoney(o.dt.ttm_revenue),
    },
    {
      leftSr: 3,
      leftLabel: "Discount Rate",
      leftValue: isZ && o.selRow === 3 && o.editing
        ? `[${o.editBuffer}_]` : `[${fmtPct(o.effectiveDiscount)}]`,
      leftFg: colorFor("Discount Rate", 3, o.overrideDiscount !== null),
      rightSr: -1,
    },
  ];

  const visProj = o.computed.projections.slice(o.colOffset, o.colOffset + o.numProjCols);

  const projRowDefs = [
    { name: "FCF (USD)",      ridx: 0, getVal: (p: RecalcResult["projections"][0]) => fmtMoney(p.fcf) },
    { name: "Terminal Value", ridx: 1, getVal: (p: RecalcResult["projections"][0]) => p.terminal_value === 0 ? "0" : fmtMoney(p.terminal_value) },
    { name: "Total Value",    ridx: 2, getVal: (p: RecalcResult["projections"][0]) => fmtMoney(p.total_value) },
    { name: "FCF Margin",     ridx: 3, getVal: (p: RecalcResult["projections"][0]) => fmtPct(p.fcf_margin) },
  ];

  const isZP = o.selZone === ZONE_PROJ;

  const lines: JSX.Element[] = [];

  // Title
  lines.push(
    <box height={1}>
      <text style={{ fg: C_AMBER }}>
        {`DCF Template${o.maxColOffset > 0 ? "  ← → scroll years" : ""}`}
      </text>
    </box>
  );

  // Historical FCF Margin is rendered inline as a third block on rows 0-2:
  //   row 0: header "Historical FCF Margin"
  //   row 1: year labels  (e.g., 2021  2022  2023  2024  2025)
  //   row 2: margin values
  //   row 3: nothing
  const histMarginInline = o.dt.historical_fcf_margin;
  const HIST_COL_W = 10;
  const HIST_GAP   = 4;

  // 4 template params (left column 4 cells + right column 3 cells, aligned per row),
  // with optional Historical FCF Margin sub-table tucked into the empty space at right.
  for (let idx = 0; idx < tmplRows.length; idx++) {
    const row = tmplRows[idx];
    const leftL1 = `${mark(row.leftSr)} ${row.leftLabel}`;
    const showHist = histMarginInline.length > 0 && idx < 3;

    lines.push(
      <box flexDirection="row" height={1}>
        <box width={TMPL_LBL_W + TMPL_VAL_W + 2}>
          <text style={{ fg: row.leftFg }}>
            {`  ${leftL1.padEnd(TMPL_LBL_W)}${row.leftValue.padStart(TMPL_VAL_W)}`}
          </text>
        </box>
        <Show when={row.rightSr >= 0}>
          <box width={TMPL_GAP}><text>{" ".repeat(TMPL_GAP)}</text></box>
          <box width={TMPL_LBL_W + TMPL_VAL_W}>
            <text style={{ fg: colorFor(row.rightLabel ?? "", row.rightSr, false) }}>
              {`${mark(row.rightSr)} ${row.rightLabel ?? ""}`.padEnd(TMPL_LBL_W) + (row.rightValue ?? "").padStart(TMPL_VAL_W)}
            </text>
          </box>
        </Show>
        <Show when={showHist}>
          <box width={HIST_GAP}><text>{" ".repeat(HIST_GAP)}</text></box>
          <Show when={idx === 0}>
            <text style={{ fg: "white" }}>{"Historical FCF Margin"}</text>
          </Show>
          <Show when={idx === 1}>
            <box flexDirection="row">
              <For each={histMarginInline}>
                {(h) => <box width={HIST_COL_W}><text style={{ fg: "white" }}>{h.date.slice(0, 4).padStart(HIST_COL_W)}</text></box>}
              </For>
            </box>
          </Show>
          <Show when={idx === 2}>
            <box flexDirection="row">
              <For each={histMarginInline}>
                {(h) => <box width={HIST_COL_W}><text style={{ fg: "white" }}>{fmtPct(h.margin).padStart(HIST_COL_W)}</text></box>}
              </For>
            </box>
          </Show>
        </Show>
      </box>
    );
  }

  // Blank
  lines.push(blankLine());

  // Projection table header
  lines.push(
    <box flexDirection="row" height={1}>
      <box width={PROJ_LABEL_W}><text style={{ fg: C_AMBER }}>{"  Year".padEnd(PROJ_LABEL_W)}</text></box>
      <For each={visProj}>
        {(p) => (
          <box width={PROJ_COL_W}>
            <text style={{ fg: C_AMBER }}>{(p.year === 0 ? "TTM" : p.date).padStart(PROJ_COL_W)}</text>
          </box>
        )}
      </For>
    </box>
  );

  // 4 data rows. Each row may also be highlighted (whole row in C_LABEL) when
  // this row is an upstream input of the currently-selected formula in a
  // different zone (e.g., Total Value row is an input to Enterprise Value).
  const projHlKeys = ["@projFcf", "@projTerminalValue", "@projTotalValue", "@projFcfMargin"];
  for (const def of projRowDefs) {
    const rowHl = o.hl.has(projHlKeys[def.ridx]);
    lines.push(
      <box flexDirection="row" height={1}>
        <box width={PROJ_LABEL_W}>
          <text style={{ fg: rowHl ? C_LABEL : C_AMBER }}>{`  ${def.name}`.padEnd(PROJ_LABEL_W)}</text>
        </box>
        <For each={visProj}>
          {(p, pIdx) => {
            const absCol = () => o.colOffset + pIdx();
            const isSel = () => isZP && o.selRow === def.ridx && absCol() === o.selCol;
            const cellFg = () => isSel() ? "black" : (rowHl ? C_LABEL : C_AMBER);
            return (
              <box width={PROJ_COL_W}>
                <text style={{ fg: cellFg(), bg: isSel() ? C_AMBER : undefined }}>
                  {def.getVal(p).padStart(PROJ_COL_W)}
                </text>
              </box>
            );
          }}
        </For>
      </box>
    );
  }

  return lines;
}

interface ValBuildOpts {
  dv: DCFData["dcf_value"];
  computed: RecalcResult;
  selZone: number;
  selRow: number;
  hl: Set<string>;
}

function buildVALLines(o: ValBuildOpts): JSX.Element[] {
  const c = o.computed;
  const dv = o.dv;
  const VAL_LBL_W = 20;
  const VAL_NUM_W = 14;
  const isSel = (row: number) => o.selZone === ZONE_VAL && o.selRow === row;
  const mark = (row: number) => isSel(row) ? "►" : " ";

  const valRowSel = (label: string, value: string, selIdx: number) =>
    `${mark(selIdx)} ${label.padEnd(VAL_LBL_W)}${value.padStart(VAL_NUM_W)}`;
  const valRowPlain = (label: string, value: string) =>
    `  ${label.padEnd(VAL_LBL_W)}${value.padStart(VAL_NUM_W)}`;

  // Color resolver: highlighted (input to selected formula) → C_LABEL,
  // selected formula cell → C_AMBER (with ► marker), plain rows → undefined.
  const fgFor = (label: string, sr: number, defaultColor: string | undefined): string | undefined => {
    if (sr >= 0 && isSel(sr)) return C_AMBER;
    if (o.hl.has(label)) return C_LABEL;
    return defaultColor;
  };

  const fpColor = c.recommendation === "Buy" ? C_GREEN : C_RED;

  const BOTTOM_LBL_W = 16;
  const BOTTOM_VAL_W = 10;
  const BOTTOM_GAP   = 6;

  const lines: JSX.Element[] = [];
  lines.push(<box height={1}><text style={{ fg: C_AMBER }}>DCF Value</text></box>);
  lines.push(<box height={1}><text style={{ fg: fgFor("Enterprise Value", 0, C_AMBER) }}>{valRowSel("Enterprise Value", fmtMoney(c.enterprise_value), 0)}</text></box>);
  lines.push(<box height={1}><text style={{ fg: fgFor("Cash", -1, undefined) }}>{valRowPlain("+ Cash", fmtMoney(dv.cash))}</text></box>);
  lines.push(<box height={1}><text style={{ fg: fgFor("Total Debt", -1, undefined) }}>{valRowPlain("- Total Debt", fmtMoney(dv.total_debt))}</text></box>);
  lines.push(<box height={1}><text style={{ fg: fgFor("Equity Value", 1, C_AMBER) }}>{valRowSel("= Equity Value", fmtMoney(c.equity_value), 1)}</text></box>);
  lines.push(<box height={1}><text style={{ fg: fgFor("Shares Outstanding", -1, undefined) }}>{valRowPlain("÷ Shares", fmtMoney(dv.shares_outstanding))}</text></box>);
  lines.push(<box height={1}><text style={{ fg: "gray" }}>{"  " + "─".repeat(VAL_LBL_W + VAL_NUM_W)}</text></box>);

  lines.push(
    <box flexDirection="row" height={1}>
      <box width={BOTTOM_LBL_W + BOTTOM_VAL_W + 2}>
        <text style={{ fg: fgFor("Fair Price", 2, C_AMBER) }}>
          {`${mark(2)} ${"Fair Price".padEnd(BOTTOM_LBL_W)}${fmtNum2(c.fair_price).padStart(BOTTOM_VAL_W)}`}
        </text>
      </box>
      <box width={BOTTOM_GAP}><text>{" ".repeat(BOTTOM_GAP)}</text></box>
      <box width={BOTTOM_LBL_W + BOTTOM_VAL_W}>
        <text style={{ fg: fgFor("Current Price", -1, undefined) }}>{`${"Current Price".padEnd(BOTTOM_LBL_W)}${fmtNum2(dv.current_price).padStart(BOTTOM_VAL_W)}`}</text>
      </box>
    </box>
  );

  lines.push(
    <box flexDirection="row" height={1}>
      <box width={BOTTOM_LBL_W + BOTTOM_VAL_W + 2}>
        <text style={{ fg: isSel(3) ? C_AMBER : fpColor }}>
          {`${mark(3)} ${"Margin".padEnd(BOTTOM_LBL_W)}${fmtPct(c.margin_of_safety).padStart(BOTTOM_VAL_W)}`}
        </text>
      </box>
      <box width={BOTTOM_GAP}><text>{" ".repeat(BOTTOM_GAP)}</text></box>
      <box width={BOTTOM_LBL_W + BOTTOM_VAL_W}>
        <text style={{ fg: fpColor }}>
          {c.recommendation === "Buy" ? "▓▓ BUY ▓▓" : "▓▓ SELL ▓▓"}
        </text>
      </box>
    </box>
  );

  return lines;
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  ticker: string;
  searchMode: boolean;
  // Notifies the parent app whenever the inline cell editor opens/closes so
  // that global hotkeys (digits switch tabs, q quits, / opens search) can be
  // suppressed while the user is typing into the edit buffer.
  onEditingChange?: (editing: boolean) => void;
}

export default function DCFScreen(props: Props) {
  const dims = useTerminalDimensions();

  const [loading, setLoading]   = createSignal(true);
  const [error, setError]       = createSignal("");
  const [data, setData]         = createSignal<DCFData | null>(null);
  const [sector, setSector]     = createSignal("");
  const [industry, setIndustry] = createSignal("");

  const [overrideGrowth, setOverrideGrowth]     = createSignal<number | null>(null);
  const [overrideDiscount, setOverrideDiscount] = createSignal<number | null>(null);

  const [selZone, setSelZone] = createSignal(ZONE_TMPL);
  const [selRow, setSelRow]   = createSignal(0);
  const [selCol, setSelCol]   = createSignal(0);

  const [colOffset, setColOffset] = createSignal(0);
  const [editing, setEditing]       = createSignal(false);
  const [editBuffer, setEditBuffer] = createSignal("");
  // First content line visible at top of viewport.
  const [scrollOffset, setScrollOffset] = createSignal(0);

  // Surface edit mode to the parent so global hotkeys can be suppressed.
  createEffect(() => { props.onEditingChange?.(editing()); });

  const dateStr = new Date().toISOString().slice(0, 10);

  // ─── Data fetch ──────────────────────────────────────────────────────────

  const fetchGen = { current: 0 };
  const infoGen  = { current: 0 };
  createEffect(() => {
    const t = props.ticker;
    if (!t) return;
    const gen = ++fetchGen.current;
    setLoading(true); setError(""); setData(null);
    setOverrideGrowth(null); setOverrideDiscount(null);
    setSelZone(ZONE_TMPL); setSelRow(0); setSelCol(0);
    setColOffset(0);
    setEditing(false); setEditBuffer("");
    setScrollOffset(0);
    // Reset header info too so a stale sector/industry from the previous
    // ticker doesn't linger while the new one loads.
    setSector(""); setIndustry("");

    getDCFData(t).then((raw: any) => {
      if (gen !== fetchGen.current) return;
      setData(raw as DCFData);
      setLoading(false);
    }).catch((e: unknown) => {
      if (gen !== fetchGen.current) return;
      setError(String(e)); setLoading(false);
    });
  });

  createEffect(() => {
    const t = props.ticker;
    if (!t) return;
    const gen = ++infoGen.current;
    getInfo(t).then((rows: any) => {
      if (gen !== infoGen.current) return;
      const info = (rows as any[]) ?? [];
      if (info.length) { setSector(info[0].sector ?? ""); setIndustry(info[0].industry ?? ""); }
    }).catch((e: unknown) => {
      if (gen !== infoGen.current) return;
      console.error("Failed to fetch info:", e);
    });
  });

  // ─── Derived values ──────────────────────────────────────────────────────

  const effectiveGrowth   = () => overrideGrowth()   ?? (data()?.dcf_template.growth_rate_1_5y ?? 0);
  const effectiveDiscount = () => overrideDiscount() ?? (data()?.dcf_template.discount_rate ?? 0);

  const computed = createMemo<RecalcResult | null>(() => {
    const d = data();
    return d ? recalc(d, effectiveGrowth(), effectiveDiscount()) : null;
  });

  // ─── Layout ──────────────────────────────────────────────────────────────

  const innerW   = () => Math.max(40, dims().width - 4);
  const divider  = () => "─".repeat(innerW());
  const isNarrow = () => innerW() < NARROW_W;

  const numProjCols = createMemo(() => Math.max(1, Math.floor((innerW() - PROJ_LABEL_W) / PROJ_COL_W)));
  const maxColOffset = createMemo(() => Math.max(0, PROJ_COL_COUNT - numProjCols()));

  // Reserved rows of dims().height not available for scrollable content:
  //   App: border(2) + tabbar(1) + top divider(1) + bottom divider(1) + status bar(1) = 6
  //   DCF: paddingTop(1) + header(1) + header divider(1) + formula divider(1) + formula bar(1) = 5
  // Total = 11.
  const contentH = () => Math.max(6, dims().height - 11);

  // Highlight set: input cell labels that feed the currently-selected formula.
  const highlightDeps = createMemo<Set<string>>(() => {
    const d = data();
    return d ? getHighlightDeps(selZone(), selRow(), d.growth_estimates) : new Set<string>();
  });

  // ─── Line memos ──────────────────────────────────────────────────────────

  // Five split column line arrays for the inputs section.
  const drLeftLines = createMemo<JSX.Element[]>(() => {
    const d = data();
    return d ? buildDRLeftLines(d.discount_rate, highlightDeps()) : [];
  });
  const drRightLines = createMemo<JSX.Element[]>(() => {
    const d = data();
    return d ? buildDRRightLines(d.discount_rate, selZone(), selRow(), highlightDeps()) : [];
  });
  const geRevLines = createMemo<JSX.Element[]>(() => {
    const d = data();
    return d ? buildGERevLines(d.growth_estimates, selZone(), selRow(), highlightDeps()) : [];
  });
  const geEpsLines = createMemo<JSX.Element[]>(() => {
    const d = data();
    return d ? buildGEEpsLines(d.growth_estimates, selZone(), selRow(), highlightDeps()) : [];
  });
  const geTrLines = createMemo<JSX.Element[]>(() => {
    const d = data();
    return d ? buildGETrLines(d.growth_estimates, selZone(), selRow(), highlightDeps()) : [];
  });

  // Inputs section: 5 evenly-distributed columns on wide, stacked on narrow.
  const inputsLines = createMemo<JSX.Element[]>(() => {
    const dL  = drLeftLines();
    const dR  = drRightLines();
    const gR  = geRevLines();
    const gE  = geEpsLines();
    const gT  = geTrLines();
    if (dL.length === 0) return [];

    if (isNarrow()) {
      // Narrow: DR-L | DR-R as one row, then GE columns stacked.
      const N = Math.max(dL.length, dR.length);
      const out: JSX.Element[] = [];
      for (let i = 0; i < N; i++) {
        out.push(
          <box flexDirection="row" height={1}>
            <box width={COL_DRL_W}>{dL[i] ?? <text>{""}</text>}</box>
            <box flexGrow={1}><text>{" "}</text></box>
            <box width={COL_DRR_W}>{dR[i] ?? <text>{""}</text>}</box>
          </box>
        );
      }
      // GE columns stacked vertically (skip each column's blank-title at index 0
      // except for geRev which carries the "Growth Estimates" title).
      out.push(blankLine());
      out.push(...gR);
      out.push(...gE.slice(1));  // skip leading blank
      out.push(...gT.slice(1));
      return out;
    }

    // Wide: 5 columns evenly distributed, separated by flexGrow={1} spacers.
    const N = Math.max(dL.length, dR.length, gR.length, gE.length, gT.length);
    const composed: JSX.Element[] = [];
    for (let i = 0; i < N; i++) {
      composed.push(
        <box flexDirection="row" height={1}>
          <box width={COL_DRL_W}>{dL[i] ?? <text>{""}</text>}</box>
          <box flexGrow={1}><text>{" "}</text></box>
          <box width={COL_DRR_W}>{dR[i] ?? <text>{""}</text>}</box>
          <box flexGrow={1}><text>{" "}</text></box>
          <box width={COL_GREV_W}>{gR[i] ?? <text>{""}</text>}</box>
          <box flexGrow={1}><text>{" "}</text></box>
          <box width={COL_GEPS_W}>{gE[i] ?? <text>{""}</text>}</box>
          <box flexGrow={1}><text>{" "}</text></box>
          <box width={COL_GTR_W}>{gT[i] ?? <text>{""}</text>}</box>
        </box>
      );
    }
    return composed;
  });

  const tmplLines = createMemo<JSX.Element[]>(() => {
    const d = data();
    const c = computed();
    if (!d || !c) return [];
    return buildTMPLLines({
      dt: d.dcf_template,
      computed: c,
      effectiveGrowth: effectiveGrowth(),
      effectiveDiscount: effectiveDiscount(),
      overrideGrowth: overrideGrowth(),
      overrideDiscount: overrideDiscount(),
      selZone: selZone(),
      selRow: selRow(),
      selCol: selCol(),
      editing: editing(),
      editBuffer: editBuffer(),
      colOffset: colOffset(),
      numProjCols: numProjCols(),
      maxColOffset: maxColOffset(),
      hl: highlightDeps(),
    });
  });

  const valLines = createMemo<JSX.Element[]>(() => {
    const d = data();
    const c = computed();
    if (!d || !c) return [];
    return buildVALLines({
      dv: d.dcf_value,
      computed: c,
      selZone: selZone(),
      selRow: selRow(),
      hl: highlightDeps(),
    });
  });

  // Combined: inputs + divider + tmpl + divider + val.
  // NOTE: Each divider must be a freshly-created JSX element — reusing the same
  // node reference across array slots breaks the DOM tree (a node can only live
  // in one slot, so the second copy collapses and overlays the wrong row).
  const makeDivider = (): JSX.Element => (
    <box height={1}><text style={{ fg: "gray" }}>{divider()}</text></box>
  );
  const allLines = createMemo<JSX.Element[]>(() => {
    const inp = inputsLines();
    const tm  = tmplLines();
    const va  = valLines();
    if (inp.length === 0 && tm.length === 0 && va.length === 0) return [];
    const out: JSX.Element[] = [];
    out.push(...inp);
    if (inp.length && (tm.length || va.length)) out.push(makeDivider());
    out.push(...tm);
    if (tm.length && va.length) out.push(makeDivider());
    out.push(...va);
    return out;
  });

  // ─── Selection-to-line mapping ────────────────────────────────────────────

  const selectedAbsLine = createMemo(() => {
    const z = selZone();
    const r = selRow();
    const inputsLen = inputsLines().length;
    const tmplStart = inputsLen + (inputsLen > 0 ? 1 : 0);
    const tmplLen = tmplLines().length;
    const valStart = tmplStart + tmplLen + (tmplLen > 0 ? 1 : 0);

    if (z === ZONE_DR) {
      // DR display indices: sr 0-4 → 1-5 (after title), sr 5 → 7 (skip Tax Provision at 6).
      return ([1, 2, 3, 4, 5, 7][r] ?? 1);
    }
    if (z === ZONE_GE) {
      if (!isNarrow()) {
        // Wide: 5-column layout. CAGR headers are on physical line 1 of every GE column.
        return 1;
      }
      // Narrow: DR rows + blank + geRev + (geEps - blank) + (geTr - blank).
      // geRev[1] = Revenue CAGR header (sr 0)
      // geEps[1] = EPS CAGR header (sr 1) — but we sliced its line 0, so it's at index 0 of the sliced arr.
      // geTr[1]  = Treasury header (sr 2) — same slicing.
      const drMax = Math.max(drLeftLines().length, drRightLines().length);
      const gRLen = geRevLines().length;
      const gELen = geEpsLines().length;
      const baseAfterDR = drMax + 1; // +1 for blank
      if (r === 0) return baseAfterDR + 1; // line 0 = "Growth Estimates", line 1 = Rev CAGR
      if (r === 1) return baseAfterDR + gRLen + 0; // EPS header is the first line of sliced geEps
      // r === 2:
      return baseAfterDR + gRLen + (gELen - 1) + 0; // Treasury header is first line of sliced geTr
    }
    if (z === ZONE_TMPL) {
      // Left column: sr 0-3 → physical lines 1-4 (after title at 0).
      // Right column: sr 4-6 share physical lines 1-3 with left rows 0-2.
      const lineInTmpl = r <= 3 ? r + 1 : r - 3;
      return tmplStart + lineInTmpl;
    }
    if (z === ZONE_PROJ) {
      // tmpl: title(0) + 4 params(1-4) + blank(5) + projHeader(6) + 4 data rows(7-10)
      return tmplStart + 7 + r;
    }
    if (z === ZONE_VAL) {
      // val: title(0), EV(1), cash(2), debt(3), equity(4), shares(5), divider(6), fair(7), margin(8)
      return valStart + ([1, 4, 7, 8][r] ?? 1);
    }
    return 0;
  });

  // Auto-scroll: keep selected line in viewport, and prefer to keep the
  // containing section's anchor (section title / table header) visible too.
  // Without the anchor pull, scrollOffset can get stuck at a value that
  // hides the top of a section after a long ↓ then ↑ traversal.
  createEffect(() => {
    const line = selectedAbsLine();
    const z    = selZone();
    const off  = scrollOffset();
    const h    = contentH();
    const total = allLines().length;
    const maxOff = Math.max(0, total - h);

    const inputsLen = inputsLines().length;
    const tmplStart = inputsLen + (inputsLen > 0 ? 1 : 0);
    const tmplLen   = tmplLines().length;
    const valStart  = tmplStart + tmplLen + (tmplLen > 0 ? 1 : 0);

    // Anchor row for each zone: the topmost row that's useful to keep visible.
    const anchor = (z === ZONE_DR || z === ZONE_GE) ? 0
                 :  z === ZONE_TMPL                  ? tmplStart
                 :  z === ZONE_PROJ                  ? tmplStart + 6 /* Year header */
                 : /* ZONE_VAL */                      valStart;

    let newOff = off;
    if (line < off) newOff = line;
    else if (line >= off + h) newOff = line - h + 1;
    // Pull viewport up to anchor when both anchor and selection still fit.
    if (anchor < newOff && line - anchor + 1 <= h) newOff = anchor;
    if (newOff < 0) newOff = 0;
    if (newOff > maxOff) newOff = maxOff;
    if (newOff !== off) setScrollOffset(newOff);
  });

  // Clamp scroll on resize / data change.
  createEffect(() => {
    const total = allLines().length;
    const h = contentH();
    const maxOff = Math.max(0, total - h);
    if (scrollOffset() > maxOff) setScrollOffset(maxOff);
  });

  // ─── Visible slice & scroll hint flags ───────────────────────────────────

  const visibleLines = createMemo<JSX.Element[]>(() => {
    const lines = allLines();
    const off = scrollOffset();
    const h = contentH();
    return lines.slice(off, off + h);
  });

  const hasHiddenAbove = () => scrollOffset() > 0;
  const hasHiddenBelow = createMemo(() => scrollOffset() + contentH() < allLines().length);

  // ─── Formula bar ─────────────────────────────────────────────────────────

  const formulaText = createMemo(() => {
    const d = data();
    const c = computed();
    if (!d || !c) return "";
    return getFormulaText(
      selZone(), selRow(), selCol(),
      d, c, effectiveGrowth(), effectiveDiscount(),
      overrideGrowth(), overrideDiscount(),
    );
  });

  // Parse formula and truncate to fit innerW so it never bleeds past the
  // viewport. Visible budget = innerW - 2 (for "ƒ " prefix). When the
  // expanded text exceeds the budget, append "…" inside the segment list.
  const formulaSegments = createMemo<FormulaSegment[]>(() => {
    const segs = parseFormula(formulaText());
    const budget = Math.max(8, innerW() - 2);
    let total = 0;
    const out: FormulaSegment[] = [];
    for (const seg of segs) {
      const remaining = budget - total;
      if (remaining <= 0) break;
      if (seg.text.length <= remaining) {
        out.push(seg);
        total += seg.text.length;
        continue;
      }
      // Need at least 1 char for the ellipsis.
      const keep = Math.max(0, remaining - 1);
      if (keep > 0) out.push({ text: seg.text.slice(0, keep), isLabel: seg.isLabel });
      out.push({ text: "…", isLabel: false });
      total = budget;
      break;
    }
    return out;
  });

  // ─── Keyboard ────────────────────────────────────────────────────────────

  useKeyboard((key: any) => {
    if (props.searchMode) return;
    const seq  = key.sequence ?? "";
    const name = key.name ?? "";

    if (editing()) {
      if (name === "escape") { setEditing(false); setEditBuffer(""); }
      else if (name === "return" || name === "enter") {
        const buf = editBuffer();
        if (/^-?\d+(\.\d+)?$/.test(buf)) {
          const val = parseFloat(buf);
          if (selRow() === 0) setOverrideGrowth(val / 100);
          else if (selRow() === 3) setOverrideDiscount(val / 100);
          setEditing(false); setEditBuffer("");
        }
      } else if (name === "backspace" || name === "delete") {
        setEditBuffer(b => b.slice(0, -1));
      } else if (seq && /^[\d.\-]$/.test(seq)) {
        setEditBuffer(b => {
          if (seq === "-" && b.length > 0) return b;
          if (seq === "." && b.includes(".")) return b;
          return b + seq;
        });
      }
      return;
    }

    if (name === "tab") {
      // Cycle between editable cells: TMPL row 0 (Growth 1-5Y) ↔ TMPL row 3 (Discount Rate).
      if (selZone() === ZONE_TMPL && selRow() === 0) {
        setSelZone(ZONE_TMPL); setSelRow(3); setSelCol(0);
      } else {
        setSelZone(ZONE_TMPL); setSelRow(0); setSelCol(0);
      }
    }
    else if (name === "up") {
      const z = selZone();
      if (selRow() > 0) {
        setSelRow(r => r - 1);
      } else if (z === ZONE_GE) {
        // GE row 0 → DR last (works on both wide and narrow)
        setSelZone(ZONE_DR);
        setSelRow(ZONE_ROW_COUNTS[ZONE_DR] - 1);
      } else if (z === ZONE_TMPL) {
        setSelZone(ZONE_GE); setSelRow(ZONE_ROW_COUNTS[ZONE_GE] - 1);
      } else if (z === ZONE_PROJ) {
        setSelZone(ZONE_TMPL); setSelRow(ZONE_ROW_COUNTS[ZONE_TMPL] - 1);
      } else if (z === ZONE_VAL) {
        setSelZone(ZONE_PROJ); setSelRow(ZONE_ROW_COUNTS[ZONE_PROJ] - 1);
      }
    }
    else if (name === "down") {
      const z = selZone();
      const maxRow = ZONE_ROW_COUNTS[z] - 1;
      if (selRow() < maxRow) {
        setSelRow(r => r + 1);
      } else if (z === ZONE_DR) {
        // DR last → GE row 0 (works on both wide and narrow)
        setSelZone(ZONE_GE); setSelRow(0);
      } else if (z === ZONE_GE) {
        setSelZone(ZONE_TMPL); setSelRow(0); setSelCol(0);
      } else if (z === ZONE_TMPL) {
        setSelZone(ZONE_PROJ); setSelRow(0); setSelCol(0);
      } else if (z === ZONE_PROJ) {
        setSelZone(ZONE_VAL); setSelRow(0);
      }
    }
    else if (name === "left") {
      const z = selZone();
      if (z === ZONE_PROJ) {
        const newCol = Math.max(0, selCol() - 1);
        setSelCol(newCol);
        if (newCol < colOffset()) setColOffset(newCol);
      }
    }
    else if (name === "right") {
      const z = selZone();
      if (z === ZONE_PROJ) {
        const newCol = Math.min(MAX_PROJ_YEARS, selCol() + 1);
        setSelCol(newCol);
        if (newCol >= colOffset() + numProjCols()) setColOffset(newCol - numProjCols() + 1);
      }
    }
    else if (name === "return" || name === "enter") {
      if (selZone() === ZONE_TMPL && (selRow() === 0 || selRow() === 3)) {
        setEditing(true);
        const val = selRow() === 0 ? effectiveGrowth() : effectiveDiscount();
        setEditBuffer((val * 100).toFixed(2));
      }
    }
    else if (seq === "r") {
      setOverrideGrowth(null);
      setOverrideDiscount(null);
    }
  });

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>

      <box flexDirection="row" height={1}>
        <text style={{ fg: C_AMBER }}>{`${props.ticker} US EQUITY`}</text>
        {sector()   && <text style={{ fg: "white" }}>{`  ·  ${sector()}`}</text>}
        {industry() && <text style={{ fg: "white" }}>{`  ·  ${industry()}`}</text>}
        <text style={{ fg: "white" }}>{`  ·  ${data()?.discount_rate.report_date ?? dateStr}`}</text>
        <Show when={hasHiddenAbove()}>
          <text style={{ fg: "gray" }}>{"  ↑"}</text>
        </Show>
        <Show when={hasHiddenBelow()}>
          <text style={{ fg: "gray" }}>{"  ↓"}</text>
        </Show>
      </box>

      <box height={1}><text style={{ fg: "gray" }}>{divider()}</text></box>

      <Show when={loading()}>
        <text style={{ fg: C_AMBER }}>{`Loading DCF for ${props.ticker}…`}</text>
      </Show>

      <Show when={!!error()}>
        <text style={{ fg: "red" }}>{`Error: ${error()}`}</text>
      </Show>

      <Show when={!loading() && !error() && data() && computed()}>
        <For each={visibleLines()}>{(line) => line}</For>

        <box height={1}><text style={{ fg: "gray" }}>{divider()}</text></box>
        <box flexDirection="row" height={1}>
          <text style={{ fg: "gray" }}>{"ƒ "}</text>
          <For each={formulaSegments()}>
            {(seg) => <text style={{ fg: seg.isLabel ? C_LABEL : C_AMBER }}>{seg.text}</text>}
          </For>
        </box>
      </Show>

    </box>
  );
}
