/** Minimal Structured Text highlighting, line by line, with block-comment state across lines. */
import { esc } from "./util.js";

const KW = new Set(
  "PROGRAM END_PROGRAM FUNCTION_BLOCK END_FUNCTION_BLOCK FUNCTION END_FUNCTION METHOD END_METHOD PROPERTY END_PROPERTY INTERFACE END_INTERFACE ACTION END_ACTION TYPE END_TYPE STRUCT END_STRUCT UNION END_UNION VAR VAR_INPUT VAR_OUTPUT VAR_IN_OUT VAR_GLOBAL VAR_TEMP VAR_STAT VAR_INST VAR_EXTERNAL VAR_CONFIG END_VAR CONSTANT RETAIN PERSISTENT AT IF THEN ELSIF ELSE END_IF CASE OF END_CASE FOR TO BY DO END_FOR WHILE END_WHILE REPEAT UNTIL END_REPEAT EXIT CONTINUE RETURN AND OR XOR NOT MOD EXTENDS IMPLEMENTS THIS SUPER PUBLIC PRIVATE PROTECTED INTERNAL ABSTRACT FINAL REF_TO REFERENCE POINTER ARRAY TRUE FALSE NAMESPACE END_NAMESPACE".split(" "),
);
const TY = new Set("BOOL BYTE WORD DWORD LWORD SINT INT DINT LINT USINT UINT UDINT ULINT REAL LREAL TIME LTIME DATE TIME_OF_DAY TOD DATE_AND_TIME DT STRING WSTRING ANY TON TOF TP R_TRIG F_TRIG CTU CTD CTUD SR RS".split(" "));

export interface HighlightState {
  inComment: boolean;
}

export function highlight(line: string, st: HighlightState): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (st.inComment) {
      const end = line.indexOf("*)", i);
      const stop = end < 0 ? line.length : end + 2;
      out += `<span class="cm">${esc(line.slice(i, stop))}</span>`;
      i = stop;
      if (end >= 0) st.inComment = false;
      continue;
    }
    const rest = line.slice(i);
    let m: RegExpExecArray | null;
    if (rest.startsWith("//")) {
      out += `<span class="cm">${esc(rest)}</span>`;
      break;
    }
    if (rest.startsWith("(*")) {
      st.inComment = true;
      out += `<span class="cm">(*</span>`;
      i += 2;
      continue;
    }
    if ((m = /^'(?:\$.|[^'])*'?|^"(?:\$.|[^"])*"?/.exec(rest))) {
      out += `<span class="st">${esc(m[0])}</span>`;
      i += m[0].length;
      continue;
    }
    if ((m = /^(?:[A-Za-z_]+#)?\d[\w.#]*/.exec(rest)) && !/[A-Za-z_]/.test(line[i - 1] ?? "")) {
      out += `<span class="nu">${esc(m[0])}</span>`;
      i += m[0].length;
      continue;
    }
    if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      const w = m[0];
      const up = w.toUpperCase();
      const prev = line[i - 1];
      if (prev !== "." && KW.has(up)) out += `<span class="kw">${esc(w)}</span>`;
      else if (prev !== "." && (TY.has(up) || /^(STRING|WSTRING)$/.test(up))) out += `<span class="ty">${esc(w)}</span>`;
      else out += esc(w);
      i += w.length;
      continue;
    }
    out += esc(line[i]!);
    i++;
  }
  return out;
}
