import sys, scriptengine as script_engine, os, traceback

# Import ensure_project_open function from the template
# This will be prepended by the script loader
def ensure_project_open(target_project_path):
    # Function implementation will be included from ensure_project_open.py
    pass

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