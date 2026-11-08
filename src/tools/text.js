// Uses an inline <textarea> over the canvas so Enter makes real line breaks.
// Ctrl+Enter or clicking elsewhere commits; Escape cancels.

import { MODULE, setting, penColor, canEdit, inBounds, docBounds, pushUndo } from "../core.js";

const CHAR_WIDTH_RATIO = 0.65;
const LINE_HEIGHT_RATIO = 1.4;

let editor = null; // { el, at, doc, scene, fontSize, color }
let measureCtx = null;

export default {
  down(point) {
    if (editor) return commit();
    const doc = canvas.scene.drawings.find(d => d.text && canEdit(d) && !d.rotation && inBounds(point, docBounds(d)));
    openEditor(doc ? [doc.x, doc.y] : point, doc);
  },
  move() {},
  up() {}
};

export const closeEditor = () => commit();

export function syncEditorTransform() {
  if (!editor || !canvas.ready) return;
  const { el, at, fontSize } = editor;
  const client = canvas.clientCoordinatesFromCanvas({ x: at[0], y: at[1] });
  const scaledSize = fontSize * canvas.stage.scale.x;

  Object.assign(el.style, { left: `${client.x}px`, top: `${client.y}px`, fontSize: `${scaledSize}px` });
  resizeTextarea(el, scaledSize);
}

export function updateActiveEditor({ color, fontSize, ...textStyle }) {
  if (!editor) return;
  if (color) editor.color = editor.el.style.color = color;
  for (const key of ["font", "bold", "italic", "align"]) {
    if (key in textStyle) editor[key] = textStyle[key];
  }
  applyEditorFont(editor.el, editor);
  if (fontSize) editor.fontSize = fontSize;
  syncEditorTransform();
  editor.el.focus();
}

function applyEditorFont(el, { font, bold, italic, align }) {
  Object.assign(el.style, {
    fontFamily: font || CONFIG.defaultFontFamily || "var(--font-primary)",
    fontWeight: bold ? "bold" : "normal",
    fontStyle: italic ? "italic" : "normal",
    textAlign: align || "left"
  });
}

const textFlags = ({ bold, italic, align }) => ({ bold: Boolean(bold), italic: Boolean(italic), align: align || "left" });

function resizeTextarea(el, scaledSize) {
  const lines = (el.value || " ").split("\n");
  const maxChars = Math.max(8, ...lines.map(l => l.length + 2));
  el.style.width = `${Math.ceil(maxChars * scaledSize * CHAR_WIDTH_RATIO)}px`;
  el.style.height = `${Math.ceil(lines.length * scaledSize * LINE_HEIGHT_RATIO + 8)}px`;
}

function openEditor(at, doc) {
  const fontSize = doc?.fontSize ?? setting("textSize");
  const color = doc ? doc._source.textColor : penColor();
  const el = document.createElement("textarea");
  el.id = "scratchpad-text";
  el.value = doc?.text ?? "";
  el.style.color = color;

  el.addEventListener("input", () => resizeTextarea(el, (editor?.fontSize ?? fontSize) * canvas.stage.scale.x));
  el.addEventListener("keydown", ev => {
    ev.stopPropagation();
    if (ev.key === "Escape") cancel();
    else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) commit();
  });
  el.addEventListener("blur", ev => {
    if (!ev.relatedTarget?.closest?.("#scratchpad-palette")) commit();
  });

  const f = doc?.flags[MODULE] ?? {};
  const textStyle = doc
    ? { font: doc.fontFamily, bold: f.bold, italic: f.italic, align: f.align }
    : { font: setting("font"), bold: setting("bold"), italic: setting("italic"), align: setting("align") };
  applyEditorFont(el, textStyle);

  document.body.append(el);
  editor = { el, at, doc, scene: canvas.scene, fontSize, color, ...textStyle };
  syncEditorTransform();
  setTimeout(() => el.focus());
}

function cancel() {
  const el = editor?.el;
  editor = null;
  el?.remove();
}

function measureTextShape(text, fontSize, { font, bold, italic } = {}) {
  const lines = text.split("\n");
  let maxWidth = fontSize;

  try {
    measureCtx ??= document.createElement("canvas").getContext("2d");
    const family = font || CONFIG.defaultFontFamily || "sans-serif";
    measureCtx.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}${fontSize}px "${family}"`;
    for (const line of lines) {
      maxWidth = Math.max(maxWidth, measureCtx.measureText(line || " ").width);
    }
  } catch {
    maxWidth = Math.max(1, ...lines.map(l => l.length)) * fontSize * CHAR_WIDTH_RATIO;
  }

  return {
    type: foundry.data.ShapeData.TYPES.RECTANGLE,
    width: Math.ceil(maxWidth + fontSize),
    height: Math.ceil(lines.length * fontSize * LINE_HEIGHT_RATIO + fontSize / 2)
  };
}

async function commit() {
  if (!editor) return;
  const { el, at, doc, scene, fontSize, color } = editor;
  const style = editor;
  const fontFamily = style.font || CONFIG.defaultFontFamily;
  const flags = textFlags(style);
  cancel();

  const text = el.value.replace(/\s+$/, "");
  const shape = measureTextShape(text, fontSize, style);

  if (doc) {
    if (!scene.drawings.has(doc.id)) return;
    const prevFlags = textFlags(doc.flags[MODULE] ?? {});
    const sameStyle = fontFamily === doc.fontFamily && Object.keys(flags).every(k => flags[k] === prevFlags[k]);
    if (text === doc.text && color === doc._source.textColor && fontSize === doc.fontSize && sameStyle) return;

    if (!text) {
      const deleted = [doc.toObject()];
      await doc.delete();
      return pushUndo({ scene: scene.id, deleted });
    }

    const prev = {
      _id: doc.id,
      text: doc.text,
      textColor: doc._source.textColor,
      fontSize: doc.fontSize,
      fontFamily: doc.fontFamily,
      [`flags.${MODULE}`]: prevFlags,
      shape: doc.toObject().shape
    };
    await doc.update({ text, textColor: color, fontSize, fontFamily, [`flags.${MODULE}`]: flags, shape });
    return pushUndo({ scene: scene.id, updated: [prev] });
  }

  if (!text) return;
  const [created] = await scene.createEmbeddedDocuments("Drawing", [{
    author: game.user.id,
    x: at[0],
    y: at[1],
    shape,
    text,
    fontSize,
    textColor: color,
    textAlpha: 1,
    fontFamily,
    strokeWidth: 0,
    fillType: CONST.DRAWING_FILL_TYPES.NONE,
    flags: { [MODULE]: { ...flags, ...(setting("private") && { private: true }) } }
  }]);
  if (created) pushUndo({ scene: scene.id, created: [created.id] });
}
