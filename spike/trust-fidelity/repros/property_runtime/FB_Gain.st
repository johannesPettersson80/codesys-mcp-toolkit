FUNCTION_BLOCK FB_Gain
VAR
    _rKp : REAL := 1.0;
END_VAR

PROPERTY Kp : REAL
    GET
        Kp := _rKp;
    END_GET
    SET
        IF Kp > 0.0 THEN
            _rKp := Kp;
        END_IF
    END_SET
END_PROPERTY
END_FUNCTION_BLOCK
