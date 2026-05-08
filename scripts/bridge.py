#!/usr/bin/env python3
"""
Persistent Python bridge process for defeatbeta-api.
Communicates via stdin/stdout using newline-delimited JSON (JSON-RPC style).

Request format:
  {"id": "1", "type": "ticker", "symbol": "AAPL", "method": "price"}
  {"id": "2", "type": "ticker", "symbol": "AAPL", "method": "earning_call_transcripts.get_transcript", "params": {"fiscal_year": 2024, "fiscal_quarter": 1}}
  {"id": "3", "type": "market", "method": "sp500_cagr_returns", "params": {"years": 10}}
  {"id": "4", "type": "meta", "method": "data_update_time"}

Response format:
  {"id": "1", "success": true, "data": [...]}
  {"id": "1", "success": false, "error": "..."}

Proxy: pass HTTP_PROXY env var, e.g. HTTP_PROXY=http://127.0.0.1:8118
"""

import sys
import json
import math
import threading
from concurrent.futures import ThreadPoolExecutor

_stdout_lock = threading.Lock()
# matplotlib's pyplot interface uses process-global state and is NOT
# thread-safe — concurrent figure creation/savefig calls produce corrupted
# PNGs. Serialize all chart rendering with this lock; data-only requests
# still run in parallel.
_matplotlib_lock = threading.Lock()
# Worker pool for handling concurrent bridge requests. 8 keeps a single
# Financials tab's parallel fetches fully in flight without oversubscribing.
_executor = ThreadPoolExecutor(max_workers=8)

# _DUCKDB_CONFIG is initialized below, after the Configuration class is imported.
_DUCKDB_CONFIG = None


def _write_line(obj: dict) -> None:
    line = json.dumps(obj) + "\n"
    with _stdout_lock:
        sys.stdout.write(line)
        sys.stdout.flush()
import os
import time
import traceback

# Read proxy from environment before any imports
HTTP_PROXY = os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy")

# Redirect stdout to stderr during imports to suppress defeatbeta-api welcome banner
_real_stdout = sys.stdout
sys.stdout = sys.stderr
import logging
import pandas as pd
# Redirect all logging to stderr so it doesn't pollute stdout JSON stream
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
from defeatbeta_api.data.ticker import Ticker
from defeatbeta_api.client.duckdb_conf import Configuration as _DuckdbConfiguration
from defeatbeta_api.data.company_meta import CompanyMeta
from defeatbeta_api.utils.util import (
    sp500_cagr_returns,
    sp500_cagr_returns_rolling,
    load_sp500_historical_annual_returns,
)
from defeatbeta_api.client.hugging_face_client import HuggingFaceClient
# Pre-import matplotlib with Agg backend (must set backend before importing pyplot)
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
sys.stdout = _real_stdout

# Now that Configuration is imported, build the shared DuckDB config.
# - threads=8: let each query use more cores
# - in-mem cache 64→512 blocks (~512MB): keep hot parquet blocks resident
_DUCKDB_CONFIG = _DuckdbConfiguration(
    threads=8
)

from typing import Any


