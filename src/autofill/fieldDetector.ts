import type { Frame } from "playwright";

/** One fillable field (or radio group) found on the page. */
export interface DetectedField {
  id: string; // value of the data-jaf-id attribute we put on the element
  kind: "text" | "textarea" | "select" | "radio" | "checkbox" | "file" | "number" | "date" | "email" | "tel" | "url" | "password";
  label: string;
  name: string;
  required: boolean;
  options: string[]; // select options / radio labels
  hasValue: boolean;
}

/**
 * Browser-side script, kept as a plain JavaScript string so the TypeScript
 * compiler/bundler cannot inject helpers (e.g. __name) that don't exist in the page.
 * It finds visible form fields and tags each one with data-jaf-id.
 */
const DETECT_SCRIPT = String.raw`(() => {
  const ATTR = "data-jaf-id";
  const KINDS = ["text", "textarea", "select", "checkbox", "file", "number", "date", "email", "tel", "url", "password"];
  let counter = Number(document.body.getAttribute("data-jaf-counter") || "0");
  function nextId() {
    counter += 1;
    document.body.setAttribute("data-jaf-counter", String(counter));
    return "f" + counter;
  }
  function clean(s) { return (s || "").replace(/\s+/g, " ").replace(/\*/g, "").trim(); }
  function isVisible(el) {
    if (el.type === "file") return true; // file inputs are often hidden behind a styled button
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  }
  function labelFor(el) {
    const id = el.getAttribute("id");
    if (id) {
      const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (lab) return clean(lab.textContent);
    }
    const wrapping = el.closest("label");
    if (wrapping) return clean(wrapping.textContent);
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(" ").map((i) => (document.getElementById(i) || {}).textContent || "").join(" ");
      if (clean(text)) return clean(text);
    }
    const legend = el.closest("fieldset") && el.closest("fieldset").querySelector("legend");
    if (legend) return clean(legend.textContent);
    const container = el.closest("div, li, section");
    const heading = container && container.querySelector("label, legend, span, p, h3, h4");
    if (heading && heading !== el && clean(heading.textContent).length < 300) return clean(heading.textContent);
    return clean(el.getAttribute("placeholder") || el.getAttribute("name") || "");
  }

  const fields = [];
  const seenRadioGroups = new Set();
  for (const el of Array.from(document.querySelectorAll("input, textarea, select"))) {
    if (!isVisible(el) || el.disabled || el.readOnly) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || (tag === "textarea" ? "textarea" : tag === "select" ? "select" : "text")).toLowerCase();
    if (["hidden", "submit", "button", "reset", "image", "search"].includes(type)) continue;

    if (type === "radio") {
      const name = el.getAttribute("name") || "";
      if (!name || seenRadioGroups.has(name)) continue;
      seenRadioGroups.add(name);
      const radios = Array.from(document.querySelectorAll('input[type="radio"][name="' + CSS.escape(name) + '"]'));
      // Reuse the id from an earlier scan so the filler knows it already handled this group.
      const existing = radios[0].getAttribute(ATTR);
      const groupId = existing ? existing.replace(/-\d+$/, "") : nextId();
      radios.forEach((r, i) => r.setAttribute(ATTR, groupId + "-" + i));
      const fieldset = el.closest("fieldset");
      const group = el.closest("[role=radiogroup]");
      const question = clean(fieldset && fieldset.querySelector("legend") && fieldset.querySelector("legend").textContent)
        || clean(group && group.getAttribute("aria-label"))
        || labelFor((el.parentElement && el.parentElement.parentElement) || el);
      fields.push({
        id: groupId, kind: "radio", label: question, name: name,
        required: radios.some((r) => r.required),
        options: radios.map((r) => labelFor(r)),
        hasValue: radios.some((r) => r.checked),
      });
      continue;
    }

    let id = el.getAttribute(ATTR);
    if (!id) { id = nextId(); el.setAttribute(ATTR, id); }
    const kind = tag === "select" ? "select" : tag === "textarea" ? "textarea" : type;
    const options = tag === "select" ? Array.from(el.options).map((o) => clean(o.textContent)).filter(Boolean) : [];
    const hasValue = type === "checkbox" ? el.checked
      : type === "file" ? (el.files ? el.files.length : 0) > 0
      : tag === "select" ? el.selectedIndex > 0
      : !!el.value;
    fields.push({
      id: id, kind: KINDS.includes(kind) ? kind : "text", label: labelFor(el), name: el.getAttribute("name") || "",
      required: !!el.required || el.getAttribute("aria-required") === "true",
      options: options, hasValue: hasValue,
    });
  }
  return fields;
})()`;

/** Finds visible form fields in a frame and tags each with data-jaf-id for the filler. */
export async function detectFields(frame: Frame): Promise<DetectedField[]> {
  return (await frame.evaluate(DETECT_SCRIPT)) as DetectedField[];
}
