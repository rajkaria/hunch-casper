"use client";

import { getNetworkConfig } from "@/config/network";
import { useNetwork } from "@/components/network-context";

/** Honest disclosure shown only on mainnet: the contracts are an unaudited hackathon build. */
export function MainnetBanner() {
  const { network } = useNetwork();
  const cfg = getNetworkConfig(network);
  if (!cfg.guardrails.showUnauditedBanner) return null;
  return (
    <div className="border-b border-accent/30 bg-accent/10 px-4 py-2 text-center text-xs text-foreground">
      <span className="font-semibold text-accent">Mainnet</span> · unaudited hackathon build ·
      bets capped at {cfg.guardrails.maxBetCspr} CSPR. For demonstration only.
    </div>
  );
}
