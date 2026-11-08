// Pure 2D geometry utilities with no Foundry globals, allowing standalone unit testing in Node.
// All points are represented as [x, y] coordinate tuples.

export function bounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Smooth a polyline using Chaikin's corner-cutting algorithm while preserving its endpoints.
 */
export function chaikin(points, iterations = 2) {
  let smoothed = points;
  for (let step = 0; step < iterations && smoothed.length > 2; step++) {
    const nextPoints = [smoothed[0]];
    for (let i = 0; i < smoothed.length - 1; i++) {
      const [ax, ay] = smoothed[i];
      const [bx, by] = smoothed[i + 1];
      nextPoints.push(
        [0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by],
        [0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]
      );
    }
    nextPoints.push(smoothed.at(-1));
    smoothed = nextPoints;
  }
  return smoothed;
}

export function distanceToSegment(point, segStart, segEnd) {
  const dx = segEnd[0] - segStart[0];
  const dy = segEnd[1] - segStart[1];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq
    ? Math.max(0, Math.min(1, ((point[0] - segStart[0]) * dx + (point[1] - segStart[1]) * dy) / lengthSq))
    : 0;
  return Math.hypot(point[0] - (segStart[0] + t * dx), point[1] - (segStart[1] + t * dy));
}

export function distanceToPolyline(point, polyline) {
  let min = Infinity;
  for (let i = 1; i < polyline.length; i++) {
    min = Math.min(min, distanceToSegment(point, polyline[i - 1], polyline[i]));
  }
  return min;
}

/**
 * Iterative Ramer-Douglas-Peucker polyline simplification.
 */
export function simplify(points, tolerance) {
  if (points.length < 3) return points.slice();

  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [start, end] = stack.pop();
    let maxDist = 0;
    let splitIndex = -1;

    for (let i = start + 1; i < end; i++) {
      const dist = distanceToSegment(points[i], points[start], points[end]);
      if (dist > maxDist) {
        maxDist = dist;
        splitIndex = i;
      }
    }

    if (maxDist > tolerance) {
      keep[splitIndex] = 1;
      stack.push([start, splitIndex], [splitIndex, end]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

const lerpPoint = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * Parametric interval [tEnter, tExit] in [0, 1] where segment (a -> b) lies inside circle (center, radius).
 */
function circleIntersectionInterval(a, b, center, radius) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const fx = a[0] - center[0];
  const fy = a[1] - center[1];

  const A = dx * dx + dy * dy;
  const C = fx * fx + fy * fy - radius * radius;
  if (A === 0) return C < 0 ? [0, 1] : null;

  const B = 2 * (fx * dx + fy * dy);
  const discriminant = B * B - 4 * A * C;
  if (discriminant <= 0) return null;

  const root = Math.sqrt(discriminant);
  const tEnter = Math.max(0, (-B - root) / (2 * A));
  const tExit = Math.min(1, (-B + root) / (2 * A));
  return tEnter < tExit ? [tEnter, tExit] : null;
}

/**
 * Cut a circle out of a polyline and return the surviving pieces.
 * Returns `[points]` (same reference) if the circle misses the line completely.
 */
export function eraseCircle(points, center, radius) {
  if (points.length < 2) return [points];

  const pieces = [];
  let current = [];
  let touched = false;

  const flush = () => {
    if (current.length >= 2) pieces.push(current);
    current = [];
  };

  if (Math.hypot(points[0][0] - center[0], points[0][1] - center[1]) < radius) {
    touched = true;
  } else {
    current.push(points[0]);
  }

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const hit = circleIntersectionInterval(a, b, center, radius);

    if (!hit) {
      if (current.length === 0) current.push(a);
      current.push(b);
      continue;
    }

    touched = true;
    if (hit[0] > 0) current.push(lerpPoint(a, b, hit[0]));
    flush();
    if (hit[1] < 1) current = [lerpPoint(a, b, hit[1]), b];
  }

  flush();
  return touched ? pieces : [points];
}

export function erasePath(polylines, eraserPath, radius) {
  for (const center of eraserPath) {
    polylines = polylines.flatMap(line => eraseCircle(line, center, radius));
  }
  return polylines;
}

/**
 * Erase marks ({ r, p: [x0, y0, x1, y1, ...] }, relative to a drawing's origin) moved by (dx, dy),
 * keeping only those that reach `box`, which is in the new coordinates.
 */
export function shiftMarks(marks, dx, dy, box) {
  const out = [];
  for (const { r, p } of marks ?? []) {
    const q = p.map((v, i) => Math.round((v + (i % 2 ? dy : dx)) * 10) / 10);
    let hit = false;
    for (let i = 0; i < q.length && !hit; i += 2) {
      hit = q[i] >= box.minX - r && q[i] <= box.maxX + r && q[i + 1] >= box.minY - r && q[i + 1] <= box.maxY + r;
    }
    if (hit) out.push({ r, p: q });
  }
  return out;
}

export function getDashPattern(dashStyle, strokeWidth) {
  return dashStyle === "dotted"
    ? [0.01, Math.max(3, strokeWidth * 2)]
    : [Math.max(6, strokeWidth * 4), Math.max(4, strokeWidth * 2.5)];
}

/**
 * Split a polyline into "on" dash segments of length `dashLength` separated by gaps of length `gapLength`.
 */
export function dashSegments(points, dashLength, gapLength) {
  const segments = [];
  if (points.length < 2 || dashLength <= 0 || gapLength <= 0) {
    return points.length >= 2 ? [points] : segments;
  }

  let drawingDash = true;
  let remaining = dashLength;
  let current = [points[0]];

  for (let i = 1; i < points.length; i++) {
    let a = points[i - 1];
    const b = points[i];
    let segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);

    while (segLen > remaining) {
      const split = lerpPoint(a, b, remaining / segLen);
      if (drawingDash) {
        current.push(split);
        segments.push(current);
        current = null;
      } else {
        current = [split];
      }
      segLen -= remaining;
      a = split;
      drawingDash = !drawingDash;
      remaining = drawingDash ? dashLength : gapLength;
    }

    remaining -= segLen;
    if (drawingDash) current.push(b);
  }

  if (drawingDash && current?.length >= 2) segments.push(current);
  return segments;
}

