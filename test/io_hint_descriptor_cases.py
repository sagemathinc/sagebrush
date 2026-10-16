# readlines' hint by special-method lookup: the type's attribute, bound by its own
# __get__ (astra's descriptor_hints probe, CORR-606-3)
import io, tempfile, os
log=[]
class Normal:
    def __index__(self): return 1
class Static:
    __index__=staticmethod(lambda:1)
class Class:
    __index__=classmethod(lambda cls:1)
class Property:
    __index__=property(lambda self:lambda:1)
class Descriptor:
    def __get__(self,obj,owner):
        log.append(('get',obj is None))
        if obj is None: return lambda ignored:100
        return lambda:1
class Described:
    __index__=Descriptor()
class Callable:
    def __call__(self): return 1
class Called:
    __index__=Callable()
class Meta(type):
    def __getattribute__(cls,name):
        if name=='__index__': return lambda obj:100
        return super().__getattribute__(name)
class MetaHint(metaclass=Meta):
    def __index__(self):return 1
class NullIndex:
    __index__=None
class FloatIndex:
    def __index__(self):return 1.5
class Child(Described):pass

directory=tempfile.mkdtemp();path=os.path.join(directory,'lines')
with open(path,'wb') as f:f.write(b'aa\nbb\ncc\n')
try:
    for cls in [Normal,Static,Class,Property,Described,Called,MetaHint,NullIndex,FloatIndex,Child]:
        for kind in ['StringIO','BytesIO','file-text','file-binary']:
            for closed in [False,True]:
                if kind=='StringIO':f=io.StringIO('aa\nbb\ncc\n')
                elif kind=='BytesIO':f=io.BytesIO(b'aa\nbb\ncc\n')
                else:f=open(path,'r' if kind=='file-text' else 'rb')
                if closed:f.close()
                log.clear()
                try:result=repr(f.readlines(cls()))
                except Exception as e:result=type(e).__name__+': '+str(e)
                print(cls.__name__,kind,closed,result,repr(log),None if closed else repr(f.read()))
                f.close()
finally:
    os.unlink(path);os.rmdir(directory)

# The lookup is CPython's _PyType_Lookup: neither a metaclass's __dict__ or
# __mro__, nor its __get__, is consulted; a descriptor's __get__ is its type's raw
# attribute, called as __get__(a, obj, type), and one set to None fails (astra's
# special_edges probe, CORR-DC0-1; StaticHint's message, which names the lambda
# by its qualified name, is python-call-qualname's)
import io as _io
class DictMeta(type):
    def __getattribute__(cls, name):
        if name == '__dict__':
            return {'__index__': lambda self: 100}
        return super().__getattribute__(name)
class DictHint(metaclass=DictMeta):
    def __index__(self): return 1
class Fake:
    def __index__(self): return 100
class MroMeta(type):
    def __getattribute__(cls, name):
        if name == '__mro__': return (Fake,)
        return super().__getattribute__(name)
class MroHint(metaclass=MroMeta):
    def __index__(self): return 1
class GetMeta(type):
    def __getattribute__(cls,name):
        if name == '__get__': return lambda self,obj,tp: lambda:100
        return super().__getattribute__(name)
class Descr(metaclass=GetMeta):
    def __get__(self,obj,tp): return lambda:1
class DescrHint:
    __index__=Descr()
class StaticGet:
    __get__=staticmethod(lambda obj,tp:lambda:1)
class StaticHint:
    __index__=StaticGet()
class ClassGet:
    __get__=classmethod(lambda cls,obj,tp:lambda:1)
class ClassHint:
    __index__=ClassGet()
class NoneGet:
    __get__=None
    def __call__(self):return 100
class NoneHint:
    __index__=NoneGet()
for cls in [DictHint,MroHint,DescrHint,StaticHint,ClassHint,NoneHint]:
    f=_io.StringIO('aa\nbb\ncc\n')
    try: result=repr(f.readlines(cls()))
    except Exception as e:result=type(e).__name__+('' if cls is StaticHint else ': '+str(e))
    print(cls.__name__,result,repr(f.read()))
