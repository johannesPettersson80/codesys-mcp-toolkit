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
import { executeCodesysScript } from "./codesys_interop"; 
import * as path from 'path';
import { stat } from "fs/promises"; 
import * as fsPromises from 'fs/promises';
import { 
    loadScriptTemplate, 
    loadScriptTemplateSync, 
    interpolateScript, 
    combineScripts,
    preloadAllScriptTemplates
} from './scriptLoader';
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
    console.error(`SERVER.TS: Checking existence of CODESYS executable: ${codesysExePath}`);
    try {
        // Using sync check here as it's part of initial setup before async operations start
        const fsChecker = require('fs');
        if (!fsChecker.existsSync(codesysExePath)) {
            console.error(`SERVER.TS ERROR: Determined CODESYS executable path does not exist: ${codesysExePath}`);
            throw new Error(`CODESYS executable not found at specified path: ${codesysExePath}`);
        } else {
            console.error(`SERVER.TS: Confirmed CODESYS executable exists.`);
        }
    } catch (err: any) {
        console.error(`SERVER.TS ERROR: Error checking CODESYS path existence: ${err.message}`);
        throw err; // Rethrow the error to be caught by the caller (bin.ts)
    }
    // --- End Configuration Handling ---

    // --- Helper Function (fileExists - async version) ---
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

    // --- Preload script templates ---
    try {
        await preloadAllScriptTemplates();
    } catch (err: any) {
        console.error(`SERVER.TS ERROR: Error preloading script templates: ${err.message}`);
        // Continue execution, as script templates will be loaded on demand as needed
    }

    // --- MCP Server Initialization ---
    console.error("SERVER.TS: Initializing McpServer...");
    const server = new McpServer({
        name: "CODESYS Control MCP Server",
        version: "1.8.0", // Updated version for refactored code
        capabilities: {
            resources: { listChanged: true },
            tools: { listChanged: true }
        }
    });
    console.error("SERVER.TS: McpServer instance created.");
    // --- End MCP Server Initialization ---

    // --- Zod Schemas ---
    const PouTypeEnum = z.enum(["Program", "FunctionBlock", "Function"]);
    const ImplementationLanguageEnum = z.enum(["ST", "LD", "FBD", "SFC", "IL", "CFC", "StructuredText", "LadderDiagram", "FunctionBlockDiagram", "SequentialFunctionChart", "InstructionList", "ContinuousFunctionChart"]);
    // --- End Zod Schemas ---

    // --- MCP Resources / Tools Definitions ---
    console.error("SERVER.TS: Defining Resources and Tools...");

    // --- Resources ---
    server.resource("project-status", "codesys://project/status", async (uri) => {
        console.error(`SERVER.TS Resource request: ${uri.href}`);
        try {
            const scriptContent = await loadScriptTemplate('check_status');
            const result = await executeCodesysScript(scriptContent, codesysExePath, codesysProfileName);
            const outputLines = result.output.split(/[\r\n]+/).filter(line => line.trim()); 
            const statusData: { [key: string]: string } = {};
            outputLines.forEach(line => { 
                const match = line.match(/^([^:]+):\s*(.*)$/); 
                if (match) { 
                    statusData[match[1].trim()] = match[2].trim(); 
                }
            });
            const statusText = `CODESYS Status:\n - Scripting OK: ${statusData['Scripting OK'] ?? 'Unknown'}\n - Project Open: ${statusData['Project Open'] ?? 'Unknown'}\n - Project Name: ${statusData['Project Name'] ?? 'Unknown'}\n - Project Path: ${statusData['Project Path'] ?? 'N/A'}`;
            const isError = !result.success || statusData['Scripting OK']?.toLowerCase() !== 'true';
            return { contents: [{ uri: uri.href, text: statusText, contentType: "text/plain" }], isError: isError };
        } catch (error: any) {
            console.error(`Error resource ${uri.href}:`, error);
            return { contents: [{ uri: uri.href, text: `Failed status script: ${error.message}`, contentType: "text/plain" }], isError: true };
        }
    });

    // Templates
    const projectStructureTemplate = new ResourceTemplate("codesys://project/{+project_path}/structure", { list: undefined });
    const pouCodeTemplate = new ResourceTemplate("codesys://project/{+project_path}/pou/{+pou_path}/code", { list: undefined });

    server.resource("project-structure", projectStructureTemplate, async (uri, params) => {
        const projectPathParam = params.project_path;
        if (typeof projectPathParam !== 'string') { 
            return { 
                contents: [{ uri: uri.href, text: `Error: Invalid project path type (${typeof projectPathParam}).`, contentType: "text/plain" }], 
                isError: true 
            }; 
        }
        const projectPath: string = projectPathParam;
        if (!projectPath) { 
            return { 
                contents: [{ uri: uri.href, text: "Error: Project path missing.", contentType: "text/plain" }], 
                isError: true 
            }; 
        }
        console.error(`Resource request: project structure for ${projectPath}`);
        try {
            const absoluteProjPath = path.normalize(path.isAbsolute(projectPath) ? projectPath : path.join(WORKSPACE_DIR, projectPath));
            
            // Load script template and prepare parameters
            const scriptTemplate = await loadScriptTemplate('get_project_structure');
            const ensureProjectOpenTemplate = await loadScriptTemplate('ensure_project_open');
            
            const combinedScript = ensureProjectOpenTemplate + '\n\n' + scriptTemplate;
            const scriptContent = interpolateScript(combinedScript, {
                'PROJECT_FILE_PATH': absoluteProjPath.replace(/\\/g, '\\\\')
            });
            
            const result = await executeCodesysScript(scriptContent, codesysExePath, codesysProfileName);
            let structureText = `Error retrieving structure for ${absoluteProjPath}.\n\n${result.output}`; 
            let isError = !result.success;
            
            if (result.success && result.output.includes("SCRIPT_SUCCESS")) {
                const startMarker = "--- PROJECT STRUCTURE START ---"; 
                const endMarker = "--- PROJECT STRUCTURE END ---";
                const startIndex = result.output.indexOf(startMarker); 
                const endIndex = result.output.indexOf(endMarker);
                
                if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
                     structureText = result.output.substring(startIndex + startMarker.length, endIndex).replace(/\\n/g, '\n').trim();
                } else {
                    console.error("Error: Could not find structure markers in script output.");
                    structureText = `Could not parse structure markers in output for ${absoluteProjPath}.\n\nOutput:\n${result.output}`;
                    isError = true;
                }
            } else { 
                isError = true; 
            }
            return { contents: [{ uri: uri.href, text: structureText, contentType: "text/plain" }], isError: isError };
        } catch (error: any) {
            console.error(`Error getting structure ${uri.href}:`, error);
            return { contents: [{ uri: uri.href, text: `Failed structure script for '${projectPath}': ${error.message}`, contentType: "text/plain" }], isError: true };
        }
    });

    server.resource("pou-code", pouCodeTemplate, async (uri, params) => {
        const projectPathParam = params.project_path; 
        const pouPathParam = params.pou_path;
        
        if (typeof projectPathParam !== 'string' || typeof pouPathParam !== 'string') { 
            return { 
                contents: [{ uri: uri.href, text: "Error: Invalid project or POU path type.", contentType: "text/plain" }], 
                isError: true 
            }; 
        }
        
        const projectPath: string = projectPathParam;
        const pouPath: string = pouPathParam;
        
        if (!projectPath || !pouPath) { 
            return { 
                contents: [{ uri: uri.href, text: "Error: Project or POU path missing.", contentType: "text/plain" }], 
                isError: true 
            }; 
        }
        
        console.error(`Resource request: POU code: Project='${projectPath}', POU='${pouPath}'`);
        
        try {
            const absoluteProjPath = path.normalize(path.isAbsolute(projectPath) ? projectPath : path.join(WORKSPACE_DIR, projectPath));
            const sanitizedPouPath = String(pouPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            
            // Load script template and prepare parameters
            const scriptTemplate = await loadScriptTemplate('get_pou_code');
            const ensureProjectOpenTemplate = await loadScriptTemplate('ensure_project_open');
            const findObjectByPathTemplate = await loadScriptTemplate('find_object_by_path');
            
            const combinedScript = ensureProjectOpenTemplate + '\n\n' + findObjectByPathTemplate + '\n\n' + scriptTemplate;
            const scriptContent = interpolateScript(combinedScript, {
                'PROJECT_FILE_PATH': absoluteProjPath.replace(/\\/g, '\\\\'),
                'POU_FULL_PATH': sanitizedPouPath
            });
            
            const result = await executeCodesysScript(scriptContent, codesysExePath, codesysProfileName);
            let codeText = `Error retrieving code for object '${sanitizedPouPath}' in project '${absoluteProjPath}'.\n\n${result.output}`; 
            let isError = !result.success;
            
            if (result.success && result.output.includes("SCRIPT_SUCCESS")) {
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
                } else { 
                    console.error(`WARN: Declaration markers not found correctly for ${sanitizedPouPath}`); 
                }
                
                if (implStartIdx !== -1 && implEndIdx !== -1 && implStartIdx < implEndIdx) {
                    implementation = result.output.substring(implStartIdx + implStartMarker.length, implEndIdx).replace(/\\n/g, '\n').trim();
                } else { 
                    console.error(`WARN: Implementation markers not found correctly for ${sanitizedPouPath}`); 
                }
                
                codeText = `// ----- Declaration -----\n${declaration}\n\n// ----- Implementation -----\n${implementation}`;
            } else { 
                isError = true; 
            }
            
            return { contents: [{ uri: uri.href, text: codeText, contentType: "text/plain" }], isError: isError };
        } catch (error: any) {
            console.error(`Error getting POU code ${uri.href}:`, error);
            return { contents: [{ uri: uri.href, text: `Failed POU code script for '${pouPath}' in '${projectPath}': ${error.message}`, contentType: "text/plain" }], isError: true };
        }
    });
    // --- End Resources ---

    // --- Tools ---
    server.tool(
        "open_project",
        "Opens an existing CODESYS project file.",
        {
            filePath: z.string().describe("Path to the project file (e.g., 'C:/Projects/MyPLC.project' or '/Users/user/projects/my_project.project').")
        },
        async (args) => {
            const { filePath } = args;
            let absPath = path.normalize(path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE_DIR, filePath));
            console.error(`Tool call: open_project: ${absPath}`);
            
            try {
                // Load the script template and prepare with parameters
                const scriptTemplate = await loadScriptTemplate('open_project');
                // Combine with required ensure_project_open script (will handle any imports)
                const ensureProjectOpenScript = await loadScriptTemplate('ensure_project_open');
                
                const combinedScript = ensureProjectOpenScript + '\n\n' + scriptTemplate;
                const scriptContent = interpolateScript(combinedScript, {
                    'PROJECT_FILE_PATH': absPath.replace(/\\/g, '\\\\')
                });
                
                const result = await executeCodesysScript(scriptContent, codesysExePath, codesysProfileName);
                const success = result.success && result.output.includes("SCRIPT_SUCCESS");
                
                return { 
                    content: [{ 
                        type: "text", 
                        text: success ? `Project opened: ${absPath}` : `Failed open project ${absPath}. Output:\n${result.output}` 
                    }], 
                    isError: !success 
                };
            } catch (e: any) {
                console.error(`Error open_project ${absPath}: ${e}`);
                return { 
                    content: [{ type: "text", text: `Error: ${e.message}` }], 
                    isError: true 
                };
            }
        }
    );

    server.tool(
        "create_project",
        "Creates a new CODESYS project from the standard template.",
        {
            filePath: z.string().describe("Path where the new project file should be created (e.g., 'C:/Projects/NewPLC.project' or '/Users/user/projects/new_project.project').")
        },
        async (args) => {
            const { filePath } = args;
            let absPath = path.normalize(path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE_DIR, filePath));
            console.error(`Tool call: create_project (copy template): ${absPath}`);
            let templatePath = "";
            
            try {
                // Template finding logic
                const baseDir = path.dirname(path.dirname(codesysExePath));
                templatePath = path.normalize(path.join(baseDir, 'Templates', 'Standard.project'));
                
                if (!(await fileExists(templatePath))) {
                    console.error(`WARN: Template not found relative to exe: ${templatePath}. Trying ProgramData...`);
                    const programData = process.env.ALLUSERSPROFILE || process.env.ProgramData || 'C:\\ProgramData';
                    const possibleTemplateDir = path.join(programData, 'CODESYS', 'CODESYS', codesysProfileName, 'Templates');
                    let potentialTemplatePath = path.normalize(path.join(possibleTemplateDir, 'Standard.project'));
                    
                    if (await fileExists(potentialTemplatePath)) { 
                        templatePath = potentialTemplatePath; 
                        console.error(`DEBUG: Found template in ProgramData: ${templatePath}`); 
                    } else {
                        const alternativeTemplateDir = path.join(programData, 'CODESYS', 'Templates');
                        potentialTemplatePath = path.normalize(path.join(alternativeTemplateDir, 'Standard.project'));
                        
                        if (await fileExists(potentialTemplatePath)) { 
                            templatePath = potentialTemplatePath; 
                            console.error(`DEBUG: Found template in ProgramData (alternative): ${templatePath}`); 
                        } else { 
                            throw new Error(`Standard template project file not found at relative path or ProgramData locations.`); 
                        }
                    }
                } else { 
                    console.error(`DEBUG: Found template relative to exe: ${templatePath}`); 
                }
            } catch (e:any) {
                console.error(`Template Error: ${e.message}`);
                return { 
                    content: [{ type: "text", text: `Template Error: ${e.message}` }], 
                    isError: true 
                };
            }
            
            try {
                // Load script template and interpolate parameters
                const scriptTemplate = await loadScriptTemplate('create_project');
                const scriptContent = interpolateScript(scriptTemplate, {
                    'PROJECT_FILE_PATH': absPath.replace(/\\/g, '\\\\'),
                    'TEMPLATE_PROJECT_PATH': templatePath.replace(/\\/g, '\\\\')
                });
                
                console.error(">>> create_project (copy-then-open): PREPARED SCRIPT:", scriptContent.substring(0, 500) + "...");
                const result = await executeCodesysScript(scriptContent, codesysExePath, codesysProfileName);
                console.error(">>> create_project (copy-then-open): EXECUTION RESULT:", JSON.stringify(result));
                
                const success = result.success && result.output.includes("SCRIPT_SUCCESS");
                return { 
                    content: [{ 
                        type: "text", 
                        text: success ? `Project created from template: ${absPath}` : `Failed create project ${absPath} from template. Output:\n${result.output}` 
                    }], 
                    isError: !success 
                };
            } catch (e: any) {
                console.error(`Error create_project ${absPath}: ${e}`);
                return { 
                    content: [{ type: "text", text: `Error: ${e.message}` }], 
                    isError: true 
                };
            }
        }
    );

    server.tool(
        "save_project",
        "Saves the currently open CODESYS project.",
        {
            projectFilePath: z.string().describe("Path to the project file to ensure is open before saving (e.g., 'C:/Projects/MyPLC.project').")
        },
        async (args) => {
            const { projectFilePath } = args;
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            console.error(`Tool call: save_project: ${absPath}`);
            
            try {
                // Load and combine script templates
                const saveProjectTemplate = await loadScriptTemplate('save_project');
                const ensureProjectOpenTemplate = await loadScriptTemplate('ensure_project_open');
                
                const combinedScript = ensureProjectOpenTemplate + '\n\n' + saveProjectTemplate;
                const scriptContent = interpolateScript(combinedScript, {
                    'PROJECT_FILE_PATH': absPath.replace(/\\/g, '\\\\')
                });
                
                const result = await executeCodesysScript(scriptContent, codesysExePath, codesysProfileName);
                const success = result.success && result.output.includes("SCRIPT_SUCCESS");
                return { 
                    content: [{ 
                        type: "text", 
                        text: success ? `Project saved: ${absPath}` : `Failed save project ${absPath}. Output:\n${result.output}` 
                    }], 
                    isError: !success 
                };
            } catch (e:any) {
                console.error(`Error save_project ${absPath}: ${e}`);
                return { 
                    content: [{ type: "text", text: `Error: ${e.message}` }], 
                    isError: true 
                };
            }
        }
    );

    server.tool(
        "create_pou",
        "Creates a new Program, Function Block, or Function POU within the specified CODESYS project.",
        {
            projectFilePath: z.string().describe("Path to the project file (e.g., 'C:/Projects/MyPLC.project')."),
            name: z.string().describe("Name for the new POU (must be a valid IEC identifier)."),
            type: PouTypeEnum.describe("Type of POU (Program, FunctionBlock, Function)."),
            language: ImplementationLanguageEnum.describe("Implementation language (ST, LD, FBD, etc.). CODESYS default will be used if specific language is not set or directly supported by scripting for this POU type."),
            parentPath: z.string().describe("Relative path under project root or application where the POU should be created (e.g., 'Application' or 'MyFolder/SubFolder').")
        },
        async (args) => {
            const { projectFilePath, name, type, language, parentPath } = args;
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            const sanParentPath = parentPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            const sanName = name.trim();

            console.error(`Tool call: create_pou: Name='${sanName}', Type='${type}', Lang='${language}', Parent='${sanParentPath}', Project='${absPath}'`);
            
            try {
                // Load and combine script templates
                const createPouTemplate = await loadScriptTemplate('create_pou');
                const ensureProjectOpenTemplate = await loadScriptTemplate('ensure_project_open');
                const findObjectByPathTemplate = await loadScriptTemplate('find_object_by_path');
                
                const combinedScript = ensureProjectOpenTemplate + '\n\n' + findObjectByPathTemplate + '\n\n' + createPouTemplate;
                const scriptContent = interpolateScript(combinedScript, {
                    'PROJECT_FILE_PATH': absPath.replace(/\\/g, '\\\\'),
                    'POU_NAME': sanName,
                    'POU_TYPE_STR': type,
                    'IMPL_LANGUAGE_STR': language,
                    'PARENT_PATH': sanParentPath
                });

                console.error(">>> create_pou: PREPARED SCRIPT:", scriptContent.substring(0,500)+"...");
                const result = await executeCodesysScript(scriptContent, codesysExePath, codesysProfileName);
                console.error(">>> create_pou: EXECUTION RESULT:", JSON.stringify(result));
                
                const success = result.success && result.output.includes("SCRIPT_SUCCESS");
                return { 
                    content: [{ 
                        type: "text", 
                        text: success ? `POU '${sanName}' created in '${sanParentPath}' of ${absPath}. Project saved.` : `Failed create POU '${sanName}'. Output:\n${result.output}` 
                    }], 
                    isError: !success 
                };
            } catch (e:any) {
                console.error(`Error create_pou ${sanName} in ${absPath}: ${e}`);
                return { 
                    content: [{ type: "text", text: `Error: ${e.message}` }], 
                    isError: true 
                };
            }
        }
    );

    server.tool(
        "set_pou_code",
        "Sets the declaration and/or implementation code for a specific POU, Method, or Property.",
        {
            projectFilePath: z.string().describe("Path to the project file (e.g., 'C:/Projects/MyPLC.project')."),
            pouPath: z.string().describe("Full relative path to the target object (e.g., 'Application/MyPOU', 'MyFolder/MyFB/MyMethod', 'MyFolder/MyFB/MyProperty')."),
            declarationCode: z.string().describe("Code for the declaration part (VAR...END_VAR). If omitted, the declaration is not changed.").optional(),
            implementationCode: z.string().describe("Code for the implementation logic part. If omitted, the implementation is not changed.").optional()
        },
        async (args) => {
            const { projectFilePath, pouPath, declarationCode, implementationCode } = args;
            if (declarationCode === undefined && implementationCode === undefined) {
                return { 
                    content: [{ type: "text", text: "Error: At least one of declarationCode or implementationCode must be provided." }], 
                    isError: true 
                };
            }
            
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            const sanPouPath = pouPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            console.error(`Tool call: set_pou_code: Target='${sanPouPath}', Project='${absPath}'`);
            
            try {
                // Load and combine script templates
                const setPouCodeTemplate = await loadScriptTemplate('set_pou_code');
                const ensureProjectOpenTemplate = await loadScriptTemplate('ensure_project_open');
                const findObjectByPathTemplate = await loadScriptTemplate('find_object_by_path');
                
                const combinedScript = ensureProjectOpenTemplate + '\n\n' + findObjectByPathTemplate + '\n\n' + setPouCodeTemplate;
                
                // Escape content for Python triple-quoted strings
                const sanDeclCode = (declarationCode ?? "").replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
                const sanImplCode = (implementationCode ?? "").replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
                
                const scriptContent = interpolateScript(combinedScript, {
                    'PROJECT_FILE_PATH': absPath.replace(/\\/g, '\\\\'),
                    'POU_FULL_PATH': sanPouPath,
                    'DECLARATION_CONTENT': sanDeclCode,
                    'IMPLEMENTATION_CONTENT': sanImplCode
                });

                console.error(">>> set_pou_code: PREPARED SCRIPT:", scriptContent.substring(0, 500) + "...");
                const result = await executeCodesysScript(scriptContent, codesysExePath, codesysProfileName);
                console.error(">>> set_pou_code: EXECUTION RESULT:", JSON.stringify(result));
                
                const success = result.success && result.output.includes("SCRIPT_SUCCESS");
                return { 
                    content: [{ 
                        type: "text", 
                        text: success ? `Code set for '${sanPouPath}' in ${absPath}. Project saved.` : `Failed set code for '${sanPouPath}'. Output:\n${result.output}` 
                    }], 
                    isError: !success 
                };
            } catch (e:any) {
                console.error(`Error set_pou_code ${sanPouPath} in ${absPath}: ${e}`);
                return { 
                    content: [{ type: "text", text: `Error: ${e.message}` }], 
                    isError: true 
                };
            }
        }
    );

    server.tool(
        "create_property",
        "Creates a new Property within a specific Function Block POU.",
        {
            projectFilePath: z.string().describe("Path to the project file (e.g., 'C:/Projects/MyPLC.project')."),
            parentPouPath: z.string().describe("Relative path to the parent Function Block POU (e.g., 'Application/MyFB')."),
            propertyName: z.string().describe("Name for the new property (must be a valid IEC identifier)."),
            propertyType: z.string().describe("Data type of the property (e.g., 'BOOL', 'INT', 'MyDUT').")
        },
        async (args) => {
            const { projectFilePath, parentPouPath, propertyName, propertyType } = args;
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            const sanParentPath = parentPouPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            const sanPropName = propertyName.trim();
            const sanPropType = propertyType.trim();
            
            console.error(`Tool call: create_property: Name='${sanPropName}', Type='${sanPropType}', ParentPOU='${sanParentPath}', Project='${absPath}'`);
            
            if (!sanPropName || !sanPropType) {
                            return { 
                                content: [{ type: "text", text: `Error: Property name and type cannot be empty.` }], 
                                isError: true 
                            };
                        }
                        
                        try {
                            // Load and combine script templates
                            const createPropertyTemplate = await loadScriptTemplate('create_property');
                            const ensureProjectOpenTemplate = await loadScriptTemplate('ensure_project_open');
                            const findObjectByPathTemplate = await loadScriptTemplate('find_object_by_path');
                            
                            const combinedScript = ensureProjectOpenTemplate + '\n\n' + findObjectByPathTemplate + '\n\n' + createPropertyTemplate;
                            const scriptContent = interpolateScript(combinedScript, {
                                'PROJECT_FILE_PATH': absPath.replace(/\\/g, '\\\\'),
                                'PARENT_POU_FULL_PATH': sanParentPath,
                                'PROPERTY_NAME': sanPropName,
                                'PROPERTY_TYPE': sanPropType
                            });

                            console.error(">>> create_property: PREPARED SCRIPT:", scriptContent.substring(0, 500) + "...");
                            const result = await executeCodesysScript(scriptContent, codesysExePath, codesysProfileName);
                            console.error(">>> create_property: EXECUTION RESULT:", JSON.stringify(result));
                            
                            const success = result.success && result.output.includes("SCRIPT_SUCCESS");
                            return {
                                content: [{ 
                                    type: "text", 
                                    text: success ? `Property '${sanPropName}' created under '${sanParentPath}' in ${absPath}. Project saved.` : `Failed to create property '${sanPropName}'. Output:\n${result.output}` 
                                }],
                                isError: !success
                            };
                        } catch (e: any) {
                            console.error(`Error create_property ${sanPropName} in ${absPath}: ${e}`);
                            return { 
                                content: [{ type: "text", text: `Error: ${e.message}` }], 
                                isError: true 
                            };
                        }
                    }
                );

                server.tool(
                    "create_method",
                    "Creates a new Method within a specific Function Block POU.",
                    {
                        projectFilePath: z.string().describe("Path to the project file (e.g., 'C:/Projects/MyPLC.project')."),
                        parentPouPath: z.string().describe("Relative path to the parent Function Block POU (e.g., 'Application/MyFB')."),
                        methodName: z.string().describe("Name of the new method (must be a valid IEC identifier)."),
                        returnType: z.string().optional().describe("Return type (e.g., 'BOOL', 'INT'). Leave empty or omit for no return value (PROCEDURE).")
                    },
                    async (args) => {
                        const { projectFilePath, parentPouPath, methodName, returnType } = args;
                        let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
                        const sanParentPath = parentPouPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                        const sanMethName = methodName.trim();
                        const sanReturnType = (returnType ?? "").trim();
                        
                        console.error(`Tool call: create_method: Name='${sanMethName}', Return='${sanReturnType}', ParentPOU='${sanParentPath}', Project='${absPath}'`);
                        
                        if (!sanMethName) {
                            return { 
                                content: [{ type: "text", text: `Error: Method name cannot be empty.` }], 
                                isError: true 
                            };
                        }
                        
                        try {
                            // Load and combine script templates
                            const createMethodTemplate = await loadScriptTemplate('create_method');
                            const ensureProjectOpenTemplate = await loadScriptTemplate('ensure_project_open');
                            const findObjectByPathTemplate = await loadScriptTemplate('find_object_by_path');
                            
                            const combinedScript = ensureProjectOpenTemplate + '\n\n' + findObjectByPathTemplate + '\n\n' + createMethodTemplate;
                            const scriptContent = interpolateScript(combinedScript, {
                                'PROJECT_FILE_PATH': absPath.replace(/\\/g, '\\\\'),
                                'PARENT_POU_FULL_PATH': sanParentPath,
                                'METHOD_NAME': sanMethName,
                                'RETURN_TYPE': sanReturnType
                            });

                            console.error(">>> create_method: PREPARED SCRIPT:", scriptContent.substring(0, 500) + "...");
                            const result = await executeCodesysScript(scriptContent, codesysExePath, codesysProfileName);
                            console.error(">>> create_method: EXECUTION RESULT:", JSON.stringify(result));
                            
                            const success = result.success && result.output.includes("SCRIPT_SUCCESS");
                            return {
                                content: [{ 
                                    type: "text", 
                                    text: success ? `Method '${sanMethName}' created under '${sanParentPath}' in ${absPath}. Project saved.` : `Failed to create method '${sanMethName}'. Output:\n${result.output}` 
                                }],
                                isError: !success
                            };
                        } catch (e: any) {
                            console.error(`Error create_method ${sanMethName} in ${absPath}: ${e}`);
                            return { 
                                content: [{ type: "text", text: `Error: ${e.message}` }], 
                                isError: true 
                            };
                        }
                    }
                );

                server.tool(
                    "compile_project",
                    "Compiles (Builds) the primary application within a CODESYS project.",
                    {
                        projectFilePath: z.string().describe("Path to the project file containing the application to compile (e.g., 'C:/Projects/MyPLC.project').")
                    },
                    async (args) => {
                        const { projectFilePath } = args;
                        let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
                        console.error(`Tool call: compile_project: ${absPath}`);
                        
                        try {
                            // Load and combine script templates
                            const compileProjectTemplate = await loadScriptTemplate('compile_project');
                            const ensureProjectOpenTemplate = await loadScriptTemplate('ensure_project_open');
                            
                            const combinedScript = ensureProjectOpenTemplate + '\n\n' + compileProjectTemplate;
                            const scriptContent = interpolateScript(combinedScript, {
                                'PROJECT_FILE_PATH': absPath.replace(/\\/g, '\\\\')
                            });
                            
                            const result = await executeCodesysScript(scriptContent, codesysExePath, codesysProfileName);
                            const success = result.success && result.output.includes("SCRIPT_SUCCESS");
                            
                            // Check for actual compile errors in the output log
                            const hasCompileErrors = result.output.includes("Compile complete --") && !/ 0 error\(s\),/.test(result.output);
                            let message = success ? `Compilation initiated for application in ${absPath}. Check CODESYS messages for results.` : `Failed initiating compilation for ${absPath}. Output:\n${result.output}`;
                            let isError = !success; // Base error status on script success
                            
                            if (success && hasCompileErrors) {
                                message += " WARNING: Build command reported errors in the output log.";
                                console.warn("Compile project reported build errors in the output.");
                                // Report as error if compile fails, even if script technically succeeded
                                isError = true;
                            }
                            
                            return { 
                                content: [{ type: "text", text: message }], 
                                isError: isError 
                            };
                        } catch (e:any) {
                            console.error(`Error compile_project ${absPath}: ${e}`);
                            return { 
                                content: [{ type: "text", text: `Error: ${e.message}` }], 
                                isError: true 
                            };
                        }
                    }
                );
                // --- End Tools ---

                console.error("SERVER.TS: Resources and Tools defined.");
                // --- End MCP Resources / Tools Definitions ---

                // --- Server Connection ---
                console.error("SERVER.TS: startServer() internal logic executing.");
                try {
                    const transport = new StdioServerTransport();
                    console.error("SERVER.TS: Connecting MCP server via stdio...");
                    // No need to await connect here if startMcpServer is called by bin.ts which awaits it
                    server.connect(transport); // Connect but don't await here, let bin.ts handle waiting
                    console.error("SERVER.TS: MCP Server connection initiated via stdio.");
                } catch (error) {
                    console.error("FATAL: Failed to initiate MCP server connection:", error);
                    // Re-throw error so bin.ts can catch it
                    throw error;
                }
                // --- End Server Connection ---

            } // --- End of startMcpServer function ---

            // --- Graceful Shutdown / Unhandled Rejection ---
            // These should remain at the top level, outside startMcpServer
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