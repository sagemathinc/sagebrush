"""_strptime, until CPython 3.14's Lib/_strptime.py can run here: it needs
calendar (which needs enum) and locale (which needs encodings), not yet in
Sagebrush. So time.strptime() and datetime's strptime() refuse, naming them,
rather than fail to import."""
raise NotImplementedError("strptime needs CPython's _strptime, which needs the calendar module (it needs enum) "
                          "and the locale module (it needs encodings), not yet in Sagebrush")
