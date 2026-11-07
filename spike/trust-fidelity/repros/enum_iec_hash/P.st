PROGRAM P
VAR
    eLocal : E_Mode;
    b : BOOL;
END_VAR
eLocal := E_Mode#MANUAL;
b := eLocal = E_Mode#AUTO;
END_PROGRAM
