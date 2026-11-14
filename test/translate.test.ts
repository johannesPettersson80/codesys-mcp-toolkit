/** HMI translations: the texts to translate, translating a screen, the header's language buttons, storage. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderScreen } from "../src/hmi/render.js";
import { HmiService } from "../src/hmi/service.js";
import { screenSchema, screenTexts, translateScreen } from "../src/hmi/spec.js";
import type { AppContext } from "../src/tools.js";

const S = screenSchema.parse({
  name: "Overview",
  title: "Pump Station",
  subtitle: "Line A",
  widgets: [
    { type: "buttons", title: "Pump", at: [1, 1, 3, 2], items: [{ label: "Start", variable: "PLC_PRG.xStart" }] },
    { type: "alarms", title: "Alarms", at: [4, 1, 3, 2], items: [{ active: "PLC_PRG.xFault", text: "Pump fault" }] },
    { type: "process", at: [1, 3, 8, 5], items: [{ type: "pump", x: 50, y: 50, running: "PLC_PRG.xRun", label: "P-101" }] },
  ],
});

describe("HMI translations", () => {
  it("lists the operator's texts, not variables or ids", () => {
    const t = screenTexts([S]);
    expect(t).toEqual(expect.arrayContaining(["Pump Station", "Line A", "Pump", "Start", "Alarms", "Pump fault", "P-101"]));
    expect(t.some((x) => x.startsWith("PLC_PRG"))).toBe(false);
  });

  it("translates a screen's texts and leaves variables alone", () => {
    const de = translateScreen(S, { "Pump Station": "Pumpstation", Start: "Starten", "Pump fault": "Pumpenstörung" });
    expect(de.title).toBe("Pumpstation");
    expect(JSON.stringify(de)).toContain('"label":"Starten","variable":"PLC_PRG.xStart"');
    expect(JSON.stringify(de)).toContain('"active":"PLC_PRG.xFault","text":"Pumpenstörung"');
    expect(de.subtitle).toBe("Line A"); // untranslated stays
    expect(translateScreen(S, undefined)).toBe(S);
  });

  it("shows language buttons in the header, the current one marked", () => {
    const html = renderScreen(S, { languages: ["de", "sv"], lang: "de" }).html;
    expect(html).toMatch(/<button class="h-lang" data-lang="">EN<\/button><button class="h-lang cur" data-lang="de">DE<\/button><button class="h-lang" data-lang="sv">SV<\/button>/);
    expect(renderScreen(S).html).not.toMatch(/h-langs/);
  });

  it("stores translations next to the screens and symbols", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmcp-tr-"));
    const hmi = new HmiService({ project: { path: join(dir, "P.project") } } as unknown as AppContext);
    hmi.save(S);
    expect(hmi.setTranslations("de", { Start: "Starten", Alarms: "Alarme" })).toBe(2);
    expect(hmi.setTranslations("de", { Alarms: "" })).toBe(1); // an empty translation removes one
    expect(hmi.translations()).toEqual({ de: { Start: "Starten" } });
    expect(hmi.page().languages).toEqual(["de"]);
    expect(hmi.setTranslations("de", { Pump: "Pumpe" }, true)).toBe(1);
    expect(hmi.translations().de).toEqual({ Pump: "Pumpe" });
    expect(hmi.screens()).toHaveLength(1);
  });
});
