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
  const p = config.provider;
  const baseLabel = p.baseUrl ? ` (${p.baseUrl})` : "";
  console.log(`   Provider: ${p.type}${baseLabel}`);
  console.log(`   Models:   ${p.mouthModel} / ${p.handModel}`);

  // Channels
  if (config.channels.length === 0) {
    console.log("   Channels: (none)");
  } else {
    const labels = config.channels.map((c) => c.type).join(", ");
    console.log(`   Channels: ${labels}`);
  }
}
