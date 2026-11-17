import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { File } from "node:buffer";
import { pushUndo, undo, redo } from "../src/core.js";
import { bakeScene } from "../src/bake.js";

const scenes = new Map();
globalThis.game = { scenes, world: { id: "world" }, i18n: { localize: key => key } };
globalThis.ui = { notifications: { warn: message => assert.fail(message) } };
globalThis.foundry = { utils: { objectsEqual: isDeepStrictEqual, Color: { from: () => 0 } } };
globalThis.File ??= File;

const flushHistory = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

function makeScene(id) {
  const collection = () => Object.assign(new Map(), {
    filter(predicate) { return [...this.values()].filter(predicate); }
  });
  const scene = {
    id, drawings: collection(), tiles: collection(), background: { src: "original.webp" },
    getFlag: () => undefined,
    getEmbeddedCollection(type) { return type === "Drawing" ? this.drawings : this.tiles; },
    async update(change) {
      if ("background.src" in change) this.background.src = change["background.src"];
    },
    // Like Foundry, resolves to the deleted documents as they were when deleted.
    async deleteEmbeddedDocuments(type, ids) {
      const docs = this.getEmbeddedCollection(type);
      const removed = ids.map(id => docs.get(id)).filter(Boolean);
      for (const id of ids) docs.delete(id);
      return removed;
    },
    async createEmbeddedDocuments(type, data) {
      for (const source of data) addDoc(this, type, source);
    }
  };
  scenes.set(id, scene);
  globalThis.canvas = { scene: { id } };
  return scene;
}

function addDoc(scene, type, source) {
  const doc = {
    ...source, id: source._id, parent: scene, source: structuredClone(source),
    getFlag: () => undefined,
    toObject() { return structuredClone(this.source); }
  };
  scene.getEmbeddedCollection(type).set(doc.id, doc);
  return doc;
}

function delayDelete(scene) {
  const started = deferred();
  const release = deferred();
  const remove = scene.deleteEmbeddedDocuments.bind(scene);
  scene.deleteEmbeddedDocuments = async (...args) => {
    started.resolve();
    await release.promise;
    return remove(...args);
  };
  return { started: started.promise, release: release.resolve };
}

test("a new action prevents an in-flight undo from resurrecting redo", async () => {
  const scene = makeScene("running");
  addDoc(scene, "Drawing", { _id: "old" });
  const pending = delayDelete(scene);
  pushUndo({ scene: scene.id, created: ["old"] });
  assert.equal(undo(), true);
  await pending.started;
  addDoc(scene, "Drawing", { _id: "new" });
  pushUndo({ scene: scene.id, created: ["new"] });
  pending.release();
  await flushHistory();
  assert.equal(scene.drawings.has("old"), false);
  assert.equal(redo(), false);
  assert.equal(undo(), true);
  await flushHistory();
  assert.equal(scene.drawings.has("new"), false);
});

test("generation is captured when undo is queued and invalidation stays scene-local", async () => {
  const blocker = makeScene("blocker");
  addDoc(blocker, "Drawing", { _id: "blocking" });
  const pending = delayDelete(blocker);
  pushUndo({ scene: blocker.id, created: ["blocking"] });
  assert.equal(undo(), true);
  await pending.started;

  const scene = makeScene("queued");
  addDoc(scene, "Drawing", { _id: "old" });
  pushUndo({ scene: scene.id, created: ["old"] });
  assert.equal(undo(), true);
  pushUndo({ scene: scene.id, created: ["new"] });
  pending.release();
  await flushHistory();
  assert.equal(scene.drawings.has("old"), false);
  assert.equal(redo(), false);

  canvas.scene = blocker;
  assert.equal(redo(), true);
  await flushHistory();
  assert.equal(blocker.drawings.has("blocking"), true);
});

test("a new action does not discard a pending redo's reverse undo", async () => {
  const scene = makeScene("redo");
  addDoc(scene, "Drawing", { _id: "restored" });
  pushUndo({ scene: scene.id, deleted: [{ _id: "removed" }] });
  assert.equal(undo(), true);
  await flushHistory();
  const pending = delayDelete(scene);
  assert.equal(redo(), true);
  await pending.started;
  pushUndo({ scene: scene.id, created: ["restored"] });
  pending.release();
  await flushHistory();
  assert.equal(scene.drawings.has("removed"), false);
  assert.equal(undo(), true);
  await flushHistory();
  assert.equal(scene.drawings.has("removed"), true);
});

