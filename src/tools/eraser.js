// Partial eraser tool that slices circular paths out of existing polyline drawings rather than deleting whole strokes.
import { MODULE, view, setting, canEdit, isPolygon, shapeFor, docLine, docBounds, inBounds, pushUndo } from "../core.js";
import { bounds, erasePath, distanceToPolyline, nearestValues } from "../geometry.js";

const ERASER_COLOR = 0xff5555;
const MIN_FRAGMENT_SIZE = 0.1;

let activeEraser = null; // { path, radius, scene }
let hoverPoint = null;

const eraserRadius = () => setting("eraser") / 2 / canvas.stage.scale.x;

export default {
  down(point) {
    hoverPoint = point;
    activeEraser = { path: [point], radius: eraserRadius(), scene: canvas.scene };
    view.preview.clear();
    view.preview.lineStyle(0);
    drawStamp(point, activeEraser.radius);
  },

  move(point) {
    hoverPoint = point;
    if (!activeEraser) return;

    const last = activeEraser.path.at(-1);
    const step = activeEraser.radius / 2;
    const dist = Math.hypot(point[0] - last[0], point[1] - last[1]);
    if (dist < step) return;

    const steps = Math.ceil(dist / step);
    for (let i = 1; i <= steps; i++) {
      const pt = [last[0] + ((point[0] - last[0]) * i) / steps, last[1] + ((point[1] - last[1]) * i) / steps];
      activeEraser.path.push(pt);
      drawStamp(pt, activeEraser.radius);
    }
  },

  hover(point) {
    hoverPoint = point;
    if (!activeEraser) drawCursor(point);
  },

  leave() {
    hoverPoint = null;
    if (!activeEraser) view.preview?.clear();
  },

  cancel() {
    activeEraser = null;
    view.preview?.clear();
  },

  async up() {
    if (!activeEraser) return;
    const { path, radius, scene } = activeEraser;
    activeEraser = null;
    view.preview.clear();
    if (hoverPoint) drawCursor(hoverPoint);

    const pathBox = bounds(path);
    const deleted = [];
    const created = [];
    const whole = setting("eraseMode") === "whole";

    for (const doc of scene.drawings) {
      if (whole ? !canEdit(doc) : !isErasable(doc)) continue;

      const hitRadius = radius + doc.strokeWidth / 2;
      const box = docBounds(doc);
      if (box.minX > pathBox.maxX + hitRadius || box.minY > pathBox.maxY + hitRadius ||
          box.maxX < pathBox.minX - hitRadius || box.maxY < pathBox.minY - hitRadius) continue;

      if (whole) {
        const line = isPolygon(doc) ? docLine(doc) : null;
        const hit = path.some(p => line ? distanceToPolyline(p, line) <= hitRadius : inBounds(p, box, radius));
        if (hit) deleted.push(doc.toObject());
        continue;
      }

      const line = docLine(doc);
      const pieces = erasePath([line], path, hitRadius);
      if (pieces.length === 1 && pieces[0] === line) continue;

      const { _id, ...base } = doc.toObject();
      deleted.push({ _id, ...base });

      const pressure = base.flags?.[MODULE]?.pressure;
      for (const piece of pieces) {
        const pieceBox = bounds(piece);
        if (pieceBox.maxX - pieceBox.minX < MIN_FRAGMENT_SIZE && pieceBox.maxY - pieceBox.minY < MIN_FRAGMENT_SIZE) continue;
        const flags = pressure
          ? foundry.utils.mergeObject(base.flags, { [MODULE]: { pressure: nearestValues(line, pressure, piece) } }, { inplace: false })
          : base.flags;
        created.push({ ...base, flags, x: pieceBox.minX, y: pieceBox.minY, shape: { ...base.shape, ...shapeFor(piece, pieceBox) } });
      }
    }

    if (!deleted.length) return;
    const createdDocs = created.length ? await scene.createEmbeddedDocuments("Drawing", created) : [];
    await scene.deleteEmbeddedDocuments("Drawing", deleted.map(d => d._id));
    pushUndo({ scene: scene.id, created: createdDocs.map(d => d.id), deleted });
  }
};

export function refreshEraserCursor() {
  if (!activeEraser && hoverPoint) drawCursor(hoverPoint);
}

function drawCursor([x, y]) {
  if (!view.preview) return;
  view.preview.clear();
  view.preview
    .lineStyle(1.5 / canvas.stage.scale.x, ERASER_COLOR, 0.7)
    .beginFill(ERASER_COLOR, 0.06)
    .drawCircle(x, y, eraserRadius())
    .endFill();
}

function drawStamp([x, y], radius) {
  view.preview.beginFill(ERASER_COLOR, 0.15).drawCircle(x, y, radius).endFill();
}

function isErasable(doc) {
  return canEdit(doc) && !doc.rotation && !doc.text && isPolygon(doc) && doc.fillType === CONST.DRAWING_FILL_TYPES.NONE;
}
