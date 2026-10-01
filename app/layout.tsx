import type { Metadata } from "next";
import "./brand.css";
import "./globals.css";

// The brand's three families, loaded the way the brand skill prescribes. DM Mono is this project's one mono.
const BRAND_FONTS = "https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=EB+Garamond:wght@400;500;600&family=Instrument+Sans:wght@300;400;500;600&display=swap";

export const metadata: Metadata = {
  title: "Markets and spotted",
  description: "Live market prices and candle chart, and recent Spotbot photos from Slack.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={BRAND_FONTS} />
      </head>
      <body>{children}</body>
    </html>
  );
}
