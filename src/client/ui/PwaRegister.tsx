"use client";

import { useEffect } from "react";

/** Registers the service worker in production builds (dev keeps hot reload simple). */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("service worker registration failed", e));
  }, []);
  return null;
}
