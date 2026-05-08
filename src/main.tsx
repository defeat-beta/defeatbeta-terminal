import { render } from "@opentui/solid";
import { bridge } from "./bridge/python";
import App from "./App";

// Start the Python bridge before rendering
await bridge.start();

// Clean up bridge on exit (triggered by q key or Ctrl+C)
process.on("SIGINT", () => {
  bridge.stop();
});

await render(() => <App />, {
  exitOnCtrlC: true,
  useMouse: true,
  enableMouseMovement: true,
});
