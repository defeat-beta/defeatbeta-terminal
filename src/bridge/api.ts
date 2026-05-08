/**
 * TypeScript API wrappers for all defeatbeta-api Ticker methods.
 * Each function maps directly to a Ticker class method in Python.
 */

import { bridge } from "./python";

// ─── Generic helpers ──────────────────────────────────────────────────────────

function ticker(symbol: string, method: string, params?: Record<string, unknown>) {
  return bridge.call({ type: "ticker", symbol: symbol.toUpperCase(), method, params });
}

function market(method: string, params?: Record<string, unknown>) {
  return bridge.call({ type: "market", method, params });
}

function statement(symbol: string, method: string) {
  return bridge.call({ type: "statement", symbol: symbol.toUpperCase(), method });
}

function render(method: string, params: Record<string, unknown>) {
  return bridge.call({ type: "render", method, params });
}

function valuation(symbol: string, method: string) {
  return bridge.call({ type: "valuation", symbol: symbol.toUpperCase(), method });
}

function meta(method: string) {
  return bridge.call({ type: "meta", method });
}

// ─── Meta ─────────────────────────────────────────────────────────────────────

export const getDataUpdateTime = () => meta("data_update_time") as Promise<string>;
export const getVersion        = () => meta("version") as Promise<string>;

// ─── Chart Rendering ──────────────────────────────────────────────────────────

export const getValuationMultiples    = (symbol: string, onProgress?: (msg: string) => void) =>
  bridge.call({ type: "valuation", symbol: symbol.toUpperCase(), method: "multiples" }, onProgress);
export const getValuationFundamentals = (symbol: string, onProgress?: (msg: string) => void) =>
  bridge.call({ type: "valuation", symbol: symbol.toUpperCase(), method: "fundamentals" }, onProgress);

export const renderMetricChart = (
  series: Array<{ date: string; value: number }>,
  industrySeries: Array<{ date: string; value: number }>,
  avg1y: number | null,
  label: string,
  rangeYears: number,
  widthCols: number,
  heightRows: number,
) => render("metric_chart", {
  series, industry_series: industrySeries, avg1y,
  label, range_years: rangeYears, width: widthCols, height: heightRows,
}) as Promise<string>;

export const renderFundBarChart = (
  periods: string[],
  stockValues: (number | null)[],
  industrySeries: Array<{ date: string; value: number }>,
  label: string,
  isPct: boolean,
  widthCols: number,
  heightRows: number,
) => render("fund_bar_chart", {
  periods, stock_values: stockValues, industry_series: industrySeries,
  label, is_pct: isPct, width: widthCols, height: heightRows,
}) as Promise<string>;

export const renderPriceChart = (
  prices: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>,
  widthCols: number,
  heightRows: number,
  earnings: string[] = [],
  dividends: string[] = [],
  splits: Array<{ date: string; factor: string }> = [],
) => render("price_chart", { prices, width: widthCols, height: heightRows, earnings, dividends, splits }) as Promise<{ image: string; xs_cols: number[] }>;

// ─── Stock Info ───────────────────────────────────────────────────────────────

export const getInfo = (symbol: string) => ticker(symbol, "info");
export const getPrice = (symbol: string) => ticker(symbol, "price");
export const getOfficers = (symbol: string) => ticker(symbol, "officers");
export const getShares = (symbol: string) => ticker(symbol, "shares");
export const getSplits = (symbol: string) => ticker(symbol, "splits");
export const getDividends = (symbol: string) => ticker(symbol, "dividends");
export const getCalendar = (symbol: string) => ticker(symbol, "calendar");
export const getBeta = (symbol: string, period = "5y", benchmark = "SPY") =>
  ticker(symbol, "beta", { period, benchmark });

// ─── Financial Statements ─────────────────────────────────────────────────────

export const getAnnualIncomeStatement    = (symbol: string) => statement(symbol, "annual_income_statement");
export const getQuarterlyIncomeStatement = (symbol: string) => statement(symbol, "quarterly_income_statement");
export const getAnnualBalanceSheet       = (symbol: string) => statement(symbol, "annual_balance_sheet");
export const getQuarterlyBalanceSheet    = (symbol: string) => statement(symbol, "quarterly_balance_sheet");
export const getAnnualCashFlow           = (symbol: string) => statement(symbol, "annual_cash_flow");
export const getQuarterlyCashFlow        = (symbol: string) => statement(symbol, "quarterly_cash_flow");

