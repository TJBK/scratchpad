// Registers Scratchpad settings, keybindings, scene controls, and document/canvas hooks.

import { MODULE, TOOL, activeTool, undo, redo } from "./core.js";
import { mountUI, syncUI, attachCanvas } from "./ui.js";
import { onSocket } from "./tools/pen.js";
import { refreshSelection, deleteSelected, selectedDrawings } from "./tools/select.js";
import { registerLayerHooks, mountLayersPanel } from "./layers.js";
import { onRefreshDrawing, registerDrawingClass } from "./render.js";
import { openBakeDialog } from "./bake.js";
import { mountBoard, scheduleRender } from "./board.js";
import { cancelPolygon } from "./tools/shape.js";

const WHITEBOARD_BUTTON = "scratchpad-whiteboard";
const BAKE_BUTTON = "scratchpad-bake";

Hooks.once("init", () => {
  const registerClientSetting = (key, type, defaultValue) => {
    game.settings.register(MODULE, key, {
      scope: "client",
      config: false,
      type,
      default: defaultValue
    });
  };

  registerClientSetting("color", String, "");
  registerClientSetting("width", Number, 4);
  registerClientSetting("dash", String, "solid");
  registerClientSetting("shape", String, "line");
  registerClientSetting("textSize", Number, 32);
  registerClientSetting("eraser", Number, 24);
  registerClientSetting("eraseMode", String, "partial");
  registerClientSetting("brush", String, "round");
  registerClientSetting("hardness", Number, 100);
  registerClientSetting("texture", String, "");
  registerClientSetting("shadow", Boolean, false);
  registerClientSetting("fill", String, "none");
  registerClientSetting("fillColor", String, "");
  registerClientSetting("private", Boolean, false);
  registerClientSetting("font", String, "");
  registerClientSetting("bold", Boolean, false);
  registerClientSetting("italic", Boolean, false);
  registerClientSetting("align", String, "left");
  registerClientSetting("activeLayers", Object, {});

  registerDrawingClass();
  registerLayerHooks();

  const priorityPrecedence = CONST.KEYBINDING_PRECEDENCE.PRIORITY;

  game.keybindings.register(MODULE, "undo", {
    name: "SCRATCHPAD.Undo",
    editable: [{ key: "KeyZ", modifiers: ["Control"] }],
    precedence: priorityPrecedence,
    onDown: () => (activeTool() ? undo() : false)
  });

  game.keybindings.register(MODULE, "redo", {
    name: "SCRATCHPAD.Redo",
    editable: [
      { key: "KeyY", modifiers: ["Control"] },
      { key: "KeyZ", modifiers: ["Control", "Shift"] }
    ],
    precedence: priorityPrecedence,
    onDown: () => (activeTool() ? redo() : false)
  });

  game.keybindings.register(MODULE, "cancelPolygon", {
    name: "SCRATCHPAD.CancelPolygon",
    editable: [{ key: "Escape" }],
    precedence: priorityPrecedence,
    onDown: () => activeTool() === TOOL.SHAPE && cancelPolygon()
  });

  game.keybindings.register(MODULE, "delete", {
    name: "SCRATCHPAD.DeleteSelection",
    editable: [{ key: "Delete" }, { key: "Backspace" }],
    precedence: priorityPrecedence,
    onDown: () => activeTool() === TOOL.SELECT && deleteSelected()
  });
});

Hooks.once("ready", () => {
  mountBoard();
  mountLayersPanel(selectedDrawings); // before mountUI, whose first syncUI shows the layer badge
  mountUI();
  game.socket.on(`module.${MODULE}`, onSocket);
});

Hooks.on(`${MODULE}.layersChanged`, () => {
  refreshSelection();
  scheduleRender();
});

Hooks.on("canvasReady", () => {
  attachCanvas();
  scheduleRender();
});

Hooks.on("canvasTearDown", () => {
  scheduleRender();
});

Hooks.on("renderSceneControls", syncUI);
Hooks.on("refreshDrawing", onRefreshDrawing);
Hooks.on("createDrawing", scheduleRender);

Hooks.on("updateDrawing", () => {
  refreshSelection();
  scheduleRender();
});

Hooks.on("deleteDrawing", () => {
  refreshSelection();
  scheduleRender();
});

// Foundry v13+ passes `controls` as an object keyed by control group name, with `tools` also keyed by tool name.
Hooks.on("getSceneControlButtons", controls => {
  const drawingTools = controls.drawings?.tools;
  if (!drawingTools) return;

  // Replace core tools Scratchpad duplicates, taking over their slot in the toolbar.
  const replaced = { freehand: TOOL.PEN, rect: TOOL.SHAPE, text: TOOL.TEXT };
  const slot = {};
  for (const [core, ours] of Object.entries(replaced)) slot[ours] = drawingTools[core]?.order;
  for (const core of ["freehand", "rect", "ellipse", "polygon", "text"]) delete drawingTools[core];

  // Extra tools slot in right after Text (before core role/snap/config/clear) via fractional orders.
  let extra = 0;
  const afterText = slot[TOOL.TEXT] ?? Object.keys(drawingTools).length;
  const registerTool = (name, titleKey, iconClass, extraOptions = {}) => {
    drawingTools[name] = {
      name,
      title: `SCRATCHPAD.${titleKey}`,
      icon: `fa-solid ${iconClass}`,
      order: slot[name] ?? afterText + ++extra / 10,
      // v13 switches tools without re-rendering controls, so renderSceneControls alone misses it.
      onChange: () => syncUI(),
      ...extraOptions
    };
  };

  registerTool(TOOL.PEN, "Pen", "fa-pen-nib");
  registerTool(TOOL.SHAPE, "ShapeTool", "fa-shapes");
  registerTool(TOOL.TEXT, "TextTool", "fa-font");
  registerTool(TOOL.SELECT, "Lasso", "fa-draw-polygon");
  registerTool(TOOL.ERASER, "Eraser", "fa-eraser");
  registerTool(TOOL.CARD, "CardTool", "fa-note-sticky");
  registerTool(TOOL.STRING, "StringTool", "fa-diagram-project");
  registerTool(WHITEBOARD_BUTTON, "Whiteboard", "fa-chalkboard", {
    button: true,
    visible: game.user.isGM,
    onChange: createWhiteboardScene
  });
  registerTool(BAKE_BUTTON, "Bake", "fa-image", {
    button: true,
    visible: game.user.isGM,
    onChange: openBakeDialog
  });
});

async function createWhiteboardScene() {
  const scene = await Scene.create({
    name: game.i18n.localize("SCRATCHPAD.WhiteboardName"),
    width: 4000,
    height: 3000,
    padding: 0.1,
    backgroundColor: "#ffffff",
    grid: { type: CONST.GRID_TYPES.GRIDLESS },
    tokenVision: false,
    fog: { exploration: false }
  });

  if (!scene) return;
  await scene.view();
  ui.controls.activate?.({ control: "drawings", tool: TOOL.PEN });
}
