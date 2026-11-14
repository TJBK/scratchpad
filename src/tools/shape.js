// Geometric shape tool (lines, arrows, rectangles, circles/ellipses, regular polygons, stars, free polygons).
// Every shape is stored as an open polyline polygon so the partial eraser, dashes, and lasso select all work on it.
import { view, penStyle, setting, lineData, drawLine, pushUndo } from "../core.js";
import { arrowShape, ellipseShape, polyShape, rectShape, snapAngle, snapSquare } from "../geometry.js";

const MIN_SHAPE_DRAG_PX = 3;
const CLOSE_DISTANCE_PX = 10;
const DOUBLE_CLICK_MS = 350;

// kind -> [sides, inner radius ratio]
const REGULAR = { triangle: [3], diamond: [4], pentagon: [5], hexagon: [6], star: [5, 0.45] };

let activeShape = null; // { start, end, shiftKey, kind, style, scene }
let polygon = null; // { points, cursor, style, scene, lastDown }
let pendingCorner = null; // { point, shiftKey }: a polygon click is placed on release, so a pinch can still call it off

function buildShapePolyline({ start, end, shiftKey, kind, style }) {
  if (kind === "rect" || kind === "ellipse" || REGULAR[kind]) {
    const corner = shiftKey ? snapSquare(start, end) : end;
    if (kind === "rect") return rectShape(start, corner);
    if (kind === "ellipse") return ellipseShape(start, corner);
    return polyShape(start, corner, ...REGULAR[kind]);
  }

  const targetEnd = shiftKey ? snapAngle(start, end) : end;
  if (kind === "arrow") {
    const headLength = Math.max(12, style.width * 3);
    return arrowShape(start, targetEnd, headLength);
  }

  return [start, targetEnd];
}

async function createShape(polyline, style, scene) {
  const [createdDoc] = await scene.createEmbeddedDocuments("Drawing", [lineData(polyline, style)]);
  if (createdDoc) pushUndo({ scene: scene.id, created: [createdDoc.id] });
}

const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= CLOSE_DISTANCE_PX / canvas.stage.scale.x;

function drawPolygonPreview() {
  const { points, cursor, style } = polygon;
  drawLine(view.preview, style, cursor ? [...points, cursor] : points);
}

function polygonDown(point, event) {
  const now = performance.now();
  if (!polygon) {
    polygon = { points: [point], cursor: point, style: penStyle(), scene: canvas.scene, lastDown: now };
    return drawPolygonPreview();
  }

  const { points } = polygon;
  const prev = points.at(-1);
  if (event.shiftKey) point = snapAngle(prev, point);

  if (points.length >= 3 && near(point, points[0])) return finishPolygon(true);
  if (near(point, prev)) {
    if (now - polygon.lastDown < DOUBLE_CLICK_MS) return finishPolygon(false);
    polygon.lastDown = now; // slow re-click on the last corner: no duplicate point, but arm the double-click
    return;
  }

  points.push(point);
  polygon.lastDown = now;
  drawPolygonPreview();
}

function finishPolygon(closed) {
  const { points, style, scene } = polygon;
  polygon = null;
  view.preview?.clear();
  if (points.length < 2) return;
  if (closed) points.push(points[0]);
  return createShape(points, style, scene);
}

// Drops an in-progress polygon (tool switch, scene change, Escape). Returns true if one was dropped.
export function cancelPolygon() {
  if (!polygon) return false;
  polygon = null;
  view.preview?.clear();
  return true;
}

export default {
  down(point, event) {
    const kind = setting("shape");
    if (kind === "polygon") {
      pendingCorner = { point, shiftKey: event.shiftKey };
      return;
    }
    cancelPolygon();
    activeShape = { start: point, end: point, shiftKey: event.shiftKey, kind, style: penStyle(), scene: canvas.scene };
  },

  move(point, event) {
    if (polygon || pendingCorner) return this.hover(point, event);
    if (!activeShape) return;

    activeShape.end = point;
    activeShape.shiftKey = event.shiftKey;
    drawLine(view.preview, activeShape.style, buildShapePolyline(activeShape));
  },

  hover(point, event) {
    if (!polygon) return;
    polygon.cursor = event.shiftKey ? snapAngle(polygon.points.at(-1), point) : point;
    drawPolygonPreview();
  },

  async up() {
    if (pendingCorner) {
      const { point, shiftKey } = pendingCorner;
      pendingCorner = null;
      return polygonDown(point, { shiftKey });
    }
    if (!activeShape) return;

    const completedShape = activeShape;
    activeShape = null;
    view.preview.clear();

    const dragDistance = Math.hypot(
      completedShape.end[0] - completedShape.start[0],
      completedShape.end[1] - completedShape.start[1]
    );
    const minCanvasDistance = MIN_SHAPE_DRAG_PX / canvas.stage.scale.x;
    if (dragDistance < minCanvasDistance) return;

    await createShape(buildShapePolyline(completedShape), completedShape.style, completedShape.scene);
  },

  // Drops the press in progress but keeps a polygon's placed corners (a pinch-zoom mid-polygon).
  cancel() {
    activeShape = null;
    pendingCorner = null;
    if (polygon) drawPolygonPreview();
    else view.preview?.clear();
  }
};
