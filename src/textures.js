// Procedural material textures for textured brushes, generated once per client so no image assets ship.
export const TEXTURES = ["snow", "moss", "sand", "dirt", "stone", "water", "grass"];

const SIZE = 128; // power of two so WebGL can repeat it
const cache = new Map();

// [base colour, [speck colours], speck count, speck radius range]
const RECIPES = {
  snow: ["#eef4fb", ["#ffffff", "#dde8f5", "#c9d8ea"], 900, [0.6, 2.2]],
  moss: ["#4a6a2a", ["#5f8a35", "#3a5520", "#6f9a3f", "#2f4618"], 1400, [0.8, 3]],
  sand: ["#d9c28c", ["#e8d6a8", "#bfa36a", "#cdb27a", "#a88c55"], 2200, [0.4, 1.2]],
  dirt: ["#6b4a2e", ["#5a3c24", "#7d5a3a", "#4a3020", "#8a6644"], 1600, [0.5, 2]],
  stone: ["#86878a", ["#9a9b9e", "#6f7073", "#a7a8ab", "#5d5e61"], 700, [1, 4]],
  water: ["#3d78b0", ["#5a92c6", "#2f6599", "#7fb0dc"], 500, [1, 5]],
  grass: ["#4f8a32", ["#5fa13c", "#3f7028", "#6cb046", "#355f22"], 1800, [0.5, 1.6]]
};

// Deterministic PRNG so every client builds an identical texture.
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

export function brushTexture(name) {
  const recipe = RECIPES[name];
  if (!recipe) return null;
  if (cache.has(name)) return cache.get(name);

  const [base, specks, count, [rMin, rMax]] = recipe;
  const el = document.createElement("canvas");
  el.width = el.height = SIZE;
  const ctx = el.getContext("2d");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, SIZE, SIZE);

  const rand = rng([...name].reduce((h, c) => h * 31 + c.charCodeAt(0), 7));
  for (let i = 0; i < count; i++) {
    const x = rand() * SIZE, y = rand() * SIZE, r = rMin + rand() * (rMax - rMin);
    ctx.fillStyle = specks[Math.floor(rand() * specks.length)];
    ctx.globalAlpha = 0.5 + rand() * 0.5;
    // Draw wrapped copies so the tile repeats seamlessly.
    for (const dx of [-SIZE, 0, SIZE]) for (const dy of [-SIZE, 0, SIZE]) {
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const texture = PIXI.Texture.from(el);
  texture.baseTexture.wrapMode = PIXI.WRAP_MODES.REPEAT;
  cache.set(name, texture);
  return texture;
}
