import sys, scriptengine as script_engine, os, traceback

# Import ensure_project_open function from the template
# This will be prepended by the script loader
def ensure_project_open(target_project_path):
    # Function implementation will be included from ensure_project_open.py
    pass

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
    print("SCRIPT_SUCCESS: Project structure retrieved.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error getting structure for %s: %s\\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)