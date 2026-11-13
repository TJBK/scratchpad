// Bakes the scene background plus visible Drawings (and optionally Tiles) into a single background image.
import { MODULE, t, pushUndo, pixiColor, docBounds } from "./core.js";
import { visibleToPlayers } from "./layers.js";
import { cardData } from "./board.js";

const MAX_BAKE_SIZE = 8192;

// v14 keeps the background on the viewed Level; writing scene.background there is silently dropped.
function bakeTarget() {
  const scene = canvas.scene;
  const level = canvas.level ?? null;
  return {
    scene,
    bgDoc: level ?? scene,
    level: level?.id ?? null,
    flag: level ? `originalBackgrounds.${level.id}` : "originalBackground"
  };
}

export async function openBakeDialog() {
  if (!game.user.isGM || !canvas.ready) return;
  const { scene, flag } = bakeTarget();
  const canRestore = scene.getFlag(MODULE, flag) !== undefined;
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: t("BakeTitle"), icon: "fa-solid fa-image" },
    content: `<p>${t("BakeHint")}</p>
      <label class="checkbox"><input type="checkbox" name="tiles"> ${t("BakeTiles")}</label>
      <label class="checkbox"><input type="checkbox" name="remove" checked> ${t("BakeRemove")}</label>`,
    buttons: [
      {
        action: "bake",
        label: t("Bake"),
        icon: "fa-solid fa-image",
        default: true,
        callback: (event, button) => ({
          tiles: button.form.elements.tiles.checked,
          remove: button.form.elements.remove.checked
        })
      },
      ...(canRestore ? [{ action: "restore", label: t("BakeRestore"), icon: "fa-solid fa-rotate-left" }] : [])
    ],
    rejectClose: false
  });
  if (!choice) return;

  try {
    if (choice === "restore") return await restoreBackground();
    await bakeScene(choice);
    ui.notifications.info(t("BakeDone"));
  } catch (err) {
    console.error(err);
    ui.notifications.error(`${t("BakeFailed")} ${err.message}`);
  }
}

// Puts back the background from before the first bake. Undoable.
async function restoreBackground() {
  const { scene, bgDoc, level, flag } = bakeTarget();
  const original = scene.getFlag(MODULE, flag);
  if (original === undefined) return;
  const previous = bgDoc.background.src ?? null;
  await bgDoc.update({ "background.src": original || null });
  pushUndo({ scene: scene.id, background: { level, src: previous } });
}

export async function bakeScene({ tiles = false, remove = true } = {}) {
  const { scene, bgDoc, level, flag } = bakeTarget();
  // The image only covers the scene rectangle. When baked things are removed, only those wholly
  // inside it are baked; the rest stay as they are, so nothing ends up both baked and still on the map.
  const rect = canvas.dimensions.sceneRect;
  const fits = (b, rotation) => !remove ||
    (!rotation && b.minX >= rect.left && b.minY >= rect.top && b.maxX <= rect.right && b.maxY <= rect.bottom);

  // Only what players can see is baked: no hidden, private, hidden-layer or GM-only-layer drawings.
  // Cards are skipped too: their text and strings live in the DOM overlay, which cannot be baked.
  // `.visible` matches what renderSceneImage draws, so nothing is deleted without being in the image.
  const drawings = scene.drawings.filter(d =>
    !d.hidden && !d.interface && !d.getFlag(MODULE, "private") && !cardData(d) && visibleToPlayers(d) &&
    d.object?.shape?.visible && fits(docBounds(d), d.rotation));
  const bakedTiles = tiles ? scene.tiles.filter(tile => !tile.hidden && tile.object?.mesh?.visible &&
    fits({ minX: tile.x, minY: tile.y, maxX: tile.x + tile.width, maxY: tile.y + tile.height }, tile.rotation)) : [];

  const blob = await renderSceneImage(drawings, bakedTiles);
  const path = await upload(blob, `${scene.id}-${Date.now()}.webp`);

  // Keep the very first original so the pre-bake background can always be restored.
  const previous = bgDoc.background.src ?? null;
  const original = scene.getFlag(MODULE, flag) ?? previous ?? "";
  await scene.update({ [`flags.${MODULE}.${flag}`]: original });
  await bgDoc.update({ "background.src": path });
  // Never delete drawings unless the baked image really became the background.
  if (bgDoc.background.src !== path) throw new Error("background update was not applied");

  // One undo step puts back the old background and everything the bake removed.
  const undo = { scene: scene.id, background: { level, src: previous } };
  if (remove && drawings.length) {
    undo.deleted = drawings.map(d => d.toObject());
    await scene.deleteEmbeddedDocuments("Drawing", undo.deleted.map(d => d._id));
  }
  if (remove && bakedTiles.length) {
    undo.tiles = { deleted: bakedTiles.map(tile => tile.toObject()) };
    await scene.deleteEmbeddedDocuments("Tile", undo.tiles.deleted.map(d => d._id));
  }
  pushUndo(undo);
}

