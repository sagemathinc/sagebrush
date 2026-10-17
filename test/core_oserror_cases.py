# OSError(errno, ...) as the subclass its errno names, its arguments and
# attributes as CPython 3.14's oserror_init (sage2); compared with CPython by
# test/core-semantics.test.ts
# (Linux's errno numbers: Sagebrush has no errno module yet)
ERRNO = dict(EPERM=1, ENOENT=2, ESRCH=3, EINTR=4, ECHILD=10, EAGAIN=11, EWOULDBLOCK=11, EACCES=13, EEXIST=17, ENOTDIR=20, EISDIR=21, EPIPE=32, ESHUTDOWN=108, EALREADY=114, EINPROGRESS=115, ECONNABORTED=103, ECONNREFUSED=111, ECONNRESET=104, ETIMEDOUT=110, EINVAL=22, ENOSPC=28)
names = ['EPERM', 'ENOENT', 'ESRCH', 'EINTR', 'ECHILD', 'EAGAIN', 'EWOULDBLOCK', 'EACCES', 'EEXIST', 'ENOTDIR', 'EISDIR', 'EPIPE', 'ESHUTDOWN', 'EALREADY', 'EINPROGRESS', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EINVAL', 'ENOSPC']
for n in names:
    v = ERRNO[n]
    e = OSError(v, 'msg')
    print(n, v, type(e).__name__, isinstance(e, OSError), e.errno, e.strerror, str(e))
def t(l, f):
    try: r = f(); print(l, type(r).__name__, repr(r.args), r.errno, r.filename, str(r))
    except Exception as x: print(l, 'raised', type(x).__name__, x)
t('one arg', lambda: OSError(2))
t('three', lambda: OSError(2, 'no', 'f.txt'))
t('subclass call', lambda: FileExistsError(2, 'no'))
class MyOS(OSError): pass
t('user subclass', lambda: MyOS(2, 'no'))
t('bool', lambda: OSError(True, 'x'))
t('float', lambda: OSError(2.0, 'x'))
t('str errno', lambda: OSError('2', 'x'))
t('big', lambda: OSError(2**70, 'x'))
t('IOError', lambda: IOError(2, 'x'))
t('EnvironmentError', lambda: EnvironmentError(13, 'x'))
t('blocking', lambda: OSError(11, 'x', 5))
b = OSError(11, 'x', 5)
print('written', b.characters_written, b.filename)
try: print(BlockingIOError(11, 'x').characters_written)
except AttributeError as e: print('no written', e)
print([c.__name__ for c in ConnectionError.__subclasses__()], BrokenPipeError.__mro__[1].__name__, issubclass(TimeoutError, OSError))
try:
    raise OSError(2, 'gone')
except FileNotFoundError as e:
    print('caught', type(e).__name__)
t('five', lambda: OSError(2, 'no', 'a', None, 'b'))
t('four', lambda: OSError(2, 'no', 'a', 5))
t('six', lambda: OSError(2, 'no', 'a', 5, 'b', 6))
print(OSError(2, 'no', 'a', None, 'b').filename2, OSError(2, 'no').filename2)
