import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eraseCircle, erasePath, simplify, chaikin, bounds,
  dashSegments, getDashPattern, distanceToPolyline, pointInPolygon, polylineHitsPolygon,
  snapAngle, snapSquare, rectShape, ellipseShape, arrowShape, polyShape, nearestValues, resample, rotateAbout,
  shiftMarks
} from "../src/geometry.js";

test("shiftMarks moves erase marks to a new origin and drops ones that miss", () => {
  const marks = [{ r: 5, p: [100, 10, 110, 10] }, { r: 5, p: [400, 10] }];
  const box = { minX: 0, minY: 0, maxX: 120, maxY: 20 };
  assert.deepEqual(shiftMarks(marks, -50, 0, box), [{ r: 5, p: [50, 10, 60, 10] }]);
  assert.deepEqual(shiftMarks(marks, 0, 0, { minX: 0, minY: 0, maxX: 94, maxY: 20 }), []);
  assert.deepEqual(shiftMarks(undefined, 0, 0, box), []);
});

const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

test("dashes split a line into on/off pieces", () => {
  assert.deepEqual(dashSegments([[0, 0], [25, 0]], 5, 5), [
    [[0, 0], [5, 0]], [[10, 0], [15, 0]], [[20, 0], [25, 0]]
  ]);
});

test("dashes carry across corners", () => {
  const out = dashSegments([[0, 0], [3, 0], [3, 10]], 5, 100);
  assert.deepEqual(out, [[[0, 0], [3, 0], [3, 2]]]);
});

test("dash with no gap returns the line", () => {
  const line = [[0, 0], [1, 1]];
  assert.deepEqual(dashSegments(line, 5, 0), [line]);
});

test("getDashPattern scales with stroke width", () => {
  const [dotLen, dotGap] = getDashPattern("dotted", 4);
  assert.equal(dotLen, 0.01);
  assert.equal(dotGap, 8);
  const [dashLen, dashGap] = getDashPattern("dashed", 4);
  assert.equal(dashLen, 16);
  assert.equal(dashGap, 10);
});

test("pointInPolygon", () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(pointInPolygon([5, 5], sq), true);
  assert.equal(pointInPolygon([15, 5], sq), false);
});

test("polylineHitsPolygon detects lasso crossing the middle of a 2-point straight line", () => {
  const lasso = [[40, -10], [60, -10], [60, 10], [40, 10]];
  const longLine = [[0, 0], [100, 0]];
  const missedLine = [[0, 50], [100, 50]];
  assert.equal(polylineHitsPolygon(longLine, lasso), true);
  assert.equal(polylineHitsPolygon(missedLine, lasso), false);
});

test("distanceToPolyline computes distance to multi-segment line", () => {
  const line = [[0, 0], [10, 0], [10, 10]];
  assert.equal(distanceToPolyline([5, 3], line), 3);
  assert.equal(distanceToPolyline([14, 5], line), 4);
});

test("snapAngle snaps to 45 degrees", () => {
  assert.ok(near(snapAngle([0, 0], [10, 1]), [Math.hypot(10, 1), 0]));
  const d = snapAngle([0, 0], [10, 9]);
  assert.ok(Math.abs(d[0] - d[1]) < 1e-9);
});

test("snapSquare keeps direction", () => {
  assert.deepEqual(snapSquare([0, 0], [-4, 10]), [-10, 10]);
});

test("rect, ellipse, and arrow shapes", () => {
  assert.equal(rectShape([0, 0], [2, 3]).length, 5);
  const ellipse = ellipseShape([0, 0], [10, 20], 16);
  assert.equal(ellipse.length, 17);
  assert.ok(near(ellipse[0], ellipse.at(-1)));
  assert.deepEqual(bounds(ellipse), { minX: 0, minY: 0, maxX: 10, maxY: 20 });

  const arrow = arrowShape([0, 0], [10, 0], 3);
  assert.equal(arrow.length, 5);
  assert.deepEqual(arrow[1], [10, 0]);
  assert.ok(arrow[2][0] < 10 && arrow[4][0] < 10);
});

test("eraser in the middle of a 2-point line splits it in two", () => {
  const line = [[0, 0], [100, 0]];
  const out = eraseCircle(line, [50, 0], 10);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], [[0, 0], [40, 0]]);
  assert.deepEqual(out[1], [[60, 0], [100, 0]]);
});

test("eraser that misses returns the same reference", () => {
  const line = [[0, 0], [100, 0]];
  const out = eraseCircle(line, [50, 50], 10);
  assert.equal(out.length, 1);
  assert.equal(out[0], line);
});

