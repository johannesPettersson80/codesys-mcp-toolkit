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