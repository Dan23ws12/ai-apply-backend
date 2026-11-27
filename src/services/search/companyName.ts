import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../../config/env.js";
import { normalizeCompanyName } from "./normalize.js";

/**
 * Country-aware company names, shared with the fraud rating (python-service/app/fraud.py).
 * Both read shared-references/company-name-parts.json and follow the same rules:
 *
 * - A country or region at the start or end of the name is removed:
 *   "DoorDash Canada" -> "DoorDash", "Accenture (UK)" -> "Accenture".
 * - If what is left is generic ("Air" from "Air Canada", "Post" from "Canada Post"),
 *   the country is part of the real name and nothing is removed.
 *
 * Blacklist rule: an entry keeps its country. Blacklisting "DoorDash" also blocks
 * "DoorDash Canada", "DoorDash UK" and so on, while blacklisting "DoorDash Canada" blocks
 * only that one.
 */

const NAME_PARTS_FILE = "shared-references/company-name-parts.json";
const FILLER_WORDS = new Set(["the", "of", "and", "&", "for", "de", "du", "la", "le", "les", "et"]);
const LEGAL_ENDING =
  /(?:,?\s+(?:inc|ltd|llc|llp|lp|plc|corp|corporation|co|company|limited|ltée|ltee|ulc|gmbh|ag|sa|s\.a|sas|srl|bv|b\.v|nv|pty|pvt|private limited|pte|ab|oy|kk)\.?)+$/iu;

interface NameParts {
  atStart: RegExp;
  atEnd: RegExp;
  generic: Set<string>;
}
let cached: NameParts | null | undefined;

function nameParts(): NameParts | null {
  if (cached !== undefined) return cached;
  try {
    const file = path.resolve(env.REFERENCES_ROOT, NAME_PARTS_FILE);
    const data = JSON.parse(readFileSync(file, "utf8")) as { countries: string[]; regions: string[]; genericWords: string[] };
    const places = [...new Set([...data.countries, ...data.regions].map((p) => p.toLowerCase()))].sort((a, b) => b.length - a.length);
    const alt = places.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const sep = String.raw`(?:\s*[-–—|:,/]\s*|\s+)`;
    cached = {
      atStart: new RegExp(String.raw`^\(?(?:${alt})\)?${sep}`, "iu"),
      atEnd: new RegExp(String.raw`${sep}\(?(?:${alt})\)?\.?$`, "iu"),
      generic: new Set(data.genericWords.map((w) => w.toLowerCase())),
    };
  } catch {
    // Without the list, names are matched exactly as before.
    cached = null;
  }
  return cached;
}

/** True when a name left after removing a country is too generic to stand on its own. */
export function isGenericLeftover(name: string): boolean {
  const parts = nameParts();
  if (!parts) return true;
  const words = (name.match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)?/gu) ?? []).filter((w) => !FILLER_WORDS.has(w.toLowerCase()));
  if (!words.length) return true;
  if (words.every((w) => parts.generic.has(w.toLowerCase()))) return true;
  const only = words[0]!;
  return words.length === 1 && only.length <= 3 && only !== only.toUpperCase();
}

/** The name without a country at its start and/or end, or null when there is none (or it is generic). */
export function companyNameWithoutCountry(company: string): string | null {
  const parts = nameParts();
  if (!parts) return null;
  const full = company.replace(/\s+/g, " ").trim();
  const legal = LEGAL_ENDING.exec(full);
  const core = legal ? full.slice(0, legal.index) : full;
  const stripped = core.replace(parts.atStart, "").trim().replace(parts.atEnd, "").trim();
  if (stripped.toLowerCase() === core.toLowerCase()) return null;
  const cleaned = stripped.replace(/^[\s\-–—|:,/()]+|[\s\-–—|:,/()]+$/g, "");
  if (!cleaned || isGenericLeftover(cleaned)) return null;
  return cleaned;
}

/** The same key the companies table uses (Company.normalizedName). */
export function companyKey(name: string): string {
  return normalizeCompanyName(name) || name.toLowerCase();
}

/** Keys a blacklist entry can match: the full name, then the name without its country. */
export function companyBlacklistKeys(name: string): string[] {
  const keys = [companyKey(name)];
  const short = companyNameWithoutCountry(name);
  if (short) {
    const k = companyKey(short);
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

/** True when the company, or the same company without its country, is on the blacklist. */
export function isBlockedName(blocked: ReadonlySet<string>, name: string): boolean {
  return companyBlacklistKeys(name).some((k) => blocked.has(k));
}
