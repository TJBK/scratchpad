// Input overlay above the Foundry canvas (below Foundry's HUD/UI) plus the top tool palette.
import { MODULE, TOOL, view, activeTool, setting, penColor, toCanvas, t } from "./core.js";
import pen, { resetRemote } from "./tools/pen.js";
import shape, { cancelPolygon } from "./tools/shape.js";
import text, { closeEditor, updateActiveEditor } from "./tools/text.js";
import select, { clearSelection, restyle, selectedDrawings } from "./tools/select.js";
import eraser, { refreshEraserCursor } from "./tools/eraser.js";
import card from "./tools/card.js";
import string from "./tools/string.js";
import { TEXTURES } from "./textures.js";
import { showLayerBadge, placeOnRight } from "./layers.js";

const HANDLERS = {
  [TOOL.PEN]: pen,
  [TOOL.SHAPE]: shape,
  [TOOL.TEXT]: text,
  [TOOL.SELECT]: select,
  [TOOL.ERASER]: eraser,
  [TOOL.CARD]: card,
  [TOOL.STRING]: string
};

const SWATCHES = [["#000000", "Black"], ["#e03131", "Red"], ["#1971c2", "Blue"], ["#2f9e44", "Green"], ["#f08c00", "Orange"], ["#ffffff", "White"]];

let board, overlay, palette;
let gesture = null;
let activePointerId = null;
let lastTool = null;

export function mountUI() {
  board = document.getElementById("board");
  if (!board) return;

  overlay = document.createElement("div");
  overlay.id = "scratchpad-overlay";
  overlay.style.zIndex = getComputedStyle(board).zIndex;
  board.after(overlay);

  overlay.addEventListener("pointerdown", onDown);
  overlay.addEventListener("pointermove", onMove);
  overlay.addEventListener("pointerup", onUp);
  overlay.addEventListener("pointercancel", onUp);
  overlay.addEventListener("lostpointercapture", onUp);
  overlay.addEventListener("pointerleave", () => HANDLERS[activeTool()]?.leave?.());
  overlay.addEventListener("contextmenu", e => e.preventDefault());
  overlay.addEventListener("wheel", e => {
    board.dispatchEvent(new WheelEvent("wheel", e));
    if (activeTool() === TOOL.ERASER) requestAnimationFrame(refreshEraserCursor);
  }, { passive: true });

  mountPalette();
  syncUI();

  const place = () => requestAnimationFrame(placePalette);
  window.addEventListener("resize", place);
  Hooks.on("collapseSidebar", place);
  Hooks.on("renderSceneNavigation", place);
  // Fonts loading or controls wrapping change the palette's size after it was placed; the badge must follow.
  new ResizeObserver(() => placeOnRight()).observe(palette);
}

// Centre the palette between Foundry's left column (scene controls, scene navigation) and the sidebar,
// so it never covers them on narrow windows. The layer badge is placed after, since it avoids the palette.
function placePalette() {
  if (!palette) return;
  const rightEdge = id => {
    const r = document.getElementById(id)?.getBoundingClientRect();
    return r?.width ? r.right : 0;
  };
  const sidebar = document.getElementById("sidebar")?.getBoundingClientRect();
  palette.style.left = `${Math.max(rightEdge("scene-controls"), rightEdge("scene-navigation")) + 12}px`;
  palette.style.right = `${Math.max(16, window.innerWidth - (sidebar?.width ? sidebar.left : window.innerWidth) + 12)}px`;
  placeOnRight();
}

// Keybinding target: moves keyboard focus into the palette. Escape there gives it back to the canvas.
export function focusPalette() {
  const first = [...(palette?.querySelectorAll("button, input, select") ?? [])].find(el => el.offsetParent);
  first?.focus();
  return Boolean(first);
}

function setColorUI(c) {
  palette.querySelector("[name=color]").value = c;
  for (const btn of palette.querySelectorAll(".swatches button")) {
    const on = btn.dataset.color.toLowerCase() === String(c).toLowerCase();
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
  }
}

// The fill colour only matters for shapes that are filled.
function showFillColor() {
  const label = palette.querySelector("[name=fillColor]").closest("label");
  label.hidden = activeTool() !== TOOL.SHAPE || palette.querySelector("[name=fill]").value === "none";
}

const esc = s => foundry.utils.escapeHTML(String(s));
const rawOption = (val, label, cur) => `<option value="${esc(val)}" ${val === cur ? "selected" : ""}>${esc(label)}</option>`;
const option = (val, key, cur) => rawOption(val, t(key), cur);
const slider = (forTools, key, name, min, max) =>
  `<label data-for="${forTools}">${t(key)} <input type="range" name="${name}" min="${min}" max="${max}">
    <input type="number" data-out="${name}" min="${min}" max="${max}" step="1" aria-label="${t(key)}"></label>`;
