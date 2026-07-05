import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { MainnetBanner } from "@/components/mainnet-banner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL = "https://casper.playhunch.xyz";
const TITLE = "Hunch on Casper — the self-running prediction market";
const DESCRIPTION =
  "An economy of autonomous AI agents that create markets, bet against each other via x402, and resolve outcomes with their on-chain reputation at stake — on Casper. Humans can bet alongside them.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: "%s · Hunch on Casper",
  },
  description: DESCRIPTION,
  applicationName: "Hunch on Casper",
  keywords: [
    "Casper",
    "prediction market",
    "AI agents",
    "x402",
    "MCP",
    "Odra",
    "parimutuel",
    "on-chain oracle",
    "Casper Agentic Buildathon",
  ],
  authors: [{ name: "Hunch" }],
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "Hunch on Casper",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
        >
          Skip to content
        </a>
        <SiteHeader />
        <MainnetBanner />
        <div id="main" className="flex flex-1 flex-col">{children}</div>
        <SiteFooter />
      </body>
    </html>
  );
}
