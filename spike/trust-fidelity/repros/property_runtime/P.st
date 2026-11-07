PROGRAM P
VAR
    fb : FB_Gain;
    rRead : REAL;       // expect 42.0 (SET then GET)
    rRejected : REAL;   // expect 42.0 (SET guard rejects -1)
END_VAR
fb.Kp := 42.0;
rRead := fb.Kp;
fb.Kp := -1.0;
rRejected := fb.Kp;
END_PROGRAM
