// Shared constants, state, and document/graphics helpers used across all Scratchpad tools.
import { bounds, dashSegments, getDashPattern, resample } from "./geometry.js";
import { brushTexture } from "./textures.js";
import { layerBlocksEdit } from "./layers.js";

export const MODULE = "scratchpad";

export const TOOL = {
  PEN: "scratchpad-pen",
  SHAPE: "scratchpad-shape",
  TEXT: "scratchpad-text",
  SELECT: "scratchpad-select",
  ERASER: "scratchpad-eraser",
  CARD: "scratchpad-card",
  STRING: "scratchpad-string"
};

const ALL_TOOLS = Object.values(TOOL);
const UNDO_LIMIT = 50;

// PIXI containers attached to canvas.controls, recreated on every canvasReady.
export const view = { preview: null, remoteLayer: null };

export const setting = key => game.settings.get(MODULE, key);
export const penColor = () => setting("color") || game.user?.color?.css || "#000000";
export const penStyle = () => ({
  color: penColor(),
  width: setting("width"),
  dash: setting("dash"),
  brush: setting("brush"),
  hardness: setting("hardness"),
  texture: setting("texture") || null,
  shadow: setting("shadow"),
  fill: setting("fill") === "none" ? null : { color: setting("fillColor") || penColor(), alpha: setting("fill") === "half" ? 0.5 : 1 },
  private: setting("private")
});

// Private drawings are only shown to (and editable by) their author.
export const isPrivateHidden = doc => Boolean(doc.getFlag(MODULE, "private")) && doc._source.author !== game.user.id;
export const t = key => game.i18n.localize(`SCRATCHPAD.${key}`);

export function pixiColor(color) {
  try {
    const num = Number(foundry.utils.Color.from(color));
    return Number.isFinite(num) ? num : 0x000000;
  } catch {
    return 0x000000;
  }
}

export function activeTool() {
  const tool = ui.controls?.tool?.name ?? game.activeTool;
  return ALL_TOOLS.includes(tool) ? tool : null;
}

export function toCanvas(event) {
  const { x, y } = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  return [x, y];
}


export const canEdit = doc =>
  doc.isOwner && !doc.locked && (!doc.hidden || game.user.isGM) && !isPrivateHidden(doc) && !layerBlocksEdit(doc);
export const isPolygon = doc => doc.shape.type === foundry.data.ShapeData.TYPES.POLYGON && doc.shape.points.length >= 4;
export const docBounds = doc => ({ minX: doc.x, minY: doc.y, maxX: doc.x + doc.shape.width, maxY: doc.y + doc.shape.height });

export function inBounds([x, y], box, pad = 0) {
  return x >= box.minX - pad && x <= box.maxX + pad && y >= box.minY - pad && y <= box.maxY + pad;
}

const round10 = n => Math.round(n * 10) / 10;

export function shapeFor(polyline, box = bounds(polyline)) {
  return {
    type: foundry.data.ShapeData.TYPES.POLYGON,
    width: Math.max(1, box.maxX - box.minX),
    height: Math.max(1, box.maxY - box.minY),
    points: polyline.flatMap(([x, y]) => [round10(x - box.minX), round10(y - box.minY)])
  };
}

const isClosed = pts => pts.length > 2 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1];

// Only non-default style values are stored, so plain strokes stay plain core drawings.
export function styleFlags(style) {
  const f = {};
  if (style.dash && style.dash !== "solid") f.dash = style.dash;
  if (style.brush && style.brush !== "round") f.brush = style.brush;
  if (style.hardness != null && style.hardness < 100) f.hardness = style.hardness;
  if (style.texture) f.texture = style.texture;
  if (style.shadow) f.shadow = true;
  if (style.pressure) f.pressure = style.pressure;
  if (style.private) f.private = true;
  return f;
}

export function lineData(polyline, style) {
  const box = bounds(polyline);
  const fill = style.fill && isClosed(polyline) ? style.fill : null;
  const flags = styleFlags(style);
  return {
    author: game.user.id,
    x: box.minX,
    y: box.minY,
    shape: shapeFor(polyline, box),
    strokeWidth: style.width,
    strokeColor: style.color,
    strokeAlpha: 1,
    fillType: fill ? CONST.DRAWING_FILL_TYPES.SOLID : CONST.DRAWING_FILL_TYPES.NONE,
    ...(fill && { fillColor: fill.color, fillAlpha: fill.alpha }),
    bezierFactor: 0,
    flags: Object.keys(flags).length ? { [MODULE]: flags } : {}
  };
}

export function docLine(doc, offsetX = doc.x, offsetY = doc.y) {
  const pts = doc.shape.points;
  const out = [];
  for (let i = 0; i < pts.length; i += 2) {
    out.push([offsetX + pts[i], offsetY + pts[i + 1]]);
  }
  return out;
}


const BRUSH_CAPS = { round: ["round", "round"], square: ["square", "miter"], flat: ["butt", "bevel"] };
const SHADOW_COLOR = "#000000";
const SHADOW_ALPHA = 0.35;

