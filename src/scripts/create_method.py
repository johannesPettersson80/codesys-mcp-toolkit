import sys, scriptengine as script_engine, os, traceback

# Import ensure_project_open function from the template
# This will be prepended by the script loader
def ensure_project_open(target_project_path):
    # Function implementation will be included from ensure_project_open.py
    pass

# Import find_object_by_path function from the template
# This will be prepended by the script loader
def find_object_by_path_robust(start_node, full_path, target_type_name="object"):
    # Function implementation will be included from find_object_by_path.py
    pass

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
        print("SCRIPT_SUCCESS: Method created successfully.")
        sys.exit(0)
    else:
         error_message = "Failed to create method '%s' under '%s'. create_method returned None." % (METHOD_NAME, parent_pou_name)
         print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)

except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error creating method '%s' under POU '%s' in project '%s': %s\\n%s" % (METHOD_NAME, PARENT_POU_FULL_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)