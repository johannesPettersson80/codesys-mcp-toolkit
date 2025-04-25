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