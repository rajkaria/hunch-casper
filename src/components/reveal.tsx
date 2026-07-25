"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Scroll-reveal wrapper: children fade + rise once the block first enters the viewport.
 * Pure CSS does the animating (`.reveal` / `.is-visible` in globals.css) so the global
 * `prefers-reduced-motion` rule neutralizes it for free; this component only flips the class.
 *
 * `delay` staggers siblings (ms). Falls back to instantly-visible when IntersectionObserver
 * is unavailable — content must never be lost to a missing observer.
 */
export function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            io.disconnect();
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`reveal ${visible ? "is-visible" : ""} ${className}`.trim()}
      style={delay ? ({ "--reveal-delay": `${delay}ms` } as React.CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}
