# RealField(p) against RR past the doubles at halfway mantissas, every
# rounding mode, both signs and orders (each operand rounded into the result's
# field first), and powers between RealField(p), Python floats and RDF with
# zero, unit, negative, NaN and infinite bases and exponents (by
# @sagebrush-astra; RR's own powers, p = 53, are left to sage-real-special-gaps)
def show(label, f, scale=0):
    try:
        r=f()
        desc=str(r.parent()) if hasattr(r, 'parent') else type(r).__name__
        try:
            v=(r.exact_rational() if hasattr(r,'exact_rational') else QQ(float(r).as_integer_ratio()[0])/float(r).as_integer_ratio()[1])/QQ(2)^scale
            print(label, '->', v, desc)
        except (TypeError, ValueError, OverflowError):
            print(label, '->', r, desc)
    except Exception as e: print(label, '!!', type(e).__name__, str(e))
for p in [2, 3, 30, 52]:
    for rnd in ['RNDN','RNDD','RNDU','RNDZ','RNDA']:
        R=RealField(p, rnd=rnd)
        for mant in [1, 1+QQ(1)/2^p, 1+QQ(3)/2^p, 2-QQ(1)/2^p]:
            for exp in [0, 1100, -1100]:
                big=RR(mant)*RR(2)^exp
                for sign in [1,-1]:
                    b=sign*big
                    # tiny is still an exact nonzero field value
                    a=R(2)^(exp-160)
                    for op,f in [('+',lambda:a+b), ('r+',lambda:b+a), ('-',lambda:a-b), ('r-',lambda:b-a)]:
                        show(str((p,rnd,mant,exp,sign,op)),f,exp)
for p in [30, 52, 54, 100]:
    R=RealField(p)
    for base in ['-2','0','1','2','NaN','+infinity','-infinity']:
        for expo in ['0','0.5','2','NaN','+infinity','-infinity']:
            for name, T in [('float',float),('RDF',RDF)]:
                a=R(base);b=T(RDF(expo))
                show(str(('pow',p,base,name,expo)), lambda:a^b)
                show(str(('rpow',p,base,name,expo)), lambda:b^a)
