// Freehand pen tool with Chaikin smoothing, Ramer-Douglas-Peucker simplification, and live socket broadcast.
import { MODULE, view, setting, penStyle, lineData, drawLine, pushUndo } from "../core.js";
import { chaikin, simplify, nearestValues } from "../geometry.js";
import { activeLayerShared } from "../layers.js";

const SOCKET_EVENT = `module.${MODULE}`;
const MIN_POINT_DISTANCE_PX = 2;
const SOCKET_FLUSH_INTERVAL_MS = 50;
const SIMPLIFY_TOLERANCE = 0.5;
const CHAIKIN_ITERATIONS = 2;
const MAX_REMOTE_WIDTH = 150; // the palette's own maximum
const MAX_REMOTE_POINTS = 20000;
const isPoint = p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);

let activeStroke = null; // { points, style, scene, id }
let nextStrokeId = 0;
let pendingCoordinates = [];
let flushTimerId = null;

// Map of remote userId -> { graphics: PIXI.Graphics, id: number }
const remoteStrokes = new Map();

export default {
  down(point, event) {
    const style = { ...penStyle(), fill: null };
    activeStroke = {
      points: [point],
      // Only stylus input carries meaningful pressure; mouse reports a constant 0.5.
      pressures: event?.pointerType === "pen" ? [event.pressure || 0.5] : null,
      style,
      scene: canvas.scene,
      id: ++nextStrokeId
    };

    drawLine(view.preview, style, [point]);
    emitStrokeEvent({ t: "start", style, p: point });
  },

  move(point, event) {
    if (!activeStroke) return;

    const lastPoint = activeStroke.points.at(-1);
    const minCanvasDistance = MIN_POINT_DISTANCE_PX / canvas.stage.scale.x;
    if (Math.hypot(point[0] - lastPoint[0], point[1] - lastPoint[1]) < minCanvasDistance) return;

    activeStroke.points.push(point);
    activeStroke.pressures?.push(event?.pressure || 0.5);
    // Redraw whole stroke: appending lineTo to already-rendered PIXI v7 geometry leaves stale triangles.
    drawLine(view.preview, { ...activeStroke.style, pressure: activeStroke.pressures }, activeStroke.points);

    pendingCoordinates.push(point[0], point[1]);
    flushTimerId ??= setTimeout(flushPendingCoordinates, SOCKET_FLUSH_INTERVAL_MS);
  },

  async up() {
    if (!activeStroke) return;

    const { points, pressures, style, scene, id } = activeStroke;
    flushPendingCoordinates();
    activeStroke = null;

    // Smooth multi-point strokes; convert single-click taps into a short visible segment.
    const finalPolyline = points.length > 1
      ? simplify(chaikin(points, CHAIKIN_ITERATIONS), SIMPLIFY_TOLERANCE)
      : [points[0], [points[0][0] + 0.5, points[0][1]]];
    const pressure = pressures && nearestValues(points, pressures, finalPolyline).map(p => Math.round(p * 100) / 100);

    try {
      const [createdDoc] = await scene.createEmbeddedDocuments("Drawing", [lineData(finalPolyline, { ...style, pressure })]);
      if (createdDoc) {
        pushUndo({ scene: scene.id, created: [createdDoc.id] });
      }
    } finally {
      // Only clear the preview if the user hasn't already begun a new stroke while saving.
      if (!activeStroke) {
        view.preview?.clear();
      }
      emitStrokeEvent({ t: "end", id }, scene);
    }
  },

  cancel() {
    if (!activeStroke) return;
    const { id, scene } = activeStroke;
    clearTimeout(flushTimerId);
    flushTimerId = null;
    pendingCoordinates = [];
    activeStroke = null;
    view.preview?.clear();
    emitStrokeEvent({ t: "end", id }, scene);
  }
};


function emitStrokeEvent(payload, targetScene = activeStroke?.scene ?? canvas.scene) {
  // Private strokes and strokes on a layer players cannot see are never broadcast live.
  if (!targetScene || setting("private") || !activeLayerShared(targetScene)) return;
  game.socket.emit(SOCKET_EVENT, {
    id: activeStroke?.id,
    ...payload,
    user: game.user.id,
    scene: targetScene.id
  });
}

function flushPendingCoordinates() {
  clearTimeout(flushTimerId);
  flushTimerId = null;

  if (pendingCoordinates.length > 0) {
    emitStrokeEvent({ t: "move", pts: pendingCoordinates });
    pendingCoordinates = [];
  }
}

export function resetRemote() {
  clearTimeout(flushTimerId);
  flushTimerId = null;
  pendingCoordinates = [];
  activeStroke = null;

  for (const remote of remoteStrokes.values()) {
    remote.graphics?.destroy();
  }
  remoteStrokes.clear();
}

export function onSocket(message) {
  if (!message || !view.remoteLayer || message.scene !== canvas.scene?.id) return;

  const existing = remoteStrokes.get(message.user);

  // Messages come from other clients: bound the width and point count, and drop non-numeric points.
  if (message.t === "start" && message.style && isPoint(message.p)) {
    existing?.graphics.destroy();
    const graphics = view.remoteLayer.addChild(new PIXI.Graphics());
    const width = Math.min(MAX_REMOTE_WIDTH, Math.max(1, Number(message.style.width) || 1));
    const style = { ...message.style, width, pressure: null, fill: null };
    remoteStrokes.set(message.user, { graphics, id: message.id, style, points: [message.p] });
    drawLine(graphics, style, [message.p]);
  } else if (message.t === "move" && existing?.id === message.id && Array.isArray(message.pts)) {
    for (let i = 0; i < message.pts.length - 1 && existing.points.length < MAX_REMOTE_POINTS; i += 2) {
      const point = [message.pts[i], message.pts[i + 1]];
      if (isPoint(point)) existing.points.push(point);
    }
    drawLine(existing.graphics, existing.style, existing.points);
  } else if (message.t === "end" && existing?.id === message.id) {
    existing.graphics.destroy();
    remoteStrokes.delete(message.user);
  }
}
