FUNCTION_BLOCK FB_Probe
VAR_INPUT
    nIn : INT;
END_VAR
VAR_OUTPUT
    nOut : INT;
END_VAR
VAR
    pInt : POINTER TO INT;
    refInt : REFERENCE TO INT;
    nLocal : INT;
    {attribute 'hide'}
    nHidden : INT;
    sText : STRING := 'Nivå åäö';   // non-ASCII round trip
END_VAR
