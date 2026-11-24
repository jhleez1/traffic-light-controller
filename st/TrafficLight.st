(*
 * The same junction controller as step7/OB1.awl, written in Structured Text
 * (IEC 61131-3) as a function block. Works in B&R Automation Studio,
 * CODESYS and TIA Portal (SCL) with small changes.
 *
 * Compare the two: in STL the step sequence needs a jump list and a
 * one-scan "step finished" flag. In ST it is a CASE statement.
 *)
FUNCTION_BLOCK TrafficLight
VAR_INPUT
	PedButton : BOOL;
	NightMode : BOOL;
	Clock1Hz : BOOL;   (* e.g. a blinker FB or the CPU clock memory bit *)
END_VAR
VAR_OUTPUT
	MainRed, MainAmber, MainGreen : BOOL;
	SideRed, SideAmber, SideGreen : BOOL;
	Walk, DontWalk : BOOL;
END_VAR
VAR
	Step : INT := 0;
	PedRequest : BOOL;
	StepTimer : TON;
	StepTime : TIME;
END_VAR

	IF PedButton THEN
		PedRequest := TRUE;
	END_IF;

	IF NightMode THEN
		Step := 0;
		StepTimer(IN := FALSE);
	ELSE
		CASE Step OF
			0: StepTime := T#6s;   (* main green *)
			1: StepTime := T#2s;   (* main amber *)
			2: StepTime := T#1s;   (* all red *)
			3: StepTime := T#4s;   (* walk *)
			4: StepTime := T#4s;   (* side green *)
			5: StepTime := T#2s;   (* side amber *)
			6: StepTime := T#1s;   (* all red *)
		ELSE
			Step := 0;
			StepTime := T#6s;
		END_CASE;

		StepTimer(IN := TRUE, PT := StepTime);

		IF StepTimer.Q THEN
			StepTimer(IN := FALSE);   (* restart the timer for the next step *)
			Step := Step + 1;
			IF Step = 3 AND NOT PedRequest THEN
				Step := 4;            (* nobody waiting: skip the walk step *)
			END_IF;
			IF Step = 3 THEN
				PedRequest := FALSE;
			END_IF;
			IF Step > 6 THEN
				Step := 0;
			END_IF;
		END_IF;
	END_IF;

	MainGreen := NOT NightMode AND Step = 0;
	MainAmber := (NOT NightMode AND Step = 1) OR (NightMode AND Clock1Hz);
	MainRed   := NOT NightMode AND Step >= 2;
	SideGreen := NOT NightMode AND Step = 4;
	SideAmber := (NOT NightMode AND Step = 5) OR (NightMode AND Clock1Hz);
	SideRed   := NOT NightMode AND (Step <= 3 OR Step = 6);
	Walk      := NOT NightMode AND Step = 3;
	DontWalk  := NOT NightMode AND Step <> 3;

END_FUNCTION_BLOCK
