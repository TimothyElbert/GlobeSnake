/** Tiny DOM helpers. Enough structure to keep the UI readable, no framework. */

type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function hexToCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/** Resolve a base URL that works under both `/` and `/RepoName/` on Pages. */
export function baseUrl(): string {
  const b = import.meta.env.BASE_URL || '/';
  return b.endsWith('/') ? b : `${b}/`;
}

export function clearChildren(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}
