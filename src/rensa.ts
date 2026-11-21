/**
 * Emberloom fork 21/11 (Stefan "a" on bottar-samma-skydd): the same text cleaner as Hermes
 * (tool-egen-infra hermes-slack/hermes_rensa.py, rules by Tyra), ported rule for rule. Ember only
 * ever sees the cleaned text. tests/rensa-vektorer.json holds outputs from the Python cleaner, and
 * tests/rensa.test.ts checks that this port gives the same text and flags.
 *
 * No AI here. Rules in Tyra's order:
 * 1. only the text field, files become "[fil: typ, storlek byte]"
 * 2. NFKC, drop Cc (except newline), Cf, Co, Cs and Cn
 * 3. Slack markup: users and channels become ids, group mentions are removed
 * 4. links and domain-like words are removed
 * 5. code is removed
 * 6. lines that look like instructions to agents, or have letters outside Latin script, are removed and flagged
 * 7. length: 1000 characters, 300 for others than the trusted users
 *
 * Remaining risk (Tyra): no regex removes a request in plain Swedish. The text is data.
 */

export const MAX_INTERN = 1000;
export const MAX_EXTERN = 300;

// JavaScript's \w and \b are ASCII-only, so word characters and boundaries are spelled out with Unicode classes
// to match Python's re.
const W = "[\\p{L}\\p{N}_]";
const NOT_W_BEFORE = `(?<!${W})`;
const NOT_W_AFTER = `(?!${W})`;

const ANVANDARE = /<@([UW][A-Z0-9]{2,20})(?:\|[^>]*)?>/g;
const KANAL = /<#([CG][A-Z0-9]{2,20})(?:\|[^>]*)?>/g;
const GRUPP = new RegExp(`<!(?:here|channel|everyone|subteam\\^[^>]*)[^>]*>|<![^>]*>|@(?:here|channel|everyone)${NOT_W_AFTER}`, "giu");
const SLACKLANK = /<((?:https?|mailto|tel|ftp|slack)[^>|]*)(?:\|[^>]*)?>/gi;
const DOMAN_I_URL = /^(?:[a-z][a-z0-9+.-]*:)?\/*(?:[^@/]*@)?([^/:?#]+)/i;
const NAKEN = new RegExp(`${NOT_W_BEFORE}(?:https?://|www\\.)\\S+|${NOT_W_BEFORE}(?:mailto|tel):\\S+`, "giu");
// Same domain rule as nova-slack-svara.
const DOMAN = new RegExp(`${NOT_W_BEFORE}[\\p{L}\\p{N}_-]+(?:\\.[\\p{L}\\p{N}_-]+)*\\.\\p{L}{2,}${NOT_W_AFTER}`, "gu");
const KODBLOCK = /```[\s\S]*?(?:```|$)/g;
const KODRAD = /`[^`\n]*`?/g;
const INSTRUKTION = [
  /ignore|bortse från|tidigare instruktion|system ?prompt|du är nu|you are now|act as|låtsas/iu,
  new RegExp(`${NOT_W_BEFORE}(?:SendMessage|knuffa|vacka-t3|sudo|ssh|gh |git |curl|rm -|chmod|launchctl|op (?:read|item))`, "iu"),
  new RegExp(`${NOT_W_BEFORE}(?:token|lösen|password|api[- ]?key|secret|nyckel)${NOT_W_AFTER}`, "iu"),
  new RegExp(`${NOT_W_BEFORE}(?:atlas|lyra|vesta|tyra|merc|nova|vega|hedda|clio|metis|iris|ember|hermes)${NOT_W_AFTER}\\s*[,:]`, "iu"),
];
const BORT = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}]/u;

/** Letters outside Latin script ("Аtlas:" with a Cyrillic А). */
export function blandadSkrift(rad: string): boolean {
  for (const c of rad) {
    if (/\p{L}/u.test(c) && !/\p{Script=Latin}/u.test(c)) return true;
  }
  return false;
}

function doman(url: string): string {
  const m = DOMAN_I_URL.exec(url);
  const d = (m ? m[1] : "").toLowerCase();
  return d.replace(/[^a-z0-9.-]/g, "").slice(0, 60) || "okänd";
}

function tecken(text: string): string {
  let ut = "";
  for (const c of text.normalize("NFKC")) {
    if (c === "\n" || !BORT.test(c)) ut += c;
  }
  return ut;
}

export interface SlackMeddelande {
  text?: unknown;
  files?: unknown;
  blocks?: unknown;
  attachments?: unknown;
}

/** (text, flags). extern: true when the sender is not one of the trusted users (fail closed at the caller). */
export function rensa(meddelande: SlackMeddelande, extern: boolean): { text: string; flaggor: string[] } {
  const flaggor = new Set<string>();
  let text = typeof meddelande.text === "string" ? meddelande.text : "";
  const delar: string[] = [];
  const filer = Array.isArray(meddelande.files) ? (meddelande.files as Array<Record<string, unknown>>).slice(0, 10) : [];
  for (const f of filer) {
    const typ = String(f.filetype ?? "okänd").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "okänd";
    const storlek = Number.isInteger(f.size) ? (f.size as number) : 0;
    delar.push(`[fil: ${typ}, ${storlek} byte]`);
    flaggor.add("fil");
  }
  const tom = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
  if (!tom(meddelande.blocks) || !tom(meddelande.attachments)) flaggor.add("bilaga_ignorerad");
  text = tecken(text);
  // Replacements go in as placeholders (NUL is already removed above), so later rules do not read into them.
  const ersatt: string[] = [];
  const satt = (ny: string, flagga: string) => {
    flaggor.add(flagga);
    ersatt.push(ny);
    return `\x00${ersatt.length - 1}\x00`;
  };
  // Code before links, so a link inside a code block leaves nothing behind.
  text = text.replace(KODBLOCK, (m) => satt(`[kod borttagen, ${[...m].length} tecken]`, "kod"));
  text = text.replace(KODRAD, (m) => satt(`[kod borttagen, ${[...m].length} tecken]`, "kod"));
  text = text.replace(ANVANDARE, (_m, id) => satt(`@id:${id}`, "omnamnande"));
  text = text.replace(KANAL, (_m, id) => satt(`#kanal:${id}`, "kanal"));
  text = text.replace(GRUPP, () => satt("[gruppomnämnande borttaget]", "gruppomnamnande"));
  const lank = (url: string) => satt(`[länk borttagen: ${doman(url)}]`, "lank");
  text = text.replace(SLACKLANK, (_m, url) => lank(url));
  text = text.replace(NAKEN, (m) => lank(m));
  text = text.replace(DOMAN, (m) => lank(m));
  // Remaining Slack control characters (< and >) are swapped, so nothing in the data reads as markup.
  text = text.replace(/</g, "‹").replace(/>/g, "›");
  const rader = text.split("\n").map((rad) => {
    if (INSTRUKTION.some((r) => r.test(rad)) || blandadSkrift(rad)) {
      flaggor.add("instruktion");
      return "[möjlig instruktion borttagen]";
    }
    return rad;
  });
  text = rader.join("\n").trim();
  text = text.replace(/\x00([0-9]+)\x00/g, (_m, n) => ersatt[Number(n)]);
  if (delar.length) text = (text + "\n" + delar.join(" ")).trim();
  const tak = extern ? MAX_EXTERN : MAX_INTERN;
  if ([...text].length > tak) {
    text = [...text].slice(0, tak).join("").trimEnd() + " [kortad]";
    flaggor.add("kortad");
  }
  return { text, flaggor: [...flaggor].sort() };
}
