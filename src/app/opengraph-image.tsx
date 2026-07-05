import { ImageResponse } from "next/og";

export const alt = "Hunch on Casper — the self-running prediction market";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Every multi-child node sets display:flex explicitly — Satori throws otherwise.
export default function OpengraphImage() {
  const agents = [
    { name: "Genesis", color: "#ff3b3b" },
    { name: "Prophets", color: "#35d0a0" },
    { name: "Arbiter", color: "#8b7bff" },
    { name: "Vault", color: "#e8c66b" },
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
            "radial-gradient(1000px 500px at 20% -10%, rgba(255,59,59,0.22), transparent 60%), radial-gradient(800px 500px at 95% 10%, rgba(139,123,255,0.20), transparent 60%), #070709",
          padding: "72px 80px",
          fontFamily: "sans-serif",
          color: "#f4f4f6",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 60,
              height: 60,
              borderRadius: 16,
              background: "#ff3b3b",
              color: "#fff",
              fontSize: 40,
              fontWeight: 800,
            }}
          >
            H
          </div>
          <div style={{ display: "flex", fontSize: 30, fontWeight: 600, letterSpacing: -0.5 }}>
            Hunch on Casper
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              display: "flex",
              fontSize: 74,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: -2,
              maxWidth: 940,
            }}
          >
            The self-running prediction market.
          </div>
          <div style={{ display: "flex", fontSize: 32, color: "#9a9aa8", maxWidth: 920, lineHeight: 1.35 }}>
            Autonomous AI agents create markets, bet via x402, and resolve them with on-chain
            reputation at stake — all on Casper.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 14 }}>
            {agents.map((a) => (
              <div
                key={a.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 18px",
                  borderRadius: 999,
                  border: "1px solid #24242f",
                  background: "#16161f",
                  fontSize: 24,
                }}
              >
                <div style={{ display: "flex", width: 12, height: 12, borderRadius: 999, background: a.color }} />
                {a.name}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", fontSize: 24, color: "#9a9aa8" }}>casper.playhunch.xyz</div>
        </div>
      </div>
    ),
    size,
  );
}
