/* A minimum XML parser for the parity harness, because node has no DOMParser and
 * this repo ships no dependencies. It handles exactly what a DMARC aggregate
 * report contains: elements, text, attributes, comments, and the XML declaration.
 * It is not a general XML parser and is not shipped to anyone.
 */
class El {
  constructor(localName) {
    this.localName = localName; this.nodeName = localName;
    this.children = []; this._text = '';
  }
  get textContent() {
    return this.children.length
      ? this.children.map(c => c.textContent).join('') : this._text;
  }
  getElementsByTagName(name) {
    const out = [];
    const walk = n => n.children.forEach(c => {
      if (name === '*' || c.localName === name) out.push(c);
      walk(c);
    });
    walk(this);
    return out;
  }
}

export class DOMParser {
  parseFromString(src) {
    const doc = { documentElement: null, getElementsByTagName: () => [] };
    const stack = [];
    let root = null;
    const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
    let m;
    try {
      while ((m = re.exec(src))) {
        const [, close, open, , selfClose, txt] = m;
        if (close) {
          const el = stack.pop();
          if (!el || el.localName !== close) throw new Error('mismatched tag');
        } else if (open) {
          const el = new El(open.includes(':') ? open.split(':').pop() : open);
          if (stack.length) stack[stack.length - 1].children.push(el);
          else if (root) throw new Error('two roots');
          else root = el;
          if (!selfClose) stack.push(el);
        } else if (txt && stack.length) {
          const t = txt.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
          if (t.trim()) stack[stack.length - 1]._text += t;
        }
      }
      if (stack.length || !root) throw new Error('unclosed');
    } catch (e) {
      const err = new El('parsererror');
      const bad = { documentElement: err, getElementsByTagName: n =>
        n === 'parsererror' ? [err] : [] };
      return bad;
    }
    doc.documentElement = root;
    doc.getElementsByTagName = n => (n === 'parsererror' ? [] : root.getElementsByTagName(n));
    return doc;
  }
}
