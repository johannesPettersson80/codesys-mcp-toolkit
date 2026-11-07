/** Find CODESYS installations, their profiles and project templates. */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CodesysInstall {
  /** Full path to CODESYS.exe */
  exe: string;
  /** Profile names found in the Profiles folder, newest first. */
  profiles: string[];
  /** Templates folder (holds Standard.project), if present. */
  templatesDir?: string;
  /** Install folder name, e.g. "CODESYS 3.5.21.0". */
  label: string;
}

/** `<root>\CODESYS\Common\CODESYS.exe` -> `<root>\CODESYS` */
function codesysDir(exe: string): string {
  return dirname(dirname(exe));
}

export function describeInstall(exe: string): CodesysInstall {
  const base = codesysDir(exe);
  const profilesDir = join(base, "Profiles");
  let profiles: string[] = [];
  if (existsSync(profilesDir)) {
    profiles = readdirSync(profilesDir)
      .filter((f) => f.toLowerCase().endsWith(".profile.xml"))
      .map((f) => f.slice(0, -".profile.xml".length))
      .sort()
      .reverse();
  }
  const templatesDir = join(base, "Templates");
  return {
    exe,
    profiles,
    templatesDir: existsSync(templatesDir) ? templatesDir : undefined,
    label: dirname(base).split(/[\\/]/).pop() ?? base,
  };
}

/** Scan Program Files for CODESYS installs (Windows only). */
export function findInstalls(): CodesysInstall[] {
  const roots = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env["ProgramW6432"]]
    .filter((r): r is string => !!r)
    .filter((r, i, a) => a.indexOf(r) === i);
  const found: CodesysInstall[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      if (!/^codesys/i.test(dir)) continue;
      const exe = join(root, dir, "CODESYS", "Common", "CODESYS.exe");
      if (existsSync(exe)) found.push(describeInstall(exe));
    }
  }
  // Newest version first ("CODESYS 3.5.21.0" > "CODESYS 3.5.19.50").
  return found.sort((a, b) => versionKey(b.label).localeCompare(versionKey(a.label)));
}

function versionKey(label: string): string {
  const m = label.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map((n) => n.padStart(4, "0")).join(".") : label;
}

export interface ResolvedCodesys {
  exe: string;
  profile: string;
  install: CodesysInstall;
}

/** Pick the CODESYS exe + profile from options, falling back to the newest install. */
export function resolveCodesys(exe?: string, profile?: string): ResolvedCodesys {
  let install: CodesysInstall | undefined;
  if (exe) {
    if (!existsSync(exe)) throw new Error(`CODESYS executable not found: ${exe}`);
    install = describeInstall(exe);
  } else {
    const all = findInstalls();
    install = profile ? all.find((i) => i.profiles.includes(profile)) ?? all[0] : all[0];
    if (!install) throw new Error("No CODESYS installation found. Pass --codesys-path <...\\CODESYS\\Common\\CODESYS.exe>.");
  }
  const prof = profile ?? install.profiles[0];
  if (!prof) throw new Error(`No CODESYS profile found next to ${install.exe}. Pass --codesys-profile "<name>".`);
  return { exe: install.exe, profile: prof, install };
}
