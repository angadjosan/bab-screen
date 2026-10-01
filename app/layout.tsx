import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Markets and spotted",
  description: "Live market prices and candle chart, and recent Spotbot photos from Slack.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
