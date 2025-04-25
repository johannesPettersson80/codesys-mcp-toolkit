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

POU_FULL_PATH = "{POU_FULL_PATH}" 
CODE_START_MARKER = "### POU CODE START ###"
CODE_END_MARKER = "### POU CODE END ###"
DECL_START_MARKER = "### POU DECLARATION START ###"
DECL_END_MARKER = "### POU DECLARATION END ###"
IMPL_START_MARKER = "### POU IMPLEMENTATION START ###"
IMPL_END_MARKER = "### POU IMPLEMENTATION END ###"

try:
    print("DEBUG: Getting code: POU_FULL_PATH='%s', Project='%s'" % (POU_FULL_PATH, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not POU_FULL_PATH: raise ValueError("POU full path empty.")

    # Find the target POU/Method/Property object
    target_object = find_object_by_path_robust(primary_project, POU_FULL_PATH, "target object")
    if not target_object: raise ValueError("Target object not found using path: %s" % POU_FULL_PATH)

    target_name = getattr(target_object, 'get_name', lambda: POU_FULL_PATH)()
    print("DEBUG: Found target object: %s" % target_name)

    declaration_code = ""; implementation_code = ""

    # --- Get Declaration Part ---
    if hasattr(target_object, 'textual_declaration'):
        decl_obj = target_object.textual_declaration
        if decl_obj and hasattr(decl_obj, 'text'):
            try:
                declaration_code = decl_obj.text
                print("DEBUG: Got declaration text.")
            except Exception as decl_read_err:
                print("ERROR: Failed to read declaration text: %s" % decl_read_err)
                declaration_code = "/* ERROR reading declaration: %s */" % decl_read_err
        else:
            print("WARN: textual_declaration exists but is None or has no 'text' attribute.")
    else:
        print("WARN: No textual_declaration attribute.")

    # --- Get Implementation Part ---
    if hasattr(target_object, 'textual_implementation'):
        impl_obj = target_object.textual_implementation
        if impl_obj and hasattr(impl_obj, 'text'):
            try:
                implementation_code = impl_obj.text
                print("DEBUG: Got implementation text.")
            except Exception as impl_read_err:
                print("ERROR: Failed to read implementation text: %s" % impl_read_err)
                implementation_code = "/* ERROR reading implementation: %s */" % impl_read_err
        else:
            print("WARN: textual_implementation exists but is None or has no 'text' attribute.")
    else:
        print("WARN: No textual_implementation attribute.")


    print("Code retrieved for: %s" % target_name)
    # Print declaration between markers, ensuring markers are on separate lines
    print("\\n" + DECL_START_MARKER)
    print(declaration_code)
    print(DECL_END_MARKER + "\\n")
    # Print implementation between markers
    print(IMPL_START_MARKER)
    print(implementation_code)
    print(IMPL_END_MARKER + "\\n")

    # --- LEGACY MARKERS for backward compatibility if needed ---
    # Combine both for old marker format, adding a separator line
    # legacy_combined_code = declaration_code + "\\n\\n// Implementation\\n" + implementation_code
    # print(CODE_START_MARKER); print(legacy_combined_code); print(CODE_END_MARKER)
    # --- END LEGACY ---

    print("SCRIPT_SUCCESS: Code retrieved.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error getting code for object '%s' in project '%s': %s\\n%s" % (POU_FULL_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)