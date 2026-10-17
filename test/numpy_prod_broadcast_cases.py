# astra's numpy-int64-exact 948af89b evidence (CORR-948-1), compared with
# NumPy by test/numpy-int64.test.ts
import numpy as np
import warnings
warnings.simplefilter('ignore')
for dt in (np.float64,np.complex128):
    a=np.broadcast_to(np.array([1e-200,1e-200,1e200],dtype=dt)[::-1],(2,3))
    print(str(np.dtype(dt)),a.shape,a.strides)
    print('whole',np.prod(a).item())
    print('axis',np.prod(a,axis=(0,1)).item())
    print('reverse axes',np.prod(a,axis=(1,0)).item())
    print('initial',np.prod(a,initial=1).item())
    out=np.array(7,dtype=dt)
    np.prod(a,out=out)
    print('out',out.item())
    print('rows',np.prod(a,axis=1).tolist())
