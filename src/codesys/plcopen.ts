/** Shared pieces of the PLCopenXML that create_graphical writes. */

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One POU as a PLCopenXML project for CODESYS's import_xml. */
export function wrap(name: string, pouType: "program" | "functionBlock", body: string, actions = "", addData = ""): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<project xmlns="http://www.plcopen.org/xml/tc6_0200">
  <fileHeader companyName="codesys-mcp-toolkit" productName="codesys-mcp-toolkit" productVersion="2" creationDateTime="2026-01-01T00:00:00" />
  <contentHeader name="${esc(name)}"><coordinateInfo><fbd><scaling x="1" y="1" /></fbd><ld><scaling x="1" y="1" /></ld><sfc><scaling x="1" y="1" /></sfc></coordinateInfo></contentHeader>
  <types><dataTypes /><pous>
    <pou name="${esc(name)}" pouType="${pouType}">
      <interface />
      ${actions}<body>${body}</body>${addData}
    </pou>
  </pous></types>
  <instances><configurations /></instances>
</project>`;
}

/** IEC operators: CODESYS's CFC calls them with CallType 'operator'; other functions are 'function'. */
export const OPERATORS = new Set(["AND", "OR", "XOR", "NOT", "ADD", "SUB", "MUL", "DIV", "MOD", "EXPT", "MOVE", "GT", "GE", "LT", "LE", "EQ", "NE", "SEL", "MAX", "MIN", "LIMIT", "MUX", "SHL", "SHR", "ROL", "ROR", "ABS", "SQRT", "LN", "LOG", "EXP", "SIN", "COS", "TAN", "ASIN", "ACOS", "ATAN", "TRUNC"]);

/** CODESYS's addData names for CFC (from its SP21 CFC plugin and its own export). */
export const CFC_DATA = {
  body: "http://www.3s-software.com/plcopenxml/cfc",
  callType: "http://www.3s-software.com/plcopenxml/cfccalltype",
  page: "http://www.3s-software.com/plcopenxml/cfcpage",
  pageInfo: "http://www.3s-software.com/plcopenxml/cfcpageinfo",
  elementType: "http://www.3s-software.com/plcopenxml/cfcelementtype",
};
