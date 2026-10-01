import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BTC and spotted",
  description: "Live Bitcoin price and candle chart, with the latest Spotbot photo from Slack.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
