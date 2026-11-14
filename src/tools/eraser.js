// Partial eraser tool that slices circular paths out of existing polyline drawings rather than deleting whole strokes.
import { MODULE, view, setting, canEdit, isPolygon, shapeFor, docLine, docBounds, hitsLine, inBounds, unrotate, pushUndo } from "../core.js";
import { bounds, erasePath, nearestValues, shiftMarks, simplify } from "../geometry.js";

const ERASER_COLOR = 0xff5555;
const MIN_FRAGMENT_SIZE = 0.1;
const MARKS_KEY = `flags.${MODULE}.erase`;

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
    // Stored marks drop the interpolated in-between points, which only matter for cutting.
    const markPath = simplify(path, radius / 20);
    const deleted = [];
    const created = [];
    const updates = [];
    const prevUpdates = [];
    const whole = setting("eraseMode") === "whole";

    for (const doc of scene.drawings) {
      if (whole ? !canEdit(doc) : !isErasable(doc)) continue;

      const hitRadius = radius + doc.strokeWidth / 2;
      const box = docBounds(doc);
      // The stored box is unrotated, so it cannot rule out a rotated drawing (whole mode only).
      if (!doc.rotation && (box.minX > pathBox.maxX + hitRadius || box.minY > pathBox.maxY + hitRadius ||
          box.maxX < pathBox.minX - hitRadius || box.maxY < pathBox.minY - hitRadius)) continue;

      if (whole) {
        const line = isPolygon(doc) ? docLine(doc) : null;
        const hit = path.some(raw => {
          const p = unrotate(doc, raw);
          return line ? hitsLine(doc, p, hitRadius, line) : inBounds(p, box, radius);
        });
        if (hit) deleted.push(doc.toObject());
        continue;
      }

      const line = docLine(doc);
      if (!path.some(p => hitsLine(doc, p, hitRadius, line))) continue;

      // The line itself is only cut where the eraser covers its whole width. Everywhere else the
      // eraser path is kept as a mark that render.js masks out, so only what was under it vanishes.
      const pad = doc.strokeWidth * 1.5 + 8; // stroke half-width plus drop shadow offset
      const ownBox = { minX: -pad, minY: -pad, maxX: doc.shape.width + pad, maxY: doc.shape.height + pad };
      const mark = { r: Math.round(radius * 10) / 10, p: markPath.flatMap(([x, y]) => [x - doc.x, y - doc.y]) };
      const marks = [...(doc.getFlag(MODULE, "erase") ?? []), ...shiftMarks([mark], 0, 0, ownBox)];
      const cutRadius = radius - doc.strokeWidth / 2;
      const pieces = cutRadius > 0 && !doc.fillType ? erasePath([line], path, cutRadius) : [line];

      if (pieces.length === 1 && pieces[0] === line) {
        updates.push({ _id: doc.id, [MARKS_KEY]: marks });
        prevUpdates.push({ _id: doc.id, [MARKS_KEY]: doc.getFlag(MODULE, "erase") ?? [] });
        continue;
      }

      const { _id, ...base } = doc.toObject();
      deleted.push({ _id, ...base });

      const pressure = base.flags?.[MODULE]?.pressure;
      for (const piece of pieces) {
        const pieceBox = bounds(piece);
        if (pieceBox.maxX - pieceBox.minX < MIN_FRAGMENT_SIZE && pieceBox.maxY - pieceBox.minY < MIN_FRAGMENT_SIZE) continue;
        const local = { minX: -pad, minY: -pad, maxX: pieceBox.maxX - pieceBox.minX + pad, maxY: pieceBox.maxY - pieceBox.minY + pad };
        const own = {
          erase: shiftMarks(marks, doc.x - pieceBox.minX, doc.y - pieceBox.minY, local),
          ...(pressure && { pressure: nearestValues(line, pressure, piece) })
        };
        const flags = foundry.utils.mergeObject(base.flags, { [MODULE]: own }, { inplace: false });
        created.push({ ...base, flags, x: pieceBox.minX, y: pieceBox.minY, shape: { ...base.shape, ...shapeFor(piece, pieceBox) } });
      }
    }

    if (!deleted.length && !updates.length) return;
    const createdDocs = created.length ? await scene.createEmbeddedDocuments("Drawing", created) : [];
    try {
      if (deleted.length) await scene.deleteEmbeddedDocuments("Drawing", deleted.map(d => d._id));
    } catch (err) {
      // Someone else removed an original first: take the new pieces back out instead of leaving duplicates.
      if (createdDocs.length) await scene.deleteEmbeddedDocuments("Drawing", createdDocs.map(d => d.id));
      throw err;
    }
    if (updates.length) await scene.updateEmbeddedDocuments("Drawing", updates);
    pushUndo({ scene: scene.id, created: createdDocs.map(d => d.id), deleted, updated: prevUpdates });
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
  // Filled shapes are erasable too: they only get erase marks, since cutting would break the fill.
  return canEdit(doc) && !doc.rotation && !doc.text && isPolygon(doc);
}
