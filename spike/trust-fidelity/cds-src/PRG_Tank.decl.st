PROGRAM PRG_Tank
VAR
    fbPI : FB_PI;
    tonHiHi : TON;
    rtInterlock : R_TRIG;
    itfReset : I_Resettable;
    nTrips : UDINT;
    sStatus : STRING(80);
    bInit : BOOL := TRUE;
    fbProbe : FB_Probe;
    nProbe : INT;
END_VAR
