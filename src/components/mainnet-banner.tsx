"use client";

import { useNetwork } from "@/components/network-context";
import { bannerDisclosure } from "@/config/caps";

/**
 * Honest disclosure shown until the contracts are audited. Driven by the SAME cap-ramp policy
 * (`config/caps.ts`) that sets the per-bet cap, so the disclosure and the number it quotes can
 * never disagree — flip `NEXT_PUBLIC_AUDIT_STATUS=audited` and both the banner and the cap lift
 * together.
 */
export function MainnetBanner() {
  const { network } = useNetwork();
  const disclosure = bannerDisclosure(network);
  if (!disclosure.show) return null;
  return (
    <div className="border-b border-accent/30 bg-accent/10 px-4 py-2 text-center text-xs text-foreground">
      <span className="font-semibold text-accent">Mainnet</span> · unaudited hackathon build ·
      {disclosure.capCspr != null ? ` bets capped at ${disclosure.capCspr} CSPR.` : ""} For demonstration only.
    </div>
  );
}
