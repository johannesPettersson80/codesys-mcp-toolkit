pInt := ADR(nLocal);
pInt^ := nIn;
refInt REF= nLocal;
IF __ISVALIDREF(refInt) THEN
    nOut := refInt + Count();
END_IF
