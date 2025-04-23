/**
 * server.ts
 * MCP Server for interacting with CODESYS via Python scripting.
 * Version: 1.6.9 (Fix disconnect error on shutdown)
 * - Removed invalid server.disconnect() calls in SIGINT/SIGTERM handlers.
 * - Includes property/method creation tools (v1.6.8).
 */

console.error(">>> SERVER.TS TOP LEVEL EXECUTION <<<");

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { executeCodesysScript } from "./codesys_interop"; // Assumes this utility exists and works
import * as os from 'os';
import * as path from 'path';
import { stat } from "fs/promises"; // For file existence check
import * as fs from 'fs/promises'; // Use promises version of fs

// --- Configuration ---
const WORKSPACE_DIR = process.cwd(); // Use current working directory as default workspace
console.error(`Using Workspace Directory: ${WORKSPACE_DIR}`);

// --- CODESYS Configuration ---
let codesysExePath = process.argv[2];
let codesysProfileName = process.argv[3];
console.error('Command line arguments:', process.argv);
if (!codesysExePath) {
    codesysExePath = "C:\\Program Files\\CODESYS 3.5.21.0\\CODESYS\\Common\\CODESYS.exe"; // Default Example - ADJUST IF NEEDED
    console.error(`WARNING: Using default CODESYS path: ${codesysExePath}`);
}
if (!codesysProfileName) {
    codesysProfileName = "CODESYS V3.5 SP21"; // Default Example - ADJUST IF NEEDED
    console.error(`WARNING: Using default CODESYS profile: ${codesysProfileName}`);
}
console.error('INFO: Using command-line arguments is recommended for production.');
console.error(`Using CODESYS Path: ${codesysExePath}`);
console.error(`Using CODESYS Profile: ${codesysProfileName}`);
console.error(`OS: ${os.platform()} ${os.release()}, Node: ${process.version}, CWD: ${process.cwd()}`);
// --- End CODESYS Configuration ---

// --- Helper Function ---
async function fileExists(filePath: string): Promise<boolean> {
    try { await stat(filePath); return true; }
    catch (error: any) { if (error.code === 'ENOENT') { return false; } throw error; }
}

// --- MCP Server Initialization ---
const server = new McpServer({
    name: "CODESYS Control MCP Server",
    version: "1.6.9", // Incremented version
    capabilities: { resources: {}, tools: {} }
});

// --- Python Script Templates ---

// (ENSURE_PROJECT_OPEN_PYTHON_SNIPPET remains the same as before)
const ENSURE_PROJECT_OPEN_PYTHON_SNIPPET = `
import sys
import scriptengine as script_engine
import os
import time
import traceback

# --- Function to ensure the correct project is open ---
MAX_RETRIES = 3
RETRY_DELAY = 2.0 # seconds (use float for time.sleep)

def ensure_project_open(target_project_path):
    print("DEBUG: Ensuring project is open: %s" % target_project_path)
    # Normalize target path once
    normalized_target_path = os.path.normcase(os.path.abspath(target_project_path))

    for attempt in range(MAX_RETRIES):
        print("DEBUG: Ensure project attempt %d/%d for %s" % (attempt + 1, MAX_RETRIES, normalized_target_path))
        primary_project = None
        try:
            # Getting primary project might fail if CODESYS instance is unstable
            primary_project = script_engine.projects.primary
        except Exception as primary_err:
             print("WARN: Error getting primary project: %s. Assuming none." % primary_err)
             # traceback.print_exc() # Optional: Print stack trace for this error
             primary_project = None

        current_project_path = ""
        project_ok = False # Flag to check if target is confirmed primary and accessible

        if primary_project:
            try:
                # Getting path should be relatively safe if primary_project object exists
                current_project_path = os.path.normcase(os.path.abspath(primary_project.path))
                print("DEBUG: Current primary project path: %s" % current_project_path)
                if current_project_path == normalized_target_path:
                    # Found the right project as primary, now check if it's usable
                    print("DEBUG: Target project path matches primary. Checking access...")
                    try:
                         # Try a relatively safe operation to confirm object usability
                         # Getting children count is a reasonable check
                         _ = len(primary_project.get_children(False))
                         print("DEBUG: Target project '%s' is primary and accessible." % target_project_path)
                         project_ok = True
                         return primary_project # SUCCESS CASE 1: Already open and accessible
                    except Exception as access_err:
                         # Project found, but accessing it failed. Might be unstable.
                         print("WARN: Primary project access check failed for '%s': %s. Will attempt reopen." % (current_project_path, access_err))
                         # traceback.print_exc() # Optional: Print stack trace
                         primary_project = None # Force reopen by falling through
                else:
                    # A *different* project is primary
                     print("DEBUG: Primary project is '%s', not the target '%s'." % (current_project_path, normalized_target_path))
                     # Consider closing the wrong project if causing issues, but for now, just open target
                     # try:
                     #     print("DEBUG: Closing incorrect primary project '%s'..." % current_project_path)
                     #     primary_project.close() # Be careful with unsaved changes
                     # except Exception as close_err:
                     #     print("WARN: Failed to close incorrect primary project: %s" % close_err)
                     primary_project = None # Force open target project

            except Exception as path_err:
                 # Failed even to get the path of the supposed primary project
                 print("WARN: Could not get path of current primary project: %s. Assuming not the target." % path_err)
                 # traceback.print_exc() # Optional: Print stack trace
                 primary_project = None # Force open target project

        # If target project not confirmed as primary and accessible, attempt to open/reopen
        if not project_ok:
            # Log clearly whether we are opening initially or reopening
            if primary_project is None and current_project_path == "":
                print("DEBUG: No primary project detected. Attempting to open target: %s" % target_project_path)
            elif primary_project is None and current_project_path != "":
                 print("DEBUG: Primary project was '%s' but failed access check or needed close. Attempting to open target: %s" % (current_project_path, target_project_path))
            else: # Includes cases where wrong project was open
                print("DEBUG: Target project not primary or initial check failed. Attempting to open/reopen: %s" % target_project_path)

            try:
                # Set flags for silent opening, handle potential attribute errors
                update_mode = script_engine.VersionUpdateFlags.NoUpdates | script_engine.VersionUpdateFlags.SilentMode
                # try:
                #     update_mode = script_engine.VersionUpdateFlags.NoUpdates | script_engine.VersionUpdateFlags.SilentMode
                # except AttributeError:
                #     print("WARN: VersionUpdateFlags not found, using integer flags for open (1 | 2 = 3).")
                #     update_mode = 3 # 1=NoUpdates, 2=SilentMode

                opened_project = None
                try:
                     # The actual open call
                     print("DEBUG: Calling script_engine.projects.open('%s', update_flags=%s)..." % (target_project_path, update_mode))
                     opened_project = script_engine.projects.open(target_project_path, update_flags=update_mode)

                     if not opened_project:
                         # This is a critical failure if open returns None without exception
                         print("ERROR: projects.open returned None for %s on attempt %d" % (target_project_path, attempt + 1))
                         # Allow retry loop to continue
                     else:
                         # Open call returned *something*, let's verify
                         print("DEBUG: projects.open call returned an object for: %s" % target_project_path)
                         print("DEBUG: Pausing for stabilization after open...")
                         time.sleep(RETRY_DELAY) # Give CODESYS time
                         # Re-verify: Is the project now primary and accessible?
                         recheck_primary = None
                         try: recheck_primary = script_engine.projects.primary
                         except Exception as recheck_primary_err: print("WARN: Error getting primary project after reopen: %s" % recheck_primary_err)

                         if recheck_primary:
                              recheck_path = ""
                              try: # Getting path might fail
                                  recheck_path = os.path.normcase(os.path.abspath(recheck_primary.path))
                              except Exception as recheck_path_err:
                                  print("WARN: Failed to get path after reopen: %s" % recheck_path_err)

                              if recheck_path == normalized_target_path:
                                   print("DEBUG: Target project confirmed as primary after reopening.")
                                   try: # Final sanity check
                                       _ = len(recheck_primary.get_children(False))
                                       print("DEBUG: Reopened project basic access confirmed.")
                                       return recheck_primary # SUCCESS CASE 2: Successfully opened/reopened
                                   except Exception as access_err_reopen:
                                        print("WARN: Reopened project (%s) basic access check failed: %s." % (normalized_target_path, access_err_reopen))
                                        # traceback.print_exc() # Optional
                                        # Allow retry loop to continue
                              else:
                                   print("WARN: Different project is primary after reopening! Expected '%s', got '%s'." % (normalized_target_path, recheck_path))
                                   # Allow retry loop to continue, maybe it fixes itself
                         else:
                               print("WARN: No primary project found after reopening attempt %d!" % (attempt+1))
                               # Allow retry loop to continue

                except Exception as open_err:
                     # Catch errors during the open call itself
                     print("ERROR: Exception during projects.open call on attempt %d: %s" % (attempt + 1, open_err))
                     traceback.print_exc() # Crucial for diagnosing open failures
                     # Allow retry loop to continue

            except Exception as outer_open_err:
                 # Catch errors in the flag setup etc.
                 print("ERROR: Unexpected error during open setup/logic attempt %d: %s" % (attempt + 1, outer_open_err))
                 traceback.print_exc()

        # If we didn't return successfully in this attempt, wait before retrying
        if attempt < MAX_RETRIES - 1:
            print("DEBUG: Ensure project attempt %d did not succeed. Waiting %f seconds..." % (attempt + 1, RETRY_DELAY))
            time.sleep(RETRY_DELAY)
        else: # Last attempt failed
             print("ERROR: Failed all ensure_project_open attempts for %s." % normalized_target_path)


    # If all retries fail after the loop
    raise RuntimeError("Failed to ensure project '%s' is open and accessible after %d attempts." % (target_project_path, MAX_RETRIES))
# --- End of function ---

# Placeholder for the project file path (must be set in scripts using this snippet)
PROJECT_FILE_PATH = r"{PROJECT_FILE_PATH}"
`;

