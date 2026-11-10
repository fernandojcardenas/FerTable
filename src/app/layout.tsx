import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PwaRegister } from "@/client/ui/PwaRegister";

export const metadata: Metadata = {
  title: "gridbase",
  description: "Spreadsheet-database with live sync",
  applicationName: "gridbase",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "gridbase", statusBarStyle: "default" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1e26" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
