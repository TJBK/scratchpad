// Simple per-scene drawing layers. The ordered layer list (bottom first) lives in scene flags;
// each Drawing stores its layer id in flags.scratchpad.layer, and layer order maps onto Drawing `sort`.
import { MODULE, t, setting, pushUndo } from "./core.js";

export const SORT_BAND = 100000; // sort range reserved for each layer
const BASE_ID = "base";

export function getLayers(scene = canvas.scene) {
  const layers = scene?.getFlag(MODULE, "layers");
  return Array.isArray(layers) && layers.length ? layers : [{ id: BASE_ID, name: t("LayerBase") }];
}

export function layerIdOf(doc, layers = getLayers(doc.parent)) {
  const id = doc.getFlag(MODULE, "layer");
  return layers.some(l => l.id === id) ? id : layers[0].id;
}

const layerOf = doc => {
  const layers = getLayers(doc.parent);
  return layers.find(l => l.id === layerIdOf(doc, layers));
};

const hiddenForMe = layer => layer.hidden || (layer.gmOnly && !game.user.isGM);
const isUsable = layer => !hiddenForMe(layer) && !layer.locked;
export const layerHides = doc => hiddenForMe(layerOf(doc));
export const layerBlocksEdit = doc => {
  const layer = layerOf(doc);
  return hiddenForMe(layer) || Boolean(layer.locked);
};
export const visibleToPlayers = doc => {
  const layer = layerOf(doc);
  return !layer.hidden && !layer.gmOnly;
};

// The layer new drawings go into: the user's choice for this scene if usable, else the top usable layer.
export function activeLayer(scene = canvas.scene) {
  const layers = getLayers(scene);
  const usable = layers.filter(isUsable);
  const chosen = setting("activeLayers")?.[scene?.id];
  return (usable.find(l => l.id === chosen) ?? usable.at(-1) ?? layers.at(-1)).id;
}

async function setActiveLayer(id) {
  const map = { ...setting("activeLayers"), [canvas.scene.id]: id };
  await game.settings.set(MODULE, "activeLayers", map);
  renderLayersPanel();
}

const bandSort = (index, sort) => index * SORT_BAND + (((sort % SORT_BAND) + SORT_BAND) % SORT_BAND);

export function registerLayerHooks() {
  // Every new drawing (any tool, including Foundry's own) lands in the active layer, on top of that layer.
  Hooks.on("preCreateDrawing", (doc, data, options, userId) => {
    if (userId !== game.user.id || !doc.parent) return;
    const layers = getLayers(doc.parent);
    const given = layers.some(l => l.id === data.flags?.[MODULE]?.layer);
    // No layer to draw on: refuse, rather than save a stroke its author cannot see or edit.
    // Data that names its layer (undo, eraser pieces) is restoring a drawing and always goes through.
    if (!given && !layers.some(isUsable)) {
      ui.notifications.warn(t("LayerNoneUsable"));
      return false;
    }
    const id = given ? data.flags[MODULE].layer : activeLayer(doc.parent);
    const index = layers.findIndex(l => l.id === id);
    const inBand = s => Math.floor(s / SORT_BAND) === index;
    const top = doc.parent.drawings.reduce((m, d) => (inBand(d.sort) ? Math.max(m, d.sort) : m), index * SORT_BAND);
    doc.updateSource({ [`flags.${MODULE}.layer`]: id, sort: inBand(data.sort ?? -1) ? data.sort : top + 1 });
  });

  Hooks.on("updateScene", (scene, changes) => {
    if (scene !== canvas.scene || !foundry.utils.hasProperty(changes, `flags.${MODULE}.layers`)) return;
    for (const drawing of canvas.drawings.placeables) drawing.renderFlags.set({ refreshState: true });
    Hooks.callAll(`${MODULE}.layersChanged`);
    renderLayersPanel();
  });

  Hooks.on("canvasReady", renderLayersPanel);
}

