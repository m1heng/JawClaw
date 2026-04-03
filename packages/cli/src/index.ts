#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { onboard } from "./onboard.js";
import { startBot } from "./start.js";

const [cmd, subcmd] = process.argv.slice(2);

function showHelp() {
  console.log("🐾 JawClaw — IM-connected coding agent");
  console.log();
  console.log("Usage: jawclaw [command]");
  console.log();
  console.log("Commands:");
  console.log("  (no args)          Start bot (onboard if first run)");
  console.log("  status             Show config and status");
  console.log("  provider add       Add or update LLM provider");
  console.log("  channel add        Add a channel");
  console.log("  channel remove     Remove a channel");
  console.log();
  console.log("Options:");
  console.log("  --help, -h         Show this help");
  console.log("  --version, -v      Show version");
}

async function main() {
  switch (cmd) {
    case "--help":
    case "-h": {
      showHelp();
      break;
    }

    case "--version":
    case "-v": {
      console.log("jawclaw 0.0.1");
      break;
    }

    case undefined: {
      let config = await loadConfig();
      if (!config || !config.provider) {
        config = await onboard(config);
      }
      await startBot(config);
      break;
    }

    case "status": {
      const { showStatus } = await import("./commands/status.js");
      await showStatus();
      break;
    }

    case "provider": {
      const { handleProvider } = await import("./commands/provider.js");
      await handleProvider(subcmd);
      break;
    }

    case "channel": {
      const { handleChannel } = await import("./commands/channel.js");
      await handleChannel(subcmd);
      break;
    }

    default:
      console.log(`Unknown command: ${cmd}`);
      console.log();
      showHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
