import { loadConfig } from "../config.js";

export async function showStatus() {
  const config = await loadConfig();

  if (!config) {
    console.log("🐾 JawClaw — not configured");
    console.log("   Run: jawclaw");
    return;
  }

  console.log("🐾 JawClaw");
  console.log();

  // Provider
  if (config.provider) {
    const pr = config.provider;
    const baseLabel = pr.baseUrl ? ` (${pr.baseUrl})` : "";
    console.log(`   Provider: ${pr.type}${baseLabel}`);
    console.log(`   Models:   ${pr.mouthModel} / ${pr.handModel}`);
  } else {
    console.log("   Provider: (none)");
  }

  // Channels
  if (config.channels.length === 0) {
    console.log("   Channels: (none)");
  } else {
    const labels = config.channels.map((c) => c.type).join(", ");
    console.log(`   Channels: ${labels}`);
  }
}
