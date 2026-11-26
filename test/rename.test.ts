/**
 * rename_symbol on a stub CODESYS that answers with cross-references as CODESYS gives them
 * (POU names without folders, in the declaration's spelling): objects in folders, an error
 * when something is left, variables of the same name in other objects, and I/O mappings
 * (issue #16).
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../src/server.js";
import type { AppContext } from "../src/tools.js";
import { declaredType, ObjectIndex, useContext } from "../src/codesys/lang.js";
import { tempDir, viaCodesys } from "./helpers.js";

interface Obj {
  kind: string;
  declaration?: string;
  implementation?: string;
}
interface Ref {
  access: string;
  pou: string;
  location: string;
  text: string;
}

/** A project of objects (path -> text), cross-references by name, and I/O channels. */
function stub(objects: Record<string, Obj>, xref: Record<string, Ref[]>, channels: { device: string; key: string; variable: string }[] = []) {
  const writes: { path: string; declaration?: string; implementation?: string }[] = [];
  const renames: { path: string; new_name: string }[] = [];
  const remaps: { from: string; to: string }[][] = [];
  const folders = new Set<string>();
  for (const p of Object.keys(objects)) p.split("/").slice(0, -1).forEach((_, i, a) => folders.add(a.slice(0, i + 1).join("/")));
  const bridge = {
    async call(op: string, args: Record<string, unknown> = {}) {
      switch (op) {
        case "tree":
          return {
            application: "Application",
            nodes: [
              ...[...folders].filter((f) => !(f in objects)).map((f) => ({ path: f, name: f.split("/").pop(), kind: "folder" })),
              ...Object.entries(objects).map(([path, o]) => ({ path, name: path.split("/").pop(), kind: o.kind })),
            ],
          };
        case "lang.xref":
          return { references: xref[`${args.kind}:${String(args.name).toLowerCase()}`] ?? [] };
        case "objects.read":
          return {
            objects: (args.paths as string[]).map((p) => {
              const key = Object.keys(objects).find((k) => k.toLowerCase() === p.toLowerCase());
              return key ? { path: key, ...objects[key] } : { path: p, error: `No object '${p}' under Application.` };
            }),
          };
        case "object.write": {
          const a = args as { path: string; declaration?: string; implementation?: string };
          writes.push(a);
          if (a.declaration !== undefined) objects[a.path]!.declaration = a.declaration;
          if (a.implementation !== undefined) objects[a.path]!.implementation = a.implementation;
          return {};
        }
        case "object.rename":
          renames.push(args as { path: string; new_name: string });
          return {};
        case "devices.remap": {
          const pairs = args.pairs as { from: string; to: string }[];
          remaps.push(pairs);
          const changed = [];
          for (const c of channels)
            for (const p of pairs)
              if (c.variable.toLowerCase().startsWith(p.from.toLowerCase()) && !/[A-Za-z0-9_]/.test(c.variable[p.from.length] ?? "")) {
                changed.push({ device: c.device, key: c.key, from: c.variable, to: p.to + c.variable.slice(p.from.length) });
                break;
              }
          return { changed };
        }
        case "project.save":
          return {};
        default:
          throw new Error(`stub: no ${op}`);
      }
    },
    health: () => ({}),
    waitReady: async () => true,
    stop: async () => undefined,
  };
  return { bridge, writes, renames, remaps, objects };
}

async function rename(s: ReturnType<typeof stub>, args: Record<string, unknown>) {
  const ctx = { bridge: s.bridge as unknown as AppContext["bridge"], autosave: false, workspace: tempDir(), startWaitMs: 0, project: { path: "X.project" } } as AppContext;
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  const r = (await client.callTool(viaCodesys("rename_symbol", args))) as { content: { text: string }[]; isError?: boolean };
  await client.close();
  return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
}

const ref = (pou: string, line: number, col: number, part: "Decl" | "Impl", access = part === "Decl" ? "Declaration" : "Read", text = ""): Ref => ({ access, pou, location: `Line ${line}, Column ${col} (${part})`, text });