def serialize(obj: Any) -> Any:
    """Recursively serialize objects to JSON-compatible types."""
    if isinstance(obj, pd.DataFrame):
        # Replace NaN/Inf with None for JSON compatibility
        return json.loads(obj.where(pd.notna(obj), None).to_json(orient="records", date_format="iso"))
    if isinstance(obj, pd.Series):
        return json.loads(obj.where(pd.notna(obj), None).to_json(orient="records", date_format="iso"))
    if isinstance(obj, dict):
        return {k: serialize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [serialize(i) for i in obj]
    if isinstance(obj, float) and (pd.isna(obj) or math.isinf(obj)):
        return None
    return obj


def _normalize_value(v) -> "float | None":
    if pd.isna(v):
        return None
    if isinstance(v, str):
        v = v.replace(",", "").strip()
        if v in ("", "*"):
            return None
    try:
        return float(v)
    except Exception:
        return None


_YOY_LABELS_INCOME = frozenset({
    "Total Revenue", "Gross Profit", "Operating Income",
    "EBIT", "EBITDA", "Net Income Common Stockholders",
    "Basic EPS", "Diluted EPS",
})
_YOY_LABELS_CASHFLOW = frozenset({
    "Operating Cash Flow", "Free Cash Flow", "Capital Expenditure (CapEx)",
})


def _get_currency(symbol: str) -> str:
    try:
        meta = CompanyMeta(http_proxy=HTTP_PROXY)
        info = meta.get_company_info(symbol)
        if info and info.get("financial_currency"):
            return str(info["financial_currency"])
    except Exception:
        pass
    return "USD"


def handle_statement(symbol: str, method: str) -> Any:
    """Return structured financial statement data with indent/is_section hierarchy."""
    t = Ticker(symbol, http_proxy=HTTP_PROXY, log_level=logging.WARNING, config=_DUCKDB_CONFIG)
    stmt = getattr(t, method)()
    df = stmt.df()
    period_type = "quarterly" if "quarterly" in method else "annual"
    currency = _get_currency(symbol)

    if df is None or df.empty:
        return {"currency": currency, "period_type": period_type, "periods": [], "statement": []}

    breakdown_col = "Breakdown"
    row_meta = stmt.row_meta
    period_cols = [c for c in df.columns if c != breakdown_col and c.upper() != "TTM"]

    if "income_statement" in method:
        yoy_labels = _YOY_LABELS_INCOME
    elif "cash_flow" in method:
        yoy_labels = _YOY_LABELS_CASHFLOW
    else:
        yoy_labels = frozenset()

    statement = []
    for i, (_, row) in enumerate(df.iterrows()):
        meta = row_meta[i] if i < len(row_meta) else {"indent": 0, "is_section": False}
        label = str(row[breakdown_col])
        statement.append({
            "label":      label,
            "indent":     meta["indent"],
            "is_section": meta["is_section"],
            "values":     [_normalize_value(row[p]) for p in period_cols],
            "show_yoy":   label in yoy_labels,
        })

    return {
        "currency":    currency,
        "period_type": period_type,
        "periods":     period_cols,
        "statement":   statement,
    }


# ─── Valuation configs ────────────────────────────────────────────────────────

_MULTIPLES_CONFIG = [
    # (label, method, col, industry_method, industry_col)
    ("P/E (TTM)",  "ttm_pe",              "ttm_pe",            "industry_ttm_pe",   "industry_pe"),
    ("P/S",        "ps_ratio",            "ps_ratio",          "industry_ps_ratio", "industry_ps_ratio"),
    ("P/B",        "pb_ratio",            "pb_ratio",          "industry_pb_ratio", "industry_pb_ratio"),
    ("PEG",        "peg_ratio",           "peg_ratio",         None,                None),
    ("EV/EBITDA",  "enterprise_to_ebitda","ev_to_ebitda",      None,                None),
    ("EV/Revenue", "enterprise_to_revenue","ev_to_revenue",    None,                None),
]

# (label, method, value_col, is_pct, is_daily)
_FUNDAMENTALS_CONFIG = [
    # (label, method, col, is_pct, is_daily, ind_method, ind_col)
    ("ROE",           "roe",               "roe",               True,  False, "industry_roe",               "industry_roe"),
    ("ROA",           "roa",               "roa",               True,  False, "industry_roa",               "industry_roa"),
    ("ROIC",          "roic",              "roic",              True,  False, "industry_roic",              "industry_roic"),
    ("ROCE",          "roce",              "roce",              True,  False, None,                          None),
    ("WACC",          "wacc",              "wacc",              True,  True,  None,                          None),
    ("Equity Mult.",  "equity_multiplier", "equity_multiplier", False, False, "industry_equity_multiplier", "industry_equity_multiplier"),
    ("Asset Turnover","asset_turnover",    "asset_turnover",    False, False, "industry_asset_turnover",    "industry_asset_turnover"),
    ("D/E Ratio",     "debt_to_equity",    "debt_to_equity",    False, False, None,                         None),
]


def _window_stats(values: list, n: int) -> dict:
    """Compute low/avg/high for the last n entries of a clean (non-None) list."""
    window = values[-n:] if n > 0 else []
    if not window:
        return {"low": None, "avg": None, "high": None}
    return {
        "low":  min(window),
        "avg":  sum(window) / len(window),
        "high": max(window),
    }


def _extract_series(df, value_col: str) -> tuple:
    """Return (dates, values) from a DataFrame, filtering out None/NaN/Inf."""
    import math
    date_col = "report_date"
    raw_dates  = [str(d)[:10] for d in df[date_col].tolist()] if date_col in df.columns else [""] * len(df)
    raw_values = df[value_col].tolist()
    dates, values = [], []
    for d, v in zip(raw_dates, raw_values):
        try:
            fv = float(v) if v is not None and not pd.isna(v) else None
        except Exception:
            fv = None
        if fv is not None and math.isfinite(fv):
            dates.append(d)
            values.append(fv)
    return dates, values


def _emit_progress(req_id: str, message: str) -> None:
    _write_line({"id": req_id, "progress": message})


def handle_valuation_multiples(symbol: str, req_id: str = "") -> Any:
    t = Ticker(symbol, http_proxy=HTTP_PROXY, log_level=logging.WARNING, config=_DUCKDB_CONFIG)
    result = []
    for label, method, col, ind_method, ind_col in _MULTIPLES_CONFIG:
        if req_id:
            _emit_progress(req_id, f"Fetching {method}()")
        t0 = time.monotonic()
        try:
            df = getattr(t, method)()
            if hasattr(df, "df"):
                df = df.df()
            if df is None or df.empty or col not in df.columns:
                raise ValueError(f"no data for {col}")
            dates, values = _extract_series(df, col)
            current = values[-1] if values else None
            series  = [{"date": d, "value": v} for d, v in zip(dates, values)]

            def _avg(n: int):
                w = values[-n:]
                return round(sum(w) / len(w), 4) if w else None

            avg1m = _avg(21)
            avg3m = _avg(63)
            avg6m = _avg(126)
            avg1y = _avg(252)
            avg2y = _avg(504)
            avg5y = _avg(1260)

            industry_avg    = None
            industry_series = []
            if ind_method:
                if req_id:
                    _emit_progress(req_id, f"Fetching {ind_method}()")
                t0 = time.monotonic()
                try:
                    ind_df = getattr(t, ind_method)()
                    if ind_df is not None and not ind_df.empty and ind_col in ind_df.columns:
                        ind_dates, ind_values = _extract_series(ind_df, ind_col)
                        industry_avg    = ind_values[-1] if ind_values else None
                        industry_series = [{"date": d, "value": v} for d, v in zip(ind_dates, ind_values)]
                except Exception:
                    pass
                finally:
                    if req_id:
                        elapsed = time.monotonic() - t0
                        _emit_progress(req_id, f"✓ {ind_method}()  {elapsed:.1f}s")

            result.append({
                "label": label, "current": current,
                "avg1m": avg1m, "avg3m": avg3m, "avg6m": avg6m,
                "avg1y": avg1y, "avg2y": avg2y, "avg5y": avg5y,
                "industry_avg": industry_avg,
                "series": series, "industry_series": industry_series,
            })
        except Exception:
            result.append({
                "label": label, "current": None,
                "avg1m": None, "avg3m": None, "avg6m": None,
                "avg1y": None, "avg2y": None, "avg5y": None,
                "industry_avg": None,
                "series": [], "industry_series": [],
            })
        finally:
            if req_id:
                elapsed = time.monotonic() - t0
                _emit_progress(req_id, f"✓ {method}()  {elapsed:.1f}s")
    return result


def handle_valuation_fundamentals(symbol: str, req_id: str = "") -> Any:
    t = Ticker(symbol, http_proxy=HTTP_PROXY, log_level=logging.WARNING, config=_DUCKDB_CONFIG)

    # Step 1: gather quarterly metrics → collect dates, values, and full time series
    quarterly_data: dict[str, dict[str, float]] = {}
    stock_series:   dict[str, list] = {}
    all_quarterly_dates: set[str] = set()
    for label, method, col, is_pct, is_daily, ind_method, ind_col in _FUNDAMENTALS_CONFIG:
        if is_daily:
            continue
        if req_id:
            _emit_progress(req_id, f"Fetching {method}()")
        t0 = time.monotonic()
        try:
            df = getattr(t, method)()
            if hasattr(df, "df"):
                df = df.df()
            if df is None or df.empty or col not in df.columns:
                quarterly_data[label] = {}
                stock_series[label] = []
            else:
                dates, values = _extract_series(df, col)
                quarterly_data[label] = dict(zip(dates, values))
                stock_series[label] = [{"date": d, "value": v} for d, v in zip(dates, values)]
                all_quarterly_dates.update(dates)
        except Exception:
            quarterly_data[label] = {}
            stock_series[label] = []
        if req_id:
            elapsed = time.monotonic() - t0
            _emit_progress(req_id, f"✓ {method}()  {elapsed:.1f}s")

    # Use last 8 quarterly periods, sorted descending
    periods = sorted(all_quarterly_dates, reverse=True)[:8]

    # Step 2: gather daily metrics → look up nearest value for each quarterly period
    daily_data: dict[str, dict[str, float]] = {}
    for label, method, col, is_pct, is_daily, ind_method, ind_col in _FUNDAMENTALS_CONFIG:
        if not is_daily:
            continue
        if req_id:
            _emit_progress(req_id, f"Fetching {method}()")
        t0 = time.monotonic()
        try:
            df = getattr(t, method)()
            if hasattr(df, "df"):
                df = df.df()
            if df is None or df.empty or col not in df.columns:
                daily_data[label] = {}
                stock_series[label] = []
            else:
                dates, values = _extract_series(df, col)
                sorted_pairs = sorted(zip(dates, values))
                sorted_dates = [p[0] for p in sorted_pairs]
                date_val_map = {p[0]: p[1] for p in sorted_pairs}
                lookup: dict[str, float] = {}
                for p in periods:
                    best = None
                    for d in reversed(sorted_dates):
                        if d <= p:
                            best = d
                            break
                    if best is not None:
                        lookup[p] = date_val_map[best]
                daily_data[label] = lookup
                stock_series[label] = [{"date": d, "value": v} for d, v in sorted_pairs]
        except Exception:
            daily_data[label] = {}
            stock_series[label] = []
        if req_id:
            elapsed = time.monotonic() - t0
            _emit_progress(req_id, f"✓ {method}()  {elapsed:.1f}s")

    # Step 3: fetch industry series for each metric that has an industry method
    ind_series: dict[str, list] = {}
    for label, method, col, is_pct, is_daily, ind_method, ind_col in _FUNDAMENTALS_CONFIG:
        if not ind_method or not ind_col:
            ind_series[label] = []
            continue
        try:
            ind_df = getattr(t, ind_method)()
            if hasattr(ind_df, "df"):
                ind_df = ind_df.df()
            if ind_df is None or ind_df.empty or ind_col not in ind_df.columns:
                ind_series[label] = []
            else:
                ind_dates, ind_values = _extract_series(ind_df, ind_col)
                ind_series[label] = [{"date": d, "value": v} for d, v in zip(ind_dates, ind_values)]
        except Exception:
            ind_series[label] = []

    # Step 4: build rows in config order
    rows = []
    for label, method, col, is_pct, is_daily, ind_method, ind_col in _FUNDAMENTALS_CONFIG:
        d = daily_data[label] if is_daily else quarterly_data.get(label, {})
        rows.append({
            "label":           label,
            "is_pct":          is_pct,
            "values":          [d.get(p) for p in periods],
            "series":          stock_series.get(label, []),
            "industry_series": ind_series.get(label, []),
        })

    return {"periods": periods, "rows": rows}


def handle_ticker(symbol: str, method: str, params: dict) -> Any:
    """Handle Ticker-based API calls."""
    ticker = Ticker(symbol, http_proxy=HTTP_PROXY, log_level=logging.WARNING, config=_DUCKDB_CONFIG)

    # News list metadata. Since defeatbeta-api 0.0.53 the underlying
    # `News.get_news_list()` already returns metadata-only columns
    # (no inline paragraph array), so this handler just sorts by date desc
    # for the UI. The wrapper name is kept for API stability with the
    # frontend's getNewsListMeta(); see also api.ts.
    if method == "news.get_news_list_meta":
        df = ticker.news().get_news_list()
        if df is not None and not df.empty and "report_date" in df.columns:
            df = df.sort_values("report_date", ascending=False)
        return serialize(df)

    # Handle sub-object methods (e.g. "earning_call_transcripts.get_transcript")
    if "." in method:
        obj_method, sub_method = method.split(".", 1)
        obj = getattr(ticker, obj_method)()
        sub_params = params or {}
        result = getattr(obj, sub_method)(**sub_params)
    else:
        result = getattr(ticker, method)(**params)

    # Unwrap Statement objects to their DataFrame
    if hasattr(result, "df"):
        result = result.df()

    return serialize(result)


def handle_market(method: str, params: dict) -> Any:
    """Handle non-ticker market-level API calls."""
    if method == "sp500_cagr_returns":
        return serialize(sp500_cagr_returns(**params))
    elif method == "sp500_cagr_returns_rolling":
        return serialize(sp500_cagr_returns_rolling(**params))
    elif method == "sp500_historical_annual_returns":
        return serialize(load_sp500_historical_annual_returns())
    else:
        raise ValueError(f"Unknown market method: {method}")


def handle_meta(method: str) -> Any:
    """Handle metadata calls."""
    if method == "version":
        import importlib.metadata
        return importlib.metadata.version("defeatbeta-api")
    client = HuggingFaceClient()
    if method == "data_update_time":
        return client.get_data_update_time()
    else:
        raise ValueError(f"Unknown meta method: {method}")


def handle_render(method: str, params: dict) -> Any:
    """Handle render requests (matplotlib chart → iTerm2 image escape sequence).
    Serialized via _matplotlib_lock because pyplot is not thread-safe.
    """
    with _matplotlib_lock:
        return _handle_render_locked(method, params)


def _handle_render_locked(method: str, params: dict) -> Any:
    if method == "price_chart":
        return render_price_chart(
            params["prices"], params["width"], params["height"],
            earnings=params.get("earnings") or [],
            dividends=params.get("dividends") or [],
            splits=params.get("splits") or [],
        )
    elif method == "metric_chart":
        return render_metric_chart(
            params["series"], params["label"],
            params["range_years"], params["width"], params["height"],
            industry_series=params.get("industry_series", []),
            avg1y=params.get("avg1y"),
        )
    elif method == "fund_bar_chart":
        return render_fund_bar_chart(
            params["periods"], params["stock_values"], params["label"],
            params["is_pct"], params["width"], params["height"],
            industry_series=params.get("industry_series", []),
        )
    else:
        raise ValueError(f"Unknown render method: {method}")


def render_price_chart(prices: list, width_cols: int, height_rows: int, earnings: list = None, dividends: list = None, splits: list = None) -> str:
    """Render a Bloomberg-style price + volume chart using matplotlib.
    Returns an iTerm2 inline image escape sequence string.
    """
    if not prices:
        return ""
    from io import BytesIO
    import base64
    from datetime import datetime
    from matplotlib.gridspec import GridSpec

    C_BG    = "#0A1628"
    C_FILL  = "#1A3C6E"
    C_AMBER = "#FFA028"
    C_GRID  = "#1E2E48"
    C_TEXT  = "#888888"
    C_VOL   = "#2A5080"

    # Parse dates, prices, and volumes
    date_objs = []
    for p in prices:
        d = p.get("date") or p.get("report_date") or ""
        try:
            date_objs.append(datetime.strptime(d[:10], "%Y-%m-%d"))
        except Exception:
            date_objs.append(None)

    closes  = [p["close"] for p in prices]
    volumes = [p.get("volume") or 0 for p in prices]
    period_high = max(p["high"] for p in prices)
    period_low  = min(p["low"]  for p in prices)

    # Filter to entries with valid dates
    valid = [(dt, c, v) for dt, c, v in zip(date_objs, closes, volumes) if dt is not None]
    if valid:
        xs_plot  = [e[0] for e in valid]
        ys_plot  = [e[1] for e in valid]
        vol_plot = [e[2] for e in valid]
        use_dates = True
    else:
        xs_plot  = list(range(len(closes)))
        ys_plot  = closes
        vol_plot = volumes
        use_dates = False

    dpi   = 100
    fig_w = max(4.0, width_cols * 0.10)
    fig_h = max(2.0, height_rows * 0.18)

    fig = plt.figure(figsize=(fig_w, fig_h), dpi=dpi)
    fig.patch.set_facecolor(C_BG)

    gs = GridSpec(2, 1, height_ratios=[5, 1], hspace=0, figure=fig)
    ax     = fig.add_subplot(gs[0])
    ax_vol = fig.add_subplot(gs[1], sharex=ax)
    ax.set_facecolor(C_BG)
    ax_vol.set_facecolor(C_BG)

    # ── Price panel ──────────────────────────────────────────────────────────
    min_y  = min(ys_plot)
    max_y  = max(ys_plot)
    last_y = ys_plot[-1]

    ax.fill_between(xs_plot, ys_plot, min_y, color=C_FILL, alpha=0.9, zorder=2)
    ax.plot(xs_plot, ys_plot, color="white", linewidth=1.0, zorder=3)
    ax.axhline(y=last_y, color=C_AMBER, linewidth=0.8, linestyle="--", zorder=4, alpha=0.85)

    # Moving averages (trading-day based; skip warm-up period)
    MA10_COLOR  = "#40C0A0"   # teal-green  (short-term  ~2 weeks)
    MA50_COLOR  = "#F0C040"   # yellow-gold (medium-term ~2.5 months)
    MA200_COLOR = "#FF6060"   # red         (long-term   ~10 months / "annual")
    ys_arr = ys_plot

    def rolling_mean(arr, n):
        result = []
        for i in range(len(arr)):
            if i < n - 1:
                result.append(None)
            else:
                result.append(sum(arr[i - n + 1 : i + 1]) / n)
        return result

    ma10  = rolling_mean(ys_arr, 10)
    ma50  = rolling_mean(ys_arr, 50)
    ma200 = rolling_mean(ys_arr, 200)

    xs_ma10  = [x for x, v in zip(xs_plot, ma10)  if v is not None]
    ys_ma10  = [v for v in ma10  if v is not None]
    xs_ma50  = [x for x, v in zip(xs_plot, ma50)  if v is not None]
    ys_ma50  = [v for v in ma50  if v is not None]
    xs_ma200 = [x for x, v in zip(xs_plot, ma200) if v is not None]
    ys_ma200 = [v for v in ma200 if v is not None]

    if xs_ma10:
        ax.plot(xs_ma10,  ys_ma10,  color=MA10_COLOR,  linewidth=0.9, zorder=4, alpha=0.85)
    if xs_ma50:
        ax.plot(xs_ma50,  ys_ma50,  color=MA50_COLOR,  linewidth=0.9, zorder=4, alpha=0.85)
    if xs_ma200:
        ax.plot(xs_ma200, ys_ma200, color=MA200_COLOR, linewidth=0.9, zorder=4, alpha=0.85)

    ax.yaxis.grid(True, color=C_GRID, linewidth=0.5, linestyle="-")
    ax.set_axisbelow(True)
    ax.xaxis.grid(False)
    ax.yaxis.tick_right()
    ax.yaxis.set_label_position("right")
    ax.tick_params(axis="y", colors="white", labelsize=10, right=True, left=False)
    ax.tick_params(axis="x", which="both", bottom=False, labelbottom=False)

    ax.spines["top"].set_visible(False)
    ax.spines["left"].set_visible(False)
    for spine in ax.spines.values():
        spine.set_edgecolor(C_GRID)

    price_range = max_y - min_y or 1
    ax.set_ylim(min_y - price_range * 0.02, max_y + price_range * 0.08)

    # ── Earnings release markers (filter to visible window) ─────────────────
    # Place each ▼ slightly above the close price on (or nearest to) the
    # earnings date so the marker visually attaches to the curve. A small "E"
    # label sits above the triangle to disambiguate the symbol.
    if earnings and use_dates:
        import bisect
        xmin_dt, xmax_dt = xs_plot[0], xs_plot[-1]
        ev_points = []  # list of (date, close_price)
        for e in earnings:
            s = e if isinstance(e, str) else (e.get("date") if isinstance(e, dict) else None)
            if not s:
                continue
            try:
                dt = datetime.strptime(s[:10], "%Y-%m-%d")
            except Exception:
                continue
            if not (xmin_dt <= dt <= xmax_dt):
                continue
            # Snap to nearest trading day in xs_plot
            i = bisect.bisect_left(xs_plot, dt)
            if i >= len(xs_plot):
                i = len(xs_plot) - 1
            elif i > 0 and (xs_plot[i] - dt) > (dt - xs_plot[i - 1]):
                i = i - 1
            ev_points.append((xs_plot[i], ys_plot[i]))

        for dt, _ in ev_points:
            ax.axvline(dt, color="#555555", linestyle=":",
                       linewidth=0.8, alpha=0.35, zorder=2)
        if ev_points:
            offset = price_range * 0.005
            for x, y in ev_points:
                ax.text(x, y + offset, "⚑",
                        color="#FF6EC7", fontsize=11,
                        ha="center", va="bottom",
                        zorder=7, clip_on=False)

    # ── Dividend markers ($ text directly on the curve) ─────────────────────
    if dividends and use_dates:
        import bisect
        xmin_dt, xmax_dt = xs_plot[0], xs_plot[-1]
        dv_points = []
        for d in dividends:
            s = d if isinstance(d, str) else (d.get("date") if isinstance(d, dict) else None)
            if not s:
                continue
            try:
                dt = datetime.strptime(s[:10], "%Y-%m-%d")
            except Exception:
                continue
            if not (xmin_dt <= dt <= xmax_dt):
                continue
            i = bisect.bisect_left(xs_plot, dt)
            if i >= len(xs_plot):
                i = len(xs_plot) - 1
            elif i > 0 and (xs_plot[i] - dt) > (dt - xs_plot[i - 1]):
                i = i - 1
            dv_points.append((xs_plot[i], ys_plot[i]))
        for dt, _ in dv_points:
            ax.axvline(dt, color="#555555", linestyle=":",
                       linewidth=0.8, alpha=0.35, zorder=2)
        if dv_points:
            dv_offset = price_range * 0.025
            for x, y in dv_points:
                ax.text(x, y + dv_offset, "$",
                        color="#00FF87", fontsize=9, fontweight="bold",
                        ha="center", va="bottom",
                        fontfamily="monospace", zorder=7,
                        clip_on=False)

    # ── Stock split markers (⇅ on the curve) ────────────────────────────────
    if splits and use_dates:
        import bisect
        xmin_dt, xmax_dt = xs_plot[0], xs_plot[-1]
        sp_points = []
        for sp in splits:
            s = sp.get("date") if isinstance(sp, dict) else None
            if not s:
                continue
            try:
                dt = datetime.strptime(s[:10], "%Y-%m-%d")
            except Exception:
                continue
            if not (xmin_dt <= dt <= xmax_dt):
                continue
            i = bisect.bisect_left(xs_plot, dt)
            if i >= len(xs_plot):
                i = len(xs_plot) - 1
            elif i > 0 and (xs_plot[i] - dt) > (dt - xs_plot[i - 1]):
                i = i - 1
            sp_points.append((xs_plot[i], ys_plot[i]))
        for dt, _ in sp_points:
            ax.axvline(dt, color="#555555", linestyle=":",
                       linewidth=0.8, alpha=0.35, zorder=2)
        if sp_points:
            sp_offset = price_range * 0.005
            for x, y in sp_points:
                ax.text(x, y + sp_offset, "⇅",
                        color="#FFD700", fontsize=11, fontweight="bold",
                        ha="center", va="bottom",
                        zorder=7, clip_on=False)

    # ── Bloomberg-style stats box — two columns, MAs colored ────────────────
    ma10_str  = f"{ys_ma10[-1]:.2f}"  if ys_ma10  else "N/A"
    ma50_str  = f"{ys_ma50[-1]:.2f}"  if ys_ma50  else "N/A"
    ma200_str = f"{ys_ma200[-1]:.2f}" if ys_ma200 else "N/A"

    font_sz = 10
    # Approximate monospace char width in axes fraction (~0.60 × em, 1pt = 1/72 in)
    char_w = (font_sz * 0.60) / 72.0 / fig_w
    # Line height in axes fraction (1.5 × em)
    line_h_ax = (font_sz * 1.55) / 72.0 / fig_h

    # Each row: (left_text, left_color, right_text, right_color)
    rows = [
        (f"Last  {last_y:.2f}  ",     "white",    f"MA10  {ma10_str}",  MA10_COLOR),
        (f"High  {period_high:.2f}  ", "white",   f"MA50  {ma50_str}",  MA50_COLOR),
        (f"Low   {period_low:.2f}  ",  "white",   f"MA200 {ma200_str}", MA200_COLOR),
    ]

    left_max  = max(len(r[0]) for r in rows)
    right_max = max(len(r[2]) for r in rows if r[2])
    left_w    = char_w * left_max
    right_w   = char_w * right_max
    pad_x     = char_w * 1.0
    pad_y     = line_h_ax * 0.65

    box_w = pad_x * 2 + left_w + right_w
    box_h = len(rows) * line_h_ax + pad_y * 2
    box_x = 0.01
    box_y = 0.99 - box_h

    from matplotlib.patches import FancyBboxPatch
    ax.add_patch(FancyBboxPatch(
        (box_x, box_y), box_w, box_h,
        boxstyle="square,pad=0", linewidth=0.8,
        edgecolor="white", facecolor=C_BG, alpha=0.88,
        transform=ax.transAxes, zorder=5,
    ))

    for k, (left_txt, left_col, right_txt, right_col) in enumerate(rows):
        y = 0.99 - pad_y - k * line_h_ax
        ax.text(box_x + pad_x, y, left_txt,
                transform=ax.transAxes, color=left_col,
                fontsize=font_sz, va="top", fontfamily="monospace", zorder=6)
        if right_txt:
            ax.text(box_x + pad_x + left_w, y, right_txt,
                    transform=ax.transAxes, color=right_col,
                    fontsize=font_sz, va="top", fontfamily="monospace", zorder=6)


    # ── Volume panel ─────────────────────────────────────────────────────────
    sorted_vols = sorted(vol_plot)
    p90_vol = sorted_vols[int(len(sorted_vols) * 0.9)] if sorted_vols else 1
    max_vol = max(p90_vol, 1)

    # Bar chart for volume; compute bar width from date gaps when using dates
    if use_dates and len(xs_plot) > 1:
        # Width in matplotlib date units (days); use ~80% of the median gap
        gaps = [(xs_plot[i+1] - xs_plot[i]).days for i in range(len(xs_plot)-1)]
        median_gap = sorted(gaps)[len(gaps)//2]
        bar_width = median_gap * 0.8
        ax_vol.bar(xs_plot, vol_plot, width=bar_width, color="white", alpha=0.7, zorder=2)
    else:
        ax_vol.bar(xs_plot, vol_plot, color="white", alpha=0.7, zorder=2)

    # Volume MA20 overlay
    vol_ma20 = rolling_mean(vol_plot, 20)
    xs_vma20 = [x for x, v in zip(xs_plot, vol_ma20) if v is not None]
    ys_vma20 = [v for v in vol_ma20 if v is not None]
    if xs_vma20:
        ax_vol.plot(xs_vma20, ys_vma20, color=C_AMBER, linewidth=1.0, zorder=3, alpha=0.9)
    ax_vol.set_ylim(0, max_vol * 1.5)
    ax_vol.yaxis.grid(True, color=C_GRID, linewidth=0.5, linestyle="-")
    ax_vol.set_axisbelow(True)
    ax_vol.xaxis.grid(False)
    ax_vol.yaxis.tick_right()
    ax_vol.yaxis.set_label_position("right")
    # Show one tick at p90 volume with a readable label (e.g. "120M")
    def fmt_vol(v: float) -> str:
        if v >= 1e9: return f"{v/1e9:.1f}B"
        if v >= 1e6: return f"{v/1e6:.0f}M"
        if v >= 1e3: return f"{v/1e3:.0f}K"
        return str(int(v))

    ax_vol.set_yticks([max_vol])
    ax_vol.set_yticklabels([fmt_vol(max_vol)])
    ax_vol.tick_params(axis="y", colors="white", labelsize=10, right=True, left=False,
                       labelleft=False, labelright=True)

    if use_dates:
        locator = mdates.AutoDateLocator()
        ax_vol.xaxis.set_major_locator(locator)
        ax_vol.xaxis.set_major_formatter(mdates.DateFormatter("%b '%y"))
    ax_vol.tick_params(axis="x", colors="white", labelsize=10)

    ax_vol.spines["top"].set_visible(False)
    ax_vol.spines["left"].set_visible(False)
    for spine in ax_vol.spines.values():
        spine.set_edgecolor(C_GRID)

    # Volume panel legend: "VOL" + MA20 label with current value
    vma20_val = f"  {fmt_vol(ys_vma20[-1])}" if ys_vma20 else ""
    ax_vol.text(0.01, 0.95, "VOL", transform=ax_vol.transAxes,
                color="white", fontsize=10, va="top", fontfamily="monospace", zorder=5)
    if ys_vma20:
        ax_vol.text(0.01, 0.60, f"MA20  {fmt_vol(ys_vma20[-1])}",
                    transform=ax_vol.transAxes,
                    color=C_AMBER, fontsize=10, va="top", fontfamily="monospace", zorder=5)

    plt.tight_layout(pad=0.3)

    # Compute terminal column for each data point (for mouse hover lookup).
    # ax.transData maps data → display pixels; convert px → terminal column.
    fig.canvas.draw()  # ensure transforms are up to date
    fig_px_w = fig_w * dpi
    try:
        if use_dates:
            xs_num = mdates.date2num(xs_plot)
        else:
            xs_num = xs_plot
        disp = ax.transData.transform([(float(x), 0.0) for x in xs_num])
        xs_cols = [int(round(px / fig_px_w * width_cols)) for px, _ in disp]
    except Exception as _e:
        sys.stderr.write(f"xs_cols compute failed: {_e}\n")
        xs_cols = []

    buf = BytesIO()
    fig.savefig(buf, format="png", facecolor=C_BG, dpi=dpi)
    plt.close(fig)

    png_bytes = buf.getvalue()
    b64 = base64.b64encode(png_bytes).decode("ascii")
    size = len(png_bytes)
    name = base64.b64encode(b"chart.png").decode("ascii")
    image = f"\033]1337;File=name={name};size={size};inline=1;width={width_cols};height={height_rows};preserveAspectRatio=0:{b64}\007"
    return {"image": image, "xs_cols": xs_cols}


def render_metric_chart(
    series: list, label: str, range_years: int, width_cols: int, height_rows: int,
    industry_series: list = None, avg1y: float = None,
) -> str:
    """Render a Bloomberg-style line chart for a single valuation metric.
    Draws 3 lines: own metric (white), industry avg (cyan), 1Y avg (gray dashed).
    Returns an iTerm2 inline image escape sequence string.
    """
    if not series:
        return ""
    from io import BytesIO
    import base64
    from datetime import datetime, timedelta

    C_BG   = "#0A1628"
    C_AMBER = "#FFA028"
    C_FILL  = "#1A3C6E"
    C_GRID  = "#1E2E48"
    C_CYAN  = "#00BFBF"

    # Filter main series by range
    if range_years and range_years < 99:
        all_dates = [s["date"] for s in series]
        if all_dates:
            try:
                last_dt = datetime.strptime(all_dates[-1][:10], "%Y-%m-%d")
                cutoff  = (last_dt - timedelta(days=range_years * 365)).strftime("%Y-%m-%d")
                series  = [s for s in series if s["date"] >= cutoff]
            except Exception:
                pass

    if not series:
        return ""

    date_objs, ys = [], []
    for s in series:
        try:
            date_objs.append(datetime.strptime(s["date"][:10], "%Y-%m-%d"))
        except Exception:
            date_objs.append(None)
        ys.append(s["value"])

    valid = [(d, v) for d, v in zip(date_objs, ys) if d is not None]
    if not valid:
        return ""
    xs_plot = [e[0] for e in valid]
    ys_plot = [e[1] for e in valid]

    # Filter industry series to same date range
    ind_xs, ind_ys = [], []
    for s in (industry_series or []):
        try:
            d = datetime.strptime(s["date"][:10], "%Y-%m-%d")
            if d >= xs_plot[0]:
                ind_xs.append(d)
                ind_ys.append(s["value"])
        except Exception:
            pass

    dpi   = 100
    fig_w = max(4.0, width_cols * 0.10)
    fig_h = max(1.5, height_rows * 0.18)

    fig, ax = plt.subplots(figsize=(fig_w, fig_h), dpi=dpi)
    fig.patch.set_facecolor(C_BG)
    ax.set_facecolor(C_BG)

    # Y range across all series
    all_ys = ys_plot + ind_ys + ([avg1y] if avg1y is not None else [])
    min_y, max_y = min(all_ys), max(all_ys)
    last_y = ys_plot[-1]

    # Main series
    ax.fill_between(xs_plot, ys_plot, min_y, color=C_FILL, alpha=0.85, zorder=2)
    ax.plot(xs_plot, ys_plot, color="white", linewidth=1.0, zorder=3)
    ax.axhline(y=last_y, color=C_AMBER, linewidth=0.8, linestyle="--", zorder=4, alpha=0.9)

    # 1Y avg horizontal line
    if avg1y is not None:
        ax.axhline(y=avg1y, color="white", linewidth=0.7, linestyle=":", zorder=4, alpha=0.85)

    # Industry avg series
    if ind_xs and ind_ys:
        ax.plot(ind_xs, ind_ys, color=C_CYAN, linewidth=0.9, zorder=5, alpha=0.9)

    ax.yaxis.grid(True, color=C_GRID, linewidth=0.5, linestyle="-")
    ax.set_axisbelow(True)
    ax.xaxis.grid(False)
    ax.yaxis.tick_right()
    ax.yaxis.set_label_position("right")
    ax.tick_params(axis="y", colors="white", labelsize=9, right=True, left=False)
    ax.tick_params(axis="x", colors="white", labelsize=9)

    import matplotlib.dates as mdates
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b '%y"))
    ax.xaxis.set_major_locator(mdates.AutoDateLocator())

    for spine in ax.spines.values():
        spine.set_edgecolor(C_GRID)
    ax.spines["top"].set_visible(False)
    ax.spines["left"].set_visible(False)

    pad = (max_y - min_y) * 0.05 or 0.1
    ax.set_ylim(min_y - pad * 0.5, max_y + pad)

    # Legend labels (top-left)
    ax.text(0.01, 0.97, f"{label}  {last_y:.2f}",
            transform=ax.transAxes, color=C_AMBER, fontsize=9,
            va="top", fontfamily="monospace", zorder=6)
    if avg1y is not None:
        ax.text(0.01, 0.78, f"1Y Avg  {avg1y:.2f}",
                transform=ax.transAxes, color="white", fontsize=9,
                va="top", fontfamily="monospace", zorder=6)
    if ind_ys:
        ax.text(0.01, 0.59, f"Industry  {ind_ys[-1]:.2f}",
                transform=ax.transAxes, color=C_CYAN, fontsize=9,
                va="top", fontfamily="monospace", zorder=6)

    # No tight_layout — use explicit margins so axes fill the image with no blank top area
    fig.subplots_adjust(top=0.99, bottom=0.12, left=0.01, right=0.93)

    buf = BytesIO()
    fig.savefig(buf, format="png", facecolor=C_BG, dpi=dpi)
    plt.close(fig)

    png_bytes = buf.getvalue()
    b64  = base64.b64encode(png_bytes).decode("ascii")
    size = len(png_bytes)
    name = base64.b64encode(b"metric.png").decode("ascii")
    # Use height_rows-1: iTerm2 occupies N+1 terminal rows for height=N,
    # so this keeps the image within its reserved flat-list blank rows.
    return f"\033]1337;File=name={name};size={size};inline=1;width={width_cols};height={height_rows - 1};preserveAspectRatio=0:{b64}\007"


def render_fund_bar_chart(
    periods: list, stock_values: list, label: str, is_pct: bool,
    width_cols: int, height_rows: int, industry_series: list = None,
) -> str:
    """Render a side-by-side bar chart comparing stock vs industry for a quarterly metric.
    periods are in descending order; the chart displays them oldest→newest (left→right).
    Returns an iTerm2 inline image escape sequence string.
    """
    from io import BytesIO
    import base64
    import numpy as np
    from datetime import datetime

    C_BG    = "#0A1628"
    C_AMBER = "#FFA028"
    C_CYAN  = "#00BFBF"
    C_GRID  = "#1E2E48"

    # Reverse to ascending order for chart (oldest left, newest right)
    periods_asc = list(reversed(periods))
    vals_asc    = list(reversed(stock_values))

    # Match industry series to each period (nearest date <= period)
    ind_vals: list = []
    if industry_series:
        sorted_ind  = sorted(industry_series, key=lambda s: s["date"])
        ind_dates   = [s["date"] for s in sorted_ind]
        ind_values  = [s["value"] for s in sorted_ind]
        for p in periods_asc:
            best = None
            for d, v in zip(reversed(ind_dates), reversed(ind_values)):
                if d <= p:
                    best = v
                    break
            ind_vals.append(best)
    has_industry = any(v is not None for v in ind_vals)

    # Short period labels: "Sep '25"
    x_labels = []
    for p in periods_asc:
        try:
            dt = datetime.strptime(p[:10], "%Y-%m-%d")
            x_labels.append(dt.strftime("%b '%y"))
        except Exception:
            x_labels.append(p[:7])

    dpi   = 100
    fig_w = max(4.0, width_cols * 0.10)
    fig_h = max(1.5, height_rows * 0.18)

    fig, ax = plt.subplots(figsize=(fig_w, fig_h), dpi=dpi)
    fig.patch.set_facecolor(C_BG)
    ax.set_facecolor(C_BG)

    n = len(periods_asc)
    x = np.arange(n)

    stock_ys = [v if v is not None else 0.0 for v in vals_asc]
    if has_industry:
        bar_w  = 0.38
        ind_ys = [v if v is not None else 0.0 for v in ind_vals]
        ax.bar(x - bar_w / 2, stock_ys, bar_w, color="white", alpha=0.85, zorder=3)
        ax.bar(x + bar_w / 2, ind_ys,   bar_w, color=C_CYAN,  alpha=0.75, zorder=3)
    else:
        ind_ys = []
        ax.bar(x, stock_ys, 0.6, color="white", alpha=0.85, zorder=3)

    # Thin x-axis labels so they don't overlap when there are many data points.
    # Each label is ~55px wide at the current DPI/font; space them accordingly.
    import math
    max_labels = max(4, int(fig_w * dpi / 55))
    step = max(1, math.ceil(n / max_labels))
    visible_ticks  = [i for i in range(n) if i % step == 0]
    visible_labels = [x_labels[i] for i in visible_ticks]
    ax.set_xticks(visible_ticks)
    ax.set_xticklabels(visible_labels, rotation=0, ha="center")
    ax.tick_params(axis="x", colors="white", labelsize=8)
    ax.tick_params(axis="y", colors="white", labelsize=9, right=True, left=False)
    ax.yaxis.tick_right()
    ax.yaxis.set_label_position("right")

    if is_pct:
        ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v*100:.1f}%"))
    else:
        ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v:.2f}x"))

    ax.yaxis.grid(True, color=C_GRID, linewidth=0.5, linestyle="-")
    ax.set_axisbelow(True)
    ax.xaxis.grid(False)
    for spine in ax.spines.values():
        spine.set_edgecolor(C_GRID)
    ax.spines["top"].set_visible(False)
    ax.spines["left"].set_visible(False)

    # Value formatters for legend
    def _fmt(v):
        if v is None: return "—"
        return f"{v*100:.1f}%" if is_pct else f"{v:.2f}x"

    last_stock = next((v for v in reversed(vals_asc) if v is not None), None)
    ax.text(0.01, 0.97, f"{label}  {_fmt(last_stock)}",
            transform=ax.transAxes, color=C_AMBER, fontsize=9,
            va="top", fontfamily="monospace", zorder=6)
    if has_industry:
        last_ind = next((v for v in reversed(ind_vals) if v is not None), None)
        ax.text(0.01, 0.78, f"Industry  {_fmt(last_ind)}",
                transform=ax.transAxes, color=C_CYAN, fontsize=9,
                va="top", fontfamily="monospace", zorder=6)

    fig.subplots_adjust(top=0.99, bottom=0.15, left=0.01, right=0.93)

    buf = BytesIO()
    fig.savefig(buf, format="png", facecolor=C_BG, dpi=dpi)
    plt.close(fig)

    png_bytes = buf.getvalue()
    b64  = base64.b64encode(png_bytes).decode("ascii")
    size = len(png_bytes)
    name = base64.b64encode(b"fund.png").decode("ascii")
    return f"\033]1337;File=name={name};size={size};inline=1;width={width_cols};height={height_rows - 1};preserveAspectRatio=0:{b64}\007"