const toggle = (forTools, name, key, icon) =>
  `<button type="button" class="toggle" data-for="${forTools}" data-toggle="${name}" aria-pressed="${Boolean(setting(name))}"
    data-tooltip="${t(key)}" aria-label="${t(key)}"><i class="fa-solid ${icon}"></i></button>`;

function fontNames() {
  const FontConfig = foundry.applications.settings?.menus?.FontConfig;
  return FontConfig?.getAvailableFonts?.() ?? Object.keys(CONFIG.fontDefinitions ?? {});
}

function mountPalette() {
  const dash = setting("dash");
  const shapeKind = setting("shape");
  const eraseMode = setting("eraseMode");
  const font = setting("font") || CONFIG.defaultFontFamily;

  palette = document.createElement("div");
  palette.id = "scratchpad-palette";
  palette.setAttribute("role", "region");
  palette.setAttribute("aria-label", game.modules.get(MODULE)?.title ?? "Scratchpad");
  palette.innerHTML = `
    <div class="swatches" data-for="pen shape text select string">${SWATCHES.map(([c, name]) =>
      `<button type="button" data-color="${c}" style="background:${c}" aria-label="${t(`Swatch_${name}`)}"
        data-tooltip="${t(`Swatch_${name}`)}" aria-pressed="false"></button>`).join("")}</div>
    <label class="colour" data-for="pen shape text select string" data-tooltip="${t("Color")}">
      <i class="fa-solid fa-pen" aria-hidden="true"></i><input type="color" name="color" aria-label="${t("Color")}"></label>
    <span data-for="card">${t("CardHint")}</span>
    <span data-for="string">${t("StringHint")}</span>
    <select name="shape" aria-label="${t("Shape")}" data-for="shape">
      ${["line", "arrow", "rect", "ellipse", "triangle", "diamond", "pentagon", "hexagon", "star", "polygon"]
        .map(k => option(k, `Shape_${k}`, shapeKind)).join("")}
    </select>
    <select name="fill" aria-label="${t("Fill")}" data-for="shape">
      ${["none", "solid", "half"].map(k => option(k, `Fill_${k}`, setting("fill"))).join("")}
    </select>
    <label class="colour" data-for="shape" data-tooltip="${t("FillColor")}">
      <i class="fa-solid fa-fill-drip" aria-hidden="true"></i><input type="color" name="fillColor" aria-label="${t("FillColor")}"></label>
    <select name="brush" aria-label="${t("Brush")}" data-for="pen shape">
      ${["round", "square", "flat"].map(k => option(k, `Brush_${k}`, setting("brush"))).join("")}
    </select>
    <select name="texture" aria-label="${t("Texture")}" data-for="pen shape">
      ${option("", "Texture_none", setting("texture"))}${TEXTURES.map(k => option(k, `Texture_${k}`, setting("texture"))).join("")}
    </select>
    <select name="dash" aria-label="${t("LineStyle")}" data-for="pen shape select">
      ${option("solid", "Solid", dash)}${option("dashed", "Dashed", dash)}${option("dotted", "Dotted", dash)}
    </select>
    ${slider("pen shape select", "Width", "width", 1, 150)}
    ${slider("pen shape", "Hardness", "hardness", 0, 100)}
    <select name="font" aria-label="${t("Font")}" data-for="text">
      ${fontNames().map(f => rawOption(f, f, font)).join("")}
    </select>
    ${slider("text", "TextSize", "textSize", 8, 128)}
    ${toggle("text", "bold", "Bold", "fa-bold")}
    ${toggle("text", "italic", "Italic", "fa-italic")}
    <select name="align" aria-label="${t("Align")}" data-for="text">
      ${["left", "center", "right"].map(k => option(k, `Align_${k}`, setting("align"))).join("")}
    </select>
    ${toggle("pen shape", "shadow", "Shadow", "fa-clone")}
    ${toggle("pen shape text card", "private", "Private", "fa-eye-slash")}
    <select name="eraseMode" aria-label="${t("EraseMode")}" data-for="eraser">
      ${option("partial", "ErasePartial", eraseMode)}${option("whole", "EraseWhole", eraseMode)}
    </select>
    ${slider("eraser", "EraserSize", "eraser", 4, 120)}`;

  // Before the layer badge and panel, so Tab moves on from the palette to them.
  const badge = document.getElementById("scratchpad-layer-badge");
  if (badge) badge.before(palette);
  else document.body.append(palette);

  setColorUI(penColor());
  palette.querySelector("[name=fillColor]").value = setting("fillColor") || penColor();
  for (const name of ["width", "textSize", "eraser", "hardness"]) {
    const val = setting(name);
    palette.querySelector(`[name=${name}]`).value = val;
    palette.querySelector(`[data-out=${name}]`).value = val;
  }

  // With a lasso selection, palette changes restyle it and leave the pen's own settings alone.
  const restyling = () => activeTool() === TOOL.SELECT && selectedDrawings().length > 0;

  const applyColor = (c, editorFocus = false) => {
    setColorUI(c);
    if (restyling()) return restyle({ color: c });
    game.settings.set(MODULE, "color", c);
    if (activeTool() === TOOL.TEXT) updateActiveEditor({ color: c }, { focus: editorFocus });
  };

  // Pressing a label or the bar itself must not take focus from the text editor, which commits on blur.
  palette.addEventListener("mousedown", e => {
    if (!e.target.closest("input, select, button")) e.preventDefault();
  });

  // Escape hands the keyboard back to the canvas, where the drawing shortcuts work.
  palette.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    document.activeElement?.blur();
  });

  palette.addEventListener("click", e => {
    if (e.target.dataset?.color) return applyColor(e.target.dataset.color, true);
    const btn = e.target.closest("[data-toggle]");
    if (!btn) return;
    const name = btn.dataset.toggle;
    const on = !setting(name);
    btn.setAttribute("aria-pressed", String(on));
    game.settings.set(MODULE, name, on);
    if (activeTool() === TOOL.TEXT && (name === "bold" || name === "italic")) updateActiveEditor({ [name]: on }, { focus: true });
  });

  palette.addEventListener("input", e => {
    if (e.target.type !== "range") return;
    const { name, value } = e.target;
    palette.querySelector(`[data-out=${name}]`).value = value;
    if (name === "textSize" && activeTool() === TOOL.TEXT) updateActiveEditor({ fontSize: Number(value) });
  });

  palette.addEventListener("change", e => {
    let { name, value, type } = e.target;
    const box = e.target.dataset.out ? e.target : null;
    if (box) {
      // A typed number drives its slider, which also clamps it to the slider's min/max.
      const range = palette.querySelector(`input[type=range][name=${box.dataset.out}]`);
      if (box.value !== "" && Number.isFinite(Number(box.value))) range.value = box.value;
      box.value = range.value;
      ({ name, value, type } = range);
    }
    if (!name) return;
    if (name === "color") return applyColor(value);

    const parsed = type === "range" ? Number(value) : value;
    if ((name === "dash" || name === "width") && restyling()) return restyle({ [name]: parsed });
    game.settings.set(MODULE, name, parsed);
    if (name === "fill") showFillColor();

    const tool = activeTool();
    if (tool === TOOL.TEXT && name === "textSize") updateActiveEditor({ fontSize: parsed });
    else if (tool === TOOL.TEXT && (name === "font" || name === "align")) updateActiveEditor({ [name]: parsed });
    else if (tool === TOOL.ERASER && name === "eraser") refreshEraserCursor();
  });
}

