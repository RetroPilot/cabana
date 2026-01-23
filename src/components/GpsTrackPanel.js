import React, {
  useMemo, useState, useCallback, useRef, useEffect
} from 'react';
import PropTypes from 'prop-types';
import cx from 'classnames';

function findNearestPoint(points, targetRelSec) {
  if (!points || points.length === 0) return null;
  if (targetRelSec <= points[0].relSec) return points[0];
  if (targetRelSec >= points[points.length - 1].relSec) return points[points.length - 1];

  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].relSec <= targetRelSec) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const distLo = Math.abs(points[lo].relSec - targetRelSec);
  const distHi = Math.abs(points[hi].relSec - targetRelSec);
  return distLo <= distHi ? points[lo] : points[hi];
}

function formatSpeed(mps) {
  if (mps == null) return '--';
  const kph = mps * 3.6;
  return `${kph.toFixed(1)} km/h`;
}

function formatHeading(deg) {
  if (deg == null || Number.isNaN(deg)) return '--';
  return `${deg.toFixed(0)}°`;
}

function formatLatLon(lat, lon) {
  if (lat == null || lon == null) return '--';
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

function formatAltitude(ele) {
  if (ele == null || Number.isNaN(ele)) return '--';
  return `${ele.toFixed(1)} m`;
}

export default function GpsTrackPanel({
  track,
  seekTime,
  gpsOffsetSec,
  onGpsOffsetChange
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [followDot, setFollowDot] = useState(false);
  const [offsetText, setOffsetText] = useState(`${gpsOffsetSec || 0}`);
  const lastPosRef = useRef(null);
  const mapRef = useRef(null);
  const svgRef = useRef(null);

  const clamp = (val, min, max) => Math.min(Math.max(val, min), max);

  const pointerToUnit = useCallback((clientX, clientY) => {
    const rect = (svgRef.current || mapRef.current)?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    const boxSize = Math.min(rect.width, rect.height);
    const offsetX = (rect.width - boxSize) / 2;
    const offsetY = (rect.height - boxSize) / 2;
    const px = (clientX - rect.left - offsetX) / boxSize;
    const py = (clientY - rect.top - offsetY) / boxSize;
    return {
      x: clamp(px, 0, 1),
      y: clamp(py, 0, 1),
      boxSize
    };
  }, []);

  useEffect(() => {
    setOffsetText(`${gpsOffsetSec || 0}`);
  }, [gpsOffsetSec]);

  const point = useMemo(() => {
    if (!track || !track.points) return null;
    const targetRel = (seekTime || 0) + (gpsOffsetSec || 0);
    return findNearestPoint(track.points, targetRel);
  }, [track, seekTime, gpsOffsetSec]);

  const bounds = track ? track.bbox : null;
  const pathData = useMemo(() => {
    if (!track || !bounds) return null;
    const { minLat, maxLat, minLon, maxLon } = bounds;
    const dLatRaw = maxLat - minLat;
    const dLonRaw = maxLon - minLon;
    const padFactor = 0.01;
    const dLat = dLatRaw || 1;
    const dLon = dLonRaw || 1;
    const minLatPad = minLat - dLat * padFactor;
    const maxLatPad = maxLat + dLat * padFactor;
    const minLonPad = minLon - dLon * padFactor;
    const maxLonPad = maxLon + dLon * padFactor;
    const dLatPad = maxLatPad - minLatPad || 1;
    const dLonPad = maxLonPad - minLonPad || 1;

    const scale = 0.98; // minimal margin to avoid clipping
    const offset = (1 - scale) / 2;
    const norm = (lat, lon) => ({
      x: offset * 100 + ((lon - minLonPad) / dLonPad) * 100 * scale,
      y: (offset * 100 + (1 - (lat - minLatPad) / dLatPad) * 100 * scale)
    });
    const path = track.points.map((p) => {
      const { x, y } = norm(p.lat, p.lon);
      return `${x},${y}`;
    }).join(' ');
    const marker = point
      ? (() => {
        const { x, y } = norm(point.lat, point.lon);
        return { x, y };
      })()
      : null;
    return { path, marker };
  }, [track, bounds, point]);

  const onWheelZoom = useCallback((e) => {
    e.preventDefault();
    const unit = pointerToUnit(e.clientX, e.clientY);
    if (!unit) return;
    const { x: px, y: py } = unit;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;

    setPan((p) => {
      const prevZoom = zoom;
      const newZoom = clamp(prevZoom * factor, 0.5, 10);

      const screenX = px * 100;
      const screenY = py * 100;
      const worldX = ((screenX - 50 - p.x) / prevZoom) + 50;
      const worldY = ((screenY - 50 - p.y) / prevZoom) + 50;

      const newPanX = screenX - ((worldX - 50) * newZoom) - 50;
      const newPanY = screenY - ((worldY - 50) * newZoom) - 50;

      setZoom(newZoom);
      return { x: newPanX, y: newPanY };
    });
  }, [zoom, pointerToUnit]);

  const startDrag = (e) => {
    if (!mapRef.current) return;
    setDragging(true);
    if (followDot) setFollowDot(false);
    lastPosRef.current = { x: e.clientX, y: e.clientY };
  };

  const endDrag = () => {
    setDragging(false);
    lastPosRef.current = null;
  };

  const onDrag = (e) => {
    if (!dragging || !mapRef.current || !lastPosRef.current) return;
    const rect = (svgRef.current || mapRef.current).getBoundingClientRect();
    const dxPx = e.clientX - lastPosRef.current.x;
    const dyPx = e.clientY - lastPosRef.current.y;
    lastPosRef.current = { x: e.clientX, y: e.clientY };

    if (rect.width === 0 || rect.height === 0) return;
    // convert pixel delta to viewBox units, compensate for zoom
    // Map pixel delta directly into viewBox units (independent of zoom for natural feel)
    const scaleX = 100 / rect.width;
    const scaleY = 100 / rect.height;
    const dxView = dxPx * scaleX;
    const dyView = dyPx * scaleY;

    setPan((p) => ({
      x: p.x + dxView,
      y: p.y + dyView
    }));
  };

  const markerScreen = useMemo(() => {
    if (!pathData || !pathData.marker) return null;
    const { x, y } = pathData.marker;
    return {
      x: ((x - 50) * zoom) + 50 + pan.x,
      y: ((y - 50) * zoom) + 50 + pan.y
    };
  }, [pathData, zoom, pan]);

  const centerOnMarker = useCallback(() => {
    if (!pathData || !pathData.marker) return;
    const { x, y } = pathData.marker;
    // set pan so marker is at screen center (50,50)
    setPan({
      x: -((x - 50) * zoom),
      y: -((y - 50) * zoom)
    });
  }, [pathData, zoom]);

  // follow the dot whenever enabled or point/zoom changes
  React.useEffect(() => {
    if (followDot) {
      centerOnMarker();
    }
  }, [followDot, centerOnMarker]);

  return (
    <div className={cx('gps-panel', { 'is-collapsed': collapsed })}>
      <div className="gps-panel__header" onClick={() => setCollapsed(!collapsed)}>
        <div className="gps-panel__title">
          <i className={cx('fa', collapsed ? 'fa-chevron-right' : 'fa-chevron-down')} />
          <strong>GPS Overlay</strong>
        </div>
        <div className="gps-panel__offset" onClick={(e) => e.stopPropagation()}>
          <label className="t-smallcaps">
            Offset (s)
            <input
              type="text"
              inputMode="decimal"
              value={offsetText}
              onChange={(e) => {
                setOffsetText(e.target.value);
              }}
              onBlur={() => {
                const trimmed = offsetText.trim();
                if (trimmed === '' || trimmed === '-') {
                  setOffsetText(`${gpsOffsetSec || 0}`);
                  return;
                }
                const parsed = Number(trimmed);
                if (Number.isFinite(parsed) && onGpsOffsetChange) {
                  onGpsOffsetChange(parsed);
                } else {
                  setOffsetText(`${gpsOffsetSec || 0}`);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
            />
          </label>
        </div>
      </div>

      {!collapsed && (
        !track ? (
          <div className="gps-panel__empty">
            <i className="fa fa-info-circle" /> No GPX loaded
          </div>
        ) : (
          <>
          <div
            className={cx('gps-panel__map', { 'is-dragging': dragging })}
            onWheel={onWheelZoom}
            onMouseDown={startDrag}
            onMouseUp={endDrag}
            onMouseLeave={endDrag}
            onMouseMove={onDrag}
            ref={mapRef}
          >
            <svg
              ref={svgRef}
              viewBox="0 0 100 100"
              preserveAspectRatio="xMidYMid meet"
            >
              <g transform={`translate(${50 + pan.x} ${50 + pan.y}) scale(${zoom}) translate(-50 -50)`}>
                <polyline
                  points={pathData ? pathData.path : ''}
                  fill="none"
                  stroke="#3f87ff"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
              {markerScreen ? (
                <circle
                  cx={markerScreen.x}
                  cy={markerScreen.y}
                  r="2.4"
                  fill="#ff5a5f"
                  stroke="#fff"
                  strokeWidth="0.8"
                />
              ) : null}
            </svg>
            <div className="gps-panel__zoom">
              ×{zoom.toFixed(2)}
            </div>
            <button
              className={cx('gps-panel__follow', { 'is-active': followDot })}
              title={followDot ? 'Stop Following' : 'Follow'}
              onWheel={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setFollowDot((v) => !v);
                if (!followDot) {
                  centerOnMarker();
                }
              }}
            >
              <i className="fa fa-crosshairs" />
            </button>
          </div>

            <div className="gps-panel__fields">
              <div className={cx('gps-panel__field', { 'is-disabled': !point })}>
                <span>Speed</span>
                <strong>{point ? formatSpeed(point.speedMps) : '--'}</strong>
              </div>
              <div className={cx('gps-panel__field', { 'is-disabled': !point })}>
                <span>Lat / Lon</span>
                <strong>{point ? formatLatLon(point.lat, point.lon) : '--'}</strong>
              </div>
              <div className={cx('gps-panel__field', { 'is-disabled': !point })}>
                <span>Altitude</span>
                <strong>{point ? formatAltitude(point.ele) : '--'}</strong>
              </div>
              <div className={cx('gps-panel__field', { 'is-disabled': !point })}>
                <span>Heading</span>
                <strong>{point ? formatHeading(point.headingDeg) : '--'}</strong>
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}

GpsTrackPanel.propTypes = {
  track: PropTypes.object,
  seekTime: PropTypes.number,
  gpsOffsetSec: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
  onGpsOffsetChange: PropTypes.func
};
