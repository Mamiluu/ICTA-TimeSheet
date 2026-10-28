// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// Whether a person signing was near the venue. This is a hint for the organiser, never a gate: a
// phone with location off, or a poor fix indoors, still signs. Only the verdict and the distance are
// kept. The coordinates the phone sent are used for the sum and thrown away.

export const GEO_RADIUS_CHOICES = [100, 300, 1000];
export const GEO_DEFAULT_RADIUS_M = 300;

// Roughly Kenya, a little generous at the edges. A pin outside it is a typing or tapping mistake.
export const KENYA_BOUNDS = { south: -4.9, north: 5.6, west: 33.8, east: 42.0 };

export function validPoint(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= KENYA_BOUNDS.south && lat <= KENYA_BOUNDS.north && lng >= KENYA_BOUNDS.west && lng <= KENYA_BOUNDS.east;
}

// Metres between two points on the earth (haversine).
export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))));
}

// null when the event does not check location. Otherwise one of
//   AT_VENUE      within the radius, allowing for how accurate the phone says its fix is
//   NEAR          within three times the radius
//   FAR           further than that
//   NOT_SHARED    the person did not share a location, or it was not usable
export function geoStatusFor(event, location) {
  if (!event || !event.geoCheck || event.locationType === 'VIRTUAL' || !Number.isFinite(event.latitude) || !Number.isFinite(event.longitude)) return null;
  const lat = Number(location && location.lat);
  const lng = Number(location && location.lng);
  if (!validPoint(lat, lng)) return { status: 'NOT_SHARED', distanceM: null };
  const radius = event.geoRadiusM || GEO_DEFAULT_RADIUS_M;
  const accuracy = Math.min(Math.max(Number(location.accuracy) || 0, 0), 150);
  const d = distanceM(lat, lng, event.latitude, event.longitude);
  if (d - accuracy <= radius) return { status: 'AT_VENUE', distanceM: d };
  if (d <= radius * 3) return { status: 'NEAR', distanceM: d };
  return { status: 'FAR', distanceM: d };
}