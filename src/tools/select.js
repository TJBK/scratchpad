// Click or lasso to select (Shift toggles), drag inside the box to move, Delete/Backspace to remove.
// Palette color/style/width changes apply to the selection.

import { MODULE, TOOL, view, activeTool, canEdit, isPolygon, inBounds, docLine, docBounds, hitsLine, unrotate, pushUndo } from "../core.js";
import { pointInPolygon, polylineHitsPolygon, rectShape } from "../geometry.js";
import { cardData } from "../board.js";
import { renderLayersPanel } from "../layers.js";

const PAD = 6;
const SELECT_COLOR = 0x3399ff;

let selection = { scene: null, ids: new Set() };
let drag = null; // { mode: "lasso", path, shiftKey } | { mode: "move", from, to }

export const selectedDrawings = () => selectedDocs();

function selectedDocs() {
  if (!selection.scene || selection.scene !== canvas.scene) return [];
  // Re-checked every time: a drawing or its layer can be locked or hidden after it was selected.
  return [...selection.ids].map(id => selection.scene.drawings.get(id)).filter(doc => doc && canEdit(doc));
}

function docOutline(doc) {
  if (isPolygon(doc)) return docLine(doc);
  const b = docBounds(doc);
  return rectShape([b.minX, b.minY], [b.maxX, b.maxY]);
}

function selectionBounds(docs = selectedDocs()) {
  if (!docs.length) return null;
  const boxes = docs.map(docBounds);
  return {
    minX: Math.min(...boxes.map(b => b.minX)) - PAD,
    minY: Math.min(...boxes.map(b => b.minY)) - PAD,
    maxX: Math.max(...boxes.map(b => b.maxX)) + PAD,
    maxY: Math.max(...boxes.map(b => b.maxY)) + PAD
  };
}

function drawOverlay() {
  const g = view.preview;
  if (!g) return;
  g.clear();

  const invScale = 1 / canvas.stage.scale.x;
  if (drag?.mode === "lasso" && drag.path.length > 1) {
    g.lineStyle(1.5 * invScale, SELECT_COLOR, 1);
    g.moveTo(...drag.path[0]);
    for (const pt of drag.path) g.lineTo(...pt);
  }

  const docs = selectedDocs();
  const box = selectionBounds(docs);
  if (!box) return;

  const dx = drag?.mode === "move" ? drag.to[0] - drag.from[0] : 0;
  const dy = drag?.mode === "move" ? drag.to[1] - drag.from[1] : 0;

  if (dx || dy) {
    g.lineStyle(1.5 * invScale, SELECT_COLOR, 0.55);
    for (const doc of docs) {
      const outline = docOutline(doc);
      g.moveTo(outline[0][0] + dx, outline[0][1] + dy);
      for (let i = 1; i < outline.length; i++) g.lineTo(outline[i][0] + dx, outline[i][1] + dy);
    }
  }

  // With several drawings selected, box each one so it's clear which are in the selection.
  if (docs.length > 1) {
    g.lineStyle(1 * invScale, SELECT_COLOR, 0.7);
    for (const doc of docs) {
      const b = docBounds(doc);
      g.drawRect(b.minX + dx, b.minY + dy, b.maxX - b.minX, b.maxY - b.minY);
    }
  }

  g.lineStyle(2 * invScale, SELECT_COLOR, 0.9)
    .beginFill(SELECT_COLOR, 0.06)
    .drawRect(box.minX + dx, box.minY + dy, box.maxX - box.minX, box.maxY - box.minY)
    .endFill();
}

function findDrawingAt(point) {
  const hitPad = 8 / canvas.stage.scale.x;
  const candidates = canvas.scene.drawings
    .filter(canEdit)
    .sort((a, b) => (b.elevation - a.elevation) || (b.sort - a.sort));

  return candidates.find(doc => {
    const p = unrotate(doc, point);
    return isPolygon(doc)
      ? hitsLine(doc, p, hitPad + (doc.strokeWidth || 2) / 2)
      : inBounds(p, docBounds(doc), hitPad);
  });
}

