FUNCTION_BLOCK FB_Counter
VAR_OUTPUT
    nLast : INT;
END_VAR
nLast := Count();

METHOD Count : INT
VAR_INST
    nCalls : INT;
END_VAR
nCalls := nCalls + 1;
Count := nCalls;
END_METHOD
END_FUNCTION_BLOCK
