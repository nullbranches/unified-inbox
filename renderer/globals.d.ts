// Globals of the window's script (renderer/app.ts).

// The bridge from preload.ts (window.api).
declare const api: Inbox.Api;

interface Window {
  api: Inbox.Api;
}

// Every element the script looks up by a selector is an HTML element (the
// page and the messages it renders have no SVG or MathML targets), so element
// lookups by selector default to HTMLElement instead of Element. These
// overloads come first; the built-in ones still apply when a type is given.
interface ParentNode {
  querySelector<E extends HTMLElement = HTMLElement>(selectors: string): E | null;
  querySelectorAll<E extends HTMLElement = HTMLElement>(selectors: string): NodeListOf<E>;
}
interface Element {
  closest<E extends HTMLElement = HTMLElement>(selectors: string): E | null;
}
