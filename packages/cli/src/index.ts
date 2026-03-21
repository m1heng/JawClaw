import "dotenv/config";
import { loadConfig } from "./config.js";
import { onboard } from "./onboard.js";
import { startBot } from "./start.js";

const [cmd, subcmd] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case undefined: {
      // Default: onboard if needed, then start
      let config = await loadConfig();
      if (!config) {
        config = await onboard();
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

    case "stop": {
      console.log("Use Ctrl+C to stop the running instance.");
      break;
    }

    default:
      console.log(`Unknown command: ${cmd}`);
      console.log();
      console.log("Usage:");
      console.log("  jawclaw              Start (onboard if first run)");
      console.log("  jawclaw status       Show config and status");
      console.log("  jawclaw provider add Update LLM provider");
      console.log("  jawclaw channel add  Add a channel");
      console.log("  jawclaw channel remove  Remove a channel");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
