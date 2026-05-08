/**
 * Root application component.
 * Handles tab switching, ticker search, and global keyboard navigation.
 */

import { createSignal, onMount, Switch, Match } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import StatusBar from "./components/StatusBar";
import Overview   from "./screens/Overview";
import Profile    from "./screens/Profile";
import Financials from "./screens/Financials";
import Valuation  from "./screens/Valuation";
import Growth          from "./screens/Growth";
import Profitability   from "./screens/Profitability";
import DCFScreen       from "./screens/DCF";
import News            from "./screens/News";
import SecFilings      from "./screens/SecFilings";
import { bridge } from "./bridge/python";
import { getDataUpdateTime, getVersion } from "./bridge/api";

const TABS = [
  { key: "1", label: "Overview" },
  { key: "2", label: "Profile" },
  { key: "3", label: "Financials" },
  { key: "4", label: "Valuation" },
  { key: "5", label: "Growth" },
  { key: "6", label: "Profitability" },
  { key: "7", label: "DCF" },
  { key: "8", label: "News" },
  { key: "9", label: "Sec Filings" },
];

export default function App() {
  const dims = useTerminalDimensions();
  const [tab, setTab] = createSignal(1);
  const [ticker, setTicker] = createSignal("AAPL");
  const [searchMode, setSearchMode] = createSignal(false);
  const [searchInput, setSearchInput] = createSignal("");
  // Set by inline editors inside child screens (e.g., DCF cell edit) so global
  // hotkeys (digit tab switch, q quit, / search) don't steal keystrokes meant
  // for the editor.
  const [inlineEditing, setInlineEditing] = createSignal(false);
  const [updateTime, setUpdateTime] = createSignal("");
  const [apiVersion, setApiVersion] = createSignal("");

  onMount(async () => {
    const [time, ver] = await Promise.allSettled([getDataUpdateTime(), getVersion()]);
    setUpdateTime(time.status === "fulfilled" ? time.value : "unknown");
    setApiVersion(ver.status  === "fulfilled" ? ver.value  : "");
  });

  useKeyboard((key: any) => {
    // Search mode: capture all input
    if (searchMode()) {
      if (key.name === "return" || key.name === "enter") {
        const t = searchInput().trim().toUpperCase();
        if (t) setTicker(t);
        setSearchInput("");
        // Defer closing search mode to a microtask so that any other
        // useKeyboard subscribers on this same event (e.g., DCFScreen) still
        // observe searchMode === true and skip the Enter — otherwise the
        // Enter that submits the search would also trigger the active
        // screen's Enter handler (e.g., open the inline cell editor).
        queueMicrotask(() => setSearchMode(false));
      } else if (key.name === "escape") {
        setSearchInput("");
        queueMicrotask(() => setSearchMode(false));
      } else if (key.name === "backspace" || key.name === "delete") {
        setSearchInput((s) => s.slice(0, -1));
      } else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        setSearchInput((s) => (s + key.sequence).toUpperCase());
      }
      return;
    }

    // While a child screen has an inline editor open, swallow all global
    // hotkeys so digits, q, and / get to the editor instead.
    if (inlineEditing()) return;

    // View mode
    const seq = key.sequence ?? "";
    if (seq === "/" || seq === ":") {
      setSearchMode(true);
      setSearchInput("");
    } else if (key.name === "q") {
      bridge.stop();
      process.kill(process.pid, "SIGINT");
    } else if (["1", "2", "3", "4", "5", "6", "7", "8", "9"].includes(seq)) {
      setTab(parseInt(seq));
    }
  });

  // Inner width = terminal width minus 2 border chars
  const divider = () => "─".repeat(Math.max(0, dims().width - 2));

  return (
    <box flexDirection="column" border={true} borderStyle="rounded" borderColor="gray">
      {/* Tab bar — explicit height={1} so blessed flex layout counts it as 1 row */}
      <box flexDirection="row" paddingLeft={1} height={1}>
        {TABS.map((t, i) => (
          <text
            style={{ fg: tab() === i + 1 ? "#FFA028" : "gray" }}
            marginRight={2}
          >
            {t.key}:{t.label}
          </text>
        ))}
      </box>

      {/* Divider — wrapped in box with height={1} so it participates in flex height */}
      <box height={1}>
        <text style={{ fg: "gray" }}>{divider()}</text>
      </box>

      {/* Content area */}
      <box flexGrow={1} flexDirection="column">
        <Switch>
          <Match when={tab() === 1}>
            <Overview ticker={ticker()} searchMode={searchMode()} />
          </Match>
          <Match when={tab() === 2}>
            <Profile ticker={ticker()} />
          </Match>
          <Match when={tab() === 3}>
            <Financials ticker={ticker()} searchMode={searchMode()} />
          </Match>
          <Match when={tab() === 4}>
            <Valuation ticker={ticker()} searchMode={searchMode()} />
          </Match>
          <Match when={tab() === 5}>
            <Growth ticker={ticker()} searchMode={searchMode()} />
          </Match>
          <Match when={tab() === 6}>
            <Profitability ticker={ticker()} searchMode={searchMode()} />
          </Match>
          <Match when={tab() === 7}>
            <DCFScreen ticker={ticker()} searchMode={searchMode()} onEditingChange={setInlineEditing} />
          </Match>
          <Match when={tab() === 8}>
            <News ticker={ticker()} searchMode={searchMode()} />
          </Match>
          <Match when={tab() === 9}>
            <SecFilings ticker={ticker()} searchMode={searchMode()} />
          </Match>
          <Match when={tab() !== 1 && tab() !== 2 && tab() !== 3 && tab() !== 4 && tab() !== 5 && tab() !== 6 && tab() !== 7 && tab() !== 8 && tab() !== 9}>
            <box padding={1}>
              <text style={{ fg: "yellow" }}>
                {TABS[tab() - 1]?.label} — coming soon
              </text>
            </box>
          </Match>
        </Switch>
      </box>

      {/* Divider */}
      <box height={1}>
        <text style={{ fg: "gray" }}>{divider()}</text>
      </box>

      {/* Status bar */}
      <StatusBar
        updateTime={updateTime()}
        apiVersion={apiVersion()}
        searchMode={searchMode()}
        searchInput={searchInput()}
        hints={
          tab() === 1 ? "/:search  1-9:tabs  ↑↓:range  ←→:pan chart  q:quit"
          : tab() === 3 ? "/:search  1-9:tabs  s:statement  p:period  ↑↓:scroll  ←→:cols  q:quit"
          : tab() === 4 ? "/:search  1-9:tabs  ↑↓:select  Enter:chart  ←→:cols  q:quit"
          : tab() === 5 ? "/:search  1-9:tabs  p:period  ↑↓:select  Enter:chart  ←→:cols  q:quit"
          : tab() === 7 ? "/:search  1-9:tabs  ↑↓←→:nav  Tab:edit cells  Enter:edit  r:reset  q:quit"
          : tab() === 8 ? "/:search  1-9:tabs  Tab:mode  ↑↓:select  ⏎:read  Esc:back  q:quit"
          : tab() === 9 ? "/:search  1-9:tabs  Tab:filter  ↑↓:select  ←→:page  ⏎:open  q:quit"
          : "/:search  1-9:tabs  q:quit"
        }
      />
    </box>
  );
}
