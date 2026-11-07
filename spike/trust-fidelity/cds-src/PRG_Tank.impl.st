IF bInit THEN
    fbPI.Kp := 50.0;
    fbPI.Ti := 60.0;
    bInit := FALSE;
END_IF

tonHiHi(IN := GVL_IO.lrLT101_Level > GVL_Par.rLevelHiHi, PT := T#2S);
rtInterlock(CLK := tonHiHi.Q);
IF rtInterlock.Q THEN
    GVL_Par.eMode := E_TankMode.INTERLOCKED;
    nTrips := nTrips + 1;
    itfReset := fbPI;
    itfReset.Reset();
END_IF

fbPI(bEnable := GVL_Par.eMode = E_TankMode.AUTO,
     rPV := LREAL_TO_REAL(GVL_IO.lrLT101_Level),
     rSP := GVL_Par.rLevelSP);

IF GVL_Par.eMode = E_TankMode.INTERLOCKED THEN
    GVL_IO.lrFV101_FlowCmd := 0.0;
    sStatus := CONCAT('INTERLOCKED, trips=', UDINT_TO_STRING(nTrips));
ELSE
    GVL_IO.lrFV101_FlowCmd := REAL_TO_LREAL(fbPI.rY / 100.0 * GVL_Par.rMaxInflow);
    sStatus := 'OK';
END_IF

fbProbe(nIn := 3);
nProbe := fbProbe.nOut;
