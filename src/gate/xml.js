// -----------------------------------------------------------------------------
// The small XML the gateway answers (`<response><door1><status>closed</status>
// ...</door1>...</response>`), read by a linear scanner of our own instead of
// a full XML parser: elements and text only, attributes skipped, the five
// entities and character references decoded, comments and the XML
// declaration ignored. A DOCTYPE (and so any entity definition) is refused.
// Bounded: number of elements, depth, length of each text; the input itself
// is size-capped by the HTTP layer. Children are kept in arrays, never as keys
// of an object: no name from the gateway ever becomes a property.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

export class XmlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XmlError';
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** The text of an element with its references decoded (unknown ones kept as they are). */
function decode(text) {
  if (!text.includes('&')) {
    return text;
  }
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,4});/gi, (whole, ref) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '';
    }
    return Object.hasOwn(ENTITIES, ref) ? ENTITIES[ref] : whole;
  });
}

/**
 * @param {string} text
 * @param {{ elements?: number, depth?: number, textLength?: number }} [limits]
 * @returns {{ name: string, text: string, children: object[] }} the root element
 */
export function parseXml(
  text,
  { elements = LIMITS.xmlElements, depth = LIMITS.xmlDepth, textLength = LIMITS.xmlText } = {},
) {
  if (typeof text !== 'string') {
    throw new XmlError('not text');
  }
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack = [];
  let root;
  let count = 0;
  /** Appends text to the open element, never beyond its cap (no quadratic growth). */
  const addText = (raw) => {
    const top = stack.at(-1);
    if (!top) {
      if (raw.trim() !== '') {
        throw new XmlError('text outside the root');
      }
      return;
    }
    if (top.length < textLength) {
      const piece = raw.slice(0, textLength - top.length);
      top.parts.push(piece);
      top.length += piece.length;
    }
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      addText(text.slice(i));
      break;
    }
    if (lt > i) {
      addText(decode(text.slice(i, lt)));
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) throw new XmlError('unterminated declaration');
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) throw new XmlError('unterminated comment');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1) throw new XmlError('unterminated CDATA');
      addText(text.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      // A DOCTYPE, hence maybe entities: never read.
      throw new XmlError('DOCTYPE refused');
    }
    const gt = text.indexOf('>', lt + 1);
    if (gt === -1) {
      throw new XmlError('unterminated tag');
    }
    let tag = text.slice(lt + 1, gt);
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      const open = stack.pop();
      if (!open || open.name !== name) {
        throw new XmlError('mismatched tag');
      }
      open.node.text = open.parts.join('').trim();
      if (stack.length === 0) {
        root = open.node;
      }
      i = gt + 1;
      continue;
    }
    // Attribute values may hold a '>': the tag ends at the first one outside quotes.
    let end = gt;
    let quote = '';
    for (let j = lt + 1; j < text.length; j += 1) {
      const char = text[j];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        end = j;
        break;
      }
      if (j === text.length - 1) throw new XmlError('unterminated tag');
    }
    tag = text.slice(lt + 1, end);
    const selfClosing = tag.endsWith('/');
    const name = (selfClosing ? tag.slice(0, -1) : tag).trim().split(/\s/, 1)[0];
    if (!NAME.test(name)) {
      throw new XmlError('bad tag name');
    }
    if (root || (stack.length === 0 && count > 0)) {
      throw new XmlError('more than one root');
    }
    count += 1;
    if (count > elements) {
      throw new XmlError('too many elements');
    }
    const node = { name, text: '', children: [] };
    stack.at(-1)?.node.children.push(node);
    if (selfClosing) {
      if (stack.length === 0) {
        root = node;
      }
    } else {
      if (stack.length >= depth) {
        throw new XmlError('too deep');
      }
      stack.push({ name, node, parts: [], length: 0 });
    }
    i = end + 1;
  }
  if (stack.length > 0 || !root) {
    throw new XmlError('unterminated document');
  }
  return root;
}

/** The first child element with this name, or undefined. */
export const child = (node, name) => node?.children.find((c) => c.name === name);

/** The text of the first child element with this name, or undefined when there is none. */
export const childText = (node, name) => child(node, name)?.text;
