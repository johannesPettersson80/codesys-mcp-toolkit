IF bEnable THEN
    rE := rSP - rPV;
    rI := LIMIT(0.0, rI + _rKp * rE * rCycleS / _rTi, 100.0);
    rY := LIMIT(0.0, _rKp * rE + rI, 100.0);
ELSE
    rY := 0.0;
END_IF
