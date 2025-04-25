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
        print("SCRIPT_SUCCESS: Property created successfully.")
        sys.exit(0)
    else:
         error_message = "Failed to create property '%s' under '%s'. create_property returned None." % (PROPERTY_NAME, parent_pou_name)
         print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)

except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error creating property '%s' under POU '%s' in project '%s': %s\\n%s" % (PROPERTY_NAME, PARENT_POU_FULL_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)