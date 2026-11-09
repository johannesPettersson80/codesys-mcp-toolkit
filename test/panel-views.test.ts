/** The panel's review view, rendered from its model (no DOM needed). */
import { beforeEach, describe, expect, it } from "vitest";
import { model, type ObjData } from "../panel/src/model.js";
import { reviewRows, reviewView, rowCounts, views } from "../panel/src/views.js";

const obj = (path: string, now: { d?: string; i?: string }, was?: { d?: string; i?: string }): ObjData => ({
  object: { path, name: path.split("/").pop()!, kind: "pou", sub: null, st: true, declaration: now.d ?? null, implementation: now.i ?? null },
  base: was ? { declaration: was.d ?? null, implementation: was.i ?? null } : null,
  version: 1,
});

const OLD = "IF bEnable THEN\n    rE := rSP - rPV;\n    rI := rI + rE;\n    rY := rI;\nELSE\n    rY := 0.0;\nEND_IF";
const NEW = "IF bEnable THEN\n    rE := rSP - rPV;\n    IF rY < 100.0 THEN\n        rI := rI + rE;\n    END_IF\n    rY := rI;\nELSE\n    rY := 0.0;\nEND_IF";

beforeEach(() => {
  views.expanded.clear();
  model.objects.clear();
  model.ws = {
    version: 1,
    project: "Tank.project",
    tree: [
      { path: "FB_PI", name: "FB_PI", kind: "pou", depth: 0, change: "M" },
      { path: "FB_PI/Track", name: "Track", kind: "method", depth: 1, change: "A" },
      { path: "PRG_Tank", name: "PRG_Tank", kind: "pou", depth: 0 },
      { path: "GVL_IO", name: "GVL_IO", kind: "gvl", depth: 0, change: "M" },
    ],
    removed: ["OldFb"],
    changeCount: 4,
  };
  model.objects.set("fb_pi", obj("FB_PI", { d: "FUNCTION_BLOCK FB_PI", i: NEW }, { d: "FUNCTION_BLOCK FB_PI", i: OLD }));
  model.objects.set("fb_pi/track", obj("FB_PI/Track", { d: "METHOD Track", i: "rI := 0.0;" }));
});

describe("panel review view", () => {
  it("groups changed members under their changed object", () => {
    expect(reviewRows()).toEqual([
      { path: "FB_PI", mark: "M", members: ["FB_PI", "FB_PI/Track"] },
      { path: "GVL_IO", mark: "M", members: ["GVL_IO"] },
      { path: "OldFb", mark: "D", members: [] },
    ]);
  });

  it("counts added and removed lines, including members, once everything is loaded", () => {
    // FB_PI: 1 line out, 3 in; Track (added): 2 lines in
    expect(rowCounts(["FB_PI", "FB_PI/Track"])).toEqual({ plus: 5, minus: 1 });
    expect(rowCounts(["GVL_IO"])).toBeUndefined(); // not fetched yet
    const html = reviewView(true);
    expect(html).toContain("3 to review");
    expect(html).toMatch(/FB_PI<\/b><span class="muted">changed <span class="good">\+5<\/span> <span class="bad">−1<\/span>/);
  });

  it("shows the changes in place in the card, with context, and only there", () => {
    views.expanded.add("fb_pi");
    const card = reviewView(true);
    expect(card).toContain('data-rv="diff" aria-pressed="true">Hide');
    expect(card).toContain('<div class="ln del"><span class="sg">−</span><span class="no"></span>');
    expect(card.match(/class="ln add"/g)).toHaveLength(5); // 3 in FB_PI, 2 in Track
    expect(card).toContain('<div class="rd-obj">FB_PI/Track <span class="muted">added</span></div>');
    expect(card).toContain("Open in full screen");
    expect(card).toContain("ELSE"); // 2 lines of context after the change...
    expect(card).not.toContain("rY := 0.0"); // ...and no more
    expect(card).not.toContain("FUNCTION_BLOCK"); // FB_PI's unchanged declaration is left out
    // the full-screen list keeps opening the editor instead
    expect(reviewView(false)).not.toContain("Open in full screen");
  });

  it("says when nothing is left to review", () => {
    model.ws!.tree = [{ path: "PRG_Tank", name: "PRG_Tank", kind: "pou", depth: 0 }];
    model.ws!.removed = [];
    expect(reviewView(true)).toContain("Nothing to review");
  });
});
