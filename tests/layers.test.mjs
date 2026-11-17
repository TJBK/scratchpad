import { test } from "node:test";
import assert from "node:assert/strict";
import { saveLayers, SORT_BAND } from "../src/layers.js";

function fakeScene(layers, drawings) {
  const scene = {
    flags: { layers },
    getFlag: (_m, key) => scene.flags[key],
    update: async changes => { scene.flags.layers = changes["flags.scratchpad.layers"]; },
    updates: null,
    updateEmbeddedDocuments: async (_type, updates) => { scene.updates = updates; },
    drawings
  };
  for (const d of drawings) d.parent = scene;
  return scene;
}
const drawing = (id, sort, layer) => ({ id, sort, getFlag: () => layer });

test("reordering layers keeps unflagged drawings in the layer they were in", async () => {
  const a = { id: "a", name: "A" }, b = { id: "b", name: "B" };
  const legacy = drawing("legacy", 5); // no layer flag: belongs to the bottom layer, A
  const onB = drawing("onB", SORT_BAND + 3, "b");
  globalThis.canvas = { scene: fakeScene([a, b], [legacy, onB]) };

  await saveLayers([b, a], { resort: true });

  const byId = Object.fromEntries(canvas.scene.updates.map(u => [u._id, u]));
  assert.equal(byId.legacy["flags.scratchpad.layer"], "a");
  assert.equal(byId.legacy.sort, SORT_BAND + 5);
  assert.equal(byId.onB["flags.scratchpad.layer"], "b");
  assert.equal(byId.onB.sort, 3);
});

test("deleting a layer moves its drawings, including unflagged ones, to the target", async () => {
  const a = { id: "a", name: "A" }, b = { id: "b", name: "B" };
  const legacy = drawing("legacy", 5);
  globalThis.canvas = { scene: fakeScene([a, b], [legacy]) };

  await saveLayers([b], { resort: true, moves: { a: "b" } });

  assert.equal(canvas.scene.updates[0]["flags.scratchpad.layer"], "b");
});

test("a drawing moved to another layer while the layer list saves keeps that move", async () => {
  const a = { id: "a", name: "A" }, b = { id: "b", name: "B" };
  let flag = "a";
  const moving = { id: "moving", sort: 5, getFlag: () => flag };
  const scene = fakeScene([a, b], [moving]);
  const save = scene.update;
  scene.update = async changes => { flag = "b"; return save(changes); }; // concurrent moveToLayer
  globalThis.canvas = { scene };

  await saveLayers([b, a], { resort: true });

  const update = scene.updates?.find(u => u._id === "moving");
  assert.equal(update ? update["flags.scratchpad.layer"] : flag, "b");
  if (update) assert.equal(Math.floor(update.sort / SORT_BAND), 0);
});

test("a deleted layer's drawings are moved before its definition is removed", async () => {
  const a = { id: "a", name: "A" }, b = { id: "b", name: "B", gmOnly: true }, c = { id: "c", name: "C", gmOnly: true };
  const flags = { onC: "c" };
  const onC = { id: "onC", sort: 2 * SORT_BAND + 1, getFlag: () => flags.onC };
  const scene = fakeScene([a, b, c], [onC]);
  // Applies updates, unlike fakeScene's, so the order of requests is observable.
  scene.updateEmbeddedDocuments = async (_type, updates) => {
    for (const u of updates) if (u["flags.scratchpad.layer"]) flags[u._id] = u["flags.scratchpad.layer"];
  };
  const save = scene.update;
  scene.update = async changes => {
    // While the list without C is saved, nothing may still name C (it would fall back to public A).
    assert.equal(flags.onC, "b");
    return save(changes);
  };
  globalThis.canvas = { scene };

  await saveLayers([a, b], { resort: true, moves: { c: "b" } });
  assert.equal(flags.onC, "b");
});