// GM only: save the layer list; with resort, rewrite every drawing's sort so layer order holds.
async function saveLayers(layers, { resort = false, moves = {} } = {}) {
  const scene = canvas.scene;
  await scene.update({ [`flags.${MODULE}.layers`]: layers });
  if (!resort) return;
  const index = new Map(layers.map((l, i) => [l.id, i]));
  const updates = [];
  for (const doc of scene.drawings) {
    const id = moves[doc.getFlag(MODULE, "layer")] ?? layerIdOf(doc, layers);
    const sort = bandSort(index.get(id), doc.sort);
    if (sort !== doc.sort || id !== doc.getFlag(MODULE, "layer")) updates.push({ _id: doc.id, sort, [`flags.${MODULE}.layer`]: id });
  }
  if (updates.length) await scene.updateEmbeddedDocuments("Drawing", updates);
}

// Moves the given drawings into a layer (top of it). Undoable.
export async function moveToLayer(docs, layerId) {
  if (!docs.length) return;
  const scene = docs[0].parent;
  const layers = getLayers(scene);
  const index = layers.findIndex(l => l.id === layerId);
  if (index < 0) return;
  let top = scene.drawings.reduce((m, d) => (layerIdOf(d, layers) === layerId ? Math.max(m, d.sort) : m), index * SORT_BAND);
  const key = `flags.${MODULE}.layer`;
  const prev = docs.map(d => ({ _id: d.id, sort: d.sort, [key]: layerIdOf(d, layers) }));
  await scene.updateEmbeddedDocuments("Drawing", docs.map(d => ({ _id: d.id, sort: ++top, [key]: layerId })));
  pushUndo({ scene: scene.id, updated: prev });
}

/* ---------------- Panel ---------------- */

let panel = null;
let badge = null;
let moveSelection = null; // () => Drawing[] supplied by the lasso tool

export function mountLayersPanel(getSelection) {
  moveSelection = getSelection;

  // Always-visible "current layer" badge on the right, next to Foundry's sidebar, while a Scratchpad tool is active.
  badge = document.createElement("button");
  badge.type = "button";
  badge.id = "scratchpad-layer-badge";
  badge.hidden = true;
  badge.setAttribute("aria-expanded", "false");
  badge.dataset.tooltip = t("LayerBadgeHint");
  badge.addEventListener("click", () => toggleLayersPanel());
  document.body.append(badge);

  panel = document.createElement("section");
  panel.id = "scratchpad-layers";
  panel.hidden = true;
  panel.setAttribute("aria-label", t("Layers"));
  document.body.append(panel);
  panel.addEventListener("click", onPanelClick);
  panel.addEventListener("dblclick", onPanelDoubleClick);

  window.addEventListener("resize", placeOnRight);
  Hooks.on("collapseSidebar", () => requestAnimationFrame(placeOnRight));
}

// Shown only while a Scratchpad tool is active; the panel closes with it.
export function showLayerBadge(show) {
  if (!badge) return;
  badge.hidden = !show;
  if (!show) panel.hidden = true;
  renderLayersPanel();
}

export function toggleLayersPanel(force) {
  if (!panel) return;
  panel.hidden = force === undefined ? !panel.hidden : !force;
  renderLayersPanel();
}

function placeOnRight() {
  const sidebar = document.getElementById("sidebar");
  const left = sidebar?.getBoundingClientRect().left || window.innerWidth;
  const right = `${Math.max(16, window.innerWidth - left + 12)}px`;
  if (!badge || !panel) return;
  badge.style.right = panel.style.right = right;

  // Drop below the tool palette on narrow windows where they would overlap.
  badge.style.top = "12px";
  const pal = document.getElementById("scratchpad-palette")?.getBoundingClientRect();
  const b = badge.getBoundingClientRect();
  if (pal?.width && b.left < pal.right && b.right > pal.left) badge.style.top = `${pal.bottom + 8}px`;
  panel.style.top = `${badge.getBoundingClientRect().bottom + 6}px`;
}

function renderBadge() {
  if (!badge || badge.hidden || !canvas.scene) return;
  const id = activeLayer();
  const layer = getLayers().find(l => l.id === id);
  badge.innerHTML = `<i class="fa-solid fa-layer-group" aria-hidden="true"></i>
    <span>${t("Layer")}: <strong>${esc(layer?.name ?? "")}</strong></span>
    <i class="fa-solid ${panel.hidden ? "fa-chevron-down" : "fa-chevron-up"}" aria-hidden="true"></i>`;
  badge.setAttribute("aria-expanded", String(!panel.hidden));
  placeOnRight();
}

