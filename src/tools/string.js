// Investigation board string tool: drag from one card to another to connect them with a string;
// drag between two already-connected cards to cut the string.

import { MODULE, t, view, penColor, pixiColor, canEdit, pushUndo } from "../core.js";
import { cardAt, cardLinks, pin, STRING_SAG_FACTOR } from "../board.js";

const PREVIEW_STRING_WIDTH_PX = 3;

let activeStringDrag = null; // { fromCard, startPin, endPoint, color }

export default {
  down(point) {
    const fromCard = cardAt(point);
    activeStringDrag = fromCard
      ? { fromCard, startPin: pin(fromCard), endPoint: point, color: penColor() }
      : null;
  },

  move(point) {
    if (!activeStringDrag) return;

    activeStringDrag.endPoint = point;

    // Snap the preview endpoint to the target card's pushpin when hovering over another card.
    const hoveredCard = cardAt(point);
    const targetPoint = hoveredCard && hoveredCard !== activeStringDrag.fromCard
      ? pin(hoveredCard)
      : point;

    drawSaggingStringPreview(activeStringDrag.startPin, targetPoint, activeStringDrag.color);
  },

  async up() {
    const completedDrag = activeStringDrag;
    activeStringDrag = null;
    view.preview.clear();

    if (!completedDrag) return;

    const toCard = cardAt(completedDrag.endPoint);
    if (toCard && toCard !== completedDrag.fromCard) {
      await toggleCardLink(completedDrag.fromCard, toCard, completedDrag.color);
    }
  },

  cancel() {
    activeStringDrag = null;
    view.preview?.clear();
  }
};

function drawSaggingStringPreview([ax, ay], [bx, by], colorString) {
  const graphics = view.preview;
  if (!graphics) return;

  const invScale = 1 / canvas.stage.scale.x;
  const sagOffset = Math.hypot(bx - ax, by - ay) * STRING_SAG_FACTOR;
  const controlX = (ax + bx) / 2;
  const controlY = (ay + by) / 2 + sagOffset;

  graphics.clear();
  graphics.lineStyle({
    width: PREVIEW_STRING_WIDTH_PX * invScale,
    color: pixiColor(colorString),
    alpha: 0.9,
    cap: "round"
  });
  graphics.moveTo(ax, ay);
  graphics.quadraticCurveTo(controlX, controlY, bx, by);
  graphics.beginFill(pixiColor(colorString), 0.9).drawCircle(bx, by, 5 * invScale).endFill();
}

async function toggleCardLink(cardA, cardB, color) {
  const linksFlagKey = `flags.${MODULE}.card.links`;
  const getPartnerCard = card => (card === cardA ? cardB : cardA);

  const existingHolder = [cardA, cardB].find(card =>
    cardLinks(card).some(link => link?.to === getPartnerCard(card).id)
  );

  // Modify the card that holds the existing link, or whichever card the current user can edit.
  const targetDoc = existingHolder ?? [cardA, cardB].find(canEdit);
  if (!targetDoc || !canEdit(targetDoc)) {
    ui.notifications.warn(t("NotOwner"));
    return;
  }

  const partnerId = getPartnerCard(targetDoc).id;
  const previousLinks = cardLinks(targetDoc);
  const updatedLinks = existingHolder
    ? previousLinks.filter(link => link?.to !== partnerId)
    : [...previousLinks, { to: partnerId, color }];

  await targetDoc.update({ [linksFlagKey]: updatedLinks });
  pushUndo({
    scene: targetDoc.parent.id,
    updated: [{ _id: targetDoc.id, [linksFlagKey]: previousLinks }]
  });
}
