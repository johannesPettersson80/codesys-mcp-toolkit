import sys, scriptengine as script_engine, os, traceback

# Import ensure_project_open function from the template
# This will be prepended by the script loader
def ensure_project_open(target_project_path):
    # Function implementation will be included from ensure_project_open.py
    pass

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
    print("Compile Initiated For Application: %s" % app_name)
    print("In Project: %s" % project_name)
    print("SCRIPT_SUCCESS: Application compilation initiated.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error initiating compilation for project %s: %s\\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)