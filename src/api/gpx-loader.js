const EARTH_RADIUS_M = 6371000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineDistanceMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function initialBearingDeg(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const brng = Math.atan2(y, x);
  const deg = (brng * 180) / Math.PI;
  return (deg + 360) % 360;
}

function looksLikeEpochSeconds(t) {
  return Number.isFinite(t) && t > 1e8;
}

export function parseGpxTrack(gpxText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(gpxText, 'application/xml');
  const errors = doc.getElementsByTagName('parsererror');
  if (errors && errors.length) {
    throw new Error('Invalid GPX: parse error');
  }

  const trkpts = Array.from(doc.getElementsByTagName('trkpt'));
  if (!trkpts.length) {
    throw new Error('No GPX track points found');
  }

  const points = [];
  let startEpoch = null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  trkpts.forEach((pt) => {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return;
    }

    const eleNode = pt.getElementsByTagName('ele')[0];
    const timeNode = pt.getElementsByTagName('time')[0];
    const ele = eleNode ? parseFloat(eleNode.textContent) : null;
    const timeStr = timeNode ? timeNode.textContent : null;
    const epochSec = timeStr ? Date.parse(timeStr) / 1000 : null;
    if (!looksLikeEpochSeconds(epochSec)) {
      return; // skip points without usable time
    }

    if (startEpoch === null) {
      startEpoch = epochSec;
    }
    const relSec = epochSec - startEpoch;

    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);

    points.push({
      lat,
      lon,
      ele,
      epochSec,
      relSec,
    });
  });

  if (!points.length) {
    throw new Error('GPX has no time-stamped track points');
  }

  // derive speed and heading
  for (let i = 0; i < points.length; i++) {
    const prev = i > 0 ? points[i - 1] : null;
    if (!prev) {
      points[i].speedMps = 0;
      points[i].headingDeg = null;
      continue;
    }
    const dt = points[i].relSec - prev.relSec;
    const dist = haversineDistanceMeters(prev, points[i]);
    points[i].speedMps = dt > 0 ? dist / dt : 0;
    points[i].headingDeg = dt > 0 ? initialBearingDeg(prev, points[i]) : prev.headingDeg;
  }

  return {
    startEpoch,
    points,
    bbox: {
      minLat,
      maxLat,
      minLon,
      maxLon
    }
  };
}

export default {
  parseGpxTrack
};
