import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "gridbase",
  description: "Spreadsheet-database with live sync",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