// Draws a stroke with every Scratchpad style option. Used for live previews, remote strokes and saved drawings alike.
export function drawLine(graphics, style, points) {
  if (!graphics || !points?.length) return;
  graphics.clear();
  if (points.length === 1) points = [points[0], [points[0][0] + 0.5, points[0][1]]];

  const closed = isClosed(points);
  if (style.shadow) {
    const o = Math.max(8, style.width);
    const shade = c => c && { ...c, color: SHADOW_COLOR, alpha: (c.alpha ?? 1) * SHADOW_ALPHA };
    strokePath(graphics, { ...shade(style), texture: null, fill: shade(style.fill) }, points.map(([x, y]) => [x + o, y + o]), closed);
  }
  strokePath(graphics, style, points, closed);
}

function strokePath(g, style, points, closed) {
  if (style.fill && closed) {
    g.lineStyle(0).beginFill(pixiColor(style.fill.color), style.fill.alpha ?? 1).drawPolygon(points.flat()).endFill();
  }
  if (!style.width) return;

  const alpha = style.alpha ?? 1;
  const isDashed = style.dash && style.dash !== "solid";
  const pressure = style.pressure?.length === points.length && !isDashed ? style.pressure : null;
  const segments = isDashed ? dashSegments(points, ...getDashPattern(style.dash, style.width)) : [points];

  // Foundry's smooth-graphics lines ignore textures, so textured brushes paint overlapping tip stamps
  // with a world-aligned texture fill instead.
  const texture = style.texture ? brushTexture(style.texture) : null;
  if (texture) {
    g.lineStyle(0).beginTextureFill({ texture, color: 0xffffff, alpha });
    const step = Math.max(1, style.width * 0.2);
    for (const seg of segments) {
      for (const [x, y, s] of resample(seg, step, pressure)) stamp(g, style.brush, x, y, (style.width / 2) * Math.max(0.1, s));
    }
    g.endFill();
    return;
  }

  const [cap, join] = BRUSH_CAPS[style.brush] ?? BRUSH_CAPS.round;
  const setWidth = width => g.lineStyle({ width, color: pixiColor(style.color), alpha, cap, join });

  if (pressure) {
    // Round caps hide the width steps between segments.
    for (let i = 1; i < points.length; i++) {
      g.lineStyle({ width: style.width * Math.max(0.1, (pressure[i - 1] + pressure[i]) / 2),
        color: pixiColor(style.color), alpha, cap: "round", join: "round" });
      g.moveTo(points[i - 1][0], points[i - 1][1]).lineTo(points[i][0], points[i][1]);
    }
    return;
  }

  setWidth(style.width);
  for (const seg of segments) {
    g.moveTo(seg[0][0], seg[0][1]);
    for (let i = 1; i < seg.length; i++) g.lineTo(seg[i][0], seg[i][1]);
  }
}

// One brush-tip imprint: round disc, square, or a flat calligraphy nib.
function stamp(g, brush, x, y, r) {
  if (brush === "square") g.drawRect(x - r, y - r, r * 2, r * 2);
  else if (brush === "flat") g.drawEllipse(x, y, r, r * 0.35);
  else g.drawCircle(x, y, r);
}

// Soft brush edge: blur scaled to stroke width and current zoom. null when fully hard.
export function softness(hardness, width) {
  if (hardness == null || hardness >= 100) return null;
  const strength = (1 - hardness / 100) * width * 0.5 * (canvas.stage?.scale.x ?? 1);
  return [new PIXI.BlurFilter(Math.max(0.5, strength), 3)];
}


const undoStack = [];
const redoStack = [];
let historyQueue = Promise.resolve();

export function pushUndo({ scene, created = [], deleted = [], updated = [] }) {
  undoStack.push({ scene, created, deleted, updated });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

async function applyHistory(op, reverseStack) {
  const scene = game.scenes.get(op.scene);
  if (!scene) return;

  const createdDocs = op.created.map(id => scene.drawings.get(id)?.toObject()).filter(Boolean);
  const toRestore = op.deleted.filter(d => !scene.drawings.has(d._id));
  const toUpdate = [];
  const prevUpdates = [];

  for (const change of op.updated) {
    const doc = scene.drawings.get(change._id);
    if (!doc) continue;
    toUpdate.push(change);
    const prev = { _id: doc.id };
    for (const key of Object.keys(change)) {
      if (key !== "_id") prev[key] = foundry.utils.getProperty(doc._source, key);
    }
    prevUpdates.push(prev);
  }

  if (createdDocs.length) await scene.deleteEmbeddedDocuments("Drawing", createdDocs.map(d => d._id));
  if (toRestore.length) await scene.createEmbeddedDocuments("Drawing", toRestore, { keepId: true });
  if (toUpdate.length) await scene.updateEmbeddedDocuments("Drawing", toUpdate);

  reverseStack.push({
    scene: op.scene,
    created: toRestore.map(d => d._id),
    deleted: createdDocs,
    updated: prevUpdates
  });
  if (reverseStack.length > UNDO_LIMIT) reverseStack.shift();
}

export function undo() {
  const op = undoStack.pop();
  if (!op) return false;
  historyQueue = historyQueue.then(() => applyHistory(op, redoStack));
  return true;
}

export function redo() {
  const op = redoStack.pop();
  if (!op) return false;
  historyQueue = historyQueue.then(() => applyHistory(op, undoStack));
  return true;
}