// Only the PIXI surface used by baking is stubbed; document/history code runs unchanged.
function setupBake(id, { upload = () => {}, render = () => {}, level = false } = {}) {
  const scene = makeScene(id);
  class Container {
    constructor() {
      this.children = [];
      this.visible = true;
      this.transform = { localTransform: {}, setFromMatrix() {} };
      this.anchor = { copyFrom() {} };
    }
    addChild(child) { this.children.push(child); return child; }
    destroy() {}
  }
  class Graphics extends Container {
    beginFill() { return this; }
    drawRect() { return this; }
    endFill() { return this; }
  }
  const filters = [];
  class BlurFilter {
    constructor(blur) { this.blur = blur; this.destroyed = false; filters.push(this); }
    destroy() { this.destroyed = true; }
  }
  globalThis.PIXI = {
    Container, Graphics, BlurFilter, Matrix: class {}, Text: class extends Container {},
    Sprite: class extends Container {}, smooth: { SmoothGraphics: class extends Graphics {} },
    Texture: { EMPTY: {} }, RenderTexture: { create: () => ({ destroy() {} }) }
  };
  Object.assign(canvas, {
    scene, stage: { scale: { x: 1 } },
    dimensions: { sceneRect: { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 } },
    primary: { children: [] },
    app: { renderer: { render, extract: { canvas: () => ({ toBlob: resolve => resolve(new Blob()) }) } } }
  });
  if (level) {
    canvas.level = { id: "level", background: { src: "original.webp" }, update: scene.update };
    scene.levels = new Map([[canvas.level.id, canvas.level]]);
  }
  foundry.applications = { apps: { FilePicker: { implementation: {
    async createDirectory() {},
    async upload() { await upload(scene); return { path: "baked.webp" }; }
  } } } };
  const add = (type, id) => {
    const doc = addDoc(scene, type, { _id: id, x: 10, y: 10, width: 10, height: 10,
      shape: { width: 10, height: 10 }, rotation: 0 });
    const shape = new PIXI.smooth.SmoothGraphics();
    shape.filters = [new BlurFilter(2), { destroyed: false, destroy() { this.destroyed = true; } }];
    doc.object = type === "Drawing" ? { shape } : { mesh: shape };
    canvas.primary.children.push(shape);
    return doc;
  };
  return { scene, add, filters, bgDoc: canvas.level ?? scene };
}

for (const level of [false, true]) {
  test(`bake keeps undo after partial tile deletion (${level ? "v14 level" : "v13 scene"})`, async () => {
    const { scene, add, bgDoc } = setupBake(`partial-${level}`, { level });
    add("Drawing", "drawing");
    add("Tile", "deleted-tile");
    const kept = add("Tile", "kept-tile");
    const remove = scene.deleteEmbeddedDocuments.bind(scene);
    scene.deleteEmbeddedDocuments = async (type, ids) => {
      if (type === "Tile") {
        scene.tiles.delete(ids[0]);
        throw new Error("tile delete failed");
      }
      return remove(type, ids);
    };
    await assert.rejects(bakeScene({ tiles: true }), /tile delete failed/);
    assert.equal(bgDoc.background.src, "baked.webp");
    assert.equal(scene.drawings.size, 0);
    assert.equal(scene.tiles.has("deleted-tile"), false);
    assert.equal(undo(), true);
    await flushHistory();
    assert.equal(bgDoc.background.src, "original.webp");
    assert.equal(scene.drawings.has("drawing"), true);
    assert.equal(scene.tiles.has("deleted-tile"), true);
    assert.equal(scene.tiles.get("kept-tile"), kept);
  });
}

test("bake preserves edited and already-deleted documents and destroys only copied blur filters", async () => {
  const { scene, add, filters } = setupBake("edits", { upload(scene) {
    for (const type of ["Drawing", "Tile"]) {
      const docs = scene.getEmbeddedCollection(type);
      docs.get(`${type}-edited`).source.x = 50;
      docs.delete(`${type}-gone`);
    }
  } });
  for (const type of ["Drawing", "Tile"]) {
    for (const suffix of ["unchanged", "edited", "gone"]) add(type, `${type}-${suffix}`);
  }
  const originals = [...filters];
  const shared = canvas.primary.children.map(child => child.filters[1]);
  await bakeScene({ tiles: true });
  assert.ok(originals.every(f => !f.destroyed));
  assert.ok(shared.every(f => !f.destroyed));
  assert.equal(filters.length, originals.length * 2);
  assert.ok(filters.slice(originals.length).every(f => f.destroyed));
  for (const type of ["Drawing", "Tile"]) {
    const docs = scene.getEmbeddedCollection(type);
    assert.equal(docs.has(`${type}-unchanged`), false);
    assert.equal(docs.get(`${type}-edited`).source.x, 50);
    assert.equal(docs.has(`${type}-gone`), false);
  }
  assert.equal(undo(), true);
  await flushHistory();
  for (const type of ["Drawing", "Tile"]) {
    const docs = scene.getEmbeddedCollection(type);
    assert.equal(docs.has(`${type}-unchanged`), true);
    assert.equal(docs.get(`${type}-edited`).source.x, 50);
    assert.equal(docs.has(`${type}-gone`), false);
  }
});

