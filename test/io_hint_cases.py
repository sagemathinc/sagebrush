# readlines' hints and the bytes a write takes, against CPython: astra's probes for
# CORR-606-3 and CORR-50F-1 (test/coverage-fixes.test.ts).
import io,os,tempfile

def show(label, f):
    try: print(label,'OK',repr(f()))
    except Exception as e: print(label,type(e).__name__,str(e))
class IndexFloat:
    def __index__(self):return 1.5
class IndexHuge:
    def __index__(self):return 2**100
class IndexOK:
    def __index__(self):return 3
class InstanceOnly: pass
only=InstanceOnly();only.__index__=lambda:3
shadow=IndexOK();shadow.__index__=lambda:100
hints=[('float-return',IndexFloat()),('huge-return',IndexHuge()),('instance-only',only),('shadow',shadow),('valid',IndexOK()),('huge-int',2**100),('huge-negative',-2**100)]
for name,ctor,data in [('StringIO',io.StringIO,'ab\nc\nd\n'),('BytesIO',io.BytesIO,b'ab\nc\nd\n')]:
    for label,hint in hints:
        f=ctor(data)
        show(name+' '+label,lambda:f.readlines(hint))
        print('remaining',repr(f.read()));f.close()
for hint in [1,2,3,4]:
    f=io.StringIO('😀\na\nb\n')
    show('astral '+str(hint),lambda:f.readlines(hint))
    print('remaining',repr(f.read()))
class FakeBuffer:
    def tobytes(self):return b'wrong'
class RealBytes(bytes):
    def __bytes__(self):return b'wrong'
class ArrayLike:
    def tobytes(self):return bytearray(b'wrong')
directory=tempfile.mkdtemp();path=os.path.join(directory,'test.bin')
try:
    for label,arg in [('fake',FakeBuffer()),('array-like',ArrayLike()),('bytes-subclass',RealBytes(b'real')),('integer',5),('bytes',b'real'),('bytearray',bytearray(b'real')),('view',memoryview(b'real'))]:
        f=io.BytesIO()
        show('BytesIO '+label,lambda:f.write(arg));print('value',repr(f.getvalue()))
        with open(path,'wb') as f:show('file '+label,lambda:f.write(arg))
        with open(path,'rb') as f:print('value',repr(f.read()))
finally:
    os.unlink(path)
    os.rmdir(directory)

import io
class Count(int):
    def __int__(self):return 0
class CountIndex(int):
    def __index__(self):return 0
for c in [Count(1),CountIndex(1)]:
    for ctor,data in [(io.StringIO,'aa\nbb\n'),(io.BytesIO,b'aa\nbb\n')]:
        f=ctor(data)
        try: print(type(c).__name__,type(f).__name__,f.readlines(c),f.read())
        except Exception as e: print(type(c).__name__,type(f).__name__,type(e).__name__,str(e))