async function renderSceneImage(drawings, tiles) {
  const renderer = canvas.app.renderer;
  const rect = canvas.dimensions.sceneRect;
  const gl = renderer.gl;
  const maxSize = Math.min(MAX_BAKE_SIZE, gl?.getParameter(gl.MAX_TEXTURE_SIZE) ?? 4096);
  const scale = Math.min(1, maxSize / Math.max(rect.width, rect.height));
  const width = Math.round(rect.width * scale);
  const height = Math.round(rect.height * scale);
  const transform = new PIXI.Matrix(scale, 0, 0, scale, -rect.x * scale, -rect.y * scale);

  // canvas.primary is a screen-sized CachedContainer whose objects only draw inside its render pass,
  // so bake plain PIXI copies (shared geometry/textures) in the group's draw order instead.
  const keep = new Set([canvas.primary.background, ...drawings.map(d => d.object.shape), ...tiles.map(tile => tile.object.mesh)]);
  const stage = new PIXI.Container();
  const backdrop = stage.addChild(new PIXI.Graphics());
  backdrop.beginFill(pixiColor(canvas.level?.background.color ?? canvas.scene.backgroundColor ?? "#999999")).drawRect(rect.x, rect.y, rect.width, rect.height).endFill();
  for (const child of canvas.primary.children) {
    if (keep.has(child) && child.visible) stage.addChild(copyOf(child, scale / canvas.stage.scale.x));
  }

  const rt = PIXI.RenderTexture.create({ width, height });
  try {
    renderer.render(stage, { renderTexture: rt, transform, clear: true });
    const extracted = renderer.extract.canvas(rt);
    return await new Promise((resolve, reject) =>
      extracted.toBlob(b => (b ? resolve(b) : reject(new Error("image encode failed"))), "image/webp", 0.92));
  } finally {
    stage.destroy({ children: true });
    rt.destroy(true);
  }
}

// A plain PIXI stand-in for a primary-group object, positioned identically.
function copyOf(obj, blurRatio) {
  let copy;
  if (obj instanceof PIXI.smooth.SmoothGraphics) {
    copy = new PIXI.smooth.SmoothGraphics(obj.geometry);
    // Soft-brush blur is sized for the current zoom (core.js softness); resize it for the bake scale.
    copy.filters = obj.filters?.map(f => (f instanceof PIXI.BlurFilter ? new PIXI.BlurFilter(f.blur * blurRatio, 3) : f)) ?? null;
    // Partial-erase mask (render.js); without it erased parts would reappear in the bake.
    if (obj.spEraseMask) copy.mask = copy.addChild(new PIXI.Graphics(obj.spEraseMask.geometry));
    for (const child of obj.children) {
      if (!(child instanceof PIXI.Text) || !child.visible) continue;
      const text = copy.addChild(new PIXI.Text(child.text, child.style));
      text.resolution = child.resolution;
      text.transform.setFromMatrix(child.transform.localTransform);
      text.anchor.copyFrom(child.anchor);
      text.alpha = child.alpha;
    }
  } else {
    copy = new PIXI.Sprite(obj.texture ?? PIXI.Texture.EMPTY);
    if (obj.anchor) copy.anchor.copyFrom(obj.anchor);
    copy.tint = obj.tint ?? 0xffffff;
  }
  copy.transform.setFromMatrix(obj.transform.localTransform);
  copy.alpha = obj.alpha;
  return copy;
}

async function upload(blob, name) {
  const FilePicker = foundry.applications.apps.FilePicker.implementation;
  const dir = `worlds/${game.world.id}/scratchpad`;
  try {
    await FilePicker.createDirectory("data", dir);
  } catch {
    // already exists
  }
  const result = await FilePicker.upload("data", dir, new File([blob], name, { type: "image/webp" }), {}, { notify: false });
  if (!result?.path) throw new Error("upload failed");
  return result.path;
}
