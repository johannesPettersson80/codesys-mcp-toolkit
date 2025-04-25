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

POU_NAME = "{POU_NAME}"
POU_TYPE_STR = "{POU_TYPE_STR}" 
IMPL_LANGUAGE_STR = "{IMPL_LANGUAGE_STR}"
PARENT_PATH_REL = "{PARENT_PATH}"

pou_type_map = { 
    "Program": script_engine.PouType.Program, 
    "FunctionBlock": script_engine.PouType.FunctionBlock, 
    "Function": script_engine.PouType.Function 
}
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

        print("POU Created: %s" % new_pou_name)
        print("Type: %s" % POU_TYPE_STR)
        print("Language: %s (Defaulted)" % IMPL_LANGUAGE_STR)
        print("Parent Path: %s" % PARENT_PATH_REL)
        print("SCRIPT_SUCCESS: POU created successfully.")
        sys.exit(0)
    else:
        error_message = "Failed to create POU '%s'. create_pou returned None." % POU_NAME
        print(error_message)
        print("SCRIPT_ERROR: %s" % error_message)
        sys.exit(1)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error creating POU '%s' in project '%s': %s\\n%s" % (POU_NAME, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: Error creating POU '%s': %s" % (POU_NAME, e))
    sys.exit(1)