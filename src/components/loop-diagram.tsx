/**
 * The hero graphic: the four-agent economy as a live circuit. Genesis (red) opens markets,
 * the Prophets (green) trade them, the Arbiter (violet) resolves, the Vault (gold) settles —
 * and the ring never stops circulating. Pure SVG + CSS keyframes (`.loop-*` in globals.css):
 * no JS, server-renderable, and frozen cleanly by prefers-reduced-motion.
 */

const NODES = [
  { x: 210, y: 60, glyph: "G", name: "Genesis", role: "opens markets", color: "var(--accent)", labelY: 118 },
  { x: 360, y: 210, glyph: "P", name: "Prophets", role: "trade via x402", color: "var(--up)", labelY: 268 },
  { x: 210, y: 360, glyph: "A", name: "Arbiter", role: "resolves, staked", color: "var(--accent-2)", labelY: 418 },
  { x: 60, y: 210, glyph: "V", name: "Vault", role: "settles, pure math", color: "var(--gold)", labelY: 268 },
] as const;

const SATELLITES = [
  { r: 3.5, color: "var(--accent)", duration: "11s", reverse: false },
  { r: 2.5, color: "var(--up)", duration: "17s", reverse: true },
  { r: 3, color: "var(--accent-2)", duration: "23s", reverse: false },
] as const;

export function LoopDiagram({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 420 440"
      role="img"
      aria-label="The agent loop: Genesis opens markets, the Prophets trade, the Arbiter resolves, the Vault settles"
      className={className}
    >
      {/* Outer tick ring + the main circuit */}
      <circle cx={210} cy={210} r={172} className="loop-ring" strokeDasharray="1 7" opacity={0.5} />
      <circle cx={210} cy={210} r={150} className="loop-ring" />
      {/* Flowing dashes — the economy circulating */}
      <circle cx={210} cy={210} r={150} className="loop-flow" style={{ stroke: "var(--accent)", opacity: 0.55 }} />

      {/* Faint spokes tying each agent to the pool */}
      {NODES.map((n) => (
        <line key={n.name} x1={210} y1={210} x2={n.x} y2={n.y} stroke="var(--border)" strokeWidth={1} opacity={0.6} />
      ))}

      {/* Center: the escrowed pool */}
      <g className="loop-center">
        <circle cx={210} cy={210} r={40} fill="var(--surface-2)" stroke="var(--border-strong)" />
        <circle cx={210} cy={210} r={40} fill="none" stroke="var(--accent)" opacity={0.35} />
        <text
          x={210}
          y={205}
          textAnchor="middle"
          fill="var(--foreground)"
          fontSize={15}
          fontWeight={600}
          fontFamily="var(--font-geist-mono), monospace"
        >
          CSPR
        </text>
        <text
          x={210}
          y={224}
          textAnchor="middle"
          fill="var(--muted)"
          fontSize={9}
          letterSpacing={1.5}
          fontFamily="var(--font-geist-mono), monospace"
        >
          THE POOL
        </text>
      </g>

      {/* Orbiting stakes */}
      {SATELLITES.map((s, i) => (
        <g
          key={i}
          className={`loop-orbit${s.reverse ? " reverse" : ""}`}
          style={{ "--orbit-duration": s.duration } as React.CSSProperties}
        >
          <circle cx={210} cy={60} r={s.r} fill={s.color} transform={`rotate(${i * 127} 210 210)`} />
        </g>
      ))}

      {/* Agent nodes */}
      {NODES.map((n) => (
        <g key={n.name} className="loop-node">
          <circle cx={n.x} cy={n.y} r={30} fill="var(--surface-2)" stroke="var(--border-strong)" />
          <circle cx={n.x} cy={n.y} r={30} fill="none" stroke={n.color} opacity={0.6} />
          <text
            x={n.x}
            y={n.y + 6}
            textAnchor="middle"
            fill={n.color}
            fontSize={17}
            fontWeight={700}
            fontFamily="var(--font-geist-mono), monospace"
          >
            {n.glyph}
          </text>
          <text
            x={n.x}
            y={n.labelY - 4}
            textAnchor="middle"
            fill="var(--foreground)"
            fontSize={13}
            fontWeight={600}
          >
            {n.name}
          </text>
          <text x={n.x} y={n.labelY + 12} textAnchor="middle" fill="var(--muted)" fontSize={10.5}>
            {n.role}
          </text>
        </g>
      ))}
    </svg>
  );
}
