import sys, scriptengine as script_engine, os, traceback

# Import ensure_project_open function from the template
# This will be prepended by the script loader
def ensure_project_open(target_project_path):
    # Function implementation will be included from ensure_project_open.py
    pass

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