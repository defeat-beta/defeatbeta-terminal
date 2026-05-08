# defeatbeta-terminal

A **Bloomberg-style terminal in your terminal** — a TUI client for stock
analysis, powered by [`defeatbeta-api`][api] and rendered with [OpenTUI][opentui]
+ [Solid.js][solid]. Nine tabs cover everything from price charts to SEC
filings, with the keyboard model and visual density of a real trading terminal.

> **Status:** v0.0.x, actively developed. macOS-tested; Linux should work, Windows
> via WSL only.

[api]: https://github.com/defeat-beta/defeatbeta-api
[opentui]: https://github.com/sst/opentui
[solid]: https://www.solidjs.com/

---

## Screenshot

<!-- TODO: replace with a hero screenshot. Recommended: Overview tab on AAPL with the price chart visible. -->

![overview](docs/screenshots/overview.png)

---

## What's inside

Nine tabs, each Bloomberg-coded:

| # | Tab | What it shows | Highlights |
|---|---|---|---|
| 1 | **Overview** | Price line + volume panel, MA10/50/200, earnings ▼ / dividends $ / split ⇅ markers | Rendered by matplotlib → piped into the terminal as an iTerm2 inline image; ↑↓ adjusts range, ←→ pans |
| 2 | **Profile** | Company description, address, key executives | Bloomberg DES-style |
| 3 | **Financials** | Income Statement / Balance Sheet / Cash Flow with hierarchy + YoY | `s` switches statement, `p` flips quarterly/annual, Enter on **Total Revenue** expands a segment / geography breakdown panel |
| 4 | **Valuation** | P/E (TTM), P/S, P/B, PEG, EV/EBITDA, EV/Revenue + industry overlays | Click into a row → inline chart (multiples vs industry) |
| 5 | **Growth** | YoY growth for Revenue / OpInc / EBITDA / Net Income / FCF / EPS | Quarterly/Annual toggle, click a row → chart |
| 6 | **Profitability** | Gross / Operating / EBITDA / Net / FCF margins, with industry comparison | Bar chart per metric |
| 7 | **DCF** | Editable 3-stage DCF (growth, discount rate, terminal) | Tab cycles between editable cells, Enter to edit, formula bar at the bottom |
| 8 | **News** | Earnings-call transcripts (lazy-loaded paragraphs) + financial news cards (paginated, lazy-loaded summaries) | Tab toggles sub-mode; ⏎ enters reading mode; URLs are clickable in supporting terminals |
| 9 | **SEC Filings** | EDGAR submissions card list, filtered by importance | Tab toggles **Important** (10-K/10-Q/8-K/DEF 14A/etc.) ↔ **All forms**; ⏎ opens EDGAR in browser |

Global keys: `1`-`9` switch tabs, `/` or `:` triggers ticker search, `q` quits.

<!-- TODO: per-tab screenshots — list of placeholders below; replace with real images. -->

<details>
<summary>Per-tab screenshots</summary>

**1. Overview**

![Overview](docs/screenshots/01-overview.png)

**2. Profile**

![Profile](docs/screenshots/02-profile.png)

**3. Financials**

![Financials](docs/screenshots/03-financials.png)

**4. Valuation**

![Valuation](docs/screenshots/04-valuation.png)

**5. Growth**

![Growth](docs/screenshots/05-growth.png)

**6. Profitability**

![Profitability](docs/screenshots/06-profitability.png)

**7. DCF**

![DCF](docs/screenshots/07-dcf.png)

**8. News**

![News](docs/screenshots/08-news.png)

**9. SEC Filings**

![SEC Filings](docs/screenshots/09-sec-filings.png)

</details>

---

## Quick start

### Prerequisites

- **[Bun][bun]** ≥ 1.1 (the JS/TS runtime)
- **[uv][uv]** (Python package manager)
- **Python** 3.11+
- **Terminal that supports iTerm2 inline images** for the price chart on the
  Overview tab (iTerm2, WezTerm, kitty all work). Other tabs work in any
  terminal.
- Optional: an HTTP proxy if `huggingface.co` (the data host) isn't directly
  reachable from your network.

[bun]: https://bun.sh/
[uv]: https://github.com/astral-sh/uv

### Install + run

```bash
git clone https://github.com/defeat-beta/defeatbeta-terminal.git
cd defeatbeta-terminal

bun install        # JS/TS deps
bun run setup      # creates .venv and installs defeatbeta-api + matplotlib

# Run (set http_proxy if needed):
bun run dev
# or with a proxy:
http_proxy="http://127.0.0.1:8118" bun run dev
```

Then press `/` to search a ticker (e.g. `AAPL`, `NVDA`, `TSLA`), `1`-`9` to
switch tabs, `q` to quit.

### Build a standalone binary

```bash
bun run build      # → ./defeatbeta (compiled with `bun build --compile`)
```

The binary still needs Python + the `defeatbeta-api` package on the system
(it spawns `scripts/bridge.py`). True single-file distribution is on the
roadmap.

---

## Architecture

```
┌──────────────────────────────┐         ┌────────────────────────────┐
│  Bun + OpenTUI + Solid.js    │  JSON   │  Python bridge process     │
│  (TypeScript, the TUI)       │ ──────► │  scripts/bridge.py          │
│  src/screens/*.tsx           │ ◄────── │  - DuckDB + parquet (HF)    │
│  src/bridge/api.ts           │         │  - matplotlib chart render  │
└──────────────────────────────┘         └────────────────────────────┘
```

- **Frontend**: [OpenTUI][opentui] (the renderer) bound to Solid.js for
  reactivity. Each tab is one component in `src/screens/`.
- **Backend**: a long-lived Python subprocess (`scripts/bridge.py`) speaks
  newline-delimited JSON-RPC over stdin/stdout. Requests fan out to a
  thread pool; matplotlib chart rendering is serialized via a lock.
- **Data source**: [`defeatbeta-api`][api] under the hood, which reads
  parquet files hosted on Hugging Face via DuckDB's httpfs cache.

---

## Roadmap

- [ ] Cross-platform pre-built binaries via GitHub Actions matrix
  (macOS arm64 / x86_64, Linux x86_64 / arm64)
- [ ] Drop the Python sidecar — rewrite chart rendering and data layer in
  pure JS/TS so the compiled binary truly runs standalone
- [ ] Streaming / live-tick mode for the price tab
- [ ] Watchlist / multi-ticker compare view
- [ ] Configurable color themes
- [ ] Windows native support (currently WSL only)

---

## Contributing

Contributions welcome — issues, PRs, and ideas. See [CONTRIBUTING.md](./CONTRIBUTING.md)
(coming soon) for the workflow. Quick pointers in the meantime:

- The fastest way to find work is the [`good first issue`][gfi] label.
- Each tab is a self-contained component; pick one and improve it.
- Bug reports: please include your terminal, OS, ticker, and a screenshot.

[gfi]: https://github.com/defeat-beta/defeatbeta-terminal/labels/good%20first%20issue

---

## Credits

- Data: [`defeatbeta-api`][api] — column-pruned, lazy-loaded reads of the
  Yahoo Finance + SEC EDGAR mirror hosted on Hugging Face Datasets.
- Rendering: [OpenTUI][opentui] — the modern TUI framework that makes box-/flex-style
  layout actually pleasant in a terminal.
- Reactivity: [Solid.js][solid] — fine-grained reactivity, React-flavored DSL.
- Inspiration: Bloomberg Terminal's keyboard-first information density.

---

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