const esc = s => foundry.utils.escapeHTML(String(s));
const iconButton = (act, icon, label, pressed) =>
  `<button type="button" data-act="${act}" data-tooltip="${label}" aria-label="${label}"${pressed === undefined ? "" : ` aria-pressed="${pressed}"`}><i class="fa-solid ${icon}"></i></button>`;

export function renderLayersPanel() {
  renderBadge();
  if (!panel || panel.hidden || !canvas.scene) return;
  const gm = game.user.isGM;
  const active = activeLayer();
  const rows = getLayers().map((l, i) => ({ ...l, i })).reverse().filter(l => gm || !hiddenForMe(l));

  panel.innerHTML = `
    <header><strong>${t("Layers")}</strong>
      ${gm ? iconButton("add", "fa-plus", t("LayerAdd")) : ""}
      ${iconButton("close", "fa-xmark", t("Close"))}</header>
    <ol>${rows.map(l => `
      <li data-id="${esc(l.id)}" class="${l.id === active ? "active" : ""}">
        <button type="button" class="name" data-act="select" aria-pressed="${l.id === active}"
          ${gm ? `data-tooltip="${t("LayerRenameHint")}"` : ""}>${esc(l.name)}</button>
        ${gm ? `
          ${iconButton("hidden", l.hidden ? "fa-eye-slash" : "fa-eye", t("LayerHide"), Boolean(l.hidden))}
          ${iconButton("gmOnly", "fa-user-secret", t("LayerGmOnly"), Boolean(l.gmOnly))}
          ${iconButton("locked", l.locked ? "fa-lock" : "fa-lock-open", t("LayerLock"), Boolean(l.locked))}
          ${iconButton("up", "fa-arrow-up", t("LayerUp"))}
          ${iconButton("down", "fa-arrow-down", t("LayerDown"))}
          ${iconButton("delete", "fa-trash", t("LayerDelete"))}` : ""}
      </li>`).join("")}
    </ol>
    <footer>${iconButton("move", "fa-right-to-bracket", t("LayerMoveSelection"))} <span>${t("LayerMoveSelection")}</span></footer>`;
}

async function onPanelClick(event) {
  const btn = event.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "close") return toggleLayersPanel(false);
  if (act === "move") return moveToLayer(moveSelection?.() ?? [], activeLayer());

  const layers = foundry.utils.deepClone(getLayers());
  if (act === "add") {
    layers.push({ id: foundry.utils.randomID(), name: `${t("Layer")} ${layers.length + 1}` });
    await saveLayers(layers);
    return setActiveLayer(layers.at(-1).id);
  }

  const id = btn.closest("[data-id]")?.dataset.id;
  const i = layers.findIndex(l => l.id === id);
  if (i < 0) return;
  if (act === "select") return setActiveLayer(id);
  if (!game.user.isGM) return;

  if (act === "hidden" || act === "gmOnly" || act === "locked") {
    layers[i][act] = !layers[i][act];
    return saveLayers(layers);
  }
  if (act === "up" || act === "down") {
    const j = act === "up" ? i + 1 : i - 1;
    if (j < 0 || j >= layers.length) return;
    [layers[i], layers[j]] = [layers[j], layers[i]];
    return saveLayers(layers, { resort: true });
  }
  if (act === "delete") {
    if (layers.length < 2) return ui.notifications.warn(t("LayerLastWarn"));
    const target = layers[i > 0 ? i - 1 : 1];
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("LayerDelete") },
      content: `<p>${esc(game.i18n.format("SCRATCHPAD.LayerDeleteConfirm", { name: layers[i].name, target: target.name }))}</p>`,
      rejectClose: false
    });
    if (!ok) return;
    layers.splice(i, 1);
    return saveLayers(layers, { resort: true, moves: { [id]: target.id } });
  }
}

function onPanelDoubleClick(event) {
  const nameBtn = event.target.closest(".name");
  if (!nameBtn || !game.user.isGM) return;
  const id = nameBtn.closest("[data-id]").dataset.id;
  const input = document.createElement("input");
  input.type = "text";
  input.value = nameBtn.textContent.trim();
  input.setAttribute("aria-label", t("LayerRenameHint"));
  nameBtn.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async save => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (!save || !name) return renderLayersPanel();
    const layers = foundry.utils.deepClone(getLayers());
    const layer = layers.find(l => l.id === id);
    if (layer) layer.name = name.slice(0, 60);
    await saveLayers(layers);
  };
  input.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}