test("render failure releases copied blur filters before any scene mutation", async () => {
  const { scene, add, filters } = setupBake("render-failure", { render() { throw new Error("render failed"); } });
  add("Drawing", "drawing");
  await assert.rejects(bakeScene(), /render failed/);
  assert.equal(filters[0].destroyed, false);
  assert.equal(filters[1].destroyed, true);
  assert.equal(scene.background.src, "original.webp");
  assert.equal(undo(), false);
});

for (const applied of [false, true]) {
  test(`failed background request is undoable when ${applied ? "applied" : "unapplied"}`, async () => {
    const { scene, add } = setupBake(`background-${applied}`);
    add("Drawing", "drawing");
    const update = scene.update.bind(scene);
    scene.update = async change => {
      if (change["background.src"] === "baked.webp") {
        if (applied) await update(change);
        throw new Error("background failed");
      }
      await update(change);
    };
    await assert.rejects(bakeScene(), /background failed/);
    assert.equal(scene.drawings.has("drawing"), true);
    assert.equal(undo(), true);
    await flushHistory();
    assert.equal(scene.background.src, "original.webp");
    assert.equal(scene.drawings.has("drawing"), true);
  });
}

test("an edit landing during the bake's delete request is what undo restores", async () => {
  const { scene, add } = setupBake("late-edit");
  add("Drawing", "late");
  const remove = scene.deleteEmbeddedDocuments.bind(scene);
  scene.deleteEmbeddedDocuments = async (type, ids) => {
    scene.drawings.get("late").source.x = 50; // remote update applied before the server deletes
    return remove(type, ids);
  };
  await bakeScene();
  assert.equal(scene.drawings.has("late"), false);
  assert.equal(undo(), true);
  await flushHistory();
  assert.equal(scene.drawings.get("late").source.x, 50);
});

async function expectUndoFailed(run) {
  const warn = ui.notifications.warn;
  const warnings = [];
  ui.notifications.warn = message => warnings.push(message);
  const error = console.error;
  console.error = () => {};
  try {
    await run();
    await flushHistory();
  } finally {
    ui.notifications.warn = warn;
    console.error = error;
  }
  assert.deepEqual(warnings, ["SCRATCHPAD.UndoFailed"]);
}

test("undo refuses to change a drawing that was locked, or whose layer was locked, meanwhile", async () => {
  const scene = makeScene("locks");
  addDoc(scene, "Drawing", { _id: "stroke" }).locked = true;
  pushUndo({ scene: scene.id, created: ["stroke"] });
  await expectUndoFailed(() => undo());
  assert.equal(scene.drawings.has("stroke"), true);

  scene.drawings.get("stroke").locked = false;
  scene.getFlag = (_m, key) => (key === "layers" ? [{ id: "base", name: "Base", locked: true }] : undefined);
  pushUndo({ scene: scene.id, updated: [{ _id: "stroke", x: 0 }] });
  await expectUndoFailed(() => undo());
  assert.equal(scene.drawings.get("stroke").source.x, undefined);
});

test("a failed restore during undo leaves the replacement pieces in place", async () => {
  const scene = makeScene("restore-fails");
  addDoc(scene, "Drawing", { _id: "piece" });
  // An erase: the original was replaced by a piece.
  pushUndo({ scene: scene.id, created: ["piece"], deleted: [{ _id: "original" }] });
  scene.createEmbeddedDocuments = async () => { throw new Error("rejected"); };
  await expectUndoFailed(() => undo());
  assert.equal(scene.drawings.has("piece"), true);
});

test("bake undo and redo are exempt from the lock check (bakes take locked drawings by design)", async () => {
  const scene = makeScene("bake-locks");
  scene.getFlag = (_m, key) => (key === "layers" ? [{ id: "base", name: "Base", locked: true }] : undefined);
  // A bake removed a locked drawing; undo restores it, redo removes it again: neither may be refused.
  pushUndo({ scene: scene.id, deleted: [{ _id: "baked", locked: true }], background: { level: null, src: "original.webp" } });
  assert.equal(undo(), true);
  await flushHistory();
  const restored = scene.drawings.get("baked");
  assert.ok(restored);
  restored.locked = true;
  assert.equal(redo(), true);
  await flushHistory();
  assert.equal(scene.drawings.has("baked"), false);
});
