/**
 * Bottom status bar: keyboard hints + data date + current ticker + search prompt.
 */

interface StatusBarProps {
  updateTime: string;
  apiVersion: string;
  searchMode: boolean;
  searchInput: string;
  hints: string;
}

export default function StatusBar(props: StatusBarProps) {

  return (
    <box flexDirection="row" justifyContent="space-between" marginTop={0}>
      <text style={{ fg: "#FFA028" }}>
        {props.searchMode
          ? `Ticker: ${props.searchInput}_`
          : props.hints}
      </text>
      <text style={{ fg: "#FFA028" }}>
        {`${props.apiVersion ? `defeatbeta-api v${props.apiVersion}  ` : ""}Data: ${props.updateTime || "..."}`}
      </text>
    </box>
  );
}
