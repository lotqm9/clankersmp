// Chat and name filtering. Masks slurs and profanity with asterisks.
// Built on `obscenity` (MIT): handles leetspeak, repeated letters and confusable characters,
// plus two extras of our own: spaced-out words ("f u c k", "s.h.i.t") and a short phrase list.

import {
  RegExpMatcher,
  TextCensor,
  asteriskCensorStrategy,
  englishDataset,
  englishRecommendedTransformers,
} from "obscenity";
import { NAME_RE, isReservedName } from "../../shared/names.ts";

const matcher = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
const censor = new TextCensor().setStrategy(asteriskCensorStrategy());

// Extra terms the dataset leaves alone (whole words only, after leet normalisation).
const EXTRA_WORDS = ["kys", "kms", "hitler", "nazi", "nazis", "heil", "spic", "spics", "coon", "coons", "wetback", "beaner", "gook", "raghead", "towelhead", "tranny", "trannies", "1488", "porno", "nudes"];
const EXTRA_PHRASES = [
  /k+\s*i+\s*l+\s*l+\s+(y+\s*o+\s*u+\s*r+\s*s+\s*e+\s*l+\s*f+|u+\s*r+\s*s+\s*e+\s*l+\s*f+|y+\s*o+\s*s+\s*e+\s*l+\s*f+)/gi,
  /\bgo\s+die\b/gi,
  /\bsieg\s+heil\b/gi,
];

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", $: "s", "!": "i", "|": "i", "+": "t" };

function normalizeWord(w: string): string {
  let out = "";
  for (const ch of w.toLowerCase()) out += LEET[ch] ?? ch;
  return out.replace(/[^a-z0-9]/g, "").replace(/(.)\1{2,}/g, "$1$1");
}

function maskRange(chars: string[], start: number, end: number): void {
  for (let i = start; i < end; i++) if (!/\s/.test(chars[i])) chars[i] = "*";
}

/** Returns the text with offensive words masked. */
export function filterText(text: string): string {
  // 1. obscenity
  let out = censor.applyTo(text, matcher.getAllMatches(text));
  const chars = [...out];

  // 2. Extra whole words.
  const wordRe = /[^\s]+/g;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(out))) {
    const n = normalizeWord(m[0]);
    if (EXTRA_WORDS.includes(n)) maskRange(chars, m.index, m.index + m[0].length);
  }
  out = chars.join("");

  // 3. Spaced-out letters: runs of single characters separated by spaces or dots ("f u c k").
  const runRe = /(?:^|(?<=\s))((?:[A-Za-z0-9@$!*][\s._\-]+){2,}[A-Za-z0-9@$!*])(?=\s|$)/g;
  const chars2 = [...out];
  while ((m = runRe.exec(out))) {
    const joined = m[1].replace(/[\s._\-]+/g, "");
    if (matcher.hasMatch(joined) || EXTRA_WORDS.includes(normalizeWord(joined))) {
      maskRange(chars2, m.index, m.index + m[1].length);
    }
  }
  out = chars2.join("");

  // 4. Phrases.
  for (const re of EXTRA_PHRASES) out = out.replace(re, (s) => s.replace(/[^\s]/g, "*"));
  return out;
}

export function isClean(text: string): boolean {
  return filterText(text) === text;
}

/** Accept a requested player name only if it is well-formed, clean and not impersonating staff. */
export function acceptableName(name: unknown): name is string {
  if (typeof name !== "string" || !NAME_RE.test(name)) return false;
  if (isReservedName(name)) return false;
  if (matcher.hasMatch(name)) return false;
  const n = normalizeWord(name);
  // Long extra words match anywhere; short ones ("kys") only as a whole segment, so "BlockySteve" is fine.
  const segments = name.split(/_|(?<=[a-z])(?=[A-Z0-9])/).map(normalizeWord);
  if (EXTRA_WORDS.some((w) => (w.length >= 5 ? n.includes(w) : segments.includes(w)))) return false;
  return true;
}

/** Strip control characters and trim chat to the allowed length. */
export function sanitizeChat(text: unknown, max: number): string {
  if (typeof text !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").trim().slice(0, max);
}
