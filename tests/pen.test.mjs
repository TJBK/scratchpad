import { test } from "node:test";
import assert from "node:assert/strict";

// Chainable no-op stand-in for PIXI.Graphics; tracks destroy().
class FakeGraphics {
  constructor() {
    this.destroyed = false;
    return new Proxy(this, { get: (t, k) => (k in t ? t[k] : () => t) });
  }
  destroy() { this.destroyed = true; }
}
globalThis.PIXI = { Graphics: FakeGraphics };
globalThis.canvas = { scene: { id: "s" }, stage: { scale: { x: 1 } } };

const { onSocket, dropRemoteStroke } = await import("../src/tools/pen.js");
const { view } = await import("../src/core.js");
const added = [];
view.remoteLayer = { addChild: g => (added.push(g), g) };

const start = (user, id) => ({ t: "start", scene: "s", user, id, p: [0, 0], style: { width: 2 } });

test("remote previews are keyed by the server-supplied sender, not message.user", () => {
  onSocket(start("victim", 1), "victim");
  const victimPreview = added.at(-1);
  // Attacker claims to be the victim: must not touch the victim's preview.
  onSocket(start("victim", 9), "attacker");
  assert.equal(victimPreview.destroyed, false);
  // Without a sender id (never from the real server) the message is ignored.
  const before = added.length;
  onSocket(start("x", 2), undefined);
  assert.equal(added.length, before);
  dropRemoteStroke("victim");
  assert.equal(victimPreview.destroyed, true);
  dropRemoteStroke("attacker");
});

test("invented user ids cannot pile up previews: one per real sender", () => {
  const before = added.length;
  for (let i = 0; i < 5; i++) onSocket(start(`fake-${i}`, i), "attacker");
  assert.equal(added.slice(before, -1).every(g => g.destroyed), true);
  dropRemoteStroke("attacker");
});

test("absurd coordinates are dropped before rendering", () => {
  onSocket({ t: "start", scene: "s", id: 1, p: [1e100, 0], style: { width: 2, dash: "dashed" } }, "u");
  const before = added.length;
  onSocket({ t: "start", scene: "s", id: 1, p: [0, 0], style: { width: 2, dash: "dashed" } }, "u");
  assert.equal(added.length, before + 1);
  onSocket({ t: "move", scene: "s", id: 1, pts: [1e100, 0, 50, 0] }, "u");
  dropRemoteStroke("u");
});

test("brush stamps share one budget across all dashes of a stroke", async () => {
  const { drawLine } = await import("../src/core.js");
  let stamps = 0;
  const g = new Proxy({}, { get: (t, k) => (k === "drawEllipse" ? () => (stamps++, g) : () => g) });
  // ~100k dashes, each long enough for many stamps: per-dash budgets would give ~2M stamps.
  const pts = [];
  for (let i = 0; i < 4; i++) pts.push([i % 2 ? 8e6 : -8e6, 0]); // ~98k dashes: just under the dash limit
  drawLine(g, { width: 150, brush: "flat", dash: "dashed", color: "#000000" }, pts);
  assert.ok(stamps <= 400000, `stamps: ${stamps}`);
});

test("brush or texture names that are Object.prototype keys do not crash rendering", () => {
  for (const style of [{ width: 2, texture: "constructor" }, { width: 2, brush: "toString" }, { width: 2, brush: "__proto__" }]) {
    assert.doesNotThrow(() => onSocket({ t: "start", scene: "s", id: 1, p: [0, 0], style }, "proto"));
  }
  dropRemoteStroke("proto");
});

test("an 'end' always follows a broadcast 'start', even if sharing turned off mid-stroke", async () => {
  const { default: pen } = await import("../src/tools/pen.js");
  const settings = { private: false };
  const sent = [];
  globalThis.game = {
    user: { id: "me" }, i18n: { localize: k => k },
    settings: { get: (_m, key) => settings[key] },
    socket: { emit: (_e, msg) => sent.push(msg) }
  };
  canvas.scene = { id: "s", getFlag: () => undefined };
  view.preview = new FakeGraphics();

  pen.down([0, 0]);
  settings.private = true; // switched to private while drawing
  pen.cancel();
  assert.deepEqual(sent.map(m => m.t), ["start", "end"]);

  // A stroke that never went out never sends an end either.
  sent.length = 0;
  pen.down([0, 0]);
  pen.cancel();
  assert.deepEqual(sent, []);
});