// (CHECK_STATUS_SCRIPT remains the same)
const CHECK_STATUS_SCRIPT = `
import sys, scriptengine as script_engine, os, traceback
project_open = False; project_name = "No project open"; project_path = "N/A"; scripting_ok = False
try:
    scripting_ok = True; primary_project = script_engine.projects.primary
    if primary_project:
        project_open = True
        try:
            project_path = os.path.normcase(os.path.abspath(primary_project.path))
            try:
                 project_name = primary_project.get_name() # Might fail
                 if not project_name: project_name = "Unnamed (path: %s)" % os.path.basename(project_path)
            except: project_name = "Unnamed (path: %s)" % os.path.basename(project_path)
        except Exception as e_path: project_path = "N/A (Error: %s)" % e_path; project_name = "Unnamed (Path Error)"
    print("Project Open: %s" % project_open); print("Project Name: %s" % project_name)
    print("Project Path: %s" % project_path); print("Scripting OK: %s" % scripting_ok)
    print("SCRIPT_SUCCESS: Status check complete."); sys.exit(0)
except Exception as e:
    error_message = "Error during status check: %s" % e
    print(error_message); print("Scripting OK: False")
    # traceback.print_exc() # Optional traceback
    print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;

// (OPEN_PROJECT_SCRIPT_TEMPLATE remains the same)
const OPEN_PROJECT_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
try:
    project = ensure_project_open(PROJECT_FILE_PATH)
    # Get name from object if possible, otherwise use path basename
    proj_name = "Unknown"
    try:
        if project: proj_name = project.get_name() or os.path.basename(PROJECT_FILE_PATH)
        else: proj_name = os.path.basename(PROJECT_FILE_PATH) + " (ensure_project_open returned None?)"
    except Exception:
        proj_name = os.path.basename(PROJECT_FILE_PATH) + " (name retrieval failed)"
    print("Project Opened: %s" % proj_name)
    print("SCRIPT_SUCCESS: Project opened successfully.")
    sys.exit(0)
except Exception as e:
    error_message = "Error opening project %s: %s" % (PROJECT_FILE_PATH, e)
    print(error_message)
    traceback.print_exc()
    print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;

// (CREATE_PROJECT_SCRIPT_TEMPLATE remains the same)
const CREATE_PROJECT_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, shutil, time, traceback
# Placeholders
TEMPLATE_PROJECT_PATH = r'{TEMPLATE_PROJECT_PATH}' # Path to Standard.project
PROJECT_FILE_PATH = r'{PROJECT_FILE_PATH}'    # Path for the new project (Target Path)
try:
    print("DEBUG: Python script create_project (copy from template):")
    print("DEBUG:   Template Source = %s" % TEMPLATE_PROJECT_PATH)
    print("DEBUG:   Target Path = %s" % PROJECT_FILE_PATH)
    if not PROJECT_FILE_PATH: raise ValueError("Target project file path empty.")
    if not TEMPLATE_PROJECT_PATH: raise ValueError("Template project file path empty.")
    if not os.path.exists(TEMPLATE_PROJECT_PATH): raise IOError("Template project file not found: %s" % TEMPLATE_PROJECT_PATH)

    # 1. Copy the template project file to the new location
    target_dir = os.path.dirname(PROJECT_FILE_PATH)
    if not os.path.exists(target_dir): print("DEBUG: Creating target directory: %s" % target_dir); os.makedirs(target_dir)
    # Check if target file already exists
    if os.path.exists(PROJECT_FILE_PATH): print("WARN: Target project file already exists, overwriting: %s" % PROJECT_FILE_PATH)

    print("DEBUG: Copying '%s' to '%s'..." % (TEMPLATE_PROJECT_PATH, PROJECT_FILE_PATH))
    shutil.copy2(TEMPLATE_PROJECT_PATH, PROJECT_FILE_PATH) # copy2 preserves metadata
    print("DEBUG: File copy complete.")

    # 2. Open the newly copied project file
    print("DEBUG: Opening the copied project: %s" % PROJECT_FILE_PATH)
    # Set flags for silent opening
    update_mode = script_engine.VersionUpdateFlags.NoUpdates | script_engine.VersionUpdateFlags.SilentMode
    # try:
    #     update_mode = script_engine.VersionUpdateFlags.NoUpdates | script_engine.VersionUpdateFlags.SilentMode
    # except AttributeError:
    #     print("WARN: VersionUpdateFlags not found, using integer flags for open (1 | 2 = 3).")
    #     update_mode = 3

    project = script_engine.projects.open(PROJECT_FILE_PATH, update_flags=update_mode)
    print("DEBUG: script_engine.projects.open returned: %s" % project)
    if project:
        print("DEBUG: Pausing briefly after open...")
        time.sleep(1.0) # Allow CODESYS to potentially initialize things
        try:
            print("DEBUG: Explicitly saving project after opening copy...")
            project.save();
            print("DEBUG: Project save after opening copy succeeded.")
        except Exception as save_err:
             print("WARN: Explicit save after opening copy failed: %s" % save_err)
             # Decide if this is critical - maybe not, but good to know.
        print("Project Created from Template Copy at: %s" % PROJECT_FILE_PATH)
        print("SCRIPT_SUCCESS: Project copied from template and opened successfully.")
        sys.exit(0)
    else:
        error_message = "Failed to open project copy %s after copying template %s. projects.open returned None." % (PROJECT_FILE_PATH, TEMPLATE_PROJECT_PATH)
        print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error creating project '%s' from template '%s': %s\\n%s" % (PROJECT_FILE_PATH, TEMPLATE_PROJECT_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: Error copying/opening template: %s" % e); sys.exit(1)
`;

// (SAVE_PROJECT_SCRIPT_TEMPLATE remains the same)
const SAVE_PROJECT_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
try:
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    # Get name from object if possible, otherwise use path basename
    project_name = "Unknown"
    try:
        if primary_project: project_name = primary_project.get_name() or os.path.basename(PROJECT_FILE_PATH)
        else: project_name = os.path.basename(PROJECT_FILE_PATH) + " (ensure_project_open returned None?)"
    except Exception:
        project_name = os.path.basename(PROJECT_FILE_PATH) + " (name retrieval failed)"

    print("DEBUG: Saving project: %s (%s)" % (project_name, PROJECT_FILE_PATH))
    primary_project.save()
    print("DEBUG: project.save() executed.")
    print("Project Saved: %s" % project_name)
    print("SCRIPT_SUCCESS: Project saved successfully.")
    sys.exit(0)
except Exception as e:
    error_message = "Error saving project %s: %s" % (PROJECT_FILE_PATH, e)
    print(error_message)
    traceback.print_exc()
    print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;

const PouTypeEnum = z.enum(["Program", "FunctionBlock", "Function"]);
const ImplementationLanguageEnum = z.enum(["ST", "LD", "FBD", "SFC", "IL", "CFC", "StructuredText", "LadderDiagram", "FunctionBlockDiagram", "SequentialFunctionChart", "InstructionList", "ContinuousFunctionChart"]);

