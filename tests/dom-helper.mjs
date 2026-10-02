// Small DOM test double for the renderer's semantic nodes, not a browser substitute.
export function createDocument() {
  const nodes = new Map();
  function element(tagName = "div") {
    return {
      tagName, children: [], attributes: {}, isConnected: true,
      get firstElementChild() { return this.children[0]; },
      set id(value) { this._id = value; nodes.set(value, this); },
      get id() { return this._id; },
      append(...children) { this.children.push(...children); },
      after(child) { this.children.push(child); },
      before(child) { this.children.unshift(child); },
      replaceChildren(...children) { this.children = children; this.textContent = ""; },
      remove() { nodes.delete(this.id); this.isConnected = false; },
      getAttribute(name) { return this.attributes[name]; },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      closest() { return this; },
      addEventListener(name, handler) { this[`on${name}`] = handler; },
      focus() { document.activeElement = this; },
      getContext() { return { fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {}, strokeRect() {}, closePath() {}, createPattern() { return {}; } }; },
    };
  }
  const document = {
    createElement: element,
    getElementById(id) { return nodes.get(id) || null; },
    add(id) { const node = element(); node.id = id; return node; },
  };
  return document;
}