describe("the object index", () => {
  it("finds objects in folders by the names cross-references use, in any case", () => {
    const idx = new ObjectIndex([
      { path: "Folder1", name: "Folder1", kind: "folder" },
      { path: "Folder1/Sub", name: "Sub", kind: "folder" },
      { path: "Folder1/Sub/FB_A", name: "FB_A", kind: "pou" },
      { path: "Folder1/Sub/FB_A/Start", name: "Start", kind: "method" },
      { path: "GVL_IO", name: "GVL_IO", kind: "gvl" },
    ]);
    expect(idx.find("Fb_A")?.path).toBe("Folder1/Sub/FB_A");
    expect(idx.find("FB_A.Start")?.path).toBe("Folder1/Sub/FB_A/Start");
    expect(idx.find("folder1/sub/fb_a")?.path).toBe("Folder1/Sub/FB_A");
    expect(idx.find("Folder1/FB_A")?.path).toBe("Folder1/Sub/FB_A");
    expect(idx.find("gvl_io")?.path).toBe("GVL_IO");
    expect(idx.find("FB_Nope")).toBeUndefined();
  });

  it("reads what stands in front of a use, and a declared type", () => {
    expect(useContext("x := iFoo + 1;", 1, 6, "iFoo")).toEqual({ how: "plain" });
    expect(useContext("y := fbA.iFoo;", 1, 10, "iFoo")).toEqual({ how: "member", chain: "fbA" });
    expect(useContext("y := GVL_IO.fbA.iFoo;", 1, 17, "iFoo")).toEqual({ how: "member", chain: "GVL_IO.fbA" });
    expect(useContext("fbA(xGo := TRUE,\n    iFoo := 3);", 2, 5, "iFoo")).toEqual({ how: "argument", chain: "fbA" });
    expect(useContext("iFoo := 3;", 1, 1, "iFoo")).toEqual({ how: "plain" });
    expect(useContext("y := afb[2].iFoo;", 1, 13, "iFoo")).toEqual({ how: "member" });
    expect(declaredType("VAR\n    a, fbA : Lib.FB_A; // the pump\nEND_VAR", "fbA")).toBe("fb_a");
    expect(declaredType("VAR\n    fbAlt : FB_B;\nEND_VAR", "fbA")).toBeUndefined();
  });
});

