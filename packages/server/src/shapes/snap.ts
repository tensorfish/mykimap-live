import type { ShapePolyline, ShapePoint } from "../types.js";
import { haversineDistance } from "../interpolation/geo.js";

/**
 * Snap a lat/lon point to the nearest position on a shape polyline.
 * Returns the interpolated distance along the shape (in meters),
 * or -1 if the shape is empty.
 *
 * Walks each segment, finds the closest perpendicular projection
 * (or nearest endpoint), and returns the cumulative distance.
 */
export function snapToShape(
  lat: number,
  lon: number,
  shape: ShapePolyline
): number {
  if (shape.length === 0) return -1;
  if (shape.length === 1) return 0;

  let bestDist = Infinity;
  let bestShapeDist = 0;

  for (let i = 0; i < shape.length - 1; i++) {
    const a = shape[i]!;
    const b = shape[i + 1]!;

    // Project point onto segment a→b using flat-earth approximation
    // (fine for sub-km segments within Melbourne)
    const t = projectOntoSegment(lat, lon, a, b);
    const clamped = Math.max(0, Math.min(1, t));

    const projLat = a.lat + clamped * (b.lat - a.lat);
    const projLon = a.lon + clamped * (b.lon - a.lon);

    const d = haversineDistance(lat, lon, projLat, projLon);

    if (d < bestDist) {
      bestDist = d;
      const segLen = b.dist - a.dist;
      bestShapeDist = a.dist + clamped * segLen;
    }
  }

  return bestShapeDist;
}

/**
 * Given a distance along a shape (in meters), return the interpolated lat/lon.
 * Uses binary search + linear interpolation between shape points.
 */
export function sampleShape(
  shape: ShapePolyline,
  dist: number
): { lat: number; lon: number } | null {
  if (shape.length === 0) return null;
  if (shape.length === 1) return { lat: shape[0]!.lat, lon: shape[0]!.lon };

  const totalDist = shape[shape.length - 1]!.dist;

  // Clamp to shape bounds
  if (dist <= 0) return { lat: shape[0]!.lat, lon: shape[0]!.lon };
  if (dist >= totalDist) {
    const last = shape[shape.length - 1]!;
    return { lat: last.lat, lon: last.lon };
  }

  // Binary search for the segment containing this distance
  let lo = 0;
  let hi = shape.length - 1;

  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (shape[mid]!.dist <= dist) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const a = shape[lo]!;
  const b = shape[hi]!;
  const segLen = b.dist - a.dist;

  if (segLen <= 0) return { lat: a.lat, lon: a.lon };

  const t = (dist - a.dist) / segLen;

  return {
    lat: a.lat + t * (b.lat - a.lat),
    lon: a.lon + t * (b.lon - a.lon),
  };
}

/**
 * Get the total length of a shape in meters.
 */
export function shapeLength(shape: ShapePolyline): number {
  if (shape.length === 0) return 0;
  return shape[shape.length - 1]!.dist;
}

// ── Helpers ──

/**
 * Project point P onto line segment A→B.
 * Returns t ∈ [0,1] where 0=A, 1=B.
 * Uses flat-earth approximation (fine for short segments).
 */
function projectOntoSegment(
  pLat: number,
  pLon: number,
  a: ShapePoint,
  b: ShapePoint
): number {
  const dx = b.lon - a.lon;
  const dy = b.lat - a.lat;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) return 0;

  return ((pLon - a.lon) * dx + (pLat - a.lat) * dy) / lenSq;
}
