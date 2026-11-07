PROGRAM P
VAR
    fb : FB_Init;
    nSeen : INT;
END_VAR
fb();
nSeen := fb.nMark;   // read with: trust-runtime ctl eval PInst.nSeen  (expect 7)
END_PROGRAM