test("eraser covering the start trims it", () => {
  const out = eraseCircle([[0, 0], [100, 0]], [0, 0], 10);
  assert.deepEqual(out, [[[10, 0], [100, 0]]]);
});

test("eraser ending exactly on a vertex preserves the next segment outside the circle", () => {
  const line = [[0, 0], [10, 0], [20, 0]];
  const out = eraseCircle(line, [5, 0], 5);
  assert.deepEqual(out, [[[10, 0], [20, 0]]]);
});

test("eraser covering everything removes the line", () => {
  assert.deepEqual(eraseCircle([[0, 0], [5, 0], [10, 0]], [5, 0], 50), []);
});

test("multi-point line keeps points on each side", () => {
  const out = eraseCircle([[0, 0], [20, 0], [40, 0], [60, 0], [80, 0]], [40, 0], 5);
  assert.deepEqual(out, [[[0, 0], [20, 0], [35, 0]], [[45, 0], [60, 0], [80, 0]]]);
});

test("erasePath sweeps several circles", () => {
  const out = erasePath([[[0, 0], [100, 0]]], [[30, 0], [70, 0]], 5);
  assert.equal(out.length, 3);
});

test("simplify drops collinear points, keeps corners", () => {
  assert.deepEqual(simplify([[0, 0], [5, 0], [10, 0], [10, 10]], 0.5), [[0, 0], [10, 0], [10, 10]]);
});

test("chaikin keeps endpoints", () => {
  const out = chaikin([[0, 0], [10, 10], [20, 0]], 2);
  assert.deepEqual(out[0], [0, 0]);
  assert.deepEqual(out.at(-1), [20, 0]);
});

test("bounds", () => {
  assert.deepEqual(bounds([[3, -1], [-2, 4]]), { minX: -2, minY: -1, maxX: 3, maxY: 4 });
});

test("polyShape: closed regular polygon starting at top, star alternates radii", () => {
  const tri = polyShape([0, 0], [10, 10], 3);
  assert.equal(tri.length, 4);
  assert.ok(near(tri[0], [5, 0]) && near(tri[3], tri[0]));
  const star = polyShape([0, 0], [10, 10], 5, 0.5);
  assert.equal(star.length, 11);
  assert.ok(Math.abs(Math.hypot(star[1][0] - 5, star[1][1] - 5) - 2.5) < 1e-9);
});

test("nearestValues maps each point to the closest source value", () => {
  assert.deepEqual(nearestValues([[0, 0], [10, 0], [20, 0]], [0.2, 0.5, 0.9], [[1, 0], [9, 1], [30, 0]]), [0.2, 0.5, 0.9]);
});

test("resample spaces points evenly and interpolates values", () => {
  const out = resample([[0, 0], [10, 0]], 2.5, [0, 1]);
  assert.deepEqual(out.map(p => p[0]), [0, 2.5, 5, 7.5, 10, 10]);
  assert.ok(Math.abs(out[2][2] - 0.5) < 1e-9);
  assert.deepEqual(resample([[0, 0], [3, 0], [3, 3]], 2).map(p => p.slice(0, 2)), [[0, 0], [2, 0], [3, 1], [3, 3], [3, 3]]);
});

test("rotateAbout turns a point around a centre, clockwise in canvas space", () => {
  assert.ok(near(rotateAbout([10, 0], [0, 0], 90), [0, 10]));
  assert.ok(near(rotateAbout([6, 5], [5, 5], -90), [5, 4]));
  assert.deepEqual(rotateAbout([3, 4], [1, 1], 0), [3, 4]);
});

test("closed shapes end exactly on their first point, so their fill is kept", () => {
  const sameEnds = pts => pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1];
  // Boxes where cos/sin of 2π used to land a rounding error away from the start.
  for (const [a, b] of [[[400, 300], [1000, 900]], [[1116, 868], [1808, 1560]], [[500, 400], [1300, 1100]]]) {
    assert.ok(sameEnds(ellipseShape(a, b)), `ellipse ${a}-${b}`);
    for (const sides of [3, 4, 5, 6]) assert.ok(sameEnds(polyShape(a, b, sides)), `${sides}-gon ${a}-${b}`);
    assert.ok(sameEnds(polyShape(a, b, 5, 0.45)), `star ${a}-${b}`);
  }
  assert.equal(ellipseShape([0, 0], [10, 10], 36).length, 37);
  assert.equal(polyShape([0, 0], [10, 10], 5, 0.45).length, 11);
});