// ─── Valuation ────────────────────────────────────────────────────────────────

export const getTtmPE = (symbol: string) => ticker(symbol, "ttm_pe");
export const getPBRatio = (symbol: string) => ticker(symbol, "pb_ratio");
export const getPSRatio = (symbol: string) => ticker(symbol, "ps_ratio");
export const getPEGRatio = (symbol: string) => ticker(symbol, "peg_ratio");
export const getEnterpriseValue = (symbol: string) => ticker(symbol, "enterprise_value");
export const getEnterpriseToEbitda = (symbol: string) => ticker(symbol, "enterprise_to_ebitda");
export const getEnterpriseToRevenue = (symbol: string) => ticker(symbol, "enterprise_to_revenue");
export const getMarketCapitalization = (symbol: string) => ticker(symbol, "market_capitalization");

// ─── TTM Metrics ──────────────────────────────────────────────────────────────

export const getTtmRevenue = (symbol: string) => ticker(symbol, "ttm_revenue");
export const getTtmEbitda = (symbol: string) => ticker(symbol, "ttm_ebitda");
export const getTtmFcf = (symbol: string) => ticker(symbol, "ttm_fcf");
export const getTtmEps = (symbol: string) => ticker(symbol, "ttm_eps");
export const getTtmNetIncome = (symbol: string) => ticker(symbol, "ttm_net_income_common_stockholders");

// ─── Profitability ────────────────────────────────────────────────────────────

export const getAnnualGrossMargin = (symbol: string) => ticker(symbol, "annual_gross_margin");
export const getQuarterlyGrossMargin = (symbol: string) => ticker(symbol, "quarterly_gross_margin");
export const getAnnualOperatingMargin = (symbol: string) => ticker(symbol, "annual_operating_margin");
export const getQuarterlyOperatingMargin = (symbol: string) => ticker(symbol, "quarterly_operating_margin");
export const getAnnualNetMargin = (symbol: string) => ticker(symbol, "annual_net_margin");
export const getQuarterlyNetMargin = (symbol: string) => ticker(symbol, "quarterly_net_margin");
export const getAnnualEbitdaMargin = (symbol: string) => ticker(symbol, "annual_ebitda_margin");
export const getQuarterlyEbitdaMargin = (symbol: string) => ticker(symbol, "quarterly_ebitda_margin");
export const getAnnualFcfMargin = (symbol: string) => ticker(symbol, "annual_fcf_margin");
export const getQuarterlyFcfMargin = (symbol: string) => ticker(symbol, "quarterly_fcf_margin");

// ─── Returns & Efficiency ─────────────────────────────────────────────────────

export const getROE = (symbol: string) => ticker(symbol, "roe");
export const getROA = (symbol: string) => ticker(symbol, "roa");
export const getROIC = (symbol: string) => ticker(symbol, "roic");
export const getROCE = (symbol: string) => ticker(symbol, "roce");
export const getAssetTurnover = (symbol: string) => ticker(symbol, "asset_turnover");
export const getEquityMultiplier = (symbol: string) => ticker(symbol, "equity_multiplier");
export const getDebtToEquity = (symbol: string) => ticker(symbol, "debt_to_equity");

// ─── Growth ───────────────────────────────────────────────────────────────────

