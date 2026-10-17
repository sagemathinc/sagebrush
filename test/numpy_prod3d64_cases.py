# astra's numpy-int64-exact 3d508e74 evidence (CORR-3D5-1), compared with
# NumPy by test/numpy-int64.test.ts
import numpy as np
import warnings
warnings.simplefilter('ignore')
def emit(label,f):
 try:
  x=f();print(label,repr(x.tolist() if hasattr(x,'tolist') else x))
 except Exception as e:print(label,type(e).__name__,str(e).split('\n')[0])
base=np.array([1e-200,1e200,1e200,1e-200,1,1e-200,1e200,1,1e-200,1e200,1,1],np.float64).reshape(2,3,2)
for perm in [(0,1,2),(0,2,1),(1,0,2),(1,2,0),(2,0,1),(2,1,0)]:
 for mask in range(8):
  a=base.transpose(perm)[tuple(slice(None,None,-1 if mask & (1<<i) else 1) for i in range(3))]
  for axes in [None,(0,1),(0,2),(1,2)]:
   for init in [None,1e200]:
    label=repr((perm,mask,axes,init))
    emit(label,lambda:np.prod(a,axis=axes,initial=init,keepdims=True))
