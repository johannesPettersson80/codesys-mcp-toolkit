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

POU_FULL_PATH = "{POU_FULL_PATH}" # Expecting format like "Application/MyPOU" or "Folder/SubFolder/MyPOU"
DECLARATION_CONTENT = """{DECLARATION_CONTENT}"""
IMPLEMENTATION_CONTENT = """{IMPLEMENTATION_CONTENT}"""

try:
    print("DEBUG: set_pou_code script: POU_FULL_PATH='%s', Project='%s'" % (POU_FULL_PATH, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not POU_FULL_PATH: raise ValueError("POU full path empty.")

    # Find the target POU/Method/Property object
    target_object = find_object_by_path_robust(primary_project, POU_FULL_PATH, "target object")
    if not target_object: raise ValueError("Target object not found using path: %s" % POU_FULL_PATH)

    target_name = getattr(target_object, 'get_name', lambda: POU_FULL_PATH)()
    print("DEBUG: Found target object: %s" % target_name)

    # --- Set Declaration Part ---
    declaration_updated = False
    # Check if the content is actually provided (might be None/empty if only impl is set)
    has_declaration_content = 'DECLARATION_CONTENT' in locals() or 'DECLARATION_CONTENT' in globals()
    if has_declaration_content and DECLARATION_CONTENT is not None: # Check not None
        if hasattr(target_object, 'textual_declaration'):
            decl_obj = target_object.textual_declaration
            if decl_obj and hasattr(decl_obj, 'replace'):
                try:
                    print("DEBUG: Accessing textual_declaration...")
                    decl_obj.replace(DECLARATION_CONTENT)
                    print("DEBUG: Set declaration text using replace().")
                    declaration_updated = True
                except Exception as decl_err:
                    print("ERROR: Failed to set declaration text: %s" % decl_err)
                    traceback.print_exc() # Print stack trace for detailed error
            else:
                 print("WARN: Target '%s' textual_declaration attribute is None or does not have replace(). Skipping declaration update." % target_name)
        else:
            print("WARN: Target '%s' does not have textual_declaration attribute. Skipping declaration update." % target_name)
    else:
         print("DEBUG: Declaration content not provided or is None. Skipping declaration update.")


    # --- Set Implementation Part ---
    implementation_updated = False
    has_implementation_content = 'IMPLEMENTATION_CONTENT' in locals() or 'IMPLEMENTATION_CONTENT' in globals()
    if has_implementation_content and IMPLEMENTATION_CONTENT is not None: # Check not None
        if hasattr(target_object, 'textual_implementation'):
            impl_obj = target_object.textual_implementation
            if impl_obj and hasattr(impl_obj, 'replace'):
                try:
                    print("DEBUG: Accessing textual_implementation...")
                    impl_obj.replace(IMPLEMENTATION_CONTENT)
                    print("DEBUG: Set implementation text using replace().")
                    implementation_updated = True
                except Exception as impl_err:
                     print("ERROR: Failed to set implementation text: %s" % impl_err)
                     traceback.print_exc() # Print stack trace for detailed error
            else:
                 print("WARN: Target '%s' textual_implementation attribute is None or does not have replace(). Skipping implementation update." % target_name)
        else:
            print("WARN: Target '%s' does not have textual_implementation attribute. Skipping implementation update." % target_name)
    else:
        print("DEBUG: Implementation content not provided or is None. Skipping implementation update.")


    # --- SAVE THE PROJECT TO PERSIST THE CODE CHANGE ---
    # Only save if something was actually updated to avoid unnecessary saves
    if declaration_updated or implementation_updated:
        try:
            print("DEBUG: Saving Project (after code change)...")
            primary_project.save() # Save the overall project file
            print("DEBUG: Project saved successfully after code change.")
        except Exception as save_err:
            print("ERROR: Failed to save Project after setting code: %s" % save_err)
            detailed_error = traceback.format_exc()
            error_message = "Error saving Project after code change for '%s': %s\\n%s" % (target_name, save_err, detailed_error)
            print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
    else:
         print("DEBUG: No code parts were updated, skipping project save.")
    # --- END SAVING ---

    print("Code Set For: %s" % target_name)
    print("Path: %s" % POU_FULL_PATH)
    print("SCRIPT_SUCCESS: Declaration and/or implementation set successfully.")
    sys.exit(0)

except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error setting code for object '%s' in project '%s': %s\\n%s" % (POU_FULL_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)