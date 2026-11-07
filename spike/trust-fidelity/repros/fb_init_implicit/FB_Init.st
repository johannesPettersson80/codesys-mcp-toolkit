FUNCTION_BLOCK FB_Init
VAR_OUTPUT
    nMark : INT;   // CODESYS: 7 after initialisation (FB_init runs implicitly). truST: 0.
END_VAR

METHOD FB_init : BOOL
VAR_INPUT
    bInitRetains : BOOL;
    bInCopyCode : BOOL;
END_VAR
nMark := 7;
FB_init := TRUE;
END_METHOD
END_FUNCTION_BLOCK
