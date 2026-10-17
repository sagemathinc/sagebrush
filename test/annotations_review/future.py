from __future__ import annotations
import sys
x: Missing
class C:
 x: Missing
 def f(self,x: Missing)->list[int]:pass
def f(x:Missing)->list[int]:pass
for o in [sys.modules[__name__],C,C.f,f]:
 try:print(o.__annotations__)
 except Exception as e:print(type(e).__name__,str(e))
