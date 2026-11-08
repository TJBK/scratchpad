// Card HTML comes from Drawing flags any owner can write, so it is rebuilt from a tag allowlist with no attributes.
// Works on a plain DOM-like node tree so it can be unit-tested in Node.

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const MAX_NESTING_DEPTH = 32;
const DEFAULT_SAFE_COLOR = "#c92a2a";

const ALLOWED_TAGS = new Set([
  "B", "STRONG", "I", "EM", "U", "S", "STRIKE",
  "BR", "P", "DIV", "UL", "OL", "LI",
  "H1", "H2", "H3", "BLOCKQUOTE", "HR", "SPAN"
]);

const VOID_TAGS = new Set(["BR", "HR"]);

const DROPPED_TAGS = new Set([
  "SCRIPT", "STYLE", "TEMPLATE", "IFRAME", "OBJECT", "EMBED",
  "NOSCRIPT", "SVG", "MATH", "TITLE", "TEXTAREA", "SELECT"
]);

const HTML_ESCAPE_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

function escapeHTML(text) {
  return String(text).replace(/[&<>"']/g, char => HTML_ESCAPE_MAP[char]);
}

// Disallowed tags and nesting past MAX_NESTING_DEPTH are unwrapped, keeping their text.
export function serializeSafe(rootNode, depth = 0) {
  let output = "";

  for (const child of rootNode.childNodes ?? []) {
    if (child.nodeType === TEXT_NODE) {
      output += escapeHTML(child.nodeValue ?? "");
    } else if (child.nodeType === ELEMENT_NODE) {
      const upperTag = String(child.tagName).toUpperCase();
      if (DROPPED_TAGS.has(upperTag)) continue;

      if (depth >= MAX_NESTING_DEPTH || !ALLOWED_TAGS.has(upperTag)) {
        output += serializeSafe(child, depth + 1);
        continue;
      }

      const lowerTag = upperTag.toLowerCase();
      if (VOID_TAGS.has(upperTag)) {
        output += `<${lowerTag}>`;
      } else {
        output += `<${lowerTag}>${serializeSafe(child, depth + 1)}</${lowerTag}>`;
      }
    }
  }

  return output;
}

// DOMParser documents are inert: no scripts run and no assets load.
export function sanitizeHTML(html) {
  try {
    const parsedDocument = new DOMParser().parseFromString(String(html ?? ""), "text/html");
    return serializeSafe(parsedDocument.body);
  } catch {
    return "";
  }
}

export function safeColor(color, fallback = DEFAULT_SAFE_COLOR) {
  return /^#[0-9a-f]{6}$/i.test(color ?? "") ? color : fallback;
}
