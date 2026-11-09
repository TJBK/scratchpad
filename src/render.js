// Extends Foundry's Drawing placeable to render Scratchpad styles: brushes, textures, pen pressure,
// shadows, fills, soft edges, private visibility and extra text styling.
import { MODULE, ownsShape, isPrivateHidden, docLine, drawLine, softness, blurStrength } from "./core.js";
import { cardData, scheduleRender } from "./board.js";
import { layerHides } from "./layers.js";

export function registerDrawingClass() {
  const Base = CONFIG.Drawing.objectClass;

  CONFIG.Drawing.objectClass = class ScratchpadDrawing extends Base {
    get isVisible() {
      return !isPrivateHidden(this.document) && !layerHides(this.document) && super.isVisible;
    }

    _refreshShape() {
      const doc = this.document;
      const f = doc.flags[MODULE] ?? {};
      // Every polyline goes through drawLine: core uses butt caps and miter joins, so even
      // the default round tip would come out square-ended.
      if (!ownsShape(doc)) {
        this.shape.filters = null;
        super._refreshShape();
        return applyEraseMask(this.shape, f.erase); // core-drawn polylines can carry erase marks too
      }

      drawLine(this.shape, {
        width: doc.strokeWidth,
        color: doc.strokeColor,
        alpha: doc.strokeAlpha,
        fill: doc.fillType ? { color: doc.fillColor, alpha: doc.fillAlpha } : null,
        ...f
      }, docLine(doc, 0, 0));
      this.shape.filters = softness(f.hardness, doc.strokeWidth);
      applyEraseMask(this.shape, f.erase);
    }

    _getTextStyle() {
      const style = super._getTextStyle();
      const f = this.document.flags[MODULE] ?? {};
      if (f.bold) style.fontWeight = "bold";
      if (f.italic) style.fontStyle = "italic";
      if (f.align) style.align = f.align;
      return style;
    }

    _onUpdate(changed, options, userId) {
      super._onUpdate(changed, options, userId);
      if (!changed.flags?.[MODULE]) return;
      this.renderFlags.set({ refreshState: true, refreshShape: true, refreshText: Boolean(this.text) });
    }
  };
}

const CLIPPER_SCALE = 10; // Clipper works in integers; 0.1px precision

// PIXI 7 has no inverse masks, so the mask is the drawing's bounds minus the eraser paths
// (each a round-ended band of the eraser's radius), computed with Foundry's bundled Clipper.
function applyEraseMask(g, marks) {
  if (g.spEraseMask) {
    g.mask = null;
    g.spEraseMask.destroy();
    g.spEraseMask = null;
  }
  const C = globalThis.ClipperLib;
  if (!marks?.length || !C) return;

  const S = CLIPPER_SCALE;
  const pt = (x, y) => ({ X: Math.round(x * S), Y: Math.round(y * S) });
  const b = g.getLocalBounds();
  const subject = [pt(b.left - 1, b.top - 1), pt(b.right + 1, b.top - 1), pt(b.right + 1, b.bottom + 1), pt(b.left - 1, b.bottom + 1)];

  const clip = new C.Clipper();
  clip.AddPath(subject, C.PolyType.ptSubject, true);
  for (const { r, p } of marks) {
    const offset = new C.ClipperOffset();
    const path = [];
    for (let i = 0; i < p.length; i += 2) path.push(pt(p[i], p[i + 1]));
    offset.AddPath(path, C.JoinType.jtRound, C.EndType.etOpenRound);
    const band = new C.Paths();
    offset.Execute(band, r * S);
    clip.AddPaths(band, C.PolyType.ptClip, true);
  }
  const tree = new C.PolyTree();
  clip.Execute(C.ClipType.ctDifference, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);

  const mask = new PIXI.Graphics().beginFill(0xffffff);
  const flat = contour => contour.flatMap(q => [q.X / S, q.Y / S]);
  // PolyTree alternates: outer contours hold holes, holes hold islands (more outers).
  const drawOuters = node => {
    for (const outer of node.Childs()) {
      mask.drawPolygon(flat(outer.Contour()));
      const holes = outer.Childs();
      if (holes.length) {
        mask.beginHole();
        for (const hole of holes) mask.drawPolygon(flat(hole.Contour()));
        mask.endHole();
      }
      holes.forEach(drawOuters);
    }
  };
  drawOuters(tree);
  mask.endFill();
  g.spEraseMask = g.addChild(mask);
  g.mask = mask;
}

// Soft-edge blur is in screen pixels, so it has to follow the zoom.
let lastScale = 0;
export function onCanvasPan(_canvas, { scale }) {
  if (scale === lastScale) return;
  lastScale = scale;
  for (const drawing of canvas.drawings?.placeables ?? []) {
    const hardness = drawing.document.flags[MODULE]?.hardness;
    const blur = drawing.shape?.filters?.[0];
    if (hardness < 100 && blur instanceof PIXI.BlurFilter) blur.blur = blurStrength(hardness, drawing.document.strokeWidth);
  }
}

export function onRefreshDrawing(drawing) {
  if (cardData(drawing.document)) scheduleRender();
}
