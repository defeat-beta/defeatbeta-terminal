# Contributing to defeatbeta-terminal

Thanks for thinking about contributing! This is a small but ambitious
project — a Bloomberg-style TUI for stock analysis — and any kind of help
moves it forward: bug reports, UX feedback, docs improvements, new tabs,
performance work. Code is just one of many ways.

This guide is intentionally short. Skim it, then dive in.

---

## Project structure

```
defeatbeta-terminal/
├── src/
│   ├── App.tsx              # tab routing + global keyboard
│   ├── main.tsx             # entrypoint
│   ├── bridge/              # Python sidecar wrapper (newline-delimited JSON-RPC)
│   ├── components/          # shared UI bits (status bar, …)
│   └── screens/             # one file per tab — each is self-contained
│       ├── Overview.tsx     #  1: price chart + volume
│       ├── Profile.tsx      #  2: company description, executives
│       ├── Financials.tsx   #  3: IS / BS / CF + revenue breakdown
│       ├── Valuation.tsx    #  4: multiples, fundamentals
│       ├── Growth.tsx       #  5: YoY growth metrics
│       ├── Profitability.tsx#  6: margin metrics
│       ├── DCF.tsx          #  7: editable DCF model
│       ├── News.tsx         #  8: transcripts + financial news
│       └── SecFilings.tsx   #  9: EDGAR filing browser
├── scripts/
│   └── bridge.py            # long-lived Python process, calls defeatbeta-api
├── docs/screenshots/        # README assets
└── README.md
```

**Design philosophy**: each tab is a leaf component owning its own state.
Cross-tab state lives in `App.tsx` (current ticker, search mode). The Python
bridge is a thin RPC server — keep heavy data work in Python, keep rendering
work in TypeScript.

---

## Local setup

See [README.md → Quick start](./README.md#quick-start). TL;DR:

```bash
bun install        # JS/TS deps
bun run setup     # creates .venv and installs defeatbeta-api + matplotlib
bun run dev      # or:  http_proxy="http://127.0.0.1:8118" bun run dev
```

Before pushing, please run:

```bash
bunx tsc --noEmit  # type check — must pass with exit 0
bun run dev        # smoke test — verify the tab(s) you touched still work
```

There's no automated test suite yet (TUIs are awkward to test). Manual
verification on at least one ticker is the bar.

---

## Branch & commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/) loosely:

- `feat:` — new user-facing feature
- `fix:` — bug fix
- `refactor:` — code restructuring without behavior change
- `docs:` — README / CONTRIBUTING / comments
- `chore:` — tooling, deps, CI
- `perf:` — performance improvement

Branch names: anything reasonable (`feat/watchlist`, `fix/dcf-formula-bar`).
Don't push directly to `main` — go through a PR.

---

## Pull request workflow

1. Fork the repo, create a branch off `main`.
2. Make your change. Keep PRs focused — one bug fix or one feature per PR is
   easier to review than five.
3. Run typecheck + smoke test (above).
4. Open a PR. The template will prompt you for the basics. **Screenshots
   for any UI change are very welcome** — most reviewers can't tell what a
   layout tweak looks like without seeing it.
5. Be patient with reviews; this is a small project. Feel free to ping if
   nothing happens for a week.

For larger changes (new tab, big refactor, breaking API change), please
**open an issue first** so we can align on the approach before you spend a
weekend on it.

---

## Reporting issues

Please use the issue templates:

- **Bug report** — anything that's broken or behaves wrong. The template
  asks for terminal, OS, ticker, steps; please fill it in. Bugs without
  reproduction steps are very hard to fix.
- **Feature request** — something missing you'd like to see.

Screenshots help a lot, especially for layout / rendering issues.

---

## Code style

This project intentionally has **no ESLint/Prettier enforcement** right now.
The codebase is small enough that "look at the surrounding code and match
the style" is the rule. A few light conventions:

- **TypeScript strict mode** is on; please don't sprinkle `any`.
- **camelCase** for variables / functions, **PascalCase** for components.
- **Two-space indent**, single quotes for TS imports — match the file
  you're editing.
- **Comments**: explain *why* (non-obvious constraints, workarounds), not
  *what* — well-named identifiers already do that.
- Each tab is a single file; don't split prematurely.

If/when the project gets bigger we'll add real linting.

---

## Where to start

Look for issues labelled
[`good first issue`](https://github.com/defeat-beta/defeatbeta-terminal/labels/good%20first%20issue)
or [`help wanted`](https://github.com/defeat-beta/defeatbeta-terminal/labels/help%20wanted).
Or pick a tab you'd like to improve and propose a change in an issue.

---

## License

By contributing, you agree that your contributions will be licensed under
the same [Apache License 2.0](./LICENSE) as the project.
