import { loadBridgeConfig } from "./lib/config.js";
import { startBridgeServer } from "./lib/server.js";

async function main() {
  const config = loadBridgeConfig();
  startBridgeServer({ version: "0.2.0", config });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
