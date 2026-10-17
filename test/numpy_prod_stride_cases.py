# astra's numpy-int64-exact 948af89b evidence (CORR-948-1), compared with
# NumPy by test/numpy-int64.test.ts
import numpy as np
import warnings
warnings.simplefilter('ignore')
def emit(label, f):
    try:
        x = f()
        print(label, repr(x.tolist() if hasattr(x, 'tolist') else x))
    except Exception as e:
        print(label, type(e).__name__, str(e).split('\n')[0])
for dt in (np.float64, np.complex128):
    for vals in ([1e-200, 1e200, 1], [1e200, 1e-200, 1e-200], [1e-200, 1e-200, 1e200]):
        v = np.array(vals, dtype=dt)
        views = [np.broadcast_to(v, (2,3)), np.broadcast_to(v[::-1], (2,3)),
                 np.broadcast_to(v[:, None], (3,2)), np.broadcast_to(v[::-1,None], (3,2)),
                 np.broadcast_to(v.reshape(1,3,1), (2,3,2)), np.broadcast_to(v[::-1].reshape(1,3,1), (2,3,2)),
                 np.array(vals*4,dtype=dt).reshape(4,3)[::2,::-1],
                 np.array(vals*4,dtype=dt).reshape(4,3)[::-2,::2],
                 np.array(vals*4,dtype=dt).reshape(4,3).T[::-1,::-2]]
        for k,a in enumerate(views):
            for axes in (None, (), 0, -1, tuple(range(a.ndim)), tuple(reversed(range(a.ndim)))):
                for init in (None, 1e200):
                    emit((str(np.dtype(dt)),vals,k,axes,init),lambda:np.prod(a,axis=axes,initial=init,keepdims=True))
