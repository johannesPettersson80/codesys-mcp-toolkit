/**
 * server.ts
 * MCP Server for interacting with CODESYS via Python scripting.
 * Implements all MCP resources and tools that interact with the CODESYS environment.
 * 
 * IMPORTANT: This server receives configuration as parameters from bin.ts,
 * which helps avoid issues with command-line argument passing in different execution environments.
 */

// --- Import 'os' FIRST ---
import * as os from 'os';
// --- End Import 'os' ---

// --- STARTUP LOG ---
console.error(`>>> SERVER.TS TOP LEVEL EXECUTION @ ${new Date().toISOString()} <<<`);
console.error(`>>> Node: ${process.version}, Platform: ${os.platform()}, Arch: ${os.arch()}`);
console.error(`>>> Initial CWD: ${process.cwd()}`);
// --- End Startup Log ---

// --- Necessary Imports ---
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { executeCodesysScript } from "./codesys_interop"; // Assumes this utility exists
import * as path from 'path';
import { stat } from "fs/promises"; // For file existence check (async)
import * as fsPromises from 'fs/promises'; // Use promises version of fs
// --- End Imports ---

// --- Define an interface for configuration ---
interface ServerConfig {
    codesysPath: string;
    profileName: string;
    workspaceDir: string;
}

