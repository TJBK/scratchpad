import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeSafe, safeColor, isLightColor, textColorOn } from "../src/sanitize.js";

const text = v => ({ nodeType: 3, nodeValue: v });
const el = (tagName, ...childNodes) => ({ nodeType: 1, tagName, childNodes });
const root = (...childNodes) => ({ childNodes });

test("keeps allowed formatting", () => {
  assert.equal(serializeSafe(root(el("B", text("bold")), el("BR"), el("UL", el("LI", text("x"))))),
    "<b>bold</b><br><ul><li>x</li></ul>");
});

test("drops scripts and their content", () => {
  assert.equal(serializeSafe(root(el("SCRIPT", text("alert(1)")), text("ok"))), "ok");
});

test("unwraps unknown tags but keeps text", () => {
  assert.equal(serializeSafe(root(el("A", text("link")), el("IMG"))), "link");
});

test("escapes text so it can't become markup", () => {
  assert.equal(serializeSafe(root(text(`<img src=x onerror="a">&'`))), "&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;");
});

test("attributes never survive", () => {
  const b = el("B", text("x"));
  b.attributes = [{ name: "onclick", value: "evil()" }];
  assert.equal(serializeSafe(root(b)), "<b>x</b>");
});

test("very deep nesting is flattened, not crashed", () => {
  let n = text("deep");
  for (let i = 0; i < 1000; i++) n = el("B", n);
  const out = serializeSafe(root(n));
  assert.ok(out.includes("deep"));
  assert.ok((out.match(/<b>/g) ?? []).length <= 32);
});

test("comments are skipped", () => {
  assert.equal(serializeSafe(root({ nodeType: 8, nodeValue: "<script>" }, text("a"))), "a");
});

test("safeColor only allows #rrggbb", () => {
  assert.equal(safeColor("#AbCdEf"), "#AbCdEf");
  assert.equal(safeColor('red" onload="x'), "#c92a2a");
  assert.equal(safeColor(undefined), "#c92a2a");
});

test("isLightColor and textColorOn pick readable text for a background", () => {
  assert.equal(isLightColor("#ffffff"), true);
  assert.equal(isLightColor("#fff8dc"), true);
  assert.equal(isLightColor("#000000"), false);
  assert.equal(isLightColor("#1971c2"), false);
  assert.equal(isLightColor("not a colour"), false);
  assert.equal(textColorOn("#fff8dc"), "#222222");
  assert.equal(textColorOn("#3a1f5c"), "#f5f5f5");
});
