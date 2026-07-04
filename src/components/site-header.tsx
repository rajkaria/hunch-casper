"use client";

import Link from "next/link";
import { NetworkToggle } from "@/components/network-toggle";
import { WalletButton } from "@/components/wallet-button";

const NAV = [
  { href: "/markets", label: "Markets" },
  { href: "/agents", label: "Agents" },
  { href: "/docs", label: "Docs" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-accent text-[13px] font-bold text-white">
            H
          </span>
          <span className="text-sm font-semibold tracking-tight">
            Hunch <span className="text-muted">on Casper</span>
          </span>
        </Link>

        <nav className="hidden items-center gap-6 text-sm text-muted sm:flex">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="transition-colors hover:text-foreground">
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <NetworkToggle />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