// --- Path finding function (used by multiple templates) ---
const FIND_OBJECT_BY_PATH_PYTHON_SNIPPET = `
import traceback
# --- Find object by path function ---
def find_object_by_path_robust(start_node, full_path, target_type_name="object"):
    print("DEBUG: Finding %s by path: '%s'" % (target_type_name, full_path))
    normalized_path = full_path.replace('\\\\', '/').strip('/')
    path_parts = normalized_path.split('/')
    if not path_parts:
        print("ERROR: Path is empty.")
        return None

    # Determine the actual starting node (project or application)
    project = start_node # Assume start_node is project initially
    if not hasattr(start_node, 'active_application') and hasattr(start_node, 'project'):
         # If start_node is not project but has project ref (e.g., an application), get the project
         try: project = start_node.project
         except Exception as proj_ref_err:
             print("WARN: Could not get project reference from start_node: %s" % proj_ref_err)
             # Proceed assuming start_node might be the project anyway or search fails

    # Try to get the application object robustly if we think we have the project
    app = None
    if hasattr(project, 'active_application'):
        try: app = project.active_application
        except Exception: pass # Ignore errors getting active app
        if not app:
            try:
                 apps = project.find("Application", True) # Search recursively
                 if apps: app = apps[0]
            except Exception: pass

    # Check if the first path part matches the application name
    app_name_lower = ""
    if app:
        try: app_name_lower = (app.get_name() or "application").lower()
        except Exception: app_name_lower = "application" # Fallback

    # Decide where to start the traversal
    current_obj = start_node # Default to the node passed in
    if hasattr(project, 'active_application'): # Only adjust if start_node was likely the project
        if app and path_parts[0].lower() == app_name_lower:
             print("DEBUG: Path starts with Application name '%s'. Beginning search there." % path_parts[0])
             current_obj = app
             path_parts = path_parts[1:] # Consume the app name part
             # If path was *only* the application name
             if not path_parts:
                 print("DEBUG: Target path is the Application object itself.")
                 return current_obj
        else:
            print("DEBUG: Path does not start with Application name. Starting search from project root.")
            current_obj = project # Start search from the project root
    else:
         print("DEBUG: Starting search from originally provided node.")


    # Traverse the remaining path parts
    parent_path_str = getattr(current_obj, 'get_name', lambda: str(current_obj))() # Safer name getting

    for i, part_name in enumerate(path_parts):
        is_last_part = (i == len(path_parts) - 1)
        print("DEBUG: Searching for part [%d/%d]: '%s' under '%s'" % (i+1, len(path_parts), part_name, parent_path_str))
        found_in_parent = None
        try:
            # Prioritize non-recursive find for direct children
            children_of_current = current_obj.get_children(False)
            print("DEBUG: Found %d direct children under '%s'." % (len(children_of_current), parent_path_str))
            for child in children_of_current:
                 child_name = getattr(child, 'get_name', lambda: None)() # Safer name getting
                 # print("DEBUG: Checking child: '%s'" % child_name) # Verbose
                 if child_name == part_name:
                     found_in_parent = child
                     print("DEBUG: Found direct child matching '%s'." % part_name)
                     break # Found direct child, stop searching children

            # If not found directly, AND it's the last part, try recursive find from current parent
            if not found_in_parent and is_last_part:
                 print("DEBUG: Direct find failed for last part '%s'. Trying recursive find under '%s'." % (part_name, parent_path_str))
                 found_recursive_list = current_obj.find(part_name, True) # Recursive find
                 if found_recursive_list:
                     # Maybe add a check here if multiple are found?
                     found_in_parent = found_recursive_list[0] # Take the first match
                     print("DEBUG: Found last part '%s' recursively." % part_name)
                 else:
                     print("DEBUG: Recursive find also failed for last part '%s'." % part_name)

            # Update current object if found
            if found_in_parent:
                current_obj = found_in_parent
                parent_path_str = getattr(current_obj, 'get_name', lambda: part_name)() # Safer name getting
                print("DEBUG: Stepped into '%s'." % parent_path_str)
            else:
                # If not found at any point, the path is invalid from this parent
                print("ERROR: Path part '%s' not found under '%s'." % (part_name, parent_path_str))
                return None # Path broken

        except Exception as find_err:
            print("ERROR: Exception while searching for '%s' under '%s': %s" % (part_name, parent_path_str, find_err))
            traceback.print_exc()
            return None # Error during search

    # Final verification (optional but recommended): Check if the found object's name matches the last part
    final_expected_name = full_path.split('/')[-1]
    found_final_name = getattr(current_obj, 'get_name', lambda: None)() # Safer name getting

    if found_final_name == final_expected_name:
        print("DEBUG: Final %s found and name verified for path '%s': %s" % (target_type_name, full_path, found_final_name))
        return current_obj
    else:
        print("ERROR: Traversal ended on object '%s' but expected final name was '%s'." % (found_final_name, final_expected_name))
        return None # Name mismatch implies target not found as expected

# --- End of find object function ---
`;

// (CREATE_POU_SCRIPT_TEMPLATE uses FIND_OBJECT_BY_PATH_PYTHON_SNIPPET)
const CREATE_POU_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
${FIND_OBJECT_BY_PATH_PYTHON_SNIPPET}
POU_NAME = "{POU_NAME}"; POU_TYPE_STR = "{POU_TYPE_STR}"; IMPL_LANGUAGE_STR = "{IMPL_LANGUAGE_STR}"; PARENT_PATH_REL = "{PARENT_PATH}"
pou_type_map = { "Program": script_engine.PouType.Program, "FunctionBlock": script_engine.PouType.FunctionBlock, "Function": script_engine.PouType.Function }
# Map common language names to ImplementationLanguages attributes if needed (optional, None usually works)
# lang_map = { "ST": script_engine.ImplementationLanguage.st, ... }

