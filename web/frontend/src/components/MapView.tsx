import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";

import type { Location } from "../types";

// OpenStreetMap's standard tiles (no API key). Loading tiles tells OSM roughly which area you view.
// Their tile policy asks for attribution and a referrer, both set below. Styled down in CSS (.mapview).
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";

/** A real map: the car's position, or a trip route with start (green) and end (red). */
export function MapView({ points, route }: { points: Location[]; route?: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  // Re-create the map only when the coordinates change, not on every parent re-render.
  const key = points.map((p) => `${p.latitude},${p.longitude}`).join(";");

  useEffect(() => {
    if (!el.current || !points.length) return;
    const map = L.map(el.current, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
    L.tileLayer(TILES, {
      attribution: ATTRIBUTION,
      maxZoom: 19,
      // Tile servers expect a referrer; send only the origin (the API keeps no-referrer).
      referrerPolicy: "strict-origin-when-cross-origin",
    }).addTo(map);

    const latlngs = points.map((p) => [p.latitude, p.longitude] as L.LatLngTuple);
    if (route && latlngs.length > 1) {
      const line = L.polyline(latlngs, { color: css("--text"), weight: 4, opacity: 0.9, lineJoin: "round" }).addTo(map);
      L.circleMarker(latlngs[0], { radius: 7, color: "#fff", weight: 2, fillColor: css("--good"), fillOpacity: 1 }).addTo(map).bindTooltip("Start");
      L.circleMarker(latlngs[latlngs.length - 1], { radius: 7, color: "#fff", weight: 2, fillColor: css("--bad"), fillOpacity: 1 })
        .addTo(map)
        .bindTooltip("End");
      map.fitBounds(line.getBounds(), { padding: [28, 28] });
    } else {
      const here = latlngs[0];
      L.circle(here, { radius: 60, color: css("--text"), weight: 1, opacity: 0.25, fillOpacity: 0.08 }).addTo(map);
      L.circleMarker(here, { radius: 8, color: "#fff", weight: 3, fillColor: css("--text"), fillOpacity: 1 }).addTo(map).bindTooltip("Your car");
      map.setView(here, 16);
    }
    // Tiles can render grey if the container was laid out after creation.
    const t = setTimeout(() => map.invalidateSize(), 50);
    return () => {
      clearTimeout(t);
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, route]);

  return <div ref={el} className={`mapview ${route ? "route" : ""}`} role="img" aria-label={route ? "Trip route map" : "Map of the car's position"} />;
}
