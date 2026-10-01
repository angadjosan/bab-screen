import type { Metadata } from "next";
import { Background } from "./Background";
import "./brand.css";
import "./globals.css";

// One family for the whole wallboard: Inter, in the weights the styles ask for. Every font token in brand.css points at it.
const BRAND_FONTS = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap";

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
      <body>
        {/* First in the body: it is a fixed layer at z-index 0, and the stage after it paints on top. */}
        <Background />
        {children}
      </body>
    </html>
  );
}
