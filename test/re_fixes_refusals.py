# python-re-fixes: what Sagebrush's re refuses where JS's RegExp would give
# another answer than CPython's sre (test/re-fixes.test.ts). CPython's own
# answers are in the comments.
import re
for p, s in [
    (r'(a)?b\1', 'b'),            # A23: None (sre fails at \1)
    (r'(a|(b))\2', 'a'),          # A23: None
    (r'(a|(b))+', 'ba'),          # A26: ('a', 'b')
    (r'(?:(a)|b)*', 'ab'),        # A26: ('a',)
    (r'(?:|a)*', 'a'),            # '' (sre takes the empty iteration)
    (r'(a*?)*', 'aa'),            # ''
    (r'(a?){1,3}', 'a'),          # group 1 (1, 1)
    (r'(a?)*\1', 'aa'),           # a reference into a rewritten repeat
    (r'(?<=(\b)*)a', 'a'),        # inside a look-behind
]:
    try:
        print(p, re.fullmatch(p, s))
    except NotImplementedError as e:
        print(p, 'NotImplementedError:', e)