// --- Wrap server logic in an exported function ---
export async function startMcpServer(config: ServerConfig) {

    console.error(`>>> SERVER.TS startMcpServer() CALLED @ ${new Date().toISOString()} <<<`);
    console.error(`>>> Config Received: ${JSON.stringify(config)}`);

    // --- Use config values directly ---
    const WORKSPACE_DIR = config.workspaceDir;
    const codesysExePath = config.codesysPath;
    const codesysProfileName = config.profileName;

    console.error(`SERVER.TS: Using Workspace Directory: ${WORKSPACE_DIR}`);
    console.error(`SERVER.TS: Using CODESYS Path: ${codesysExePath}`);
    console.error(`SERVER.TS: Using CODESYS Profile: ${codesysProfileName}`);

    // --- Sanity check - confirm the path exists if possible ---
    // This helps catch configuration issues early and prevents runtime failures
    console.error(`SERVER.TS: Checking existence of CODESYS executable: ${codesysExePath}`);
    try {
        const fsChecker = require('fs'); // Sync check okay at startup
        if (!fsChecker.existsSync(codesysExePath)) {
            console.error(`SERVER.TS ERROR: Determined CODESYS executable path does not exist: ${codesysExePath}`);
            process.exit(1);
        } else {
            console.error(`SERVER.TS: Confirmed CODESYS executable exists.`);
        }
    } catch (err: any) {
        console.error(`SERVER.TS ERROR: Error checking CODESYS path existence: ${err.message}`);
        process.exit(1);
    }
    // --- End Configuration Handling ---

    // --- Helper Function (fileExists - FIXED) ---
    async function fileExists(filePath: string): Promise<boolean> {
        try {
            await stat(filePath);
            return true;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return false; // File does not exist
            }
            throw error; // Other error
        }
    }
    // --- End Helper Function ---

    // --- MCP Server Initialization ---
    console.error("SERVER.TS: Initializing McpServer...");
    const server = new McpServer({
        name: "CODESYS Control MCP Server",
        version: "1.7.1", // Update version
        capabilities: { resources: {}, tools: {} }
    });
    console.error("SERVER.TS: McpServer instance created.");
    // --- End MCP Server Initialization ---

    // --- Python Script Templates ---
    // ENSURE_PROJECT_OPEN_PYTHON_SNIPPET - Reusable function for ensuring a project is open
    // This snippet provides robust project opening with retry logic and error handling
    const ENSURE_PROJECT_OPEN_PYTHON_SNIPPET = `...`; // Paste your full snippet
    
    // CHECK_STATUS_SCRIPT - Checks the status of CODESYS and current project
    // Used to verify scripting works and report on the currently open project
    const CHECK_STATUS_SCRIPT = `...`; // Paste your full snippet
    
    // OPEN_PROJECT_SCRIPT_TEMPLATE - Used to open an existing CODESYS project
    // This script ensures the project is properly opened and accessible through the CODESYS scripting interface
    const OPEN_PROJECT_SCRIPT_TEMPLATE = `...`; // Paste your full snippet
    
    // CREATE_PROJECT_SCRIPT_TEMPLATE - Creates a new project from a template file
    // Handles copying the template and opening the new project in CODESYS
    const CREATE_PROJECT_SCRIPT_TEMPLATE = `...`; // Paste your full snippet
    
    // SAVE_PROJECT_SCRIPT_TEMPLATE - Saves the currently open project
    // Ensures changes to POUs, Methods, etc. are persisted to the project file
    const SAVE_PROJECT_SCRIPT_TEMPLATE = `...`; // Paste your full snippet
    
    // FIND_OBJECT_BY_PATH_PYTHON_SNIPPET - Utility function to locate objects in the project tree
    // This function handles path traversal with robust error handling
    const FIND_OBJECT_BY_PATH_PYTHON_SNIPPET = `...`; // Paste your full snippet
    
    // CREATE_POU_SCRIPT_TEMPLATE - Creates a new Program, Function Block, or Function
    // This script creates a POU in the specified path with the given type and implementation language
    const CREATE_POU_SCRIPT_TEMPLATE = `...`; // Paste your full snippet
    
    // SET_POU_CODE_SCRIPT_TEMPLATE - Sets the declaration and implementation code for a POU
    // This script finds the target POU/Method/Property by path and updates its textual content
    const SET_POU_CODE_SCRIPT_TEMPLATE = `...`; // Paste your full snippet
    
    // CREATE_PROPERTY_SCRIPT_TEMPLATE - Creates a property in a Function Block
    // This script adds a property with the specified type to the parent POU
    const CREATE_PROPERTY_SCRIPT_TEMPLATE = `...`; // Paste your full snippet
    
    // CREATE_METHOD_SCRIPT_TEMPLATE - Creates a method in a Function Block
    // This script adds a method with optional return type to the parent POU
    const CREATE_METHOD_SCRIPT_TEMPLATE = `...`; // Paste your full snippet
    
    // COMPILE_PROJECT_SCRIPT_TEMPLATE - Builds the active application in a project
    // This script finds the compilable application in the project and runs the build command
    const COMPILE_PROJECT_SCRIPT_TEMPLATE = `...`; // Paste your full snippet
    
    // GET_PROJECT_STRUCTURE_SCRIPT_TEMPLATE - Retrieves the project object hierarchy
    // Lists all objects in the project with their types and relationships
    const GET_PROJECT_STRUCTURE_SCRIPT_TEMPLATE = `...`; // Paste your full snippet
    
    // GET_POU_CODE_SCRIPT_TEMPLATE - Retrieves code from a POU, Method, or Property
    // Gets both the declaration and implementation sections for the specified object
    const GET_POU_CODE_SCRIPT_TEMPLATE = `...`; // Paste your full snippet
    // --- End Python Script Templates ---

    // --- Zod Schemas (moved for clarity before usage) ---
    const PouTypeEnum = z.enum(["Program", "FunctionBlock", "Function"]);
    const ImplementationLanguageEnum = z.enum(["ST", "LD", "FBD", "SFC", "IL", "CFC", "StructuredText", "LadderDiagram", "FunctionBlockDiagram", "SequentialFunctionChart", "InstructionList", "ContinuousFunctionChart"]);
    // --- End Zod Schemas ---


    // --- MCP Resources / Tools Definitions ---
    console.error("SERVER.TS: Defining Resources and Tools...");

    // --- Resources ---
    server.resource("project-status", "codesys://project/status", async (uri) => {
        console.error(`SERVER.TS Resource request: ${uri.href}`);
        try {
            const result = await executeCodesysScript(CHECK_STATUS_SCRIPT, codesysExePath, codesysProfileName);
            const outputLines = result.output.split(/[\r\n]+/).filter(line => line.trim()); const statusData: { [key: string]: string } = {};
            outputLines.forEach(line => { const match = line.match(/^([^:]+):\s*(.*)$/); if (match) { statusData[match[1].trim()] = match[2].trim(); }});
            const statusText = `CODESYS Status:\n - Scripting OK: ${statusData['Scripting OK'] ?? 'Unknown'}\n - Project Open: ${statusData['Project Open'] ?? 'Unknown'}\n - Project Name: ${statusData['Project Name'] ?? 'Unknown'}\n - Project Path: ${statusData['Project Path'] ?? 'N/A'}`;
            const isError = !result.success || statusData['Scripting OK']?.toLowerCase() !== 'true';
            // **** RETURN MCP STRUCTURE ****
            return { contents: [{ uri: uri.href, text: statusText, contentType: "text/plain" }], isError: isError };
        } catch (error: any) {
            console.error(`Error resource ${uri.href}:`, error);
            // **** RETURN MCP STRUCTURE ****
            return { contents: [{ uri: uri.href, text: `Failed status script: ${error.message}`, contentType: "text/plain" }], isError: true };
        }
    });

    // *** DEFINE TEMPLATES ***
    const projectStructureTemplate = new ResourceTemplate("codesys://project/{+project_path}/structure", { list: undefined });
    const pouCodeTemplate = new ResourceTemplate("codesys://project/{+project_path}/pou/{+pou_path}/code", { list: undefined });
    // *** END DEFINE TEMPLATES ***

    server.resource("project-structure", projectStructureTemplate, async (uri, params) => {
        // *** DEFINE VARIABLES (like projectPath) ***
        const projectPathParam = params.project_path;
        if (typeof projectPathParam !== 'string') { return { contents: [{ uri: uri.href, text: `Error: Invalid project path type (${typeof projectPathParam}).`, contentType: "text/plain" }], isError: true }; }
        const projectPath: string = projectPathParam; // Define projectPath
        if (!projectPath) { return { contents: [{ uri: uri.href, text: "Error: Project path missing.", contentType: "text/plain" }], isError: true }; }
        // *** END DEFINE VARIABLES ***
        console.error(`Resource request: project structure for ${projectPath}`);
        try {
            const absoluteProjPath = path.normalize(path.isAbsolute(projectPath) ? projectPath : path.join(WORKSPACE_DIR, projectPath));
            const escapedPathForPython = absoluteProjPath.replace(/\\/g, '\\\\');
            // *** DEFINE scriptContent ***
            const scriptContent = GET_PROJECT_STRUCTURE_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escapedPathForPython);
            // *** END DEFINE scriptContent ***
            const result = await executeCodesysScript(scriptContent, codesysExePath, codesysProfileName);
            let structureText = `Error retrieving structure for ${absoluteProjPath}.\n\n${result.output}`; let isError = !result.success;
            if (result.success && result.output.includes("SCRIPT_SUCCESS")) {
                const startMarker = "--- PROJECT STRUCTURE START ---"; const endMarker = "--- PROJECT STRUCTURE END ---";
                const startIndex = result.output.indexOf(startMarker); const endIndex = result.output.indexOf(endMarker);
                if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
                     structureText = result.output.substring(startIndex + startMarker.length, endIndex).replace(/\\n/g, '\n').trim();
                 } else {
                    console.error("Error: Could not find structure markers in script output.");
                    structureText = `Could not parse structure markers in output for ${absoluteProjPath}.\n\nOutput:\n${result.output}`;
                    isError = true;
                }
            } else { isError = true; }
             // **** RETURN MCP STRUCTURE ****
            return { contents: [{ uri: uri.href, text: structureText, contentType: "text/plain" }], isError: isError };
        } catch (error: any) {
             console.error(`Error getting structure ${uri.href}:`, error);
             // **** RETURN MCP STRUCTURE ****
             return { contents: [{ uri: uri.href, text: `Failed structure script for '${projectPath}': ${error.message}`, contentType: "text/plain" }], isError: true };
        }
    });

    server.resource("pou-code", pouCodeTemplate, async (uri, params) => {
        // *** DEFINE VARIABLES (like projectPath, pouPath) ***
        const projectPathParam = params.project_path; const pouPathParam = params.pou_path;
        if (typeof projectPathParam !== 'string' || typeof pouPathParam !== 'string') { return { contents: [{ uri: uri.href, text: "Error: Invalid project or POU path type.", contentType: "text/plain" }], isError: true }; }
        const projectPath: string = projectPathParam; // Define projectPath
        const pouPath: string = pouPathParam; // Define pouPath
        if (!projectPath || !pouPath) { return { contents: [{ uri: uri.href, text: "Error: Project or POU path missing.", contentType: "text/plain" }], isError: true }; }
        // *** END DEFINE VARIABLES ***
        console.error(`Resource request: POU code: Project='${projectPath}', POU='${pouPath}'`);
        try {
            const absoluteProjPath = path.normalize(path.isAbsolute(projectPath) ? projectPath : path.join(WORKSPACE_DIR, projectPath));
            const sanitizedPouPath = String(pouPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            const escapedProjPath = absoluteProjPath.replace(/\\/g, '\\\\');
            // *** DEFINE scriptContent ***
            let scriptContent = GET_POU_CODE_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escapedProjPath);
            scriptContent = scriptContent.replace("{POU_FULL_PATH}", sanitizedPouPath);
            // *** END DEFINE scriptContent ***
            const result = await executeCodesysScript(scriptContent, codesysExePath, codesysProfileName);
            let codeText = `Error retrieving code for object '${sanitizedPouPath}' in project '${absoluteProjPath}'.\n\n${result.output}`; let isError = !result.success;
            if (result.success && result.output.includes("SCRIPT_SUCCESS")) {
                 // ... (marker parsing logic) ...
                 const declStartMarker = "### POU DECLARATION START ###";
                 const declEndMarker = "### POU DECLARATION END ###";
                 const implStartMarker = "### POU IMPLEMENTATION START ###";
                 const implEndMarker = "### POU IMPLEMENTATION END ###";

                 const declStartIdx = result.output.indexOf(declStartMarker);
                 const declEndIdx = result.output.indexOf(declEndMarker);
                 const implStartIdx = result.output.indexOf(implStartMarker);
                 const implEndIdx = result.output.indexOf(implEndMarker);

                let declaration = "/* Declaration not found in output */";
                let implementation = "/* Implementation not found in output */";
                 if (declStartIdx !== -1 && declEndIdx !== -1 && declStartIdx < declEndIdx) {
                     declaration = result.output.substring(declStartIdx + declStartMarker.length, declEndIdx).replace(/\\n/g, '\n').trim();
                 } else { console.error(`WARN: Declaration markers not found correctly for ${sanitizedPouPath}`); }
                 if (implStartIdx !== -1 && implEndIdx !== -1 && implStartIdx < implEndIdx) {
                    implementation = result.output.substring(implStartIdx + implStartMarker.length, implEndIdx).replace(/\\n/g, '\n').trim();
                 } else { console.error(`WARN: Implementation markers not found correctly for ${sanitizedPouPath}`); }
                 codeText = `// ----- Declaration -----\n${declaration}\n\n// ----- Implementation -----\n${implementation}`;
                 // *** END MARKER PARSING ***
            } else { isError = true; }
            // **** RETURN MCP STRUCTURE ****
            return { contents: [{ uri: uri.href, text: codeText, contentType: "text/plain" }], isError: isError };
        } catch (error: any) {
             console.error(`Error getting POU code ${uri.href}:`, error);
             // **** RETURN MCP STRUCTURE ****
             return { contents: [{ uri: uri.href, text: `Failed POU code script for '${pouPath}' in '${projectPath}': ${error.message}`, contentType: "text/plain" }], isError: true };
        }
    });
    // --- End Resources ---


    // --- Tools ---
    server.tool("open_project", { filePath: z.string().describe("Path to the project file.") }, async (args) => {
        const { filePath } = args; let absPath = path.normalize(path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE_DIR, filePath));
        console.error(`Tool call: open_project: ${absPath}`);
        try {
            const escapedPath = absPath.replace(/\\/g, '\\\\');
            // *** DEFINE script ***
            const script = OPEN_PROJECT_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escapedPath);
            // *** END DEFINE script ***
            const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
            const success = result.success && result.output.includes("SCRIPT_SUCCESS");
            // **** RETURN MCP STRUCTURE ****
            return { content: [{ type: "text", text: success ? `Project opened: ${absPath}` : `Failed open project ${absPath}. Output:\n${result.output}` }], isError: !success };
        } catch (e: any) {
             console.error(`Error open_project ${absPath}: ${e}`);
             // **** RETURN MCP STRUCTURE ****
             return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });

    server.tool("create_project", { filePath: z.string().describe("Path for new project.") }, async (args) => {
        const { filePath } = args; let absPath = path.normalize(path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE_DIR, filePath));
        console.error(`Tool call: create_project (copy template): ${absPath}`);
        let templatePath = "";
        try {
            // ... (template finding logic - assuming this works and defines templatePath) ...
            const baseDir = path.dirname(path.dirname(codesysExePath));
            templatePath = path.normalize(path.join(baseDir, 'Templates', 'Standard.project'));
             if (!(await fileExists(templatePath))) {
                 console.error(`WARN: Template not found relative to exe: ${templatePath}. Trying ProgramData...`);
                 const programData = process.env.ALLUSERSPROFILE || process.env.ProgramData || 'C:\\ProgramData';
                 const possibleTemplateDir = path.join(programData, 'CODESYS', 'CODESYS', codesysProfileName, 'Templates');
                 let potentialTemplatePath = path.normalize(path.join(possibleTemplateDir, 'Standard.project'));
                 if (await fileExists(potentialTemplatePath)) { templatePath = potentialTemplatePath; console.error(`DEBUG: Found template in ProgramData: ${templatePath}`); }
                 else {
                      const alternativeTemplateDir = path.join(programData, 'CODESYS', 'Templates');
                      potentialTemplatePath = path.normalize(path.join(alternativeTemplateDir, 'Standard.project'));
                      if (await fileExists(potentialTemplatePath)) { templatePath = potentialTemplatePath; console.error(`DEBUG: Found template in ProgramData (alternative): ${templatePath}`); }
                      else { throw new Error(`Standard template project file not found at relative path or ProgramData locations.`); }
                 }
             } else { console.error(`DEBUG: Found template relative to exe: ${templatePath}`); }
             // *** END TEMPLATE FINDING ***
        } catch (e:any) {
             console.error(`Template Error: ${e.message}`);
             // **** RETURN MCP STRUCTURE ****
             return { content: [{ type: "text", text: `Template Error: ${e.message}` }], isError: true };
        }
        try {
            const escProjPath = absPath.replace(/\\/g, '\\\\'); const escTmplPath = templatePath.replace(/\\/g, '\\\\');
             // *** DEFINE script ***
            const script = CREATE_PROJECT_SCRIPT_TEMPLATE
                .replace("{PROJECT_FILE_PATH}", escProjPath)
                .replace("{TEMPLATE_PROJECT_PATH}", escTmplPath);
             // *** END DEFINE script ***
            console.error(">>> create_project (copy-then-open): PREPARED SCRIPT:", script.substring(0, 500) + "...");
            const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
            console.error(">>> create_project (copy-then-open): EXECUTION RESULT:", JSON.stringify(result));
            const success = result.success && result.output.includes("SCRIPT_SUCCESS");
             // **** RETURN MCP STRUCTURE ****
            return { content: [{ type: "text", text: success ? `Project created from template: ${absPath}` : `Failed create project ${absPath} from template. Output:\n${result.output}` }], isError: !success };
        } catch (e: any) {
            console.error(`Error create_project ${absPath}: ${e}`);
             // **** RETURN MCP STRUCTURE ****
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });

    server.tool("save_project", { projectFilePath: z.string().describe("Path to project.") }, async (args) => {
        const { projectFilePath } = args; let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
        console.error(`Tool call: save_project: ${absPath}`);
         try {
            const escapedPath = absPath.replace(/\\/g, '\\\\');
             // *** DEFINE script ***
            const script = SAVE_PROJECT_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escapedPath);
             // *** END DEFINE script ***
            const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
            const success = result.success && result.output.includes("SCRIPT_SUCCESS");
             // **** RETURN MCP STRUCTURE ****
            return { content: [{ type: "text", text: success ? `Project saved: ${absPath}` : `Failed save project ${absPath}. Output:\n${result.output}` }], isError: !success };
         } catch (e:any) {
             console.error(`Error save_project ${absPath}: ${e}`);
             // **** RETURN MCP STRUCTURE ****
             return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
         }
    });

    server.tool("create_pou", {
        projectFilePath: z.string().describe("Path to project."),
        name: z.string().describe("Name for the new POU."),
        type: PouTypeEnum.describe("Type of POU (Program, FunctionBlock, Function)."),
        language: ImplementationLanguageEnum.describe("Implementation language (ST, LD, FBD, etc.). Will use default if not directly supported/mapped by script."),
        parentPath: z.string().describe("Relative path under project/application (e.g., 'Application' or 'MyFolder/SubFolder').")
    }, async (args) => {
        const { projectFilePath, name, type, language, parentPath } = args;
        let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
        const sanParentPath = parentPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const sanName = name.trim();

        console.error(`Tool call: create_pou: Name='${sanName}', Type='${type}', Lang='${language}', Parent='${sanParentPath}', Project='${absPath}'`);
         try {
            const escProjPath = absPath.replace(/\\/g, '\\\\');
             // *** DEFINE script ***
            let script = CREATE_POU_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProjPath);
            script = script.replace("{POU_NAME}", sanName);
            script = script.replace("{POU_TYPE_STR}", type);
            script = script.replace("{IMPL_LANGUAGE_STR}", language);
            script = script.replace("{PARENT_PATH}", sanParentPath);
             // *** END DEFINE script ***

            console.error(">>> create_pou: PREPARED SCRIPT:", script.substring(0,500)+"...");
            const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
            console.error(">>> create_pou: EXECUTION RESULT:", JSON.stringify(result));
            const success = result.success && result.output.includes("SCRIPT_SUCCESS");
             // **** RETURN MCP STRUCTURE ****
            return { content: [{ type: "text", text: success ? `POU '${sanName}' created in '${sanParentPath}' of ${absPath}. Project saved.` : `Failed create POU '${sanName}'. Output:\n${result.output}` }], isError: !success };
         } catch (e:any) {
             console.error(`Error create_pou ${sanName} in ${absPath}: ${e}`);
             // **** RETURN MCP STRUCTURE ****
             return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
         }
    });

    server.tool("set_pou_code", {
        projectFilePath: z.string().describe("Path to project."),
        pouPath: z.string().describe("Relative POU/Method/Property path (e.g., 'Application/MyPOU' or 'MyFolder/MyFB/MyMethod')."),
        declarationCode: z.string().describe("Code for the declaration part (VAR...END_VAR).").optional(),
        implementationCode: z.string().describe("Code for the implementation logic part.").optional()
    }, async (args) => {
        const { projectFilePath, pouPath, declarationCode, implementationCode } = args;
        if (declarationCode === undefined && implementationCode === undefined) {
            return { content: [{ type: "text", text: "Error: At least one of declarationCode or implementationCode must be provided." }], isError: true };
        }
        let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
        const sanPouPath = pouPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        console.error(`Tool call: set_pou_code: Target='${sanPouPath}', Project='${absPath}'`);
         try {
            const escProjPath = absPath.replace(/\\/g, '\\\\');
            const sanDeclCode = (declarationCode ?? "").replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
            const sanImplCode = (implementationCode ?? "").replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
             // *** DEFINE script ***
            let script = SET_POU_CODE_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProjPath);
            script = script.replace("{POU_FULL_PATH}", sanPouPath);
            script = script.replace("{DECLARATION_CONTENT}", sanDeclCode);
            script = script.replace("{IMPLEMENTATION_CONTENT}", sanImplCode);
             // *** END DEFINE script ***

            console.error(">>> set_pou_code: PREPARED SCRIPT:", script.substring(0, 500) + "...");
            const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
            console.error(">>> set_pou_code: EXECUTION RESULT:", JSON.stringify(result));
            const success = result.success && result.output.includes("SCRIPT_SUCCESS");
             // **** RETURN MCP STRUCTURE ****
            return { content: [{ type: "text", text: success ? `Code set for '${sanPouPath}' in ${absPath}. Project saved.` : `Failed set code for '${sanPouPath}'. Output:\n${result.output}` }], isError: !success };
         } catch (e:any) {
             console.error(`Error set_pou_code ${sanPouPath} in ${absPath}: ${e}`);
             // **** RETURN MCP STRUCTURE ****
             return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
         }
    });

    server.tool("create_property", {
        projectFilePath: z.string().describe("Path to the project file."),
        parentPouPath: z.string().describe("Relative path to the parent POU (e.g., 'Application/MyFB')."),
        propertyName: z.string().describe("Name of the new property."),
        propertyType: z.string().describe("Data type of the property (e.g., 'BOOL', 'INT', 'MyDUT').")
    }, async (args) => {
        const { projectFilePath, parentPouPath, propertyName, propertyType } = args;
        let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
        const sanParentPath = parentPouPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const sanPropName = propertyName.trim();
        const sanPropType = propertyType.trim();
        console.error(`Tool call: create_property: Name='${sanPropName}', Type='${sanPropType}', ParentPOU='${sanParentPath}', Project='${absPath}'`);
        if (!sanPropName || !sanPropType) {
             // **** RETURN MCP STRUCTURE ****
            return { content: [{ type: "text", text: `Error: Property name and type cannot be empty.` }], isError: true };
        }
        try {
            const escProjPath = absPath.replace(/\\/g, '\\\\');
             // *** DEFINE script ***
            let script = CREATE_PROPERTY_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProjPath);
            script = script.replace("{PARENT_POU_FULL_PATH}", sanParentPath);
            script = script.replace("{PROPERTY_NAME}", sanPropName);
            script = script.replace("{PROPERTY_TYPE}", sanPropType);
             // *** END DEFINE script ***

            console.error(">>> create_property: PREPARED SCRIPT:", script.substring(0, 500) + "...");
            const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
            console.error(">>> create_property: EXECUTION RESULT:", JSON.stringify(result));
            const success = result.success && result.output.includes("SCRIPT_SUCCESS");
             // **** RETURN MCP STRUCTURE ****
            return {
                content: [{ type: "text", text: success ? `Property '${sanPropName}' created under '${sanParentPath}' in ${absPath}. Project saved.` : `Failed to create property '${sanPropName}'. Output:\n${result.output}` }],
                isError: !success
            };
        } catch (e: any) {
            console.error(`Error create_property ${sanPropName} in ${absPath}: ${e}`);
             // **** RETURN MCP STRUCTURE ****
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });

    server.tool("create_method", {
        projectFilePath: z.string().describe("Path to the project file."),
        parentPouPath: z.string().describe("Relative path to the parent POU (e.g., 'Application/MyFB')."),
        methodName: z.string().describe("Name of the new method."),
        returnType: z.string().optional().describe("Return type (e.g., 'BOOL', 'INT'). Leave empty or omit for no return value."),
    }, async (args) => {
        const { projectFilePath, parentPouPath, methodName, returnType } = args;
        let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
        const sanParentPath = parentPouPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const sanMethName = methodName.trim();
        const sanReturnType = (returnType ?? "").trim();
        console.error(`Tool call: create_method: Name='${sanMethName}', Return='${sanReturnType}', ParentPOU='${sanParentPath}', Project='${absPath}'`);
         if (!sanMethName) {
             // **** RETURN MCP STRUCTURE ****
            return { content: [{ type: "text", text: `Error: Method name cannot be empty.` }], isError: true };
        }
        try {
            const escProjPath = absPath.replace(/\\/g, '\\\\');
             // *** DEFINE script ***
            let script = CREATE_METHOD_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProjPath);
            script = script.replace("{PARENT_POU_FULL_PATH}", sanParentPath);
            script = script.replace("{METHOD_NAME}", sanMethName);
            script = script.replace("{RETURN_TYPE}", sanReturnType);
             // *** END DEFINE script ***

            console.error(">>> create_method: PREPARED SCRIPT:", script.substring(0, 500) + "...");
            const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
            console.error(">>> create_method: EXECUTION RESULT:", JSON.stringify(result));
            const success = result.success && result.output.includes("SCRIPT_SUCCESS");
             // **** RETURN MCP STRUCTURE ****
            return {
                content: [{ type: "text", text: success ? `Method '${sanMethName}' created under '${sanParentPath}' in ${absPath}. Project saved.` : `Failed to create method '${sanMethName}'. Output:\n${result.output}` }],
                isError: !success
            };
        } catch (e: any) {
            console.error(`Error create_method ${sanMethName} in ${absPath}: ${e}`);
             // **** RETURN MCP STRUCTURE ****
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    });

    server.tool("compile_project", { projectFilePath: z.string().describe("Path to project.") }, async (args) => {
        const { projectFilePath } = args;
        let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
        console.error(`Tool call: compile_project: ${absPath}`);
        try {
            const escapedPath = absPath.replace(/\\/g, '\\\\');
             // *** DEFINE script ***
            const script = COMPILE_PROJECT_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escapedPath);
             // *** END DEFINE script ***
            const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
            const success = result.success && result.output.includes("SCRIPT_SUCCESS");
            const hasCompileErrors = result.output.includes("Compile complete --") && !/ 0 error\(s\),/.test(result.output);
            let message = success ? `Compilation initiated for application in ${absPath}. Check CODESYS messages for results.` : `Failed initiating compilation for ${absPath}. Output:\n${result.output}`;
            let isError = !success; // Base error status on script success
            if (success && hasCompileErrors) {
                message += " WARNING: Build command reported errors in the output log.";
                console.warn("Compile project reported build errors in the output.");
                 // Optionally set isError = true here if compile errors should fail the tool call
                 isError = true;
            }
             // **** RETURN MCP STRUCTURE ****
            return { content: [{ type: "text", text: message }], isError: isError };
         } catch (e:any) {
             console.error(`Error compile_project ${absPath}: ${e}`);
             // **** RETURN MCP STRUCTURE ****
             return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
         }
    });
    // --- End Tools ---

    console.error("SERVER.TS: Resources and Tools defined.");
    // --- End MCP Resources / Tools Definitions ---


    // --- Server Connection ---
    console.error("SERVER.TS: startServer() internal logic executing.");
    try {
        const transport = new StdioServerTransport();
        console.error("SERVER.TS: Connecting MCP server via stdio...");
        await server.connect(transport);
        console.error("SERVER.TS: MCP Server connected and listening.");
        console.error("SERVER.TS: server.connect() promise resolved successfully.");
    } catch (error) {
        console.error("FATAL: Failed to connect MCP server:", error);
        process.exit(1);
    }
    // --- End Server Connection ---

} // --- End of startMcpServer function ---


// --- Graceful Shutdown / Unhandled Rejection ---
process.on('SIGINT', () => {
    console.error('\nSERVER.TS: SIGINT received, shutting down...');
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.error('\nSERVER.TS: SIGTERM received, shutting down...');
    process.exit(0);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('SERVER.TS: Unhandled Rejection at:', promise, 'reason:', reason);
});
// --- End Graceful Shutdown / Unhandled Rejection ---

console.error(">>> SERVER.TS Module Parsed <<<"); // Log end of script parsing