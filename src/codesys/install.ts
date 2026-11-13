/** Find CODESYS installations, their profiles and project templates. */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface CodesysInstall {
  /** Full path to CODESYS.exe */
  exe: string;
  /** Profile names found in the Profiles folder, newest first. */
  profiles: string[];
  /** Templates folder (holds Standard.project), if present. */
  templatesDir?: string;
  /** Install folder name, e.g. "CODESYS 3.5.21.0". */
  label: string;
  /** Add-on folder passed as --additionalfolder (SP22 and later). */
  additionalFolder?: string;
}

const isCodesysExe = (exe: string) => basename(exe).toLowerCase() === "codesys.exe";

/**
 * The folder holding an install's Profiles and Templates. CODESYS keeps them
 * two levels above the program (`<root>\CODESYS\Common\CODESYS.exe`). Products
 * built on CODESYS can lay this out differently, so look a few levels up.
 */
function installBase(exe: string): string {
  let dir = dirname(exe);
  for (let level = 0; level < 3; level++) {
    for (const base of [dir, join(dir, "CODESYS")]) if (existsSync(join(base, "Profiles"))) return base;
    dir = dirname(dir);
  }
  return dirname(dirname(exe));
}

/** The workspace folder: created when missing, with a clear error when it can't be used. */
export function ensureWorkspace(dir: string, log: (m: string) => void): string {
  try {
    if (existsSync(dir)) {
      if (!statSync(dir).isDirectory()) throw new Error("it is a file, not a folder");
      return dir;
    }
    mkdirSync(dir, { recursive: true });
    log(`created the workspace folder ${dir}`);
    return dir;
  } catch (e) {
    throw new Error(`Can't use the workspace ${dir}: ${(e as Error).message}`);
  }
}

/**
 * The add-on folder CODESYS's own shortcuts start this install with
 * (`--additionalfolder`). SP22 installs add-ons such as Scripting there:
 * `<CODESYS>\AdditionalFolders\Default`, or the only folder in AdditionalFolders.
 */
export function findAdditionalFolder(base: string): string | undefined {
  const root = join(base, "AdditionalFolders");
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const pick = dirs.find((d) => d.toLowerCase() === "default") ?? (dirs.length === 1 ? dirs[0] : undefined);
  return pick ? join(root, pick) : undefined;
}

function profilesIn(dir: string): string[] {
  const profilesDir = join(dir, "Profiles");
  if (!existsSync(profilesDir)) return [];
  return readdirSync(profilesDir)
    .filter((f) => f.toLowerCase().endsWith(".profile.xml"))
    .map((f) => f.slice(0, -".profile.xml".length));
}

export function describeInstall(exe: string, additionalFolder?: string): CodesysInstall {
  const base = installBase(exe);
  const extra = additionalFolder ?? findAdditionalFolder(base);
  const profiles = [...new Set([...profilesIn(base), ...(extra ? profilesIn(extra) : [])])].sort(compareProfiles);
  const templatesDir = join(base, "Templates");
  return {
    exe,
    profiles,
    templatesDir: existsSync(templatesDir) ? templatesDir : undefined,
    label: isCodesysExe(exe) ? (dirname(base).split(/[\\/]/).pop() ?? base) : dirname(exe).split(/[\\/]/).slice(-2).join(" "),
    ...(extra ? { additionalFolder: extra } : {}),
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

/** "CODESYS V3.5 SP22 Patch 1" -> a key that sorts numerically (SP9 < SP21 < SP22 < SP22 Patch 1). */
export function profileKey(name: string): string {
  const m = /V(\d+)\.(\d+)(?:\.(\d+))?(?:\s*SP\s*(\d+))?(?:\s*Patch\s*(\d+))?/i.exec(name);
  if (!m) return "";
  return [m[1], m[2], m[3], m[4], m[5]].map((n) => (n ?? "0").padStart(4, "0")).join(".");
}

/** Newest profile first; names without a version last, alphabetically. */
export function compareProfiles(a: string, b: string): number {
  return profileKey(b).localeCompare(profileKey(a)) || a.localeCompare(b);
}

function versionKey(label: string): string {
  const m = label.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map((n) => n.padStart(4, "0")).join(".") : label;
}

export interface ResolvedCodesys {
  exe: string;
  profile: string;
  install: CodesysInstall;
  /** Why this install was picked, for the log. */
  reason: string;
  /** Something to log about the profile, when it couldn't be confirmed. */
  warning?: string;
}

/** Pick the CODESYS exe + profile from options, falling back to the newest install. */
export function resolveCodesys(exe?: string, profile?: string, additionalFolder?: string): ResolvedCodesys {
  if (additionalFolder && !existsSync(additionalFolder)) throw new Error(`CODESYS additional folder not found: ${additionalFolder}`);
  let install: CodesysInstall | undefined;
  let reason: string;
  if (exe) {
    if (!existsSync(exe)) throw new Error(`CODESYS executable not found: ${exe}`);
    install = describeInstall(exe, additionalFolder);
    reason = "set with --codesys-path";
  } else {
    const all = findInstalls();
    const withProfile = profile ? all.find((i) => i.profiles.includes(profile)) : undefined;
    install = withProfile ?? all[0];
    if (!install) throw new Error("No CODESYS installation found. Pass --codesys-path <...\\CODESYS\\Common\\CODESYS.exe>.");
    reason = withProfile ? `it has profile "${profile}"` : pickedNewest(all.map((i) => i.label));
    if (additionalFolder) install = { ...install, additionalFolder };
  }
  // Machine Expert's LogicBuilder.exe has no profiles and runs without --profile; an empty profile omits it.
  const prof = profile ?? install.profiles[0] ?? (isCodesysExe(install.exe) ? undefined : "");
  if (prof === undefined) throw new Error(`No CODESYS profile found next to ${install.exe}. Pass --codesys-profile "<name>".`);
  let warning: string | undefined;
  if (profile && !install.profiles.some((p) => p.toLowerCase() === profile.toLowerCase())) {
    const known = install.profiles.join(", ");
    // Only CODESYS.exe is known to name its profiles after these files; other products get the benefit of the doubt.
    if (known && isCodesysExe(install.exe)) throw new Error(`Profile "${profile}" isn't installed next to ${install.exe}. Installed profiles: ${known}.`);
    warning = known ? `profile "${profile}" isn't among those found next to ${install.exe} (${known}); trying it anyway` : `no Profiles folder found near ${install.exe}, so profile "${profile}" can't be checked`;
  }
  return { exe: install.exe, profile: prof, install, reason, ...(warning ? { warning } : {}) };
}

/** "newest of 2 installs found (CODESYS 3.5.22.40, CODESYS 3.5.21.0); --codesys-path picks another" */
export function pickedNewest(labels: string[]): string {
  return labels.length === 1 ? "the only install found" : `newest of ${labels.length} installs found (${labels.join(", ")}); --codesys-path picks another`;
}
