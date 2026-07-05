"use client";

import { CASPER_NETWORKS, NETWORKS } from "@/config/network";
import { useNetwork } from "@/components/network-context";

/** Segmented Testnet ⇄ Mainnet control. The one switch that repoints the entire app. */
export function NetworkToggle() {
  const { network, setNetwork } = useNetwork();
  return (
    <div
      className="chip inline-flex p-0.5 text-xs font-medium"
      role="radiogroup"
      aria-label="Casper network"
    >
      {CASPER_NETWORKS.map((n) => {
        const active = n === network;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setNetwork(n)}
            className={`rounded-full px-3 py-1 transition-colors ${
              active
                ? "bg-accent text-white"
                : "text-muted hover:text-foreground"
            }`}
          >
            {NETWORKS[n].label}
          </button>
        );
      })}
    </div>
  );
}