try:
    print("DEBUG: create_pou script: Name='%s', Type='%s', Lang='%s', ParentPath='%s', Project='%s'" % (POU_NAME, POU_TYPE_STR, IMPL_LANGUAGE_STR, PARENT_PATH_REL, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not POU_NAME: raise ValueError("POU name empty.")
    if not PARENT_PATH_REL: raise ValueError("Parent path empty.")

    # Resolve POU Type Enum
    pou_type_enum = pou_type_map.get(POU_TYPE_STR)
    if not pou_type_enum: raise ValueError("Invalid POU type string: %s. Use Program, FunctionBlock, or Function." % POU_TYPE_STR)

    # Find parent object using the robust function
    parent_object = find_object_by_path_robust(primary_project, PARENT_PATH_REL, "parent container")
    if not parent_object: raise ValueError("Parent object not found for path: %s" % PARENT_PATH_REL)

    parent_name = getattr(parent_object, 'get_name', lambda: str(parent_object))()
    print("DEBUG: Using parent object: %s (Type: %s)" % (parent_name, type(parent_object).__name__))

    # Check if parent object supports creating POUs (should implement ScriptIecLanguageObjectContainer)
    if not hasattr(parent_object, 'create_pou'):
        raise TypeError("Parent object '%s' of type %s does not support create_pou." % (parent_name, type(parent_object).__name__))

    # Set language GUID to None (let CODESYS default based on parent/settings)
    lang_guid = None
    print("DEBUG: Setting language to None (will use default).")
    # Example if mapping language string: lang_guid = lang_map.get(IMPL_LANGUAGE_STR, None)

    print("DEBUG: Calling parent_object.create_pou: Name='%s', Type=%s, Lang=%s" % (POU_NAME, pou_type_enum, lang_guid))

    # Call create_pou using keyword arguments
    new_pou = parent_object.create_pou(
        name=POU_NAME,
        type=pou_type_enum,
        language=lang_guid # Pass None
    )

    print("DEBUG: parent_object.create_pou returned: %s" % new_pou)
    if new_pou:
        new_pou_name = getattr(new_pou, 'get_name', lambda: POU_NAME)()
        print("DEBUG: POU object created: %s" % new_pou_name)

        # --- SAVE THE PROJECT TO PERSIST THE NEW POU ---
        try:
            print("DEBUG: Saving Project...")
            primary_project.save() # Save the overall project file
            print("DEBUG: Project saved successfully after POU creation.")
        except Exception as save_err:
            print("ERROR: Failed to save Project after POU creation: %s" % save_err)
            detailed_error = traceback.format_exc()
            error_message = "Error saving Project after creating POU '%s': %s\\n%s" % (new_pou_name, save_err, detailed_error)
            print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
        # --- END SAVING ---

        print("POU Created: %s" % new_pou_name); print("Type: %s" % POU_TYPE_STR); print("Language: %s (Defaulted)" % IMPL_LANGUAGE_STR); print("Parent Path: %s" % PARENT_PATH_REL)
        print("SCRIPT_SUCCESS: POU created successfully."); sys.exit(0)
    else:
        error_message = "Failed to create POU '%s'. create_pou returned None." % POU_NAME; print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error creating POU '%s' in project '%s': %s\\n%s" % (POU_NAME, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: Error creating POU '%s': %s" % (POU_NAME, e)); sys.exit(1)
`;

// (SET_POU_CODE_SCRIPT_TEMPLATE uses FIND_OBJECT_BY_PATH_PYTHON_SNIPPET)
const SET_POU_CODE_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
${FIND_OBJECT_BY_PATH_PYTHON_SNIPPET}
POU_FULL_PATH = "{POU_FULL_PATH}" # Expecting format like "Application/MyPOU" or "Folder/SubFolder/MyPOU"
DECLARATION_CONTENT = """{DECLARATION_CONTENT}"""
IMPLEMENTATION_CONTENT = """{IMPLEMENTATION_CONTENT}"""

try:
    print("DEBUG: set_pou_code script: POU_FULL_PATH='%s', Project='%s'" % (POU_FULL_PATH, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not POU_FULL_PATH: raise ValueError("POU full path empty.")

    # Find the target POU/Method/Property object
    target_object = find_object_by_path_robust(primary_project, POU_FULL_PATH, "target object")
    if not target_object: raise ValueError("Target object not found using path: %s" % POU_FULL_PATH)

    target_name = getattr(target_object, 'get_name', lambda: POU_FULL_PATH)()
    print("DEBUG: Found target object: %s" % target_name)

    # --- Set Declaration Part ---
    declaration_updated = False
    # Check if the content is actually provided (might be None/empty if only impl is set)
    has_declaration_content = 'DECLARATION_CONTENT' in locals() or 'DECLARATION_CONTENT' in globals()
    if has_declaration_content and DECLARATION_CONTENT is not None: # Check not None
        if hasattr(target_object, 'textual_declaration'):
            decl_obj = target_object.textual_declaration
            if decl_obj and hasattr(decl_obj, 'replace'):
                try:
                    print("DEBUG: Accessing textual_declaration...")
                    decl_obj.replace(DECLARATION_CONTENT)
                    print("DEBUG: Set declaration text using replace().")
                    declaration_updated = True
                except Exception as decl_err:
                    print("ERROR: Failed to set declaration text: %s" % decl_err)
                    traceback.print_exc() # Print stack trace for detailed error
            else:
                 print("WARN: Target '%s' textual_declaration attribute is None or does not have replace(). Skipping declaration update." % target_name)
        else:
            print("WARN: Target '%s' does not have textual_declaration attribute. Skipping declaration update." % target_name)
    else:
         print("DEBUG: Declaration content not provided or is None. Skipping declaration update.")


    # --- Set Implementation Part ---
    implementation_updated = False
    has_implementation_content = 'IMPLEMENTATION_CONTENT' in locals() or 'IMPLEMENTATION_CONTENT' in globals()
    if has_implementation_content and IMPLEMENTATION_CONTENT is not None: # Check not None
        if hasattr(target_object, 'textual_implementation'):
            impl_obj = target_object.textual_implementation
            if impl_obj and hasattr(impl_obj, 'replace'):
                try:
                    print("DEBUG: Accessing textual_implementation...")
                    impl_obj.replace(IMPLEMENTATION_CONTENT)
                    print("DEBUG: Set implementation text using replace().")
                    implementation_updated = True
                except Exception as impl_err:
                     print("ERROR: Failed to set implementation text: %s" % impl_err)
                     traceback.print_exc() # Print stack trace for detailed error
            else:
                 print("WARN: Target '%s' textual_implementation attribute is None or does not have replace(). Skipping implementation update." % target_name)
        else:
            print("WARN: Target '%s' does not have textual_implementation attribute. Skipping implementation update." % target_name)
    else:
        print("DEBUG: Implementation content not provided or is None. Skipping implementation update.")


    # --- SAVE THE PROJECT TO PERSIST THE CODE CHANGE ---
    # Only save if something was actually updated to avoid unnecessary saves
    if declaration_updated or implementation_updated:
        try:
            print("DEBUG: Saving Project (after code change)...")
            primary_project.save() # Save the overall project file
            print("DEBUG: Project saved successfully after code change.")
        except Exception as save_err:
            print("ERROR: Failed to save Project after setting code: %s" % save_err)
            detailed_error = traceback.format_exc()
            error_message = "Error saving Project after code change for '%s': %s\\n%s" % (target_name, save_err, detailed_error)
            print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
    else:
         print("DEBUG: No code parts were updated, skipping project save.")
    # --- END SAVING ---

    print("Code Set For: %s" % target_name)
    print("Path: %s" % POU_FULL_PATH)
    print("SCRIPT_SUCCESS: Declaration and/or implementation set successfully."); sys.exit(0)

except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error setting code for object '%s' in project '%s': %s\\n%s" % (POU_FULL_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;

// --- CREATE_PROPERTY_SCRIPT_TEMPLATE uses FIND_OBJECT_BY_PATH_PYTHON_SNIPPET ---
const CREATE_PROPERTY_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
${FIND_OBJECT_BY_PATH_PYTHON_SNIPPET}
PARENT_POU_FULL_PATH = "{PARENT_POU_FULL_PATH}" # e.g., "Application/MyFB"
PROPERTY_NAME = "{PROPERTY_NAME}"
PROPERTY_TYPE = "{PROPERTY_TYPE}"
# Optional: Language for Getter/Setter (usually defaults to ST)
# LANG_GUID_STR = "{LANG_GUID_STR}" # Example if needed

try:
    print("DEBUG: create_property script: ParentPOU='%s', Name='%s', Type='%s', Project='%s'" % (PARENT_POU_FULL_PATH, PROPERTY_NAME, PROPERTY_TYPE, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not PARENT_POU_FULL_PATH: raise ValueError("Parent POU full path empty.")
    if not PROPERTY_NAME: raise ValueError("Property name empty.")
    if not PROPERTY_TYPE: raise ValueError("Property type empty.")

    # Find the parent POU object
    parent_pou_object = find_object_by_path_robust(primary_project, PARENT_POU_FULL_PATH, "parent POU")
    if not parent_pou_object: raise ValueError("Parent POU object not found: %s" % PARENT_POU_FULL_PATH)

    parent_pou_name = getattr(parent_pou_object, 'get_name', lambda: PARENT_POU_FULL_PATH)()
    print("DEBUG: Found Parent POU object: %s" % parent_pou_name)

    # Check if parent object supports creating properties (should implement ScriptIecLanguageMemberContainer)
    if not hasattr(parent_pou_object, 'create_property'):
         raise TypeError("Parent object '%s' of type %s does not support create_property." % (parent_pou_name, type(parent_pou_object).__name__))

    # Default language to None (usually ST)
    lang_guid = None
    print("DEBUG: Calling create_property: Name='%s', Type='%s', Lang=%s" % (PROPERTY_NAME, PROPERTY_TYPE, lang_guid))

    # Call the create_property method ON THE PARENT POU
    new_property_object = parent_pou_object.create_property(
        name=PROPERTY_NAME,
        return_type=PROPERTY_TYPE,
        language=lang_guid # Pass None to use default
    )

    if new_property_object:
        new_prop_name = getattr(new_property_object, 'get_name', lambda: PROPERTY_NAME)()
        print("DEBUG: Property object created: %s" % new_prop_name)

        # --- SAVE THE PROJECT TO PERSIST THE NEW PROPERTY OBJECT ---
        try:
            print("DEBUG: Saving Project (after property creation)...")
            primary_project.save()
            print("DEBUG: Project saved successfully after property creation.")
        except Exception as save_err:
            print("ERROR: Failed to save Project after creating property: %s" % save_err)
            detailed_error = traceback.format_exc()
            error_message = "Error saving Project after creating property '%s': %s\\n%s" % (PROPERTY_NAME, save_err, detailed_error)
            print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
        # --- END SAVING ---

        print("Property Created: %s" % new_prop_name)
        print("Parent POU: %s" % PARENT_POU_FULL_PATH)
        print("Type: %s" % PROPERTY_TYPE)
        print("SCRIPT_SUCCESS: Property created successfully."); sys.exit(0)
    else:
         error_message = "Failed to create property '%s' under '%s'. create_property returned None." % (PROPERTY_NAME, parent_pou_name)
         print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)

except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error creating property '%s' under POU '%s' in project '%s': %s\\n%s" % (PROPERTY_NAME, PARENT_POU_FULL_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;

// --- CREATE_METHOD_SCRIPT_TEMPLATE uses FIND_OBJECT_BY_PATH_PYTHON_SNIPPET ---
const CREATE_METHOD_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
${FIND_OBJECT_BY_PATH_PYTHON_SNIPPET}
PARENT_POU_FULL_PATH = "{PARENT_POU_FULL_PATH}" # e.g., "Application/MyFB"
METHOD_NAME = "{METHOD_NAME}"
RETURN_TYPE = "{RETURN_TYPE}" # Can be empty string for no return type
# Optional: Language
# LANG_GUID_STR = "{LANG_GUID_STR}" # Example if needed

try:
    print("DEBUG: create_method script: ParentPOU='%s', Name='%s', ReturnType='%s', Project='%s'" % (PARENT_POU_FULL_PATH, METHOD_NAME, RETURN_TYPE, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not PARENT_POU_FULL_PATH: raise ValueError("Parent POU full path empty.")
    if not METHOD_NAME: raise ValueError("Method name empty.")
    # RETURN_TYPE can be empty

    # Find the parent POU object
    parent_pou_object = find_object_by_path_robust(primary_project, PARENT_POU_FULL_PATH, "parent POU")
    if not parent_pou_object: raise ValueError("Parent POU object not found: %s" % PARENT_POU_FULL_PATH)

    parent_pou_name = getattr(parent_pou_object, 'get_name', lambda: PARENT_POU_FULL_PATH)()
    print("DEBUG: Found Parent POU object: %s" % parent_pou_name)

     # Check if parent object supports creating methods (should implement ScriptIecLanguageMemberContainer)
    if not hasattr(parent_pou_object, 'create_method'):
         raise TypeError("Parent object '%s' of type %s does not support create_method." % (parent_pou_name, type(parent_pou_object).__name__))

    # Default language to None (usually ST)
    lang_guid = None
    # Use None if RETURN_TYPE is empty string, otherwise use the string
    actual_return_type = RETURN_TYPE if RETURN_TYPE else None
    print("DEBUG: Calling create_method: Name='%s', ReturnType=%s, Lang=%s" % (METHOD_NAME, actual_return_type, lang_guid))

    # Call the create_method method ON THE PARENT POU
    new_method_object = parent_pou_object.create_method(
        name=METHOD_NAME,
        return_type=actual_return_type,
        language=lang_guid # Pass None to use default
    )

    if new_method_object:
        new_meth_name = getattr(new_method_object, 'get_name', lambda: METHOD_NAME)()
        print("DEBUG: Method object created: %s" % new_meth_name)

        # --- SAVE THE PROJECT TO PERSIST THE NEW METHOD OBJECT ---
        try:
            print("DEBUG: Saving Project (after method creation)...")
            primary_project.save()
            print("DEBUG: Project saved successfully after method creation.")
        except Exception as save_err:
            print("ERROR: Failed to save Project after creating method: %s" % save_err)
            detailed_error = traceback.format_exc()
            error_message = "Error saving Project after creating method '%s': %s\\n%s" % (METHOD_NAME, save_err, detailed_error)
            print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
        # --- END SAVING ---

        print("Method Created: %s" % new_meth_name)
        print("Parent POU: %s" % PARENT_POU_FULL_PATH)
        print("Return Type: %s" % (RETURN_TYPE if RETURN_TYPE else "(None)"))
        print("SCRIPT_SUCCESS: Method created successfully."); sys.exit(0)
    else:
         error_message = "Failed to create method '%s' under '%s'. create_method returned None." % (METHOD_NAME, parent_pou_name)
         print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)

except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error creating method '%s' under POU '%s' in project '%s': %s\\n%s" % (METHOD_NAME, PARENT_POU_FULL_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;


// (COMPILE_PROJECT_SCRIPT_TEMPLATE remains the same)
const COMPILE_PROJECT_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
try:
    print("DEBUG: compile_project script: Project='%s'" % PROJECT_FILE_PATH)
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    project_name = os.path.basename(PROJECT_FILE_PATH)
    target_app = None
    app_name = "N/A"

    # Try getting active application first
    try:
        target_app = primary_project.active_application
        if target_app:
            app_name = getattr(target_app, 'get_name', lambda: "Unnamed App (Active)")()
            print("DEBUG: Found active application: %s" % app_name)
    except Exception as active_err:
        print("WARN: Could not get active application: %s. Searching..." % active_err)

    # If no active app, search for the first one
    if not target_app:
        print("DEBUG: Searching for first compilable application...")
        apps = []
        try:
             # Search recursively through all project objects
             all_children = primary_project.get_children(True)
             for child in all_children:
                  # Check using the marker property and if build method exists
                  if hasattr(child, 'is_application') and child.is_application and hasattr(child, 'build'):
                       app_name_found = getattr(child, 'get_name', lambda: "Unnamed App")()
                       print("DEBUG: Found potential application object: %s" % app_name_found)
                       apps.append(child)
                       break # Take the first one found
        except Exception as find_err: print("WARN: Error finding application object: %s" % find_err)

        if not apps: raise RuntimeError("No compilable application found in project '%s'" % project_name)
        target_app = apps[0]
        app_name = getattr(target_app, 'get_name', lambda: "Unnamed App (First Found)")()
        print("WARN: Compiling first found application: %s" % app_name)

    print("DEBUG: Calling build() on app '%s'..." % app_name)
    if not hasattr(target_app, 'build'):
         raise TypeError("Selected object '%s' is not an application or doesn't support build()." % app_name)

    # Execute the build
    target_app.build();
    print("DEBUG: Build command executed for application '%s'." % app_name)

    # Check messages is harder without direct access to message store from script.
    # Rely on CODESYS UI or log output for now.
    print("Compile Initiated For Application: %s" % app_name); print("In Project: %s" % project_name)
    print("SCRIPT_SUCCESS: Application compilation initiated."); sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error initiating compilation for project %s: %s\\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;

// (GET_PROJECT_STRUCTURE_SCRIPT_TEMPLATE remains the same)
const GET_PROJECT_STRUCTURE_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
# FIND_OBJECT_BY_PATH_PYTHON_SNIPPET is NOT needed here, we start from project root.

def get_object_structure(obj, indent=0, max_depth=10): # Add max_depth
    lines = []; indent_str = "  " * indent
    if indent > max_depth:
        lines.append("%s- Max recursion depth reached." % indent_str)
        return lines
    try:
        name = "Unnamed"; obj_type = type(obj).__name__
        guid_str = ""
        folder_str = ""
        try:
            name = getattr(obj, 'get_name', lambda: "Unnamed")() or "Unnamed" # Safer get_name
            if hasattr(obj, 'guid'): guid_str = " {%s}" % obj.guid
            if hasattr(obj, 'is_folder') and obj.is_folder: folder_str = " [Folder]"
        except Exception as name_err:
             print("WARN: Error getting name/guid/folder status for an object: %s" % name_err)
             name = "!!! Error Getting Name !!!"

        lines.append("%s- %s (%s)%s%s" % (indent_str, name, obj_type, folder_str, guid_str))

        # Get children only if the object potentially has them
        children = []
        can_have_children = hasattr(obj, 'get_children') and (
            not hasattr(obj, 'is_folder') or # If it's not clear if it's a folder (e.g., project root)
            (hasattr(obj, 'is_folder') and obj.is_folder) or # If it is a folder
             # Add known container types explicitly, check marker interfaces too
             hasattr(obj, 'is_project') or hasattr(obj, 'is_application') or hasattr(obj, 'is_device') or hasattr(obj,'is_pou')
        )

        if can_have_children:
            try:
                children = obj.get_children(False)
                # print("DEBUG: %s has %d children" % (name, len(children))) # Verbose
            except Exception as get_child_err:
                lines.append("%s  ERROR getting children: %s" % (indent_str, get_child_err))
                # traceback.print_exc() # Optional

        for child in children:
            lines.extend(get_object_structure(child, indent + 1, max_depth)) # Recurse

    except Exception as e:
        lines.append("%s- Error processing node: %s" % (indent_str, e))
        traceback.print_exc() # Print detailed error for this node
    return lines
try:
    print("DEBUG: Getting structure for: %s" % PROJECT_FILE_PATH)
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    project_name = os.path.basename(PROJECT_FILE_PATH)
    print("DEBUG: Getting structure for project: %s" % project_name)
    # Use the project object obtained from ensure_project_open
    structure_list = get_object_structure(primary_project, max_depth=15) # Set a reasonable depth
    structure_output = "\\n".join(structure_list)
    # Ensure markers are printed distinctly
    print("\\n--- PROJECT STRUCTURE START ---")
    print(structure_output)
    print("--- PROJECT STRUCTURE END ---\\n")
    print("SCRIPT_SUCCESS: Project structure retrieved."); sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error getting structure for %s: %s\\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;

// (GET_POU_CODE_SCRIPT_TEMPLATE uses FIND_OBJECT_BY_PATH_PYTHON_SNIPPET)
const GET_POU_CODE_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
${FIND_OBJECT_BY_PATH_PYTHON_SNIPPET}
POU_FULL_PATH = "{POU_FULL_PATH}"; CODE_START_MARKER = "### POU CODE START ###"; CODE_END_MARKER = "### POU CODE END ###"
DECL_START_MARKER = "### POU DECLARATION START ###"; DECL_END_MARKER = "### POU DECLARATION END ###"
IMPL_START_MARKER = "### POU IMPLEMENTATION START ###"; IMPL_END_MARKER = "### POU IMPLEMENTATION END ###"

try:
    print("DEBUG: Getting code: POU_FULL_PATH='%s', Project='%s'" % (POU_FULL_PATH, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not POU_FULL_PATH: raise ValueError("POU full path empty.")

    # Find the target POU/Method/Property object
    target_object = find_object_by_path_robust(primary_project, POU_FULL_PATH, "target object")
    if not target_object: raise ValueError("Target object not found using path: %s" % POU_FULL_PATH)

    target_name = getattr(target_object, 'get_name', lambda: POU_FULL_PATH)()
    print("DEBUG: Found target object: %s" % target_name)

    declaration_code = ""; implementation_code = ""

    # --- Get Declaration Part ---
    if hasattr(target_object, 'textual_declaration'):
        decl_obj = target_object.textual_declaration
        if decl_obj and hasattr(decl_obj, 'text'):
            try:
                declaration_code = decl_obj.text
                print("DEBUG: Got declaration text.")
            except Exception as decl_read_err:
                print("ERROR: Failed to read declaration text: %s" % decl_read_err)
                declaration_code = "/* ERROR reading declaration: %s */" % decl_read_err
        else:
            print("WARN: textual_declaration exists but is None or has no 'text' attribute.")
    else:
        print("WARN: No textual_declaration attribute.")

    # --- Get Implementation Part ---
    if hasattr(target_object, 'textual_implementation'):
        impl_obj = target_object.textual_implementation
        if impl_obj and hasattr(impl_obj, 'text'):
            try:
                implementation_code = impl_obj.text
                print("DEBUG: Got implementation text.")
            except Exception as impl_read_err:
                print("ERROR: Failed to read implementation text: %s" % impl_read_err)
                implementation_code = "/* ERROR reading implementation: %s */" % impl_read_err
        else:
            print("WARN: textual_implementation exists but is None or has no 'text' attribute.")
    else:
        print("WARN: No textual_implementation attribute.")


    print("Code retrieved for: %s" % target_name)
    # Print declaration between markers, ensuring markers are on separate lines
    print("\\n" + DECL_START_MARKER)
    print(declaration_code)
    print(DECL_END_MARKER + "\\n")
    # Print implementation between markers
    print(IMPL_START_MARKER)
    print(implementation_code)
    print(IMPL_END_MARKER + "\\n")

    # --- LEGACY MARKERS for backward compatibility if needed ---
    # Combine both for old marker format, adding a separator line
    # legacy_combined_code = declaration_code + "\\n\\n// Implementation\\n" + implementation_code
    # print(CODE_START_MARKER); print(legacy_combined_code); print(CODE_END_MARKER)
    # --- END LEGACY ---

    print("SCRIPT_SUCCESS: Code retrieved."); sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error getting code for object '%s' in project '%s': %s\\n%s" % (POU_FULL_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;


// --- MCP Resources ---
// (Resource definitions remain the same)
server.resource("project-status", "codesys://project/status", async (uri) => {
    console.error(`Resource request: ${uri.href}`);
    try {
        const result = await executeCodesysScript(CHECK_STATUS_SCRIPT, codesysExePath, codesysProfileName);
        const outputLines = result.output.split(/[\r\n]+/).filter(line => line.trim()); const statusData: { [key: string]: string } = {};
        outputLines.forEach(line => { const match = line.match(/^([^:]+):\s*(.*)$/); if (match) { statusData[match[1].trim()] = match[2].trim(); }});
        const statusText = `CODESYS Status:\n - Scripting OK: ${statusData['Scripting OK'] ?? 'Unknown'}\n - Project Open: ${statusData['Project Open'] ?? 'Unknown'}\n - Project Name: ${statusData['Project Name'] ?? 'Unknown'}\n - Project Path: ${statusData['Project Path'] ?? 'N/A'}`;
        // Determine error status based on script success AND scripting OK status
        const isError = !result.success || statusData['Scripting OK']?.toLowerCase() !== 'true';
        return { contents: [{ uri: uri.href, text: statusText, contentType: "text/plain" }], isError: isError };
    } catch (error: any) { console.error(`Error resource ${uri.href}:`, error); return { contents: [{ uri: uri.href, text: `Failed status script: ${error.message}`, contentType: "text/plain" }], isError: true }; }
});

const projectStructureTemplate = new ResourceTemplate("codesys://project/{+project_path}/structure", { list: undefined });
server.resource("project-structure", projectStructureTemplate, async (uri, params) => {
    const projectPathParam = params.project_path;
    if (typeof projectPathParam !== 'string') { return { contents: [{ uri: uri.href, text: `Error: Invalid project path type (${typeof projectPathParam}).`, contentType: "text/plain" }], isError: true }; }
    const projectPath: string = projectPathParam; if (!projectPath) { return { contents: [{ uri: uri.href, text: "Error: Project path missing.", contentType: "text/plain" }], isError: true }; }
    console.error(`Resource request: project structure for ${projectPath}`);
    try {
        const absoluteProjPath = path.normalize(path.isAbsolute(projectPath) ? projectPath : path.join(WORKSPACE_DIR, projectPath));
        // No need to check file existence here, ensure_project_open will handle it
        // if (!(await fileExists(absoluteProjPath))) { return { contents: [{ uri: uri.href, text: `Error: Project file not found: ${absoluteProjPath}`, contentType: "text/plain" }], isError: true }; }
        const escapedPathForPython = absoluteProjPath.replace(/\\/g, '\\\\'); const scriptContent = GET_PROJECT_STRUCTURE_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escapedPathForPython);
        const result = await executeCodesysScript(scriptContent, codesysExePath, codesysProfileName);
        let structureText = `Error retrieving structure for ${absoluteProjPath}.\n\n${result.output}`; let isError = !result.success;
        if (result.success && result.output.includes("SCRIPT_SUCCESS")) {
            const startMarker = "--- PROJECT STRUCTURE START ---"; const endMarker = "--- PROJECT STRUCTURE END ---";
            const startIndex = result.output.indexOf(startMarker); const endIndex = result.output.indexOf(endMarker);
            if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
                 // Extract text between markers, replace escaped newlines, trim whitespace
                 structureText = result.output.substring(startIndex + startMarker.length, endIndex).replace(/\\n/g, '\n').trim();
             } else {
                console.error("Error: Could not find structure markers in script output.");
                structureText = `Could not parse structure markers in output for ${absoluteProjPath}.\n\nOutput:\n${result.output}`;
                isError = true;
            }
        } else { isError = true; } // Explicitly set error if script failed
        return { contents: [{ uri: uri.href, text: structureText, contentType: "text/plain" }], isError: isError };
    } catch (error: any) { console.error(`Error getting structure ${uri.href}:`, error); return { contents: [{ uri: uri.href, text: `Failed structure script for '${projectPath}': ${error.message}`, contentType: "text/plain" }], isError: true }; }
});

const pouCodeTemplate = new ResourceTemplate("codesys://project/{+project_path}/pou/{+pou_path}/code", { list: undefined });
server.resource("pou-code", pouCodeTemplate, async (uri, params) => {
    const projectPathParam = params.project_path; const pouPathParam = params.pou_path;
    if (typeof projectPathParam !== 'string' || typeof pouPathParam !== 'string') { return { contents: [{ uri: uri.href, text: "Error: Invalid project or POU path type.", contentType: "text/plain" }], isError: true }; }
    const projectPath: string = projectPathParam; const pouPath: string = pouPathParam; if (!projectPath || !pouPath) { return { contents: [{ uri: uri.href, text: "Error: Project or POU path missing.", contentType: "text/plain" }], isError: true }; }
    console.error(`Resource request: POU code: Project='${projectPath}', POU='${pouPath}'`);
    try {
        const absoluteProjPath = path.normalize(path.isAbsolute(projectPath) ? projectPath : path.join(WORKSPACE_DIR, projectPath));
        const sanitizedPouPath = String(pouPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); // Normalize slashes, remove leading/trailing
        // No need to check file existence here, ensure_project_open handles it
        // if (!(await fileExists(absoluteProjPath))) { return { contents: [{ uri: uri.href, text: `Error: Project file not found: ${absoluteProjPath}`, contentType: "text/plain" }], isError: true }; }
        const escapedProjPath = absoluteProjPath.replace(/\\/g, '\\\\');
        let scriptContent = GET_POU_CODE_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escapedProjPath);
        scriptContent = scriptContent.replace("{POU_FULL_PATH}", sanitizedPouPath); // Use normalized POU path
        const result = await executeCodesysScript(scriptContent, codesysExePath, codesysProfileName);
        let codeText = `Error retrieving code for object '${sanitizedPouPath}' in project '${absoluteProjPath}'.\n\n${result.output}`; let isError = !result.success;
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
             // Combine them for the output (adjust format as needed)
             codeText = `// ----- Declaration -----\n${declaration}\n\n// ----- Implementation -----\n${implementation}`;
        } else { isError = true; }
        return { contents: [{ uri: uri.href, text: codeText, contentType: "text/plain" }], isError: isError };
    } catch (error: any) { console.error(`Error getting POU code ${uri.href}:`, error); return { contents: [{ uri: uri.href, text: `Failed POU code script for '${pouPath}' in '${projectPath}': ${error.message}`, contentType: "text/plain" }], isError: true }; }
});