export function syncUI() {
  const tool = activeTool();
  overlay?.classList.toggle("active", Boolean(tool));
  overlay?.classList.toggle("eraser", tool === TOOL.ERASER);
  overlay?.classList.toggle("text", tool === TOOL.TEXT);
  if (tool !== TOOL.SELECT) overlay?.classList.remove("move");

  if (palette) {
    // Settings can change outside the palette (another window, a macro); a stale control
    // would show a choice that isn't applied, and re-picking it fires no change event.
    for (const el of palette.querySelectorAll("select[name], input[type=range][name]")) {
      const value = setting(el.name);
      if (value !== "" && value != null) el.value = value; // "" = font unset: keep the default shown
      const out = palette.querySelector(`[data-out=${el.name}]`);
      if (out) out.value = el.value;
    }
    // A selection restyled in the lasso tool showed its colour here; switching tools shows the pen's again.
    if (tool !== lastTool) setColorUI(penColor());
    for (const btn of palette.querySelectorAll("[data-toggle]")) btn.setAttribute("aria-pressed", String(Boolean(setting(btn.dataset.toggle))));
    palette.classList.toggle("active", Boolean(tool));
    const short = tool?.replace(`${MODULE}-`, "");
    for (const el of palette.querySelectorAll("[data-for]")) {
      el.hidden = !el.dataset.for.split(" ").includes(short);
    }
    showFillColor();
    if (tool) placePalette();
  }

  showLayerBadge(Boolean(tool)); // after the palette is laid out, so the badge can avoid it
  if (tool !== TOOL.SELECT) clearSelection();
  if (tool !== TOOL.SHAPE) cancelPolygon();
  if (tool !== TOOL.TEXT) closeEditor();
  // Only on leaving the eraser: its leave() clears the preview the other tools share.
  if (lastTool === TOOL.ERASER && tool !== TOOL.ERASER) eraser.leave();
  lastTool = tool;
}

