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