describe("rename_symbol", () => {
  const folder = () =>
    stub(
      {
        "Folder1/FB_A": { kind: "pou", declaration: "FUNCTION_BLOCK FB_A\nVAR\n    iFoo : DWORD;\nEND_VAR", implementation: "iFoo := iFoo + 1;" },
        "Folder1/PRG_Main": { kind: "pou", declaration: "PROGRAM PRG_Main\nVAR\n    fbA : FB_A;\n    d : DWORD;\nEND_VAR", implementation: "fbA();\nd := fbA.iFoo;" },
      },
      { "variable:ifoo": [ref("Fb_A", 3, 5, "Decl"), ref("Fb_A", 1, 1, "Impl", "Write"), ref("Fb_A", 1, 9, "Impl"), ref("PRG_Main", 2, 10, "Impl")] },
    );

  it("renames a variable of a POU in a folder, given the bare name or the path", async () => {
    for (const owner of ["FB_A", "Folder1/FB_A", "fb_a"]) {
      const s = folder();
      const r = await rename(s, { kind: "variable", owner, name: "iFoo", newName: "dwFoo" });
      expect(r.isError, r.text).toBe(false);
      expect(r.text).toMatch(/Renamed Folder1\/FB_A\.iFoo to dwFoo: 4 occurrence\(s\) in 2 object\(s\)/);
      expect(s.objects["Folder1/FB_A"]!.implementation).toBe("dwFoo := dwFoo + 1;");
      expect(s.objects["Folder1/PRG_Main"]!.implementation).toBe("fbA();\nd := fbA.dwFoo;");
    }
  });

  it("is an error, so a batch stops, when it changes nothing or skips an object", async () => {
    const none = await rename(folder(), { kind: "variable", owner: "FB_Nope", name: "iFoo", newName: "dwFoo" });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/There is no object 'FB_Nope'/);
    const s = folder();
    const graphical = stub(
      { ...s.objects, "Folder1/CFC_Use": { kind: "pou", declaration: "PROGRAM CFC_Use\nVAR\n    fbA : FB_A;\nEND_VAR" } },
      { "variable:ifoo": [ref("Fb_A", 3, 5, "Decl"), ref("CFC_Use", 1, 1, "Impl")] },
    );
    const r = await rename(graphical, { kind: "variable", owner: "FB_A", name: "iFoo", newName: "dwFoo" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Not changed \(do these by hand\): Folder1\/CFC_Use \(graphical body\)/);
    expect(r.text).toMatch(/Renamed Folder1\/FB_A\.iFoo to dwFoo: 1 occurrence/);
  });

  const sharedObjects = () => ({
    FB_A: { kind: "pou", declaration: "FUNCTION_BLOCK FB_A\nVAR_INPUT\n    iCurrentState : INT;\nEND_VAR", implementation: "iCurrentState := iCurrentState + 1;" },
    FB_B: { kind: "pou", declaration: "FUNCTION_BLOCK FB_B\nVAR\n    iCurrentState : INT;\n    fbInner : FB_A;\nEND_VAR", implementation: "iCurrentState := 2;\nfbInner(iCurrentState := iCurrentState);" },
    PLC_PRG: {
      kind: "pou",
      declaration: "PROGRAM PLC_PRG\nVAR\n    fbA : FB_A;\n    fbB : FB_B;\n    i : INT;\nEND_VAR",
      implementation: "fbA(iCurrentState := 1);\nfbB();\ni := fbA.iCurrentState + fbB.iCurrentState;",
    },
  });
  const sharedRefs = () => [
    ref("FB_A", 3, 5, "Decl"),
    ref("FB_A", 1, 1, "Impl", "Write"),
    ref("FB_A", 1, 18, "Impl"),
    ref("FB_B", 3, 5, "Decl"),
    ref("FB_B", 1, 1, "Impl", "Write"),
    ref("FB_B", 2, 9, "Impl", "Write"), // fbInner(iCurrentState := ...): FB_A's input
    ref("FB_B", 2, 26, "Impl"), // ... := iCurrentState: FB_B's own
    ref("PLC_PRG", 1, 5, "Impl", "Write"), // fbA(iCurrentState := 1)
    ref("PLC_PRG", 3, 10, "Impl"), // fbA.iCurrentState
    ref("PLC_PRG", 3, 30, "Impl"), // fbB.iCurrentState
  ];

  it("renames only the owner's variable when another FB declares one of the same name", async () => {
    const s = stub(sharedObjects(), { "variable:icurrentstate": sharedRefs() });
    const r = await rename(s, { kind: "variable", owner: "FB_A", name: "iCurrentState", newName: "iState" });
    expect(r.isError, r.text).toBe(false);
    expect(s.objects.FB_A!.declaration).toContain("iState : INT;");
    expect(s.objects.FB_A!.implementation).toBe("iState := iState + 1;");
    // FB_B keeps its own, but the input of its FB_A instance is renamed
    expect(s.objects.FB_B!.declaration).toContain("iCurrentState : INT;");
    expect(s.objects.FB_B!.implementation).toBe("iCurrentState := 2;\nfbInner(iState := iCurrentState);");
    expect(s.objects.PLC_PRG!.implementation).toBe("fbA(iState := 1);\nfbB();\ni := fbA.iState + fbB.iCurrentState;");
    expect(r.text).toMatch(/6 occurrence\(s\) in 3 object\(s\)/);
  });

  it("refuses, changing nothing, when a use can't be told apart", async () => {
    const o = sharedObjects();
    o.PLC_PRG.declaration = "PROGRAM PLC_PRG\nVAR\n    afb : ARRAY[1..2] OF FB_A;\n    i : INT;\nEND_VAR";
    o.PLC_PRG.implementation = "i := afb[1].iCurrentState;";
    const s = stub(o, { "variable:icurrentstate": [ref("FB_A", 3, 5, "Decl"), ref("FB_B", 3, 5, "Decl"), ref("PLC_PRG", 1, 13, "Impl")] });
    const r = await rename(s, { kind: "variable", owner: "FB_A", name: "iCurrentState", newName: "iState" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/can't be told apart \(nothing was changed\):\n- PLC_PRG Line 1, Column 13/);
    expect(s.writes).toEqual([]);
  });

  it("remaps the I/O channels mapped to a renamed GVL variable, keeping the index", async () => {
    const s = stub(
      { GVL_IO: { kind: "gvl", declaration: "VAR_GLOBAL\n    wFoo : ARRAY[0..3] OF WORD;\nEND_VAR" }, PLC_PRG: { kind: "pou", declaration: "PROGRAM PLC_PRG\nVAR\nEND_VAR", implementation: "GVL_IO.wFoo[0] := 1;" } },
      { "variable:wfoo": [{ access: "Declaration", pou: "GVL_IO", location: "Line 2", text: "wFoo (Declaration)" }, ref("PLC_PRG", 1, 8, "Impl", "Write"), { access: "Read", pou: "IoConfig__ErrorPou", location: "", text: "" }] },
      [
        { device: "PLC/Ethernet/MB", key: "Registers[0]", variable: "Application.GVL_IO.wFoo[3]" },
        { device: "PLC/Ethernet/MB", key: "Registers[1]", variable: "Application.GVL_IO.wFoobar" },
      ],
    );
    const r = await rename(s, { kind: "variable", owner: "GVL_IO", name: "wFoo", newName: "wBar" });
    expect(r.isError, r.text).toBe(false);
    // CODESYS gives a GVL declaration's location as just "Line 2"
    expect(s.objects.GVL_IO!.declaration).toContain("wBar : ARRAY[0..3] OF WORD;")
    expect(s.objects.PLC_PRG!.implementation).toBe("GVL_IO.wBar[0] := 1;")
    expect(s.remaps[0]).toContainEqual({ from: "Application.GVL_IO.wFoo", to: "Application.GVL_IO.wBar" });
    expect(r.text).toMatch(/Remapped 1 I\/O channel\(s\) on 1 device\(s\): PLC\/Ethernet\/MB Application\.GVL_IO\.wFoo\[3\] -> Application\.GVL_IO\.wBar\[3\]/);
  });

  it("says so, as an error, when the I/O configuration uses the name but no mapping matched", async () => {
    const s = stub(
      { GVL_IO: { kind: "gvl", declaration: "VAR_GLOBAL\n    wFoo : WORD;\nEND_VAR" } },
      { "variable:wfoo": [ref("GVL_IO", 2, 5, "Decl"), { access: "Read", pou: "IoConfig__ErrorPou", location: "", text: "" }] },
    );
    const r = await rename(s, { kind: "variable", owner: "GVL_IO", name: "wFoo", newName: "wBar" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no channel mapping matched/);
  });

  it("renames a POU in a folder", async () => {
    const s = stub(
      { "Lib/FB_Pump": { kind: "pou", declaration: "FUNCTION_BLOCK FB_Pump\nVAR\nEND_VAR", implementation: "" }, PLC_PRG: { kind: "pou", declaration: "PROGRAM PLC_PRG\nVAR\n    fbP : FB_Pump;\nEND_VAR", implementation: "fbP();" } },
      { "pou:fb_pump": [ref("PLC_PRG", 3, 11, "Decl", "Declaration", "FB_Pump")] },
    );
    const r = await rename(s, { kind: "pou", owner: "FB_Pump", newName: "FB_Motor" });
    expect(r.isError, r.text).toBe(false);
    expect(s.objects["Lib/FB_Pump"]!.declaration).toMatch(/^FUNCTION_BLOCK FB_Motor/);
    expect(s.objects.PLC_PRG!.declaration).toContain("fbP : FB_Motor;");
    expect(s.renames).toMatchObject([{ path: "Lib/FB_Pump", new_name: "FB_Motor" }]);
  });
});
