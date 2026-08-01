/**
 * The share card for one finalist — the thing that actually travels.
 *
 * A team posts `/p/<their-id>` into a group chat and this is what unfurls: their name, their live
 * stake and implied chance, and the question. Rendered per request against the same read model the
 * page uses, so the card never advertises numbers the page then contradicts.
 *
 * Satori (which renders this) has no CSS cascade: every multi-child node must set `display: flex`
 * explicitly or it throws at request time.
 */

import { ImageResponse } from "next/og";
import { createContainer } from "@/lib/container";
import { DEFAULT_NETWORK } from "@/config/network";
import { BUILDATHON_MARKET_SLUG, findFinalist } from "@/core/buildathon-field";
import { fieldRowFor } from "@/core/field-board";
import { formatProbability } from "@/core/parimutuel-odds";
import { motesToCspr } from "@/core/types";

export const alt = "Back this project in the Casper Agentic Buildathon 2026 market";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function ProjectOpengraphImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const finalist = findFinalist(id);
  const market = await createContainer(DEFAULT_NETWORK).store.get(BUILDATHON_MARKET_SLUG, DEFAULT_NETWORK);
  const row = market ? fieldRowFor(market, id) : undefined;
  const staked = market ? BigInt(market.totalStakedMotes) > 0n : false;
  const stakeCspr = motesToCspr(row?.stakeMotes ?? "0");

  const name = finalist?.name ?? `BUIDL #${id}`;
  // 70 characters is the longest name on the finalist list; shrink rather than clip so the whole
  // project name survives the card — the name IS the reason the link gets clicked.
  const nameSize = name.length > 46 ? 52 : name.length > 28 ? 64 : 78;

  const stats: { label: string; value: string }[] = [
    { label: "Staked on it", value: stakeCspr > 0 ? `${stakeCspr.toLocaleString()} CSPR` : "—" },
    {
      label: "Implied chance",
      value: staked && row ? formatProbability(row.impliedProbability) : "first bet sets it",
    },
    // No rank while the field is unbet: "#1 of 177" on a zero pool would advertise a lead that
    // does not exist, on the one surface nobody clicks through to check.
    row?.rank
      ? { label: "Position", value: `#${row.rank} of ${market?.outcomes.length ?? 177}` }
      : { label: "Field", value: `1 of ${market?.outcomes.length ?? 177} entered` },
  ];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background:
            "radial-gradient(1000px 500px at 15% -10%, rgba(232,198,107,0.20), transparent 60%), radial-gradient(800px 500px at 95% 10%, rgba(255,59,59,0.18), transparent 60%), #070709",
          padding: "64px 72px",
          fontFamily: "sans-serif",
          color: "#f4f4f6",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 52,
              height: 52,
              borderRadius: 14,
              background: "#ff3b3b",
              color: "#fff",
              fontSize: 34,
              fontWeight: 800,
            }}
          >
            H
          </div>
          <div style={{ display: "flex", fontSize: 26, fontWeight: 600, color: "#a5a5b0" }}>
            Casper Agentic Buildathon 2026 · finalist #{id}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", fontSize: 24, fontWeight: 600, color: "#e8c66b" }}>
            Back it to win
          </div>
          <div style={{ display: "flex", fontSize: nameSize, fontWeight: 800, letterSpacing: -1.5, lineHeight: 1.05 }}>
            {name}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ display: "flex", gap: 56 }}>
            {stats.map((s) => (
              <div key={s.label} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", fontSize: 20, color: "#7d7d8a", textTransform: "uppercase" }}>
                  {s.label}
                </div>
                <div style={{ display: "flex", fontSize: 34, fontWeight: 700 }}>{s.value}</div>
              </div>
            ))}
          </div>
          <div
            style={{
              display: "flex",
              borderTop: "1px solid #24242c",
              paddingTop: 18,
              fontSize: 22,
              color: "#a5a5b0",
            }}
          >
            Parimutuel · real testnet CSPR · no house liquidity · casper.playhunch.xyz
          </div>
        </div>
      </div>
    ),
    size,
  );
}
