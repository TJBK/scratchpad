// Extends Foundry's Drawing placeable to render Scratchpad styles: brushes, textures, pen pressure,
// shadows, fills, soft edges, private visibility and extra text styling.
import { MODULE, isPolygon, isPrivateHidden, docLine, drawLine, softness } from "./core.js";
import { cardData, scheduleRender } from "./board.js";
import { layerHides } from "./layers.js";

const SHAPE_FLAGS = ["dash", "brush", "hardness", "texture", "pressure", "shadow", "arrow"];

export function registerDrawingClass() {
  const Base = CONFIG.Drawing.objectClass;

  CONFIG.Drawing.objectClass = class ScratchpadDrawing extends Base {
    get isVisible() {
      return !isPrivateHidden(this.document) && !layerHides(this.document) && super.isVisible;
    }

    _refreshShape() {
      const doc = this.document;
      const f = doc.flags[MODULE] ?? {};
      if (!isPolygon(doc) || !SHAPE_FLAGS.some(k => f[k] != null)) {
        this.shape.filters = null;
        return super._refreshShape();
      }

      drawLine(this.shape, {
        width: doc.strokeWidth,
        color: doc.strokeColor,
        alpha: doc.strokeAlpha,
        fill: doc.fillType ? { color: doc.fillColor, alpha: doc.fillAlpha } : null,
        ...f
      }, docLine(doc, 0, 0));
      this.shape.filters = softness(f.hardness, doc.strokeWidth);
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

export function onRefreshDrawing(drawing) {
  if (cardData(drawing.document)) scheduleRender();
}
