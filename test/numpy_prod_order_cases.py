# astra's numpy-int64-exact 3d508e74 evidence (CORR-3D5-1), compared with
# NumPy by test/numpy-int64.test.ts
import numpy as np
import warnings
warnings.simplefilter('ignore')
for dt in [np.float64,np.complex128]:
    a=np.array([1e-200,1e-200,1e200],dtype=dt)[::-1]
    print(dt.__name__,np.prod(a).item(),np.prod(a,axis=0,initial=1).item())
    a=np.array([[1e-200,1e-200,1e200],[1e-200,1e-200,1e200]],dtype=dt)[:,::-1]
    print(dt.__name__,'rows',np.prod(a,axis=1).tolist())
a=np.array([1e-200,1e-200,1e200],np.float64)[::-1]
out=np.array(7.0)
np.prod(a,out=out)
print('out',out.item())
a=np.array([1e-200,1e200,1e200,1e-200,1,1e-200,1e200,1,1e-200,1e200,1,1],np.float64).reshape(2,3,2)
print('3d reverse middle',np.prod(a[:,::-1,:],keepdims=True).tolist())
