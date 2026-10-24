// src/lib/followCamera.ts
// Pure function: given the ambulance and the previous map view,
// returns the next camera position for the follow-ambulance mode.
// Kept isolated so it can be unit-tested and swapped without touching MapView.

export type FollowCameraView = {
  latitude: number;
  longitude: number;
  zoom: number;
  pitch: number;   // degrees, 0 = looking straight down
  bearing: number; // degrees, 0 = north-up, clockwise
};

export type PreviousView = FollowCameraView;

const FOLLOW_ZOOM = 17.5;
const FOLLOW_PITCH = 60;
// How far behind the ambulance the camera trails, in metres.
// (At zoom 17.5, ~40 m behind gives a "chase cam" feel.)
const TRAIL_M = 40;
// 0 = snap instantly; 1 = never move. Small = responsive; large = silky.
// We lerp every frame, so a small alpha makes motion smooth without lag.
const ALPHA = 0.18;

// Metres per degree latitude (constant enough at SF's latitude for short trails).
const M_PER_DEG_LAT = 111_320;

function metresToLatLng(metres: number, bearingDeg: number): { dLat: number; dLng: number } {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (Math.cos(rad) * metres) / M_PER_DEG_LAT;
  const dLng =
    (Math.sin(rad) * metres) /
    (M_PER_DEG_LAT * Math.cos((37.777 * Math.PI) / 180)); // ~SF latitude
  return { dLat, dLng };
}

// Shortest-path angular lerp so 350° → 10° goes the 20° way, not the 340° way.
function lerpAngle(a: number, b: number, t: number): number {
  const diff = ((b - a + 540) % 360) - 180;
  return (a + diff * t + 360) % 360;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function followCamera(
  ambulance: { pos: { lat: number; lng: number }; headingDeg: number },
  previousView: PreviousView,
): FollowCameraView {
  // Target: point a little behind the ambulance, along its heading.
  const behindBearing = (ambulance.headingDeg + 180) % 360;
  const { dLat, dLng } = metresToLatLng(TRAIL_M, behindBearing);

  const targetLat = ambulance.pos.lat + dLat;
  const targetLng = ambulance.pos.lng + dLng;

  return {
    latitude: lerp(previousView.latitude, targetLat, ALPHA),
    longitude: lerp(previousView.longitude, targetLng, ALPHA),
    zoom: lerp(previousView.zoom, FOLLOW_ZOOM, ALPHA),
    pitch: lerp(previousView.pitch, FOLLOW_PITCH, ALPHA),
    bearing: lerpAngle(previousView.bearing, ambulance.headingDeg, ALPHA),
  };
}
