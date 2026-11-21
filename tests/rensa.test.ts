import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { rensa } from "../src/rensa.js";

// Outputs from tool-egen-infra hermes-slack/hermes_rensa.py. The port must give the same text and flags.
const vektorer = JSON.parse(readFileSync(new URL("./rensa-vektorer.json", import.meta.url), "utf8")) as Array<{
  in: Record<string, unknown>; extern: boolean; text: string; flaggor: string[];
}>;

describe("rensa matches the Hermes cleaner", () => {
  it.each(vektorer.map((v, i) => [i, v] as const))("vector %i", (_i, v) => {
    expect(rensa(v.in, v.extern)).toEqual({ text: v.text, flaggor: v.flaggor });
  });
});

// The shared cases for all three bots (tool-egen-infra slack-rensa/rensa-fall.json, Lyra #664).
const gemensamma = JSON.parse(readFileSync(new URL("./rensa-fall.json", import.meta.url), "utf8")) as {
  fall: Array<{ meddelande: Record<string, unknown>; extern: boolean; text: string; flaggor: string[] }>;
};

describe("rensa matches the shared Slack cleaner cases", () => {
  it.each(gemensamma.fall.map((f, i) => [i, f] as const))("shared case %i", (_i, f) => {
    expect(rensa(f.meddelande, f.extern)).toEqual({ text: f.text, flaggor: f.flaggor });
  });
});
