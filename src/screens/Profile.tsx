/**
 * Profile screen — Bloomberg DES (Company Description) style.
 * Shows business summary, company details, and key executives.
 */

import { createSignal, createEffect, onMount, onCleanup, Show, For } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { getInfo, getOfficers } from "../bridge/api";

interface Props {
  ticker: string;
}

const C_AMBER = "#FFA028";
const C_CYAN  = "cyan";

function wordWrap(text: string, width: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? current + " " + word : word;
    if (candidate.length <= width) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function fmtEmployees(n: number | null | undefined): string {
  if (n == null) return "N/A";
  return n.toLocaleString();
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export default function Profile(props: Props) {
  const dims = useTerminalDimensions();

  const [loading,       setLoading]       = createSignal(true);
  const [error,         setError]         = createSignal("");
  const [profile,       setProfile]       = createSignal<Record<string, any>>({});
  const [officers,      setOfficers]      = createSignal<any[]>([]);
  const [progressLines, setProgressLines] = createSignal<string[]>([]);

  createEffect(() => {
    const t = props.ticker;
    if (!t) return;
    setLoading(true);
    setError("");
    const _labels = ["info()", "officers()"];
    setProgressLines(_labels.map(l => `Fetching ${l}…`));
    const _t0s = _labels.map(() => Date.now());
    const _done = (i: number) => {
      const s = ((Date.now() - _t0s[i]) / 1000).toFixed(1);
      setProgressLines(ls => ls.map((l, j) => j === i ? `✓ ${_labels[i]}  ${s}s` : l));
    };
    Promise.all([
      getInfo(t).then(r => { _done(0); return r; }),
      getOfficers(t).then(r => { _done(1); return r; }),
    ]).then(([prof, off]: any) => {
      // getInfo returns an array of records (serialised DataFrame); take first row
      const row = Array.isArray(prof) ? (prof[0] ?? {}) : (prof ?? {});
      setProfile(row);
      setOfficers(Array.isArray(off) ? off : []);
      setLoading(false);
    }).catch((e: unknown) => {
      setError(String(e));
      setLoading(false);
    });
  });

  const innerW = () => Math.max(40, dims().width - 4);

  // Live clock — updates every second
  const [dateStr, setDateStr] = createSignal("");
  const [timeStr, setTimeStr] = createSignal("");
  onMount(() => {
    const update = () => {
      const now = new Date();
      setDateStr(now.toISOString().slice(0, 10));
      setTimeStr(now.toTimeString().slice(0, 8));
    };
    update();
    const clockId = setInterval(update, 1000);
    onCleanup(() => clearInterval(clockId));
  });

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>

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

      <Show when={!loading() && !error()}>
        {(() => {
          const p        = profile();
          const name     = ((p.symbol ?? props.ticker) as string).toUpperCase();
          const country  = (p.country ?? "") as string;
          const sector   = (p.sector   ?? "") as string;
          const industry = (p.industry ?? "") as string;
          const summary  = (p.long_business_summary ?? "") as string;
          const addrLine = [p.address, p.city, p.zip].filter(Boolean).join(", ");
          const phone    = (p.phone   ?? "") as string;
          const website  = ((p.web_site ?? "") as string).replace(/^https?:\/\//, "");
          const employees = fmtEmployees(p.full_time_employees);

          const descW     = Math.max(30, innerW());
          const descLines = wordWrap(summary, descW);
          // Label prefix is always 10 chars; left column is 45% of available width
          const LABEL_W = 10;
          const leftW   = Math.max(LABEL_W + 20, Math.floor(innerW() * 0.45));
          const rightW  = innerW() - leftW - 3;   // 3 = separator width
          const valW    = leftW - LABEL_W;         // value space in left column
          const divider = "─".repeat(innerW());

          return (
            <box flexDirection="column">

              {/* ── Company header (Bloomberg style, single line) ── */}
              <box flexDirection="row" height={1}>
                <text style={{ fg: C_AMBER }}>{`${name} US EQUITY`}</text>
                <Show when={!!sector}>
                  <text style={{ fg: "white" }}>{`  ·  ${sector}`}</text>
                </Show>
                <Show when={!!industry}>
                  <text style={{ fg: "white" }}>{`  ·  ${industry}  ·`}</text>
                </Show>
                <text style={{ fg: "white" }}>{`  ${dateStr()}  ${timeStr()}`}</text>
              </box>

              <text style={{ fg: "gray" }}>{divider}</text>

              {/* ── Description ── */}
              <text style={{ fg: C_CYAN }}>{"DESCRIPTION"}</text>
              <For each={descLines}>
                {(line: string) => <text style={{ fg: "white" }}>{line}</text>}
              </For>

              <text style={{ fg: "gray" }}>{divider}</text>

              {/* ── Two-column: Company Info | Key Executives ── */}
              <box flexDirection="row">

                {/* Left: Company Information */}
                <box flexDirection="column" width={leftW}>
                  <text style={{ fg: C_CYAN }}>{"COMPANY INFORMATION"}</text>
                  <text style={{ fg: "gray" }}>{"─".repeat(19)}</text>

                  <Show when={!!addrLine}>
                    <box flexDirection="row" height={1}>
                      <text style={{ fg: C_AMBER }}>{"HQ        "}</text>
                      <text style={{ fg: "white" }}>{truncate(addrLine, valW)}</text>
                    </box>
                  </Show>

                  <Show when={!!country}>
                    <box flexDirection="row" height={1}>
                      <text style={{ fg: C_AMBER }}>{"          "}</text>
                      <text style={{ fg: "white" }}>{country}</text>
                    </box>
                  </Show>

                  <Show when={!!phone}>
                    <box flexDirection="row" height={1}>
                      <text style={{ fg: C_AMBER }}>{"Phone     "}</text>
                      <text style={{ fg: "white" }}>{phone}</text>
                    </box>
                  </Show>

                  <Show when={!!website}>
                    <box flexDirection="row" height={1}>
                      <text style={{ fg: C_AMBER }}>{"Website   "}</text>
                      <text style={{ fg: "white" }}>{truncate(website, valW)}</text>
                    </box>
                  </Show>

                  <box flexDirection="row" height={1}>
                    <text style={{ fg: C_AMBER }}>{"Employees "}</text>
                    <text style={{ fg: "white" }}>{employees}</text>
                  </box>
                </box>

                {/* Vertical separator */}
                <box flexDirection="column" width={3}>
                  <text style={{ fg: "gray" }}>{"   "}</text>
                  <text style={{ fg: "gray" }}>{"   "}</text>
                  <For each={officers()}>
                    {() => <text style={{ fg: "gray" }}>{"│  "}</text>}
                  </For>
                </box>

                {/* Right: Key Executives */}
                <box flexDirection="column" flexGrow={1}>
                  <text style={{ fg: C_CYAN }}>{"KEY EXECUTIVES"}</text>
                  <text style={{ fg: "gray" }}>{"─".repeat(14)}</text>
                  {(() => {
                    // nameW = longest name + 2 padding, capped at half the right column
                    const maxNameLen = Math.max(0, ...officers().map((o: any) => (o.name ?? "").length));
                    const nameW = Math.min(maxNameLen + 2, Math.floor(rightW * 0.5));
                    const AGE_W = 5;   // "  " + up to 3-digit age
                    return (
                    <For each={officers()}>
                      {(o: any) => {
                      const titleW = Math.max(10, rightW - nameW - AGE_W);
                      const nm     = truncate(o.name  ?? "", nameW).padEnd(nameW);
                      const title  = truncate(o.title ?? "", titleW).padEnd(titleW);
                      const age    = o.age != null ? `  ${o.age}` : "";
                      return (
                        <box flexDirection="row" height={1}>
                          <text style={{ fg: C_AMBER }}>{nm}</text>
                          <text style={{ fg: "white" }}>{title}</text>
                          <text style={{ fg: "white" }}>{age}</text>
                        </box>
                      );
                    }}
                  </For>
                    );
                  })()}
                </box>

              </box>
            </box>
          );
        })()}
      </Show>

    </box>
  );
}
