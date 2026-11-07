FUNCTION_BLOCK FB_PI IMPLEMENTS I_Resettable
VAR_INPUT
    bEnable : BOOL;
    rPV : REAL;             // process value
    rSP : REAL;             // setpoint
    rCycleS : REAL := 0.01; // scan time [s]
END_VAR
VAR_OUTPUT
    rY : REAL;              // output 0..100 %
END_VAR
VAR
    _rKp : REAL := 50.0;
    _rTi : REAL := 60.0;
    rI : REAL;
    rE : REAL;
END_VAR