def process_request(req: dict) -> dict:
    """Process a single request and return a response dict."""
    req_id = req.get("id", "unknown")
    req_type = req.get("type", "")
    method = req.get("method", "")
    params = req.get("params") or {}

    try:
        if req_type == "statement":
            symbol = req["symbol"]
            data = handle_statement(symbol, method)
        elif req_type == "valuation":
            symbol = req["symbol"]
            if method == "multiples":
                data = handle_valuation_multiples(symbol, req_id=req_id)
            elif method == "fundamentals":
                data = handle_valuation_fundamentals(symbol, req_id=req_id)
            else:
                raise ValueError(f"Unknown valuation method: {method}")
        elif req_type == "ticker":
            symbol = req["symbol"]
            data = handle_ticker(symbol, method, params)
        elif req_type == "market":
            data = handle_market(method, params)
        elif req_type == "meta":
            data = handle_meta(method)
        elif req_type == "render":
            data = handle_render(method, params)
        else:
            raise ValueError(f"Unknown request type: {req_type}")

        return {"id": req_id, "success": True, "data": data}
    except Exception as e:
        return {"id": req_id, "success": False, "error": str(e), "traceback": traceback.format_exc()}


def _handle(req: dict) -> None:
    try:
        response = process_request(req)
    except Exception as e:
        response = {
            "id": req.get("id"),
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc(),
        }
    _write_line(response)


def main():
    # Signal readiness to the parent process (synchronous, before worker pool activity)
    _write_line({"ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            _write_line({"id": None, "success": False, "error": f"JSON parse error: {e}"})
            continue

        # Dispatch to worker pool — responses may arrive out of order;
        # the frontend pending Map routes by id so this is safe.
        _executor.submit(_handle, req)


if __name__ == "__main__":
    main()
