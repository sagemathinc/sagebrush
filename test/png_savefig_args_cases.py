# savefig's arguments against matplotlib's (astra's probe in the review of
# python-png 6bc9fec): transparent with and without a facecolor, colors,
# subplots' figure arguments, the figure's facecolor when it is made, the
# axes' white patches, file objects, SVG by format, metadata text.
import io, os, struct, tempfile
import matplotlib.pyplot as plt

def show(label, f):
    try:
        print(label, 'OK', f())
    except Exception as e:
        print(label, type(e).__name__, str(e))
    finally:
        plt.close('all')
        plt.rcdefaults()

def save(fig, **kw):
    b=io.BytesIO()
    fig.savefig(b, **kw)
    return b.getvalue()

def pixels(**kw):
    fig=plt.figure(figsize=(2,2), facecolor='yellow')
    a=plt.imread(io.BytesIO(save(fig, **kw)))
    return [round(float(x)*255) for x in a[0,0]]

show('transparent explicit red', lambda: pixels(transparent=True, facecolor='red'))
show('transparent explicit auto', lambda: pixels(transparent=True, facecolor='auto'))
show('transparent default', lambda: pixels(transparent=True))
show('opaque red', lambda: pixels(facecolor='red'))
show('bad RGB range', lambda: pixels(facecolor=(2,0,0)))
show('bad RGB NaN', lambda: pixels(facecolor=(float('nan'),0,0)))

def subplot_opts():
    fig,ax=plt.subplots(figsize=(2,1),dpi=80,facecolor='red')
    a=plt.imread(io.BytesIO(save(fig)))
    return a.shape, [round(float(x)*255) for x in a[0,0]]
show('subplots figure kwargs',subplot_opts)

def changed_rc():
    plt.rcParams['figure.facecolor']='red'
    fig=plt.figure(figsize=(2,2))
    plt.rcParams['figure.facecolor']='blue'
    a=plt.imread(io.BytesIO(save(fig)))
    return [round(float(x)*255) for x in a[0,0]]
show('figure facecolor captured',changed_rc)

def axes_background():
    fig,ax=plt.subplots(figsize=(2,2))
    a=plt.imread(io.BytesIO(save(fig,facecolor='red')))
    return [round(float(x)*255) for x in a[a.shape[0]//2,a.shape[1]//2]]
show('axes white on red figure',axes_background)

def read_after_write():
    b=io.BytesIO()
    plt.figure(figsize=(1,1)).savefig(b)
    return plt.imread(b).shape
show('read file object at end',read_after_write)

def repeat_read():
    b=io.BytesIO(save(plt.figure(figsize=(1,1))))
    one=plt.imread(b).shape
    return one,plt.imread(b).shape
show('read file object twice',repeat_read)

d=tempfile.mkdtemp(prefix='astra-png-args-')
def svg_name(name):
    p=os.path.join(d,name)
    plt.figure(figsize=(1,1)).savefig(p,format='svg')
    with open(p,'rb') as f: return b'<svg' in f.read()
show('explicit svg arbitrary extension',lambda:svg_name('explicit.png'))
show('explicit svg no extension',lambda:svg_name('plain'))
show('SVG binary file object',lambda:b'<svg' in save(plt.figure(figsize=(1,1)),format='svg'))

def text_chunks(data):
    out=[];i=8
    while i+8<=len(data):
        n=struct.unpack('>I',data[i:i+4])[0]
        k=data[i+4:i+8]
        v=data[i+8:i+8+n]
        if k==b'tEXt':
            a,b=v.split(b'\0',1)
            out.append((a.decode('latin1'),b.decode('latin1')))
        elif k==b'iTXt':
            a,rest=v.split(b'\0',1)
            assert rest[:2]==b'\0\0'
            rest=rest[2:].split(b'\0',2)[2]
            out.append((a.decode('latin1'),rest.decode('utf8')))
        i+=12+n
    return sorted(out)

for value in ['ordinary', '\u03b1 \u03b2', 'before\x1eAfter\x1fextra', 'before\x1fafter', 'caf\u00e9']:
    show('metadata '+repr(value),lambda value=value:text_chunks(save(plt.figure(figsize=(1,1)),metadata={'Software':None,'Title':value})))

def svg_face():
    b=io.StringIO()
    plt.figure(figsize=(1,1)).savefig(b,format='svg',facecolor='red')
    return ('#ff0000' in b.getvalue() or 'fill="red"' in b.getvalue())
show('SVG explicit facecolor',svg_face)