export function pointInPolygon([x, y], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function segmentsIntersect(a, b, c, d) {
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a), d2 = cross(c, d, b);
  const d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function polylineHitsPolygon(polyline, polygon) {
  if (polygon.length < 3 || polyline.length === 0) return false;
  if (polyline.some(pt => pointInPolygon(pt, polygon))) return true;

  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1], b = polyline[i];
    if (pointInPolygon(lerpPoint(a, b, 0.5), polygon)) return true;
    for (let j = 0, k = polygon.length - 1; j < polygon.length; k = j++) {
      if (segmentsIntersect(a, b, polygon[k], polygon[j])) return true;
    }
  }
  return false;
}

export function snapAngle(start, end) {
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(end[1] - start[1], end[0] - start[0]) / step) * step;
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  return [start[0] + Math.cos(angle) * length, start[1] + Math.sin(angle) * length];
}

export function snapSquare(start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return [start[0] + (dx < 0 ? -side : side), start[1] + (dy < 0 ? -side : side)];
}

export function rectShape(a, b) {
  return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]], [a[0], a[1]]];
}

export function ellipseShape(a, b, segments = 36) {
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
  const rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
  return Array.from({ length: segments + 1 }, (_, i) => {
    const angle = (i / segments) * Math.PI * 2;
    return [cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry];
  });
}

// Evenly spaced points along a polyline as [x, y, value]; value is linearly interpolated from `values` (default 1).
export function resample(points, step, values = null) {
  const out = [];
  const val = i => (values ? values[i] : 1);
  if (!points.length) return out;
  out.push([points[0][0], points[0][1], val(0)]);
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1], [bx, by] = points[i];
    const len = Math.hypot(bx - ax, by - ay);
    let d = step - carry;
    while (d <= len) {
      const t = d / len;
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t, val(i - 1) + (val(i) - val(i - 1)) * t]);
      d += step;
    }
    carry = len - (d - step);
  }
  const last = points.at(-1);
  out.push([last[0], last[1], val(points.length - 1)]);
  return out;
}

// For each dst point, the value of the nearest src point (keeps pen pressure aligned after smoothing or erasing).
export function nearestValues(src, values, dst) {
  return dst.map(([x, y]) => {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < src.length; i++) {
      const d = (src[i][0] - x) ** 2 + (src[i][1] - y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return values[best];
  });
}

// Regular polygon (or star when inner < 1) inscribed in the box a-b, first vertex at top.
export function polyShape(a, b, sides, inner = 1) {
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
  const rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
  const count = inner < 1 ? sides * 2 : sides;
  return Array.from({ length: count + 1 }, (_, i) => {
    const angle = -Math.PI / 2 + (i / count) * Math.PI * 2;
    const r = inner < 1 && i % 2 ? inner : 1;
    return [cx + Math.cos(angle) * rx * r, cy + Math.sin(angle) * ry * r];
  });
}

export function arrowShape(start, tip, headLength) {
  const angle = Math.atan2(tip[1] - start[1], tip[0] - start[0]);
  const spread = 0.45;
  const barb = offset => [tip[0] - headLength * Math.cos(angle + offset), tip[1] - headLength * Math.sin(angle + offset)];
  return [start, tip, barb(-spread), tip, barb(spread)];
}