function updateSelectionFromLasso(path, shiftKey = false) {
  if (!shiftKey || selection.scene !== canvas.scene) {
    selection = { scene: canvas.scene, ids: new Set() };
  }

  if (path.length < 3) {
    const hit = findDrawingAt(path[0]);
    if (!hit) return;
    if (shiftKey && selection.ids.has(hit.id)) selection.ids.delete(hit.id);
    else selection.ids.add(hit.id);
    return;
  }

  for (const doc of canvas.scene.drawings) {
    if (!canEdit(doc)) continue;
    const lasso = doc.rotation ? path.map(p => unrotate(doc, p)) : path;
    const outline = docOutline(doc);
    // A lasso drawn wholly inside a filled shape (or a text/card box) still selects it.
    const hit = polylineHitsPolygon(outline, lasso) || ((!isPolygon(doc) || doc.fillType) && pointInPolygon(lasso[0], outline));
    if (hit) selection.ids.add(doc.id);
  }
}

const overlayClass = (name, on) => document.getElementById("scratchpad-overlay")?.classList.toggle(name, on);

export default {
  down(point, event) {
    const box = selectionBounds();
    const inside = !event?.shiftKey && box && inBounds(point, box);
    drag = inside
      ? { mode: "move", from: point, to: point }
      : { mode: "lasso", path: [point], shiftKey: Boolean(event?.shiftKey) };
    drawOverlay();
  },

  move(point) {
    if (!drag) return;
    if (drag.mode === "move") {
      drag.to = point;
    } else {
      const last = drag.path.at(-1);
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 3 / canvas.stage.scale.x) return;
      drag.path.push(point);
    }
    drawOverlay();
  },

  // Move cursor where a press would drag the selection rather than start a new lasso.
  hover(point, event) {
    const box = selectionBounds();
    overlayClass("move", Boolean(!event?.shiftKey && box && inBounds(point, box)));
  },

  async up() {
    if (!drag) return;
    const current = drag;
    drag = null;

    if (current.mode === "lasso") {
      updateSelectionFromLasso(current.path, current.shiftKey);
      renderLayersPanel();
      return drawOverlay();
    }

    const dx = current.to[0] - current.from[0];
    const dy = current.to[1] - current.from[1];
    const docs = selectedDocs();
    if (Math.hypot(dx, dy) < 1 || !docs.length) return drawOverlay();

    const updated = docs.map(doc => ({ _id: doc.id, x: doc.x, y: doc.y }));
    await selection.scene.updateEmbeddedDocuments("Drawing", docs.map(doc => ({ _id: doc.id, x: doc.x + dx, y: doc.y + dy })));
    pushUndo({ scene: selection.scene.id, updated });
    drawOverlay();
  },

  cancel() {
    drag = null;
    drawOverlay();
  }
};

export function refreshSelection() {
  if (activeTool() !== TOOL.SELECT || drag) return;
  drawOverlay();
  renderLayersPanel(); // the selection may have lost drawings
}

export function clearSelection() {
  overlayClass("move", false);
  if (!selection.ids.size) return;
  selection.ids.clear();
  view.preview?.clear();
  renderLayersPanel();
}

export function deleteSelected() {
  const docs = selectedDocs();
  if (!docs.length) return false;

  const scene = selection.scene;
  const deleted = docs.map(d => d.toObject());
  selection.ids.clear();
  drawOverlay();
  renderLayersPanel();

  scene.deleteEmbeddedDocuments("Drawing", deleted.map(d => d._id))
    .then(() => pushUndo({ scene: scene.id, deleted }));
  return true;
}

export async function restyle({ color, dash, width }) {
  const docs = selectedDocs();
  if (!docs.length) return false;

  const dashKey = `flags.${MODULE}.dash`;
  const prev = [], next = [];

  for (const doc of docs) {
    const p = { _id: doc.id }, n = { _id: doc.id };

    if (color) {
      const key = doc.text ? "textColor" : cardData(doc) ? "fillColor" : "strokeColor";
      p[key] = doc._source[key];
      n[key] = color;
    }
    if (width && !doc.text && !cardData(doc)) {
      p.strokeWidth = doc._source.strokeWidth;
      n.strokeWidth = width;
    }
    if (dash && !doc.text && isPolygon(doc)) {
      p[dashKey] = doc.getFlag(MODULE, "dash") ?? "solid";
      n[dashKey] = dash;
    }

    if (Object.keys(n).length > 1) {
      prev.push(p);
      next.push(n);
    }
  }

  if (next.length) {
    await selection.scene.updateEmbeddedDocuments("Drawing", next);
    pushUndo({ scene: selection.scene.id, updated: prev });
  }
  return true;
}