// --- MCP Tools ---

server.tool("open_project", { filePath: z.string().describe("Path to the project file.") }, async (args) => {
    const { filePath } = args; let absPath = path.normalize(path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE_DIR, filePath));
    console.error(`Tool call: open_project: ${absPath}`);
    // File existence check is now handled by ensure_project_open within the script
    // if (!(await fileExists(absPath))) { return { content: [{ type: "text", text: `Error: File not found: ${absPath}` }], isError: true }; }
    try {
        const escapedPath = absPath.replace(/\\/g, '\\\\'); const script = OPEN_PROJECT_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escapedPath);
        const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
        const success = result.success && result.output.includes("SCRIPT_SUCCESS");
        return { content: [{ type: "text", text: success ? `Project opened: ${absPath}` : `Failed open project ${absPath}. Output:\n${result.output}` }], isError: !success };
    } catch (e: any) { console.error(`Error open_project ${absPath}: ${e}`); return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

server.tool("create_project", { filePath: z.string().describe("Path for new project.") }, async (args) => {
    const { filePath } = args; let absPath = path.normalize(path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE_DIR, filePath));
    console.error(`Tool call: create_project (copy template): ${absPath}`);
    let templatePath = "";
    try {
        // Prioritize relative path first, as it's more common with portable installs
        const baseDir = path.dirname(path.dirname(codesysExePath)); // Go up two levels from CODESYS.exe
        templatePath = path.normalize(path.join(baseDir, 'Templates', 'Standard.project'));
         if (await fileExists(templatePath)) {
             console.error(`DEBUG: Found template relative to exe: ${templatePath}`);
         } else {
            // Fallback to ProgramData
            console.error(`WARN: Template not found relative to exe: ${templatePath}. Trying ProgramData...`);
            const programData = process.env.ALLUSERSPROFILE || process.env.ProgramData || 'C:\\ProgramData';
            // Construct path carefully, might vary slightly between versions/installers
            const possibleTemplateDir = path.join(programData, 'CODESYS', 'CODESYS', codesysProfileName, 'Templates'); // Common pattern
            let potentialTemplatePath = path.normalize(path.join(possibleTemplateDir, 'Standard.project'));
            if (await fileExists(potentialTemplatePath)) {
                templatePath = potentialTemplatePath;
                console.error(`DEBUG: Found template in ProgramData: ${templatePath}`);
            } else {
                // Try another common pattern without the profile name subdir under the second CODESYS
                 const alternativeTemplateDir = path.join(programData, 'CODESYS', 'Templates');
                 potentialTemplatePath = path.normalize(path.join(alternativeTemplateDir, 'Standard.project'));
                 if (await fileExists(potentialTemplatePath)) {
                     templatePath = potentialTemplatePath;
                     console.error(`DEBUG: Found template in ProgramData (alternative): ${templatePath}`);
                 } else {
                    throw new Error(`Standard template project file not found at relative path or ProgramData locations.`);
                 }
            }
         }
    } catch (e:any) { console.error(`Template Error: ${e.message}`); return { content: [{ type: "text", text: `Template Error: ${e.message}` }], isError: true }; }
    try {
        const escProjPath = absPath.replace(/\\/g, '\\\\'); const escTmplPath = templatePath.replace(/\\/g, '\\\\');
        const script = CREATE_PROJECT_SCRIPT_TEMPLATE
            .replace("{PROJECT_FILE_PATH}", escProjPath)
            .replace("{TEMPLATE_PROJECT_PATH}", escTmplPath);
        console.error(">>> create_project (copy-then-open): PREPARED SCRIPT:", script.substring(0, 500) + "..."); // Log start of script
        const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
        console.error(">>> create_project (copy-then-open): EXECUTION RESULT:", JSON.stringify(result));
        const success = result.success && result.output.includes("SCRIPT_SUCCESS");
        return { content: [{ type: "text", text: success ? `Project created from template: ${absPath}` : `Failed create project ${absPath} from template. Output:\n${result.output}` }], isError: !success };
    } catch (e: any) { console.error(`Error create_project ${absPath}: ${e}`); return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

server.tool("save_project", { projectFilePath: z.string().describe("Path to project.") }, async (args) => {
    const { projectFilePath } = args; let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
    console.error(`Tool call: save_project: ${absPath}`);
    // No need to check file existence here, ensure_project_open handles it
    // if (!(await fileExists(absPath))) { return { content: [{ type: "text", text: `Error: File not found: ${absPath}` }], isError: true }; }
     try {
        const escapedPath = absPath.replace(/\\/g, '\\\\'); const script = SAVE_PROJECT_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escapedPath);
        const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
        const success = result.success && result.output.includes("SCRIPT_SUCCESS");
        return { content: [{ type: "text", text: success ? `Project saved: ${absPath}` : `Failed save project ${absPath}. Output:\n${result.output}` }], isError: !success };
     } catch (e:any) { console.error(`Error save_project ${absPath}: ${e}`); return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
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
    const sanParentPath = parentPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); // Normalize parent path slashes
    const sanName = name.trim(); // Trim whitespace from name

    console.error(`Tool call: create_pou: Name='${sanName}', Type='${type}', Lang='${language}', Parent='${sanParentPath}', Project='${absPath}'`);
    // No need for file exists check here
    // if (!(await fileExists(absPath))) { return { content: [{ type: "text", text: `Error: File not found: ${absPath}` }], isError: true }; }
     try {
        const escProjPath = absPath.replace(/\\/g, '\\\\');
        // Use the fixed CREATE_POU_SCRIPT_TEMPLATE
        let script = CREATE_POU_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProjPath);
        script = script.replace("{POU_NAME}", sanName);
        script = script.replace("{POU_TYPE_STR}", type); // Pass the enum string directly
        script = script.replace("{IMPL_LANGUAGE_STR}", language); // Pass language string
        script = script.replace("{PARENT_PATH}", sanParentPath); // Use normalized path

        console.error(">>> create_pou: PREPARED SCRIPT:", script.substring(0,500)+"...");
        const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
        console.error(">>> create_pou: EXECUTION RESULT:", JSON.stringify(result));
        const success = result.success && result.output.includes("SCRIPT_SUCCESS");
        return { content: [{ type: "text", text: success ? `POU '${sanName}' created in '${sanParentPath}' of ${absPath}. Project saved.` : `Failed create POU '${sanName}'. Output:\n${result.output}` }], isError: !success };
     } catch (e:any) { console.error(`Error create_pou ${sanName} in ${absPath}: ${e}`); return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

// **TOOL: set_pou_code**
server.tool("set_pou_code", {
    projectFilePath: z.string().describe("Path to project."),
    pouPath: z.string().describe("Relative POU/Method/Property path (e.g., 'Application/MyPOU' or 'MyFolder/MyFB/MyMethod')."),
    declarationCode: z.string().describe("Code for the declaration part (VAR...END_VAR).").optional(),
    implementationCode: z.string().describe("Code for the implementation logic part.").optional()
}, async (args) => {
    const { projectFilePath, pouPath, declarationCode, implementationCode } = args;

    // Basic validation: ensure at least one code part is provided
    if (declarationCode === undefined && implementationCode === undefined) {
        return { content: [{ type: "text", text: "Error: At least one of declarationCode or implementationCode must be provided." }], isError: true };
    }

    let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
    const sanPouPath = pouPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); // Normalize POU path slashes
    console.error(`Tool call: set_pou_code: Target='${sanPouPath}', Project='${absPath}'`);

    // No need for file exists check here
    // if (!(await fileExists(absPath))) { return { content: [{ type: "text", text: `Error: File not found: ${absPath}` }], isError: true }; }

     try {
        const escProjPath = absPath.replace(/\\/g, '\\\\');

        // Escape content for Python triple-quoted strings
        // Provide empty string if undefined, then escape
        const sanDeclCode = (declarationCode ?? "").replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
        const sanImplCode = (implementationCode ?? "").replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');

        // Use the SET_POU_CODE_SCRIPT_TEMPLATE
        let script = SET_POU_CODE_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProjPath);
        script = script.replace("{POU_FULL_PATH}", sanPouPath);
        script = script.replace("{DECLARATION_CONTENT}", sanDeclCode);
        script = script.replace("{IMPLEMENTATION_CONTENT}", sanImplCode);

        console.error(">>> set_pou_code: PREPARED SCRIPT:", script.substring(0, 500) + "...");
        const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
        console.error(">>> set_pou_code: EXECUTION RESULT:", JSON.stringify(result));

        const success = result.success && result.output.includes("SCRIPT_SUCCESS");
        return { content: [{ type: "text", text: success ? `Code set for '${sanPouPath}' in ${absPath}. Project saved.` : `Failed set code for '${sanPouPath}'. Output:\n${result.output}` }], isError: !success };
     } catch (e:any) { console.error(`Error set_pou_code ${sanPouPath} in ${absPath}: ${e}`); return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

// **NEW TOOL: create_property**
server.tool("create_property", {
    projectFilePath: z.string().describe("Path to the project file."),
    parentPouPath: z.string().describe("Relative path to the parent POU (e.g., 'Application/MyFB')."),
    propertyName: z.string().describe("Name of the new property."),
    propertyType: z.string().describe("Data type of the property (e.g., 'BOOL', 'INT', 'MyDUT').")
    // language: z.string().optional().describe("Implementation language for Getter/Setter (e.g., 'ST'). Defaults to project default.") // Optional
}, async (args) => {
    const { projectFilePath, parentPouPath, propertyName, propertyType } = args;
    let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
    const sanParentPath = parentPouPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const sanPropName = propertyName.trim();
    const sanPropType = propertyType.trim();

    console.error(`Tool call: create_property: Name='${sanPropName}', Type='${sanPropType}', ParentPOU='${sanParentPath}', Project='${absPath}'`);

    // No file exists check needed here
    if (!sanPropName || !sanPropType) {
        return { content: [{ type: "text", text: `Error: Property name and type cannot be empty.` }], isError: true };
    }

    try {
        const escProjPath = absPath.replace(/\\/g, '\\\\');
        let script = CREATE_PROPERTY_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProjPath);
        script = script.replace("{PARENT_POU_FULL_PATH}", sanParentPath);
        script = script.replace("{PROPERTY_NAME}", sanPropName);
        script = script.replace("{PROPERTY_TYPE}", sanPropType);
        // Add language replacement here if you implement the optional language argument

        console.error(">>> create_property: PREPARED SCRIPT:", script.substring(0, 500) + "...");
        const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
        console.error(">>> create_property: EXECUTION RESULT:", JSON.stringify(result));

        const success = result.success && result.output.includes("SCRIPT_SUCCESS");
        return {
            content: [{ type: "text", text: success ? `Property '${sanPropName}' created under '${sanParentPath}' in ${absPath}. Project saved.` : `Failed to create property '${sanPropName}'. Output:\n${result.output}` }],
            isError: !success
        };
    } catch (e: any) {
        console.error(`Error create_property ${sanPropName} in ${absPath}: ${e}`);
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});

// **NEW TOOL: create_method**
server.tool("create_method", {
    projectFilePath: z.string().describe("Path to the project file."),
    parentPouPath: z.string().describe("Relative path to the parent POU (e.g., 'Application/MyFB')."),
    methodName: z.string().describe("Name of the new method."),
    returnType: z.string().optional().describe("Return type (e.g., 'BOOL', 'INT'). Leave empty or omit for no return value."),
    // language: z.string().optional().describe("Implementation language (e.g., 'ST'). Defaults to project default.") // Optional
}, async (args) => {
    const { projectFilePath, parentPouPath, methodName, returnType } = args;
    let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
    const sanParentPath = parentPouPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const sanMethName = methodName.trim();
    const sanReturnType = (returnType ?? "").trim(); // Use empty string if undefined/null

    console.error(`Tool call: create_method: Name='${sanMethName}', Return='${sanReturnType}', ParentPOU='${sanParentPath}', Project='${absPath}'`);

    // No file exists check needed here
     if (!sanMethName) {
        return { content: [{ type: "text", text: `Error: Method name cannot be empty.` }], isError: true };
    }

    try {
        const escProjPath = absPath.replace(/\\/g, '\\\\');
        let script = CREATE_METHOD_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProjPath);
        script = script.replace("{PARENT_POU_FULL_PATH}", sanParentPath);
        script = script.replace("{METHOD_NAME}", sanMethName);
        script = script.replace("{RETURN_TYPE}", sanReturnType); // Pass empty string if no return type
        // Add language replacement here if needed

        console.error(">>> create_method: PREPARED SCRIPT:", script.substring(0, 500) + "...");
        const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
        console.error(">>> create_method: EXECUTION RESULT:", JSON.stringify(result));

        const success = result.success && result.output.includes("SCRIPT_SUCCESS");
        return {
            content: [{ type: "text", text: success ? `Method '${sanMethName}' created under '${sanParentPath}' in ${absPath}. Project saved.` : `Failed to create method '${sanMethName}'. Output:\n${result.output}` }],
            isError: !success
        };
    } catch (e: any) {
        console.error(`Error create_method ${sanMethName} in ${absPath}: ${e}`);
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});

// (compile_project tool remains the same)
server.tool("compile_project", { projectFilePath: z.string().describe("Path to project.") }, async (args) => {
    const { projectFilePath } = args;
    let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
    console.error(`Tool call: compile_project: ${absPath}`);
     // No file exists check needed here
    // if (!(await fileExists(absPath))) { return { content: [{ type: "text", text: `Error: File not found: ${absPath}` }], isError: true }; }
    try {
        const escapedPath = absPath.replace(/\\/g, '\\\\');
        const script = COMPILE_PROJECT_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escapedPath);
        const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
        const success = result.success && result.output.includes("SCRIPT_SUCCESS");
        // Add check for compile errors in output if possible/needed
        // Regex might be more robust if format is consistent
        const hasCompileErrors = result.output.includes("Compile complete --") && !/ 0 error\(s\),/.test(result.output);
        let message = success ? `Compilation initiated for application in ${absPath}. Check CODESYS messages for results.` : `Failed initiating compilation for ${absPath}. Output:\n${result.output}`;
        if (success && hasCompileErrors) {
            message += " WARNING: Build command reported errors in the output log.";
            console.warn("Compile project reported build errors in the output.");
            // Optionally set isError = true here if compile errors should fail the tool call
            // return { content: [{ type: "text", text: message }], isError: true };
        }
        return { content: [{ type: "text", text: message }], isError: !success };
     } catch (e:any) { console.error(`Error compile_project ${absPath}: ${e}`); return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});


// --- Server Connection & Start ---
async function startServer() {
    try {
        const transport = new StdioServerTransport();
        console.error("Connecting MCP server via stdio...");
        await server.connect(transport);
        console.error("MCP Server connected and listening.");
    } catch (error) {
        console.error("FATAL: Failed to start MCP server:", error);
        process.exit(1);
    }
}

// Ensure startup happens only once if run directly
if (require.main === module) {
    startServer();
}

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
    console.error('\nSIGINT received, shutting down...');
    // No server.disconnect() needed for stdio
    process.exit(0); // Exit the process, closing stdio streams
});
process.on('SIGTERM', () => {
    console.error('\nSIGTERM received, shutting down...');
    // No server.disconnect() needed for stdio
    process.exit(0); // Exit the process, closing stdio streams
});

// Optional: Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Application specific logging, throwing an error, or other logic here
});