export function attachCanvas() {
  resetRemote();
  // ControlsLayer's teardown leaves foreign children alone, so the previous pair must be removed here.
  for (const old of [view.preview, view.remoteLayer]) if (old && !old.destroyed) old.destroy({ children: true });
  view.preview = canvas.controls.addChild(new PIXI.Graphics());
  view.remoteLayer = canvas.controls.addChild(new PIXI.Container());
  cancelPolygon();
  clearSelection();
  closeEditor();
  gesture?.cancel?.(); // a drag still in flight belongs to the old canvas
  gesture = null;
  activePointerId = null;
  touches.clear();
  pinch = null;
}

// Touch: two fingers pan/pinch-zoom the canvas. While a stylus is in use (touching or hovering
// in the last moment), a single finger doesn't draw: it's most likely the palm resting on the screen.
const PALM_WINDOW_MS = 1500;
const touches = new Map(); // pointerId -> [clientX, clientY]
let pinch = null; // { mid: [x, y], dist }
let lastPenAt = -Infinity;

function pinchState() {
  const [a, b] = [...touches.values()];
  return { mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1 };
}

function startPinch() {
  if (gesture) {
    const g = gesture;
    const id = activePointerId;
    gesture = null;
    activePointerId = null;
    if (overlay.hasPointerCapture?.(id)) overlay.releasePointerCapture(id);
    g.cancel ? g.cancel() : g.up();
  }
  pinch = pinchState();
}

function movePinch() {
  const next = pinchState();
  const scale = canvas.stage.scale.x * (next.dist / pinch.dist);
  const anchor = canvas.canvasCoordinatesFromClient({ x: pinch.mid[0], y: pinch.mid[1] });
  const rect = board.getBoundingClientRect();
  // Keep the canvas point under the previous finger midpoint under the new midpoint.
  canvas.pan({
    x: anchor.x - (next.mid[0] - rect.left - rect.width / 2) / scale,
    y: anchor.y - (next.mid[1] - rect.top - rect.height / 2) / scale,
    scale
  });
  pinch = next;
}

function onDown(e) {
  const tool = activeTool();
  if (e.pointerType === "pen") lastPenAt = performance.now();
  // preventDefault below also stops the press from taking focus, so a palette control or chat box
  // would keep it and swallow the drawing shortcuts (Ctrl+Z, Delete, Escape). The text editor
  // is left alone: pressing the canvas is how its text gets committed.
  const focused = document.activeElement;
  if (tool && focused instanceof HTMLElement && focused !== document.body && focused.id !== "scratchpad-text") focused.blur();
  if (e.pointerType === "touch" && tool && canvas.ready) {
    e.preventDefault();
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (touches.size >= 2) return startPinch();
    if (performance.now() - lastPenAt < PALM_WINDOW_MS) return;
  }
  if (e.button !== 0 || !tool || !canvas.ready) {
    board.dispatchEvent(new PointerEvent("pointerdown", e));
    return;
  }
  // A left press must never reach core DrawingsLayer: with our tool active it builds an invalid drawing.
  e.preventDefault();
  if (gesture) finishGesture(e); // missed release (focus loss, dialog): end the stale gesture instead of blocking input
  activePointerId = e.pointerId;
  overlay.setPointerCapture(e.pointerId);
  gesture = HANDLERS[tool];
  try {
    gesture.down(toCanvas(e), e);
  } catch (err) {
    gesture = null;
    activePointerId = null;
    throw err;
  }
}

function onMove(e) {
  if (e.pointerType === "pen") lastPenAt = performance.now();
  if (touches.has(e.pointerId)) {
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && touches.size >= 2) return movePinch();
  }
  if (!gesture) {
    const tool = activeTool();
    if (tool && canvas.ready) HANDLERS[tool]?.hover?.(toCanvas(e), e);
    return;
  }
  if (e.pointerId !== activePointerId) return;
  for (const ev of e.getCoalescedEvents?.() ?? [e]) {
    gesture.move(toCanvas(ev), ev);
  }
}

function onUp(e) {
  if (e.type !== "lostpointercapture" && touches.delete(e.pointerId) && touches.size < 2) pinch = null;
  if (!gesture || e.pointerId !== activePointerId) return;
  if (e.type === "pointerup" && e.button !== 0) return;
  finishGesture(e);
}

function finishGesture(e) {
  const g = gesture;
  const id = activePointerId;
  gesture = null; // clear first: releasing capture fires lostpointercapture -> onUp
  activePointerId = null;
  if (overlay.hasPointerCapture?.(id)) overlay.releasePointerCapture(id);
  g.up(e);
}
