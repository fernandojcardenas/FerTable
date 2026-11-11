"use client";

// A map of records with Leaflet. Tiles come from OpenStreetMap unless
// NEXT_PUBLIC_FERTABLE_MAP_TILES points somewhere else.

import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";
import type { MapPoint } from "@/shared/interfaces";

const TILES = process.env.NEXT_PUBLIC_FERTABLE_MAP_TILES || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = process.env.NEXT_PUBLIC_FERTABLE_MAP_ATTRIBUTION || "© OpenStreetMap contributors";

export function MapElement({ points, onOpen }: { points: MapPoint[]; onOpen: (rowId: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<import("leaflet").Map | null>(null);
  const layer = useRef<import("leaflet").LayerGroup | null>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    void import("leaflet").then((L) => {
      if (cancelled || !box.current) return;
      const m = L.map(box.current, { zoomControl: true, attributionControl: true, worldCopyJump: true }).setView([20, 0], 1);
      L.tileLayer(TILES, { maxZoom: 18, attribution: ATTRIBUTION }).addTo(m);
      map.current = m;
      layer.current = L.layerGroup().addTo(m);
      ro = new ResizeObserver(() => m.invalidateSize());
      ro.observe(box.current);
      draw(L);
    });
    return () => { cancelled = true; ro?.disconnect(); map.current?.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function draw(L: typeof import("leaflet")) {
    const m = map.current, g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const color = getComputedStyle(document.documentElement).getPropertyValue("--s1").trim() || "#2a78d6";
    for (const p of points) {
      L.circleMarker([p.lat, p.lng], { radius: 7, color: "#fff", weight: 2, fillColor: color, fillOpacity: 0.95 })
        .bindTooltip(p.label || "(unnamed)")
        .on("click", () => openRef.current(p.rowId))
        .addTo(g);
    }
    if (points.length === 1) m.setView([points[0].lat, points[0].lng], 12);
    else if (points.length > 1) m.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])), { padding: [24, 24], maxZoom: 14 });
  }

  const key = JSON.stringify(points);
  useEffect(() => { void import("leaflet").then(draw); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={box} className="map-box" role="application" aria-label={`Map with ${points.length} records`} />;
}
