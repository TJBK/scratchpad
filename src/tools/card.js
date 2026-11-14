// Investigation board card tool: click empty canvas space to create a new card, or click an existing card to edit it.
import { MODULE, t, setting, canEdit, pushUndo } from "../core.js";
import { cardAt, cardData } from "../board.js";
import { sanitizeHTML, safeColor, textColorOn } from "../sanitize.js";

const DEFAULT_FILL = "#fff8dc";
const CARD_WIDTH = 280;
const CARD_HEIGHT = 180;
const COMMANDS = [
  ["bold", "fa-bold", "Bold"],
  ["italic", "fa-italic", "Italic"],
  ["underline", "fa-underline", "Underline"],
  ["strikeThrough", "fa-strikethrough", "Strike"],
  ["formatBlock", "fa-heading", "Heading", "h2"],
  ["formatBlock", "fa-paragraph", "Paragraph", "p"],
  ["insertUnorderedList", "fa-list-ul", "BulletList"],
  ["insertOrderedList", "fa-list-ol", "NumberedList"],
  ["removeFormat", "fa-eraser", "ClearFormat"]
];

let dialogOpen = false;
let pressedAt = null; // acted on at release, so the first finger of a pinch-zoom opens no dialog

export default {
  down(point) {
    pressedAt = dialogOpen ? null : point;
  },
  move() {},
  up() {
    const point = pressedAt;
    pressedAt = null;
    if (!point) return;
    const doc = cardAt(point);
    if (!doc) return createCard(point);
    if (!canEdit(doc)) return ui.notifications.warn(t("NotOwner"));
    editCard(doc);
  },
  cancel() {
    pressedAt = null;
  }
};

// Height a card needs to show all its text at `width`. Cards can't scroll on the canvas, so they grow instead.
function fittedHeight(html, width) {
  const probe = document.createElement("div");
  probe.className = "scratchpad-card";
  probe.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:auto;visibility:hidden`;
  probe.innerHTML = html;
  document.body.append(probe);
  const height = Math.ceil(probe.getBoundingClientRect().height);
  probe.remove();
  return height;
}

async function createCard([x, y]) {
  const scene = canvas.scene;
  const result = await openEditor("", DEFAULT_FILL);
  if (!result) return;

  const [doc] = await scene.createEmbeddedDocuments("Drawing", [{
    author: game.user.id,
    x,
    y,
    shape: {
      type: foundry.data.ShapeData.TYPES.RECTANGLE,
      width: CARD_WIDTH,
      height: Math.max(CARD_HEIGHT, fittedHeight(result.html, CARD_WIDTH))
    },
    fillType: CONST.DRAWING_FILL_TYPES.SOLID,
    fillColor: result.fill,
    fillAlpha: 1,
    strokeWidth: 2,
    strokeColor: "#8a7a4a",
    strokeAlpha: 1,
    flags: { [MODULE]: { card: { html: result.html, links: [] }, ...(setting("private") && { private: true }) } }
  }]);
  if (doc) pushUndo({ scene: scene.id, created: [doc.id] });
}

async function editCard(doc) {
  const htmlKey = `flags.${MODULE}.card.html`;
  const result = await openEditor(cardData(doc)?.html ?? "", doc._source.fillColor || DEFAULT_FILL);
  if (!result || !doc.parent?.drawings.has(doc.id)) return;

  const height = Math.max(doc.shape.height, fittedHeight(result.html, doc.shape.width));
  const prev = { _id: doc.id, [htmlKey]: cardData(doc)?.html ?? "", fillColor: doc._source.fillColor, "shape.height": doc.shape.height };
  await doc.update({ [htmlKey]: result.html, fillColor: result.fill, "shape.height": height });
  pushUndo({ scene: doc.parent.id, updated: [prev] });
}

function openEditor(html, fill) {
  dialogOpen = true;
  const safeFill = safeColor(fill, DEFAULT_FILL);
  const buttons = COMMANDS.map(([cmd, icon, key, arg = ""]) =>
    `<button type="button" data-cmd="${cmd}" data-arg="${arg}" aria-label="${t(key)}" data-tooltip="${t(key)}"><i class="fa-solid ${icon}" aria-hidden="true"></i></button>`
  ).join("");

  const content = `<div class="scratchpad-card-editor">
    <div class="toolbar">${buttons}<input type="color" name="fill" value="${safeFill}" aria-label="${t("CardColor")}"></div>
    <div class="body" contenteditable="true" role="textbox" aria-multiline="true" aria-label="${t("CardTitle")}"
      style="background:${safeFill};color:${textColorOn(safeFill)}">${sanitizeHTML(html)}</div>
  </div>`;

  return new Promise(resolve => {
    const done = val => { dialogOpen = false; resolve(val); };
    const dialog = new foundry.applications.api.DialogV2({
      window: { title: t("CardTitle") },
      content,
      buttons: [
        {
          action: "save",
          label: t("Save"),
          default: true,
          callback: () => ({
            html: sanitizeHTML(dialog.element.querySelector(".body").innerHTML),
            fill: safeColor(dialog.element.querySelector("[name=fill]").value, DEFAULT_FILL)
          })
        },
        { action: "cancel", label: t("Cancel") }
      ],
      submit: res => done(typeof res === "object" ? res : null)
    });

    dialog.addEventListener?.("close", () => done(null));
    dialog.render({ force: true }).then(() => {
      const root = dialog.element;
      const body = root.querySelector(".body");
      const fillInput = root.querySelector("[name=fill]");

      fillInput.addEventListener("input", () => {
        const color = safeColor(fillInput.value, DEFAULT_FILL);
        body.style.background = color;
        body.style.color = textColorOn(color);
      });
      const toolbar = root.querySelector(".toolbar");
      const runCommand = btn => document.execCommand(btn.dataset.cmd, false, btn.dataset.arg || null);
      toolbar.addEventListener("mousedown", e => {
        const btn = e.target.closest("button[data-cmd]");
        if (!btn) return;
        e.preventDefault();
        runCommand(btn);
      });
      // Enter/Space fire click with detail 0; mouse clicks are already handled on mousedown.
      toolbar.addEventListener("click", e => {
        const btn = e.target.closest("button[data-cmd]");
        if (!btn || e.detail !== 0) return;
        body.focus();
        runCommand(btn);
      });
      body.focus();
    });
  });
}
