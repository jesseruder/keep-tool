// Functions that are stringified and evaluated inside the page via
// Runtime.callFunctionOn / Runtime.evaluate. They must be self-contained: no imports,
// no closure over anything in the service worker.

/** `this` is the target element. Sets a value the way a user would, so frameworks see it. */
export function setFormValue(value) {
  const element = this;
  const tag = (element.tagName || "").toLowerCase();
  const type = (element.type || "").toLowerCase();
  const fire = () => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };

  if (tag === "input" && (type === "checkbox" || type === "radio")) {
    const want =
      typeof value === "boolean"
        ? value
        : !(value === "false" || value === "0" || value === "" || value === 0 || value === false);
    if (element.checked !== want) {
      // click() keeps radio-group semantics and label behaviour intact.
      element.click();
    } else {
      fire();
    }
    return { ok: true, kind: type, value: element.checked };
  }

  if (tag === "select") {
    const wanted = String(value);
    let matched = null;
    for (const option of element.options) {
      if (option.value === wanted || (option.text || "").trim() === wanted) {
        matched = option;
        break;
      }
    }
    if (!matched) {
      for (const option of element.options) {
        if ((option.text || "").trim().toLowerCase() === wanted.toLowerCase()) {
          matched = option;
          break;
        }
      }
    }
    if (!matched) {
      const available = Array.from(element.options)
        .slice(0, 20)
        .map((option) => option.value || (option.text || "").trim())
        .join(", ");
      return { ok: false, error: `No option matching "${wanted}". Options: ${available}` };
    }
    element.value = matched.value;
    fire();
    return { ok: true, kind: "select", value: element.value };
  }

  if (tag === "input" || tag === "textarea") {
    const prototype = tag === "input" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    try {
      element.focus();
    } catch {
      // not focusable, still settable
    }
    // The prototype setter bypasses React's value tracker, so React sees a real change.
    if (setter) setter.call(element, String(value));
    else element.value = String(value);
    fire();
    return { ok: true, kind: tag, value: element.value };
  }

  if (element.isContentEditable) {
    try {
      element.focus();
    } catch {
      // ignore
    }
    element.textContent = String(value);
    fire();
    return { ok: true, kind: "contenteditable", value: element.textContent };
  }

  return { ok: false, error: `Element <${tag}> is not a form field` };
}

export function extractPageText(maxChars) {
  const target =
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.querySelector("[role=main]") ||
    document.body;
  const raw = ((target && target.innerText) || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    title: document.title,
    url: location.href,
    source: target === document.body ? "body" : (target.tagName || "").toLowerCase(),
    total: raw.length,
    truncated: raw.length > maxChars,
    text: raw.slice(0, maxChars),
  };
}

/** `this` is a file input. Builds a real File so the page's change handlers fire. */
export function attachImageToInput(base64, filename, mimeType) {
  const element = this;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const file = new File([bytes], filename, { type: mimeType });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  if ((element.tagName || "").toLowerCase() !== "input" || element.type !== "file") {
    return { ok: false, error: "Element is not a file input; use a coordinate for drag and drop" };
  }
  element.files = transfer.files;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, name: file.name, size: file.size };
}

export function dropImageAtPoint(base64, filename, mimeType, x, y) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const file = new File([bytes], filename, { type: mimeType });
  const transfer = new DataTransfer();
  transfer.items.add(file);

  const target = document.elementFromPoint(x, y);
  if (!target) return { ok: false, error: `No element at (${x}, ${y})` };
  const options = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: transfer };
  target.dispatchEvent(new DragEvent("dragenter", options));
  target.dispatchEvent(new DragEvent("dragover", options));
  target.dispatchEvent(new DragEvent("drop", options));
  return { ok: true, target: target.tagName.toLowerCase(), name: file.name, size: file.size };
}

/** `this` is the element; viewport-relative CSS pixels. */
export function elementRect() {
  const rect = this.getBoundingClientRect();
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    visible: rect.width > 0 && rect.height > 0,
  };
}

export const VIEWPORT_EXPRESSION =
  "({width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio," +
  " scrollX: window.scrollX, scrollY: window.scrollY, url: location.href, title: document.title})";

/** CDP wants the function as source text. */
export function source(fn) {
  return fn.toString();
}
