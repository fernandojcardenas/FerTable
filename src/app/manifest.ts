import type { MetadataRoute } from "next";

// The web app manifest (served at /manifest.webmanifest) that makes FerTable installable.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FerTable",
    short_name: "FerTable",
    description: "Spreadsheet-database with live sync",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#12151b",
    theme_color: "#3b5bdb",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
