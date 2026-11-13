// Cards are filled-rectangle Drawings with `flags.scratchpad.card = { html, links: [{ to, color }] }`.
// Their HTML and strings render in a DOM/SVG overlay that follows canvas pan and zoom.

import { MODULE, isPrivateHidden, onViewedLevel } from "./core.js";
import { layerHides } from "./layers.js";
import { sanitizeHTML, safeColor, textColorOn } from "./sanitize.js";
import { syncEditorTransform } from "./tools/text.js";

const PIN_TOP_OFFSET = 14;
const PIN_RADIUS = 7;
export const STRING_SAG_FACTOR = 0.12;

let boardElement = null;
let layerElement = null;
let lastTransform = "";
let lastHTML = "";
let pendingFrame = 0;

export const cardData = doc => doc.getFlag(MODULE, "card");
export const cardLinks = doc => {
  const links = cardData(doc)?.links;
  return Array.isArray(links) ? links : [];
};

export function pin(doc) {
  const cx = doc.x + doc.shape.width / 2;
  const cy = doc.y + doc.shape.height / 2;
  const localY = PIN_TOP_OFFSET - doc.shape.height / 2;
  const rad = ((Number(doc.rotation) || 0) * Math.PI) / 180;
  return rad ? [cx - localY * Math.sin(rad), cy + localY * Math.cos(rad)] : [cx, doc.y + PIN_TOP_OFFSET];
}

export function visibleCards() {
  if (!canvas.ready || !canvas.scene) return [];
  return canvas.scene.drawings
    .filter(doc => cardData(doc) && (!doc.hidden || game.user.isGM) && !isPrivateHidden(doc) && !layerHides(doc) && onViewedLevel(doc))
    .sort((a, b) => (a.elevation - b.elevation) || (a.sort - b.sort));
}

function isPointInCard(doc, [x, y]) {
  const { width, height } = doc.shape;
  const rad = (-(Number(doc.rotation) || 0) * Math.PI) / 180;
  if (!rad) return x >= doc.x && x <= doc.x + width && y >= doc.y && y <= doc.y + height;

  const dx = x - (doc.x + width / 2);
  const dy = y - (doc.y + height / 2);
  const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
  const localY = dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.abs(localX) <= width / 2 && Math.abs(localY) <= height / 2;
}

export function cardAt(point) {
  return visibleCards().findLast(doc => isPointInCard(doc, point));
}

export function mountBoard() {
  boardElement = document.getElementById("board");
  if (!boardElement) return;

  layerElement = document.createElement("div");
  layerElement.id = "scratchpad-board";
  layerElement.style.zIndex = getComputedStyle(boardElement).zIndex;
  boardElement.after(layerElement);

  canvas.app?.ticker.add(syncTransform);
  scheduleRender();
}

function syncTransform() {
  if (!canvas.ready || !boardElement || !layerElement) return;
  const m = canvas.stage.worldTransform;
  const rect = boardElement.getBoundingClientRect();
  const tf = `matrix(${m.a},${m.b},${m.c},${m.d},${m.tx + rect.left},${m.ty + rect.top})`;

  if (tf !== lastTransform) {
    layerElement.style.transform = lastTransform = tf;
    syncEditorTransform();
  }
}

export function scheduleRender() {
  if (layerElement && !pendingFrame) {
    pendingFrame = requestAnimationFrame(renderBoard);
  }
}

function renderBoard() {
  pendingFrame = 0;
  const cards = visibleCards();
  const byId = new Map(cards.map(d => [d.id, d]));
  const linked = new Set();
  const strings = [];

  for (const card of cards) {
    for (const link of cardLinks(card)) {
      const target = byId.get(link?.to);
      if (!target || target === card) continue;

      linked.add(card).add(target);
      const [ax, ay] = pin(card);
      const [bx, by] = pin(target);
      const sag = Math.hypot(bx - ax, by - ay) * STRING_SAG_FACTOR;
      strings.push(`<path d="M${ax} ${ay} Q${(ax + bx) / 2} ${(ay + by) / 2 + sag} ${bx} ${by}" stroke="${safeColor(link.color)}"/>`);
    }
  }

  const cardsHTML = cards.map(d =>
    `<div class="scratchpad-card${d.hidden ? " is-hidden" : ""}" ` +
    `style="left:${+d.x}px;top:${+d.y}px;width:${+d.shape.width}px;height:${+d.shape.height}px;transform:rotate(${+d.rotation || 0}deg);` +
    `color:${textColorOn(safeColor(d._source.fillColor, "#fff8dc"))}">` +
    `${sanitizeHTML(cardData(d)?.html)}</div>`
  ).join("");

  const pinsSVG = [...linked].map(d => {
    const [cx, cy] = pin(d);
    return `<circle cx="${cx}" cy="${cy}" r="${PIN_RADIUS}"/>`;
  }).join("");

  const html = `${cardsHTML}<svg class="scratchpad-strings">${strings.join("")}<g class="pins">${pinsSVG}</g></svg>`;
  if (html !== lastHTML) {
    layerElement.innerHTML = lastHTML = html;
  }
}