export const getAnnualRevenueGrowth = (symbol: string) => ticker(symbol, "annual_revenue_yoy_growth");
export const getQuarterlyRevenueGrowth = (symbol: string) => ticker(symbol, "quarterly_revenue_yoy_growth");
export const getAnnualOperatingIncomeGrowth = (symbol: string) => ticker(symbol, "annual_operating_income_yoy_growth");
export const getQuarterlyOperatingIncomeGrowth = (symbol: string) => ticker(symbol, "quarterly_operating_income_yoy_growth");
export const getAnnualNetIncomeGrowth = (symbol: string) => ticker(symbol, "annual_net_income_yoy_growth");
export const getQuarterlyNetIncomeGrowth = (symbol: string) => ticker(symbol, "quarterly_net_income_yoy_growth");
export const getAnnualEbitdaGrowth = (symbol: string) => ticker(symbol, "annual_ebitda_yoy_growth");
export const getQuarterlyEbitdaGrowth = (symbol: string) => ticker(symbol, "quarterly_ebitda_yoy_growth");
export const getAnnualFcfGrowth = (symbol: string) => ticker(symbol, "annual_fcf_yoy_growth");
export const getQuarterlyFcfGrowth = (symbol: string) => ticker(symbol, "quarterly_fcf_yoy_growth");
export const getQuarterlyEpsGrowth = (symbol: string) => ticker(symbol, "quarterly_eps_yoy_growth");
export const getQuarterlyTtmEpsGrowth = (symbol: string) => ticker(symbol, "quarterly_ttm_eps_yoy_growth");

// ─── DCF & WACC ───────────────────────────────────────────────────────────────

export const getDCF = (symbol: string) => ticker(symbol, "dcf");
export const getDCFData = (symbol: string) => ticker(symbol, "dcf_data");
export const getWACC = (symbol: string) => ticker(symbol, "wacc");

// ─── Revenue Breakdown ────────────────────────────────────────────────────────

export const getRevenueBySegment = (symbol: string) => ticker(symbol, "revenue_by_segment");
export const getRevenueByGeography = (symbol: string) => ticker(symbol, "revenue_by_geography");
export const getRevenueByProduct = (symbol: string) => ticker(symbol, "revenue_by_product");

// ─── Earnings Call Transcripts ────────────────────────────────────────────────

export const getTranscriptsList = (symbol: string) =>
  ticker(symbol, "earning_call_transcripts.get_transcripts_list");

export const getTranscript = (symbol: string, fiscalYear: number, fiscalQuarter: number) =>
  ticker(symbol, "earning_call_transcripts.get_transcript", {
    fiscal_year: fiscalYear,
    fiscal_quarter: fiscalQuarter,
  });

// ─── SEC Filings ──────────────────────────────────────────────────────────────

export const getSecFilings = (symbol: string) => ticker(symbol, "sec_filing");

// ─── News ─────────────────────────────────────────────────────────────────────

export const getNewsList = (symbol: string) => ticker(symbol, "news.get_news_list");
/** Lightweight news list — drops the inline `news` paragraphs column on the
 *  Python side (kept under 1 MB even for tickers with thousands of articles)
 *  and returns rows sorted by report_date descending. */
export const getNewsListMeta = (symbol: string) => ticker(symbol, "news.get_news_list_meta");
export const getNews = (symbol: string, uuid: string) => ticker(symbol, "news.get_news", { uuid });

// ─── Industry Comparison ──────────────────────────────────────────────────────

export const getIndustryTtmPE = (symbol: string) => ticker(symbol, "industry_ttm_pe");
export const getIndustryPBRatio = (symbol: string) => ticker(symbol, "industry_pb_ratio");
export const getIndustryPSRatio = (symbol: string) => ticker(symbol, "industry_ps_ratio");
export const getIndustryROE = (symbol: string) => ticker(symbol, "industry_roe");
export const getIndustryROA = (symbol: string) => ticker(symbol, "industry_roa");
export const getIndustryGrossMargin = (symbol: string) => ticker(symbol, "industry_quarterly_gross_margin");
export const getIndustryEbitdaMargin = (symbol: string) => ticker(symbol, "industry_quarterly_ebitda_margin");
export const getIndustryNetMargin = (symbol: string) => ticker(symbol, "industry_quarterly_net_margin");
export const getIndustryAssetTurnover = (symbol: string) => ticker(symbol, "industry_asset_turnover");
export const getIndustryEquityMultiplier = (symbol: string) => ticker(symbol, "industry_equity_multiplier");

// ─── Market-level Data ────────────────────────────────────────────────────────

export const getSP500CAGRReturns = (years: number) => market("sp500_cagr_returns", { years });
export const getSP500CAGRReturnsRolling = (years: number) => market("sp500_cagr_returns_rolling", { years });
export const getSP500HistoricalAnnualReturns = () => market("sp500_historical_annual_returns");
