"""Python wrapper for Expat parser."""

# pyexpat for Sagebrush (codex friction P3c-1; design note r3, all five lanes cleared): the slice of CPython 3.14.10's
# pyexpat that its xml.etree.ElementTree uses, and more of the same handlers, written in Python over a port of the
# parts of libexpat 2.9.0 (CPython 3.14.10's Modules/expat) that decide what a document reports: the tokenizer
# (xmltok_impl.c), the prolog's role machine (xmlrole.c) and the processors (xmlparse.c doProlog, doContent,
# storeAtts, addBinding, storeAttributeValue, storeEntityValue, the accounting and the buffer's reparse deferral).
# The reference is CPython 3.14.10: every message, code and position is pinned against its own pyexpat
# (test/expat_corpus.json, recorded by test/gen_expat_corpus.py).
#
# It reads nothing and writes nothing: no file, network or host capability, no external entity or DTD is ever
# fetched (there is no resolver), and it imports only re, types and sys, sys for sys.modules alone (pinned by an
# import census).
#
# libexpat's notice (MIT), for the logic ported from it and the name tables derived from its nametab.h:
#
#   Copyright (c) 1997-2000 Thai Open Source Software Center Ltd
#   Copyright (c) 2000      Clark Cooper <coopercc@users.sourceforge.net>
#   Copyright (c) 2001-2025 Expat maintainers
#   Licensed under the MIT license:
#   Permission is  hereby granted,  free of charge,  to any  person obtaining
#   a  copy  of  this  software   and  associated  documentation  files  (the
#   "Software"),  to  deal in  the  Software  without restriction,  including
#   without  limitation the  rights  to use,  copy,  modify, merge,  publish,
#   distribute, sublicense, and/or sell copies of the Software, and to permit
#   persons  to whom  the Software  is  furnished to  do so,  subject to  the
#   following conditions:
#   The above copyright  notice and this permission notice  shall be included
#   in all copies or substantial portions of the Software.
#   THE  SOFTWARE  IS  PROVIDED  "AS  IS",  WITHOUT  WARRANTY  OF  ANY  KIND,
#   EXPRESS  OR IMPLIED,  INCLUDING  BUT  NOT LIMITED  TO  THE WARRANTIES  OF
#   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
#   NO EVENT SHALL THE AUTHORS OR  COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
#   DAMAGES OR  OTHER LIABILITY, WHETHER  IN AN  ACTION OF CONTRACT,  TORT OR
#   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
#   USE OR OTHER DEALINGS IN THE SOFTWARE.

import re as _re
import sys as _sys
import types as _types

EXPAT_VERSION = "expat_2.9.0"
version_info = (2, 9, 0)
native_encoding = "UTF-8"
features = [("sizeof(XML_Char)", 1), ("sizeof(XML_LChar)", 1), ("XML_DTD", 0), ("XML_CONTEXT_BYTES", 1024),
            ("XML_NS", 0), ("XML_BLAP_MAX_AMP", 100), ("XML_BLAP_ACT_THRES", 8388608), ("XML_GE", 0),
            ("XML_AT_MAX_AMP", 100), ("XML_AT_ACT_THRES", 67108864)]
XML_PARAM_ENTITY_PARSING_NEVER = 0
XML_PARAM_ENTITY_PARSING_UNLESS_STANDALONE = 1
XML_PARAM_ENTITY_PARSING_ALWAYS = 2

# (expat 2.9.0's error codes and messages, in code order)
_ERRORS = [
    ("XML_ERROR_NO_MEMORY", "out of memory"), ("XML_ERROR_SYNTAX", "syntax error"),
    ("XML_ERROR_NO_ELEMENTS", "no element found"), ("XML_ERROR_INVALID_TOKEN", "not well-formed (invalid token)"),
    ("XML_ERROR_UNCLOSED_TOKEN", "unclosed token"), ("XML_ERROR_PARTIAL_CHAR", "partial character"),
    ("XML_ERROR_TAG_MISMATCH", "mismatched tag"), ("XML_ERROR_DUPLICATE_ATTRIBUTE", "duplicate attribute"),
    ("XML_ERROR_JUNK_AFTER_DOC_ELEMENT", "junk after document element"),
    ("XML_ERROR_PARAM_ENTITY_REF", "illegal parameter entity reference"),
    ("XML_ERROR_UNDEFINED_ENTITY", "undefined entity"), ("XML_ERROR_RECURSIVE_ENTITY_REF", "recursive entity reference"),
    ("XML_ERROR_ASYNC_ENTITY", "asynchronous entity"), ("XML_ERROR_BAD_CHAR_REF", "reference to invalid character number"),
    ("XML_ERROR_BINARY_ENTITY_REF", "reference to binary entity"),
    ("XML_ERROR_ATTRIBUTE_EXTERNAL_ENTITY_REF", "reference to external entity in attribute"),
    ("XML_ERROR_MISPLACED_XML_PI", "XML or text declaration not at start of entity"),
    ("XML_ERROR_UNKNOWN_ENCODING", "unknown encoding"),
    ("XML_ERROR_INCORRECT_ENCODING", "encoding specified in XML declaration is incorrect"),
    ("XML_ERROR_UNCLOSED_CDATA_SECTION", "unclosed CDATA section"),
    ("XML_ERROR_EXTERNAL_ENTITY_HANDLING", "error in processing external entity reference"),
    ("XML_ERROR_NOT_STANDALONE", "document is not standalone"),
    ("XML_ERROR_UNEXPECTED_STATE", "unexpected parser state - please send a bug report"),
    ("XML_ERROR_ENTITY_DECLARED_IN_PE", "entity declared in parameter entity"),
    ("XML_ERROR_FEATURE_REQUIRES_XML_DTD", "requested feature requires XML_DTD support in Expat"),
    ("XML_ERROR_CANT_CHANGE_FEATURE_ONCE_PARSING", "cannot change setting once parsing has begun"),
    ("XML_ERROR_UNBOUND_PREFIX", "unbound prefix"), ("XML_ERROR_UNDECLARING_PREFIX", "must not undeclare prefix"),
    ("XML_ERROR_INCOMPLETE_PE", "incomplete markup in parameter entity"),
    ("XML_ERROR_XML_DECL", "XML declaration not well-formed"), ("XML_ERROR_TEXT_DECL", "text declaration not well-formed"),
    ("XML_ERROR_PUBLICID", "illegal character(s) in public id"), ("XML_ERROR_SUSPENDED", "parser suspended"),
    ("XML_ERROR_NOT_SUSPENDED", "parser not suspended"), ("XML_ERROR_ABORTED", "parsing aborted"),
    ("XML_ERROR_FINISHED", "parsing finished"),
    ("XML_ERROR_SUSPEND_PE", "cannot suspend in external parameter entity"),
    ("XML_ERROR_RESERVED_PREFIX_XML", "reserved prefix (xml) must not be undeclared or bound to another namespace name"),
    ("XML_ERROR_RESERVED_PREFIX_XMLNS", "reserved prefix (xmlns) must not be declared or undeclared"),
    ("XML_ERROR_RESERVED_NAMESPACE_URI", "prefix must not be bound to one of the reserved namespace names"),
    ("XML_ERROR_INVALID_ARGUMENT", "invalid argument"),
    ("XML_ERROR_NO_BUFFER", "a successful prior call to function XML_GetBuffer is required"),
    ("XML_ERROR_AMPLIFICATION_LIMIT_BREACH", "limit on input amplification factor (from DTD and entities) breached"),
    ("XML_ERROR_NOT_STARTED", "parser not started"),
]

errors = _types.ModuleType("pyexpat.errors", "Constants used to describe error conditions.")
errors.codes = {}
errors.messages = {}
for _code, (_name, _message) in enumerate(_ERRORS, 1):
    setattr(errors, _name, _message)
    errors.codes[_message] = _code
    errors.messages[_code] = _message
model = _types.ModuleType("pyexpat.model", "Constants used to interpret content model information.")
for _name, _value in (("XML_CTYPE_EMPTY", 1), ("XML_CTYPE_ANY", 2), ("XML_CTYPE_MIXED", 3), ("XML_CTYPE_NAME", 4),
                      ("XML_CTYPE_CHOICE", 5), ("XML_CTYPE_SEQ", 6), ("XML_CQUANT_NONE", 0), ("XML_CQUANT_OPT", 1),
                      ("XML_CQUANT_REP", 2), ("XML_CQUANT_PLUS", 3)):
    setattr(model, _name, _value)
del _code, _name, _message, _value
# (as CPython's pyexpat: the submodules are importable by name, `import pyexpat.errors`)
_sys.modules[errors.__name__] = errors
_sys.modules[model.__name__] = model


class ExpatError(Exception):
    pass


ExpatError.__module__ = "xml.parsers.expat"
error = ExpatError


def ErrorString(code, /):
    """Returns string error for given number."""
    if not isinstance(code, int):
        raise TypeError(f"'{type(code).__name__}' object cannot be interpreted as an integer")
    return errors.messages.get(code)


# ---------------------------------------------------------------------------- characters (expat's byte types)
# (expat classifies each character: name characters by its own tables (nametab.h, derived below, older than XML 1.0's
# fifth edition), never one above U+FFFF; characters XML forbids, and every byte that isn't valid in the input's
# encoding (decoded here as a lone surrogate, surrogateescape), are invalid)
_NMSTRT_NONASCII = "À-ÖØ-öø-ıĴ-ľŁ-ňŊ-žƀ-ǃǍ-ǰǴ-ǵǺ-ȗɐ-ʨʻ-ˁΆΈ-ΊΌΎ-ΡΣ-ώϐ-ϖϚϜϞϠϢ-ϳЁ-ЌЎ-яё-ќў-ҁҐ-ӄӇ-ӈӋ-ӌӐ-ӫӮ-ӵӸ-ӹԱ-Ֆՙա-ֆא-תװ-ײء-غف-يٱ-ڷں-ھۀ-ێې-ۓەۥ-ۦअ-हऽक़-ॡঅ-ঌএ-ঐও-নপ-রলশ-হড়-ঢ়য়-ৡৰ-ৱਅ-ਊਏ-ਐਓ-ਨਪ-ਰਲ-ਲ਼ਵ-ਸ਼ਸ-ਹਖ਼-ੜਫ਼ੲ-ੴઅ-ઋઍએ-ઑઓ-નપ-રલ-ળવ-હઽૠଅ-ଌଏ-ଐଓ-ନପ-ରଲ-ଳଶ-ହଽଡ଼-ଢ଼ୟ-ୡஅ-ஊஎ-ஐஒ-கங-சஜஞ-டண-தந-பம-வஷ-ஹఅ-ఌఎ-ఐఒ-నప-ళవ-హౠ-ౡಅ-ಌಎ-ಐಒ-ನಪ-ಳವ-ಹೞೠ-ೡഅ-ഌഎ-ഐഒ-നപ-ഹൠ-ൡก-ฮะา-ำเ-ๅກ-ຂຄງ-ຈຊຍດ-ທນ-ຟມ-ຣລວສ-ຫອ-ຮະາ-ຳຽເ-ໄཀ-ཇཉ-ཀྵႠ-Ⴥა-ჶᄀᄂ-ᄃᄅ-ᄇᄉᄋ-ᄌᄎ-ᄒᄼᄾᅀᅌᅎᅐᅔ-ᅕᅙᅟ-ᅡᅣᅥᅧᅩᅭ-ᅮᅲ-ᅳᅵᆞᆨᆫᆮ-ᆯᆷ-ᆸᆺᆼ-ᇂᇫᇰᇹḀ-ẛẠ-ỹἀ-ἕἘ-Ἕἠ-ὅὈ-Ὅὐ-ὗὙὛὝὟ-ώᾀ-ᾴᾶ-ᾼιῂ-ῄῆ-ῌῐ-ΐῖ-Ίῠ-Ῥῲ-ῴῶ-ῼΩK-Å℮ↀ-ↂ〇〡-〩ぁ-ゔァ-ヺㄅ-ㄬ一-龥가-힣"
_NAME_NONASCII = "·À-ÖØ-öø-ıĴ-ľŁ-ňŊ-žƀ-ǃǍ-ǰǴ-ǵǺ-ȗɐ-ʨʻ-ˁː-ˑ̀-͠ͅ-͡Ά-ΊΌΎ-ΡΣ-ώϐ-ϖϚϜϞϠϢ-ϳЁ-ЌЎ-яё-ќў-ҁ҃-҆Ґ-ӄӇ-ӈӋ-ӌӐ-ӫӮ-ӵӸ-ӹԱ-Ֆՙա-ֆ֑-֣֡-ֹֻ-ֽֿׁ-ׂׄא-תװ-ײء-غـ-ْ٠-٩ٰ-ڷں-ھۀ-ێې-ۓە-۪ۨ-ۭ۰-۹ँ-ःअ-ह़-्॑-॔क़-ॣ०-९ঁ-ঃঅ-ঌএ-ঐও-নপ-রলশ-হ়া-ৄে-ৈো-্ৗড়-ঢ়য়-ৣ০-ৱਂਅ-ਊਏ-ਐਓ-ਨਪ-ਰਲ-ਲ਼ਵ-ਸ਼ਸ-ਹ਼ਾ-ੂੇ-ੈੋ-੍ਖ਼-ੜਫ਼੦-ੴઁ-ઃઅ-ઋઍએ-ઑઓ-નપ-રલ-ળવ-હ઼-ૅે-ૉો-્ૠ૦-૯ଁ-ଃଅ-ଌଏ-ଐଓ-ନପ-ରଲ-ଳଶ-ହ଼-ୃେ-ୈୋ-୍ୖ-ୗଡ଼-ଢ଼ୟ-ୡ୦-୯ஂ-ஃஅ-ஊஎ-ஐஒ-கங-சஜஞ-டண-தந-பம-வஷ-ஹா-ூெ-ைொ-்ௗ௧-௯ఁ-ఃఅ-ఌఎ-ఐఒ-నప-ళవ-హా-ౄె-ైొ-్ౕ-ౖౠ-ౡ౦-౯ಂ-ಃಅ-ಌಎ-ಐಒ-ನಪ-ಳವ-ಹಾ-ೄೆ-ೈೊ-್ೕ-ೖೞೠ-ೡ೦-೯ം-ഃഅ-ഌഎ-ഐഒ-നപ-ഹാ-ൃെ-ൈൊ-്ൗൠ-ൡ൦-൯ก-ฮะ-ฺเ-๎๐-๙ກ-ຂຄງ-ຈຊຍດ-ທນ-ຟມ-ຣລວສ-ຫອ-ຮະ-ູົ-ຽເ-ໄໆ່-ໍ໐-໙༘-༙༠-༩༹༵༷༾-ཇཉ-ཀྵཱ-྄྆-ྋྐ-ྕྗྙ-ྭྱ-ྷྐྵႠ-Ⴥა-ჶᄀᄂ-ᄃᄅ-ᄇᄉᄋ-ᄌᄎ-ᄒᄼᄾᅀᅌᅎᅐᅔ-ᅕᅙᅟ-ᅡᅣᅥᅧᅩᅭ-ᅮᅲ-ᅳᅵᆞᆨᆫᆮ-ᆯᆷ-ᆸᆺᆼ-ᇂᇫᇰᇹḀ-ẛẠ-ỹἀ-ἕἘ-Ἕἠ-ὅὈ-Ὅὐ-ὗὙὛὝὟ-ώᾀ-ᾴᾶ-ᾼιῂ-ῄῆ-ῌῐ-ΐῖ-Ίῠ-Ῥῲ-ῴῶ-ῼ⃐-⃜⃡ΩK-Å℮ↀ-ↂ々〇〡-〯〱-〵ぁ-ゔ゙-゚ゝ-ゞァ-ヺー-ヾㄅ-ㄬ一-龥가-힣"
_INVALID = "\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\ud800-\\udfff\\ufffe\\uffff"

# byte types (xmltok_impl.h), for a character of the decoded text
(_BT_NONXML, _BT_MALFORM, _BT_LT, _BT_AMP, _BT_RSQB, _BT_LEAD, _BT_CR, _BT_LF, _BT_GT, _BT_QUOT, _BT_APOS, _BT_EQUALS, _BT_QUEST,
 _BT_EXCL, _BT_SOL, _BT_SEMI, _BT_NUM, _BT_LSQB, _BT_S, _BT_NMSTRT, _BT_COLON, _BT_HEX, _BT_DIGIT, _BT_NAME, _BT_MINUS, _BT_OTHER,
 _BT_PERCNT, _BT_LPAR, _BT_RPAR, _BT_AST, _BT_PLUS, _BT_COMMA, _BT_VERBAR, _BT_PARTIAL) = range(34)

_ASCII_BT = [_BT_NONXML] * 9 + [_BT_S, _BT_LF, _BT_NONXML, _BT_NONXML, _BT_CR] + [_BT_NONXML] * 18 + [
    _BT_S, _BT_EXCL, _BT_QUOT, _BT_NUM, _BT_OTHER, _BT_PERCNT, _BT_AMP, _BT_APOS, _BT_LPAR, _BT_RPAR, _BT_AST, _BT_PLUS, _BT_COMMA,
    _BT_MINUS, _BT_NAME, _BT_SOL] + [_BT_DIGIT] * 10 + [_BT_COLON, _BT_SEMI, _BT_LT, _BT_EQUALS, _BT_GT, _BT_QUEST, _BT_OTHER] + [
    _BT_HEX] * 6 + [_BT_NMSTRT] * 20 + [_BT_LSQB, _BT_OTHER, _BT_RSQB, _BT_OTHER, _BT_NMSTRT, _BT_OTHER] + [_BT_HEX] * 6 + [
    _BT_NMSTRT] * 20 + [_BT_OTHER, _BT_VERBAR, _BT_OTHER, _BT_OTHER, _BT_OTHER]

# tokens (xmltok.h)
_TOK_TRAILING_RSQB, _TOK_NONE, _TOK_TRAILING_CR, _TOK_PARTIAL_CHAR, _TOK_PARTIAL, _TOK_INVALID = -5, -4, -3, -2, -1, 0
(_TOK_START_TAG_WITH_ATTS, _TOK_START_TAG_NO_ATTS, _TOK_EMPTY_ELEMENT_WITH_ATTS, _TOK_EMPTY_ELEMENT_NO_ATTS, _TOK_END_TAG,
 _TOK_DATA_CHARS, _TOK_DATA_NEWLINE, _TOK_CDATA_SECT_OPEN, _TOK_ENTITY_REF, _TOK_CHAR_REF, _TOK_PI, _TOK_XML_DECL, _TOK_COMMENT,
 _TOK_BOM, _TOK_PROLOG_S, _TOK_DECL_OPEN, _TOK_DECL_CLOSE, _TOK_NAME, _TOK_NMTOKEN, _TOK_POUND_NAME, _TOK_OR, _TOK_PERCENT,
 _TOK_OPEN_PAREN, _TOK_CLOSE_PAREN, _TOK_OPEN_BRACKET, _TOK_CLOSE_BRACKET, _TOK_LITERAL, _TOK_PARAM_ENTITY_REF,
 _TOK_INSTANCE_START, _TOK_NAME_QUESTION, _TOK_NAME_ASTERISK, _TOK_NAME_PLUS, _TOK_COND_SECT_OPEN, _TOK_COND_SECT_CLOSE,
 _TOK_CLOSE_PAREN_QUESTION, _TOK_CLOSE_PAREN_ASTERISK, _TOK_CLOSE_PAREN_PLUS, _TOK_COMMA, _TOK_ATTRIBUTE_VALUE_S,
 _TOK_CDATA_SECT_CLOSE, _TOK_PREFIXED_NAME, _TOK_IGNORE_SECT) = range(1, 43)

# (the most one synchronous scan examines: a longer run is scanned in windows, Sagebrush's Stop checked between them)
_WINDOW = 1 << 20


class _Chars:
    """The character classes of one parser: a namespace-processing parser's colon is its own type (_BT_COLON), else
    a name character."""

    def __init__(self, ns):
        colon = "" if ns else ":"
        self.ns = ns
        nmstrt = "A-Z_a-z" + colon + _NMSTRT_NONASCII
        name = "A-Z_a-z0-9.\\-" + colon + _NAME_NONASCII
        self.nmstrt = _re.compile("[" + nmstrt + "]")
        self.name_run = _re.compile("[" + name + "]*")
        # (a run of content data: none of < & ] CR LF, no invalid character; and the same in a CDATA section)
        self.data_run = _re.compile("[^<&\\]\\r\\n" + _INVALID + "]+")
        self.cdata_run = _re.compile("[^\\]\\r\\n" + _INVALID + "]+")
        # (attribute and entity values, comments, PIs, literals: any valid character but the ones each scanner stops at)
        self.att_run = _re.compile("[^<&\\t\\n\\r '\"" + _INVALID + "]+")
        self.plain_run = _re.compile("[^\\-?\\]'\"<&%\\t\\n\\r " + _INVALID + "]+")
        self.colon_bt = _BT_COLON if ns else _BT_NMSTRT
        # (an attribute in one match, the common case: a name, =, a quoted value of plain characters, and what must
        # follow it; anything else is left to scan_atts, character by character, and its exact errors)
        if ns:
            start, rest = "A-Z_a-z" + _NMSTRT_NONASCII, "A-Z_a-z0-9.\\-" + _NAME_NONASCII
            qname = f"[{start}][{rest}]*(?::[{start}][{rest}]*)?"
        else:
            qname = f"[{nmstrt}][{name}]*"
        self.att_fast = _re.compile(qname + "[\\t\\n\\r ]*=[\\t\\n\\r ]*(?:\"[^\"<&" + _INVALID + "]*\"|'[^'<&" + _INVALID +
                                    "]*')(?=[\\t\\n\\r />])")
        self.space_run = _re.compile("[\\t\\n\\r ]*")
        self.not_normal = _re.compile("[\\t\\r\\n]|  ")


class _Tok:
    """expat's tokenizer (xmltok_impl.c) over a decoded text: each scanner returns (token, next index). `pc` is the
    index of a partial character at the final end (its bytes are incomplete), or -1."""

    __slots__ = ("s", "n", "pc", "c", "odd", "atts")

    def __init__(self, s, n, pc, chars, odd=False):
        self.s = s
        self.n = n
        self.pc = pc
        self.c = chars
        self.odd = odd
        self.atts = None            # (the attributes of the start tag just scanned, when the fast path read them)

    def bt(self, i):
        if i == self.pc:
            return _BT_PARTIAL
        ch = self.s[i]
        o = ord(ch)
        if o < 0x80:
            t = _ASCII_BT[o]
            return self.c.colon_bt if t == _BT_COLON else t
        if 0xD800 <= o <= 0xDFFF or o == 0xFFFE or o == 0xFFFF:
            return _BT_MALFORM
        return _BT_LEAD

    def is_nmstrt(self, i):
        return self.c.nmstrt.match(self.s, i, i + 1) is not None

    def is_name(self, i):
        return self.c.name_run.match(self.s, i, i + 1).end() == i + 1

    def name_end(self, i, end):
        """The end of the run of name characters (and, outside namespace processing, colons) from i."""
        while True:
            j = self.c.name_run.match(self.s, i, min(end, i + _WINDOW)).end()
            if j < min(end, i + _WINDOW) or j >= end:
                return j
            i = j

    # (CHECK_NMSTRT_CASES / CHECK_NAME_CASES / INVALID_CASES of a non-ASCII or invalid character: None to go on,
    # else the (token, next) to return)
    def _lead_nmstrt(self, t, i):
        if t == _BT_PARTIAL:
            return (_TOK_PARTIAL_CHAR, i)
        if t == _BT_MALFORM or t == _BT_NONXML or not self.is_nmstrt(i):
            return (_TOK_INVALID, i)
        return None

    def _lead_name(self, t, i):
        if t == _BT_PARTIAL:
            return (_TOK_PARTIAL_CHAR, i)
        if t == _BT_MALFORM or t == _BT_NONXML or not self.is_name(i):
            return (_TOK_INVALID, i)
        return None

    def _invalid_case(self, t, i):
        if t == _BT_PARTIAL:
            return (_TOK_PARTIAL_CHAR, i)
        if t == _BT_MALFORM or t == _BT_NONXML:
            return (_TOK_INVALID, i)
        return None

    def _partial(self, i):
        """The input ended inside a token: partial, or a partial character if one stands at the end."""
        return (_TOK_PARTIAL_CHAR, i) if self.pc >= 0 and i >= self.pc else (_TOK_PARTIAL, i)

    def end_of(self, end):
        return end if self.pc < 0 else self.pc + 1

    # ptr after "<!-"
    def scan_comment(self, i, end):
        if i < end:
            if self.bt(i) != _BT_MINUS:
                return (_TOK_INVALID, i)
            i += 1
            while i < end:
                r = self.c.plain_run.match(self.s, i, min(self.n, end, i + _WINDOW))
                if r is not None and r.end() > i:
                    i = r.end()
                    continue
                t = self.bt(i)
                if t == _BT_MINUS:
                    i += 1
                    if not i < end:
                        return self._partial(i)
                    if self.bt(i) == _BT_MINUS:
                        i += 1
                        if not i < end:
                            return self._partial(i)
                        if self.bt(i) != _BT_GT:
                            return (_TOK_INVALID, i)
                        return (_TOK_COMMENT, i + 1)
                    continue
                inv = self._invalid_case(t, i)
                if inv is not None:
                    return inv
                i += 1
        return self._partial(i)

    # ptr after "<!"
    def scan_decl(self, i, end):
        if not i < end:
            return self._partial(i)
        t = self.bt(i)
        if t == _BT_MINUS:
            return self.scan_comment(i + 1, end)
        if t == _BT_LSQB:
            return (_TOK_COND_SECT_OPEN, i + 1)
        if t == _BT_NMSTRT or t == _BT_HEX:
            i += 1
        else:
            return (_TOK_INVALID, i)
        while i < end:
            t = self.bt(i)
            if t == _BT_PERCNT:
                if not i + 1 < end:
                    return self._partial(i)
                if self.bt(i + 1) in (_BT_S, _BT_CR, _BT_LF, _BT_PERCNT):
                    return (_TOK_INVALID, i)
                return (_TOK_DECL_OPEN, i)
            if t == _BT_S or t == _BT_CR or t == _BT_LF:
                return (_TOK_DECL_OPEN, i)
            if t == _BT_NMSTRT or t == _BT_HEX:
                i += 1
            else:
                return (_TOK_INVALID, i)
        return self._partial(i)

    def check_pi_target(self, a, b):
        """(ok, token): an XML declaration's target is exactly 'xml'; 'XML' in any other case is an error."""
        if b - a != 3:
            return (True, _TOK_PI)
        x, m, l = self.s[a], self.s[a + 1], self.s[a + 2]
        if x not in "xX" or m not in "mM" or l not in "lL":
            return (True, _TOK_PI)
        if x == "X" or m == "M" or l == "L":
            return (False, _TOK_PI)
        return (True, _TOK_XML_DECL)

    # ptr after "<?"
    def scan_pi(self, i, end):
        target = i
        if not i < end:
            return self._partial(i)
        t = self.bt(i)
        if t == _BT_NMSTRT or t == _BT_HEX:
            i += 1
        elif t in (_BT_LEAD, _BT_MALFORM, _BT_NONXML, _BT_PARTIAL):
            r = self._lead_nmstrt(t, i)
            if r is not None:
                return r
            i += 1
        else:
            return (_TOK_INVALID, i)
        while i < end:
            j = self.name_end(i, min(end, self.n))
            if j > i:
                i = j
                continue
            t = self.bt(i)
            if t in (_BT_LEAD, _BT_MALFORM, _BT_NONXML, _BT_PARTIAL):
                r = self._lead_name(t, i)
                if r is not None:
                    return r
                i += 1
                continue
            if t == _BT_S or t == _BT_CR or t == _BT_LF:
                ok, tok = self.check_pi_target(target, i)
                if not ok:
                    return (_TOK_INVALID, i)
                i += 1
                while i < end:
                    r = self.c.plain_run.match(self.s, i, min(self.n, end, i + _WINDOW))
                    if r is not None and r.end() > i:
                        i = r.end()
                        continue
                    t = self.bt(i)
                    inv = self._invalid_case(t, i)
                    if inv is not None:
                        return inv
                    if t == _BT_QUEST:
                        i += 1
                        if not i < end:
                            return self._partial(i)
                        if self.bt(i) == _BT_GT:
                            return (tok, i + 1)
                        continue
                    i += 1
                return self._partial(i)
            if t == _BT_QUEST:
                ok, tok = self.check_pi_target(target, i)
                if not ok:
                    return (_TOK_INVALID, i)
                i += 1
                if not i < end:
                    return self._partial(i)
                if self.bt(i) == _BT_GT:
                    return (tok, i + 1)
                return (_TOK_INVALID, i)
            return (_TOK_INVALID, i)
        return self._partial(i)

    # ptr after "<!["
    def scan_cdata_section(self, i, end):
        if end - i < 6 and not (self.pc >= 0 and end > self.pc):
            return self._partial(i)
        for k, ch in enumerate("CDATA["):
            if not i + k < end:
                return self._partial(i + k)
            if self.bt(i + k) == _BT_PARTIAL:
                return (_TOK_INVALID, i + k)
            if self.s[i + k] != ch:
                return (_TOK_INVALID, i + k)
        return (_TOK_CDATA_SECT_OPEN, i + 6)

    def cdata_section_tok(self, i, end):
        if i >= end:
            return (_TOK_PARTIAL, i) if self.odd else (_TOK_NONE, i)
        t = self.bt(i)
        if t == _BT_RSQB:
            i += 1
            if not i < end:
                return self._partial(i)
            if self.bt(i) == _BT_RSQB:
                i += 1
                if not i < end:
                    return self._partial(i)
                if self.bt(i) == _BT_GT:
                    return (_TOK_CDATA_SECT_CLOSE, i + 1)
                i -= 1
        elif t == _BT_CR:
            i += 1
            if not i < end:
                return self._partial(i)
            if self.bt(i) == _BT_LF:
                i += 1
            return (_TOK_DATA_NEWLINE, i)
        elif t == _BT_LF:
            return (_TOK_DATA_NEWLINE, i + 1)
        else:
            inv = self._invalid_case(t, i)
            if inv is not None:
                return inv
            i += 1
        stop = min(end, self.n)
        while i < stop:
            r = self.c.cdata_run.match(self.s, i, min(stop, i + _WINDOW))
            if r is not None:
                i = r.end()
                continue
            break
        return (_TOK_DATA_CHARS, i)

    # ptr after "</"
    def scan_end_tag(self, i, end):
        if not i < end:
            return self._partial(i)
        t = self.bt(i)
        if t == _BT_NMSTRT or t == _BT_HEX:
            i += 1
        elif t in (_BT_LEAD, _BT_MALFORM, _BT_NONXML, _BT_PARTIAL):
            r = self._lead_nmstrt(t, i)
            if r is not None:
                return r
            i += 1
        else:
            return (_TOK_INVALID, i)
        while i < end:
            j = self.name_end(i, min(end, self.n))
            if j > i:
                i = j
                continue
            t = self.bt(i)
            if t in (_BT_LEAD, _BT_MALFORM, _BT_NONXML, _BT_PARTIAL):
                r = self._lead_name(t, i)
                if r is not None:
                    return r
                i += 1
                continue
            if t == _BT_S or t == _BT_CR or t == _BT_LF:
                i += 1
                while i < end:
                    t = self.bt(i)
                    if t == _BT_S or t == _BT_CR or t == _BT_LF:
                        i += 1
                        continue
                    if t == _BT_GT:
                        return (_TOK_END_TAG, i + 1)
                    if t == _BT_PARTIAL:
                        return (_TOK_INVALID, i)
                    return (_TOK_INVALID, i)
                return self._partial(i)
            if t == _BT_COLON:
                i += 1
                continue
            if t == _BT_GT:
                return (_TOK_END_TAG, i + 1)
            return (_TOK_INVALID, i)
        return self._partial(i)

    def _digits(self, i, end, hexa):
        """&#[x] digits ;"""
        if i < end:
            t = self.bt(i)
            if not (t == _BT_DIGIT or (hexa and t == _BT_HEX)):
                return (_TOK_INVALID, i)
            i += 1
            while i < end:
                t = self.bt(i)
                if t == _BT_DIGIT or (hexa and t == _BT_HEX):
                    i += 1
                    continue
                if t == _BT_SEMI:
                    return (_TOK_CHAR_REF, i + 1)
                return (_TOK_INVALID, i)
        return self._partial(i)

    # ptr after "&#"
    def scan_char_ref(self, i, end):
        if i < end:
            if self.bt(i) != _BT_PARTIAL and self.s[i] == "x":
                return self._digits(i + 1, end, True)
            t = self.bt(i)
            if t != _BT_DIGIT:
                return (_TOK_INVALID, i)
            return self._digits(i, end, False)
        return self._partial(i)

    # ptr after "&"
    def scan_ref(self, i, end):
        if not i < end:
            return self._partial(i)
        t = self.bt(i)
        if t == _BT_NMSTRT or t == _BT_HEX:
            i += 1
        elif t == _BT_NUM:
            return self.scan_char_ref(i + 1, end)
        elif t in (_BT_LEAD, _BT_MALFORM, _BT_NONXML, _BT_PARTIAL):
            r = self._lead_nmstrt(t, i)
            if r is not None:
                return r
            i += 1
        else:
            return (_TOK_INVALID, i)
        while i < end:
            j = self.name_end(i, min(end, self.n))
            if j > i:
                i = j
                continue
            t = self.bt(i)
            if t in (_BT_LEAD, _BT_MALFORM, _BT_NONXML, _BT_PARTIAL):
                r = self._lead_name(t, i)
                if r is not None:
                    return r
                i += 1
                continue
            if t == _BT_SEMI:
                return (_TOK_ENTITY_REF, i + 1)
            return (_TOK_INVALID, i)
        return self._partial(i)

    def _nmstrt_or(self, t, i):
        """CHECK_NMSTRT_CASES then the given type: (consumed?, result)"""
        if t == _BT_NMSTRT or t == _BT_HEX:
            return True, None
        if t in (_BT_LEAD, _BT_MALFORM, _BT_NONXML, _BT_PARTIAL):
            r = self._lead_nmstrt(t, i)
            return (r is None), r
        return False, None

    # ptr after the first character of an attribute's name
    def scan_atts(self, i, end):
        had_colon = False
        while i < end:
            j = self.name_end(i, min(end, self.n))
            if j > i:
                i = j
                continue
            t = self.bt(i)
            if t in (_BT_LEAD, _BT_MALFORM, _BT_NONXML, _BT_PARTIAL):
                r = self._lead_name(t, i)
                if r is not None:
                    return r
                i += 1
                continue
            if t == _BT_COLON:
                if had_colon:
                    return (_TOK_INVALID, i)
                had_colon = True
                i += 1
                if not i < end:
                    return self._partial(i)
                ok, r = self._nmstrt_or(self.bt(i), i)
                if r is not None:
                    return r
                if not ok:
                    return (_TOK_INVALID, i)
                i += 1
                continue
            if t == _BT_S or t == _BT_CR or t == _BT_LF:
                while True:
                    i += 1
                    if not i < end:
                        return self._partial(i)
                    t = self.bt(i)
                    if t == _BT_EQUALS:
                        break
                    if t == _BT_S or t == _BT_LF or t == _BT_CR:
                        continue
                    return (_TOK_INVALID, i)
                t = _BT_EQUALS
            if t == _BT_EQUALS:
                had_colon = False
                while True:
                    i += 1
                    if not i < end:
                        return self._partial(i)
                    opn = self.bt(i)
                    if opn == _BT_QUOT or opn == _BT_APOS:
                        break
                    if opn == _BT_S or opn == _BT_LF or opn == _BT_CR:
                        continue
                    return (_TOK_INVALID, i)
                i += 1
                # in the attribute value
                while True:
                    if not i < end:
                        return self._partial(i)
                    r = self.c.att_run.match(self.s, i, min(self.n, end, i + _WINDOW))
                    if r is not None and r.end() > i:
                        i = r.end()
                        continue
                    t = self.bt(i)
                    if t == opn:
                        break
                    inv = self._invalid_case(t, i)
                    if inv is not None:
                        return inv
                    if t == _BT_AMP:
                        tok, nxt = self.scan_ref(i + 1, end)
                        if tok <= 0:
                            return (tok, nxt)
                        i = nxt
                        continue
                    if t == _BT_LT:
                        return (_TOK_INVALID, i)
                    i += 1
                i += 1
                if not i < end:
                    return self._partial(i)
                t = self.bt(i)
                if t == _BT_SOL:
                    return self._sol(i, end, _TOK_EMPTY_ELEMENT_WITH_ATTS)
                if t == _BT_GT:
                    return (_TOK_START_TAG_WITH_ATTS, i + 1)
                if not (t == _BT_S or t == _BT_CR or t == _BT_LF):
                    return (_TOK_INVALID, i)
                # after the closing quote and white space
                while True:
                    i += 1
                    if not i < end:
                        return self._partial(i)
                    t = self.bt(i)
                    ok, r = self._nmstrt_or(t, i)
                    if r is not None:
                        return r
                    if ok:
                        i += 1
                        break
                    if t == _BT_S or t == _BT_CR or t == _BT_LF:
                        continue
                    if t == _BT_GT:
                        return (_TOK_START_TAG_WITH_ATTS, i + 1)
                    if t == _BT_SOL:
                        return self._sol(i, end, _TOK_EMPTY_ELEMENT_WITH_ATTS)
                    return (_TOK_INVALID, i)
                continue
            return (_TOK_INVALID, i)
        return self._partial(i)

    def _sol(self, i, end, tok):
        i += 1
        if not i < end:
            return self._partial(i)
        if self.bt(i) != _BT_GT:
            return (_TOK_INVALID, i)
        return (tok, i + 1)

    def scan_attributes(self, i, end):
        """The attributes of a start tag from the first one's name at i: each one in a single match while they are
        plain, recorded for storeAtts as getAtts would find them; from the first that isn't, scan_atts's exact path
        (and nothing recorded)"""
        c = self.c
        t = self.s
        atts = []
        while True:
            m = c.att_fast.match(t, i, min(self.n, end, i + _WINDOW))
            if m is None:
                self.atts = None
                return self.scan_atts(i + 1, end)
            eq = t.index("=", i)
            name_end = eq
            while t[name_end - 1] in " \t\r\n":
                name_end -= 1
            ve = m.end() - 1
            vs = t.index(t[ve], eq) + 1
            normalized = not (vs < ve and (t[vs] == " " or t[ve - 1] == " " or c.not_normal.search(t, vs, ve)))
            atts.append([i, name_end, vs, ve, normalized])
            j = c.space_run.match(t, m.end()).end()
            if j >= end or j >= self.n:
                return self._partial(j)
            ch = t[j]
            if ch == ">":
                self.atts = atts
                return (_TOK_START_TAG_WITH_ATTS, j + 1)
            if ch == "/":
                r = self._sol(j, end, _TOK_EMPTY_ELEMENT_WITH_ATTS)
                self.atts = atts if r[0] > 0 else None
                return r
            if j == m.end():
                self.atts = None
                return (_TOK_INVALID, j)
            i = j

    # ptr after "<"
    def scan_lt(self, i, end):
        if not i < end:
            return self._partial(i)
        t = self.bt(i)
        if t == _BT_EXCL:
            i += 1
            if not i < end:
                return self._partial(i)
            t = self.bt(i)
            if t == _BT_MINUS:
                return self.scan_comment(i + 1, end)
            if t == _BT_LSQB:
                return self.scan_cdata_section(i + 1, end)
            return (_TOK_INVALID, i)
        if t == _BT_QUEST:
            return self.scan_pi(i + 1, end)
        if t == _BT_SOL:
            return self.scan_end_tag(i + 1, end)
        ok, r = self._nmstrt_or(t, i)
        if r is not None:
            return r
        if not ok:
            return (_TOK_INVALID, i)
        i += 1
        had_colon = False
        while i < end:
            j = self.name_end(i, min(end, self.n))
            if j > i:
                i = j
                continue
            t = self.bt(i)
            if t in (_BT_LEAD, _BT_MALFORM, _BT_NONXML, _BT_PARTIAL):
                r = self._lead_name(t, i)
                if r is not None:
                    return r
                i += 1
                continue
            if t == _BT_COLON:
                if had_colon:
                    return (_TOK_INVALID, i)
                had_colon = True
                i += 1
                if not i < end:
                    return self._partial(i)
                ok, r = self._nmstrt_or(self.bt(i), i)
                if r is not None:
                    return r
                if not ok:
                    return (_TOK_INVALID, i)
                i += 1
                continue
            if t == _BT_S or t == _BT_CR or t == _BT_LF:
                i += 1
                while i < end:
                    t = self.bt(i)
                    ok, r = self._nmstrt_or(t, i)
                    if r is not None:
                        return r
                    if ok:
                        return self.scan_attributes(i, end)
                    if t == _BT_GT:
                        return (_TOK_START_TAG_NO_ATTS, i + 1)
                    if t == _BT_SOL:
                        return self._sol(i, end, _TOK_EMPTY_ELEMENT_NO_ATTS)
                    if t == _BT_S or t == _BT_CR or t == _BT_LF:
                        i += 1
                        continue
                    return (_TOK_INVALID, i)
                return self._partial(i)
            if t == _BT_GT:
                return (_TOK_START_TAG_NO_ATTS, i + 1)
            if t == _BT_SOL:
                return self._sol(i, end, _TOK_EMPTY_ELEMENT_NO_ATTS)
            return (_TOK_INVALID, i)
        return self._partial(i)

    def content_tok(self, i, end):
        if i >= end:
            return (_TOK_PARTIAL, i) if self.odd else (_TOK_NONE, i)
        t = self.bt(i)
        if t == _BT_LT:
            return self.scan_lt(i + 1, end)
        if t == _BT_AMP:
            return self.scan_ref(i + 1, end)
        if t == _BT_CR:
            i += 1
            if not i < end:
                return (_TOK_TRAILING_CR, i)
            if self.bt(i) == _BT_LF:
                i += 1
            return (_TOK_DATA_NEWLINE, i)
        if t == _BT_LF:
            return (_TOK_DATA_NEWLINE, i + 1)
        if t == _BT_RSQB:
            i += 1
            if not i < end:
                return (_TOK_TRAILING_RSQB, i)
            if self.bt(i) == _BT_RSQB:
                i += 1
                if not i < end:
                    return (_TOK_TRAILING_RSQB, i)
                if self.bt(i) == _BT_GT:
                    return (_TOK_INVALID, i)
                i -= 1
        else:
            inv = self._invalid_case(t, i)
            if inv is not None:
                return inv
            i += 1
        stop = min(end, self.n)
        while i < stop:
            r = self.c.data_run.match(self.s, i, min(stop, i + _WINDOW))
            if r is not None:
                i = r.end()
                continue
            # (a ] in data: "]]>" is invalid at its >; a ] that may begin one at the end of the input ends the run)
            if self.bt(i) == _BT_RSQB:
                if i + 1 < end:
                    if self.bt(i + 1) != _BT_RSQB:
                        i += 1
                        continue
                    if i + 2 < end:
                        if self.bt(i + 2) != _BT_GT:
                            i += 1
                            continue
                        return (_TOK_INVALID, i + 2)
            return (_TOK_DATA_CHARS, i)
        return (_TOK_DATA_CHARS, i)

    # ptr after "%"
    def scan_percent(self, i, end):
        if not i < end:
            return self._partial(i)
        t = self.bt(i)
        ok, r = self._nmstrt_or(t, i)
        if r is not None:
            return r
        if not ok:
            if t in (_BT_S, _BT_LF, _BT_CR, _BT_PERCNT):
                return (_TOK_PERCENT, i)
            return (_TOK_INVALID, i)
        i += 1
        while i < end:
            j = self.name_end(i, min(end, self.n))
            if j > i:
                i = j
                continue
            t = self.bt(i)
            if t in (_BT_LEAD, _BT_MALFORM, _BT_NONXML, _BT_PARTIAL):
                r = self._lead_name(t, i)
                if r is not None:
                    return r
                i += 1
                continue
            if t == _BT_SEMI:
                return (_TOK_PARAM_ENTITY_REF, i + 1)
            return (_TOK_INVALID, i)
        return self._partial(i)

    def scan_pound_name(self, i, end):
        if not i < end:
            return self._partial(i)
        ok, r = self._nmstrt_or(self.bt(i), i)
        if r is not None:
            return r
        if not ok:
            return (_TOK_INVALID, i)
        i += 1
        while i < end:
            j = self.name_end(i, min(end, self.n))
            if j > i:
                i = j
                continue
            t = self.bt(i)
            if t in (_BT_LEAD, _BT_MALFORM, _BT_NONXML, _BT_PARTIAL):
                r = self._lead_name(t, i)
                if r is not None:
                    return r
                i += 1
                continue
            if t in (_BT_CR, _BT_LF, _BT_S, _BT_RPAR, _BT_GT, _BT_PERCNT, _BT_VERBAR):
                return (_TOK_POUND_NAME, i)
            return (_TOK_INVALID, i)
        return (-_TOK_POUND_NAME, i)

    def scan_lit(self, opn, i, end):
        while i < end:
            r = self.c.plain_run.match(self.s, i, min(self.n, end, i + _WINDOW))
            if r is not None and r.end() > i:
                i = r.end()
                continue
            t = self.bt(i)
            inv = self._invalid_case(t, i)
            if inv is not None:
                return inv
            if t == _BT_QUOT or t == _BT_APOS:
                i += 1
                if t != opn:
                    continue
                if not i < end:
                    return (-_TOK_LITERAL, i)
                if self.bt(i) in (_BT_S, _BT_CR, _BT_LF, _BT_GT, _BT_PERCNT, _BT_LSQB):
                    return (_TOK_LITERAL, i)
                return (_TOK_INVALID, i)
            i += 1
        return self._partial(i)

    def prolog_tok(self, i, end):
        if i >= end:
            return (_TOK_PARTIAL, i) if self.odd else (_TOK_NONE, i)
        t = self.bt(i)
        if t == _BT_QUOT or t == _BT_APOS:
            return self.scan_lit(t, i + 1, end)
        if t == _BT_LT:
            i += 1
            if not i < end:
                return self._partial(i)
            t = self.bt(i)
            if t == _BT_EXCL:
                return self.scan_decl(i + 1, end)
            if t == _BT_QUEST:
                return self.scan_pi(i + 1, end)
            if t in (_BT_NMSTRT, _BT_HEX, _BT_LEAD, _BT_PARTIAL) or (t == _BT_MALFORM):
                if t == _BT_MALFORM:
                    return (_TOK_INVALID, i)
                return (_TOK_INSTANCE_START, i - 1)
            return (_TOK_INVALID, i)
        if t == _BT_CR:
            if i + 1 == end:
                return (-_TOK_PROLOG_S, end)
            t = _BT_S
        if t == _BT_S or t == _BT_LF:
            while True:
                i += 1
                if not i < end:
                    break
                t = self.bt(i)
                if t == _BT_S or t == _BT_LF:
                    continue
                if t == _BT_CR:
                    if i + 1 != end:
                        continue
                return (_TOK_PROLOG_S, i)
            return (_TOK_PROLOG_S, i)
        if t == _BT_PERCNT:
            return self.scan_percent(i + 1, end)
        if t == _BT_COMMA:
            return (_TOK_COMMA, i + 1)
        if t == _BT_LSQB:
            return (_TOK_OPEN_BRACKET, i + 1)
        if t == _BT_RSQB:
            i += 1
            if not i < end:
                return (-_TOK_CLOSE_BRACKET, i)
            if self.bt(i) == _BT_RSQB:
                if not i + 1 < end:
                    return self._partial(i)
                if self.bt(i + 1) == _BT_GT:
                    return (_TOK_COND_SECT_CLOSE, i + 2)
            return (_TOK_CLOSE_BRACKET, i)
        if t == _BT_LPAR:
            return (_TOK_OPEN_PAREN, i + 1)
        if t == _BT_RPAR:
            i += 1
            if not i < end:
                return (-_TOK_CLOSE_PAREN, i)
            t = self.bt(i)
            if t == _BT_AST:
                return (_TOK_CLOSE_PAREN_ASTERISK, i + 1)
            if t == _BT_QUEST:
                return (_TOK_CLOSE_PAREN_QUESTION, i + 1)
            if t == _BT_PLUS:
                return (_TOK_CLOSE_PAREN_PLUS, i + 1)
            if t in (_BT_CR, _BT_LF, _BT_S, _BT_GT, _BT_COMMA, _BT_VERBAR, _BT_RPAR):
                return (_TOK_CLOSE_PAREN, i)
            return (_TOK_INVALID, i)
        if t == _BT_VERBAR:
            return (_TOK_OR, i + 1)
        if t == _BT_GT:
            return (_TOK_DECL_CLOSE, i + 1)
        if t == _BT_NUM:
            return self.scan_pound_name(i + 1, end)
        if t == _BT_PARTIAL:
            return (_TOK_PARTIAL_CHAR, i)
        if t == _BT_LEAD or t == _BT_MALFORM:
            if t == _BT_MALFORM:
                return (_TOK_INVALID, i)
            if self.is_nmstrt(i):
                tok = _TOK_NAME
            elif self.is_name(i):
                tok = _TOK_NMTOKEN
            else:
                return (_TOK_INVALID, i)
            i += 1
        elif t == _BT_NMSTRT or t == _BT_HEX:
            tok = _TOK_NAME
            i += 1
        elif t in (_BT_DIGIT, _BT_NAME, _BT_MINUS, _BT_COLON):
            tok = _TOK_NMTOKEN
            i += 1
        else:
            return (_TOK_INVALID, i)
        while i < end:
            j = self.name_end(i, min(end, self.n))
            if j > i:
                i = j
                continue
            t = self.bt(i)
            if t in (_BT_LEAD, _BT_MALFORM, _BT_NONXML, _BT_PARTIAL):
                r = self._lead_name(t, i)
                if r is not None:
                    return r
                i += 1
                continue
            if t in (_BT_GT, _BT_RPAR, _BT_COMMA, _BT_VERBAR, _BT_LSQB, _BT_PERCNT, _BT_S, _BT_CR, _BT_LF):
                return (tok, i)
            if t == _BT_COLON:
                i += 1
                if tok == _TOK_NAME:
                    if not i < end:
                        return self._partial(i)
                    tok = _TOK_PREFIXED_NAME
                    t = self.bt(i)
                    if t in (_BT_LEAD, _BT_MALFORM, _BT_NONXML, _BT_PARTIAL):
                        r = self._lead_name(t, i)
                        if r is not None:
                            return r
                        i += 1
                    elif t in (_BT_NMSTRT, _BT_HEX, _BT_DIGIT, _BT_NAME, _BT_MINUS):
                        i += 1
                    else:
                        tok = _TOK_NMTOKEN
                elif tok == _TOK_PREFIXED_NAME:
                    tok = _TOK_NMTOKEN
                continue
            if t == _BT_PLUS:
                if tok == _TOK_NMTOKEN:
                    return (_TOK_INVALID, i)
                return (_TOK_NAME_PLUS, i + 1)
            if t == _BT_AST:
                if tok == _TOK_NMTOKEN:
                    return (_TOK_INVALID, i)
                return (_TOK_NAME_ASTERISK, i + 1)
            if t == _BT_QUEST:
                if tok == _TOK_NMTOKEN:
                    return (_TOK_INVALID, i)
                return (_TOK_NAME_QUESTION, i + 1)
            return (_TOK_INVALID, i)
        return (-tok, i)

    def attribute_value_tok(self, i, end):
        if i >= end:
            return (_TOK_NONE, i)
        start = i
        while i < end:
            t = self.bt(i)
            if t == _BT_AMP:
                if i == start:
                    return self.scan_ref(i + 1, end)
                return (_TOK_DATA_CHARS, i)
            if t == _BT_LT:
                return (_TOK_INVALID, i)
            if t == _BT_LF:
                if i == start:
                    return (_TOK_DATA_NEWLINE, i + 1)
                return (_TOK_DATA_CHARS, i)
            if t == _BT_CR:
                if i == start:
                    i += 1
                    if not i < end:
                        return (_TOK_TRAILING_CR, i)
                    if self.bt(i) == _BT_LF:
                        i += 1
                    return (_TOK_DATA_NEWLINE, i)
                return (_TOK_DATA_CHARS, i)
            if t == _BT_S:
                if i == start:
                    return (_TOK_ATTRIBUTE_VALUE_S, i + 1)
                return (_TOK_DATA_CHARS, i)
            r = self.c.att_run.match(self.s, i, min(end, i + _WINDOW))
            i = r.end() if r is not None and r.end() > i else i + 1
        return (_TOK_DATA_CHARS, i)

    def entity_value_tok(self, i, end):
        if i >= end:
            return (_TOK_NONE, i)
        start = i
        while i < end:
            t = self.bt(i)
            if t == _BT_AMP:
                if i == start:
                    return self.scan_ref(i + 1, end)
                return (_TOK_DATA_CHARS, i)
            if t == _BT_PERCNT:
                if i == start:
                    tok, nxt = self.scan_percent(i + 1, end)
                    return ((_TOK_INVALID, nxt) if tok == _TOK_PERCENT else (tok, nxt))
                return (_TOK_DATA_CHARS, i)
            if t == _BT_LF:
                if i == start:
                    return (_TOK_DATA_NEWLINE, i + 1)
                return (_TOK_DATA_CHARS, i)
            if t == _BT_CR:
                if i == start:
                    i += 1
                    if not i < end:
                        return (_TOK_TRAILING_CR, i)
                    if self.bt(i) == _BT_LF:
                        i += 1
                    return (_TOK_DATA_NEWLINE, i)
                return (_TOK_DATA_CHARS, i)
            r = self.c.plain_run.match(self.s, i, min(end, i + _WINDOW))
            i = r.end() if r is not None and r.end() > i else i + 1
        return (_TOK_DATA_CHARS, i)

    def ignore_section_tok(self, i, end):
        level = 0
        while i < end:
            t = self.bt(i)
            inv = self._invalid_case(t, i)
            if inv is not None:
                return inv
            if t == _BT_LT:
                i += 1
                if not i < end:
                    return self._partial(i)
                if self.bt(i) == _BT_EXCL:
                    i += 1
                    if not i < end:
                        return self._partial(i)
                    if self.bt(i) == _BT_LSQB:
                        level += 1
                        i += 1
                continue
            if t == _BT_RSQB:
                i += 1
                if not i < end:
                    return self._partial(i)
                if self.bt(i) == _BT_RSQB:
                    i += 1
                    if not i < end:
                        return self._partial(i)
                    if self.bt(i) == _BT_GT:
                        i += 1
                        if level == 0:
                            return (_TOK_IGNORE_SECT, i)
                        level -= 1
                continue
            i += 1
        return self._partial(i)

    def is_public_id(self, a, b):
        """(ok, bad index) for a literal [a, b) including its quotes"""
        for i in range(a + 1, b - 1):
            ch = self.s[i]
            o = ord(ch)
            if o < 0x80:
                t = _ASCII_BT[o]
                if t in (_BT_DIGIT, _BT_HEX, _BT_MINUS, _BT_APOS, _BT_LPAR, _BT_RPAR, _BT_PLUS, _BT_COMMA, _BT_SOL, _BT_EQUALS,
                         _BT_QUEST, _BT_CR, _BT_LF, _BT_SEMI, _BT_EXCL, _BT_AST, _BT_PERCNT, _BT_NUM, _BT_COLON):
                    continue
                if t == _BT_S:
                    if ch == "\t":
                        return (False, i)
                    continue
                if t == _BT_NAME or t == _BT_NMSTRT:
                    continue
                if ch in "$@":
                    continue
            return (False, i)
        return (True, -1)


# ---------------------------------------------------------------------------- the prolog's roles (xmlrole.c)
(_ROLE_ERROR, _ROLE_NONE, _ROLE_XML_DECL, _ROLE_INSTANCE_START, _ROLE_DOCTYPE_NONE, _ROLE_DOCTYPE_NAME, _ROLE_DOCTYPE_SYSTEM_ID,
 _ROLE_DOCTYPE_PUBLIC_ID, _ROLE_DOCTYPE_INTERNAL_SUBSET, _ROLE_DOCTYPE_CLOSE, _ROLE_GENERAL_ENTITY_NAME,
 _ROLE_PARAM_ENTITY_NAME, _ROLE_ENTITY_NONE, _ROLE_ENTITY_VALUE, _ROLE_ENTITY_SYSTEM_ID, _ROLE_ENTITY_PUBLIC_ID,
 _ROLE_ENTITY_COMPLETE, _ROLE_ENTITY_NOTATION_NAME, _ROLE_NOTATION_NONE, _ROLE_NOTATION_NAME, _ROLE_NOTATION_SYSTEM_ID,
 _ROLE_NOTATION_NO_SYSTEM_ID, _ROLE_NOTATION_PUBLIC_ID, _ROLE_ATTRIBUTE_NAME, _ROLE_ATTRIBUTE_TYPE_CDATA,
 _ROLE_ATTRIBUTE_TYPE_ID, _ROLE_ATTRIBUTE_TYPE_IDREF, _ROLE_ATTRIBUTE_TYPE_IDREFS, _ROLE_ATTRIBUTE_TYPE_ENTITY,
 _ROLE_ATTRIBUTE_TYPE_ENTITIES, _ROLE_ATTRIBUTE_TYPE_NMTOKEN, _ROLE_ATTRIBUTE_TYPE_NMTOKENS, _ROLE_ATTRIBUTE_ENUM_VALUE,
 _ROLE_ATTRIBUTE_NOTATION_VALUE, _ROLE_ATTLIST_NONE, _ROLE_ATTLIST_ELEMENT_NAME, _ROLE_IMPLIED_ATTRIBUTE_VALUE,
 _ROLE_REQUIRED_ATTRIBUTE_VALUE, _ROLE_DEFAULT_ATTRIBUTE_VALUE, _ROLE_FIXED_ATTRIBUTE_VALUE, _ROLE_ELEMENT_NONE,
 _ROLE_ELEMENT_NAME, _ROLE_CONTENT_ANY, _ROLE_CONTENT_EMPTY, _ROLE_CONTENT_PCDATA, _ROLE_GROUP_OPEN, _ROLE_GROUP_CLOSE,
 _ROLE_GROUP_CLOSE_REP, _ROLE_GROUP_CLOSE_OPT, _ROLE_GROUP_CLOSE_PLUS, _ROLE_GROUP_CHOICE, _ROLE_GROUP_SEQUENCE,
 _ROLE_CONTENT_ELEMENT, _ROLE_CONTENT_ELEMENT_REP, _ROLE_CONTENT_ELEMENT_OPT, _ROLE_CONTENT_ELEMENT_PLUS, _ROLE_PI,
 _ROLE_COMMENT, _ROLE_TEXT_DECL, _ROLE_IGNORE_SECT, _ROLE_INNER_PARAM_ENTITY_REF, _ROLE_PARAM_ENTITY_REF) = range(-1, 61)

_ATT_TYPES = ("CDATA", "ID", "IDREF", "IDREFS", "ENTITY", "ENTITIES", "NMTOKEN", "NMTOKENS")


class _Prolog:
    """The prolog's state (PROLOG_STATE): which declaration a token belongs to, and its role there."""

    __slots__ = ("handler", "level", "role_none", "document_entity", "include_level", "in_entity_value")

    def __init__(self):
        self.handler = "prolog0"
        self.level = 0
        self.role_none = _ROLE_NONE
        self.document_entity = True
        self.include_level = 0
        self.in_entity_value = False

    def _common(self, tok):
        if not self.document_entity and tok == _TOK_PARAM_ENTITY_REF:
            return _ROLE_INNER_PARAM_ENTITY_REF
        self.handler = "error"
        return _ROLE_ERROR

    def _top(self):
        self.handler = "internalSubset" if self.document_entity else "externalSubset1"

    def role(self, tok, text, a, b):
        """XmlTokenRole: `text[a:b]` is the token."""
        h = self.handler
        word = text[a:b] if tok in (_TOK_NAME, _TOK_DECL_OPEN, _TOK_POUND_NAME) else None
        if h == "prolog0" or h == "prolog1":
            if tok == _TOK_PROLOG_S:
                self.handler = "prolog1"
                return _ROLE_NONE
            if tok == _TOK_XML_DECL and h == "prolog0":
                self.handler = "prolog1"
                return _ROLE_XML_DECL
            if tok == _TOK_PI:
                self.handler = "prolog1"
                return _ROLE_PI
            if tok == _TOK_COMMENT:
                self.handler = "prolog1"
                return _ROLE_COMMENT
            if tok == _TOK_BOM:
                return _ROLE_NONE
            if tok == _TOK_DECL_OPEN:
                if word[2:] == "DOCTYPE":
                    self.handler = "doctype0"
                    return _ROLE_DOCTYPE_NONE
                return self._common(tok)
            if tok == _TOK_INSTANCE_START:
                self.handler = "error"
                return _ROLE_INSTANCE_START
            return self._common(tok)
        if h == "prolog2":
            if tok == _TOK_PROLOG_S:
                return _ROLE_NONE
            if tok == _TOK_PI:
                return _ROLE_PI
            if tok == _TOK_COMMENT:
                return _ROLE_COMMENT
            if tok == _TOK_INSTANCE_START:
                self.handler = "error"
                return _ROLE_INSTANCE_START
            return self._common(tok)
        if h == "doctype0":
            if tok == _TOK_PROLOG_S:
                return _ROLE_DOCTYPE_NONE
            if tok == _TOK_NAME or tok == _TOK_PREFIXED_NAME:
                self.handler = "doctype1"
                return _ROLE_DOCTYPE_NAME
            return self._common(tok)
        if h == "doctype1":
            if tok == _TOK_PROLOG_S:
                return _ROLE_DOCTYPE_NONE
            if tok == _TOK_OPEN_BRACKET:
                self.handler = "internalSubset"
                return _ROLE_DOCTYPE_INTERNAL_SUBSET
            if tok == _TOK_DECL_CLOSE:
                self.handler = "prolog2"
                return _ROLE_DOCTYPE_CLOSE
            if tok == _TOK_NAME:
                if word == "SYSTEM":
                    self.handler = "doctype3"
                    return _ROLE_DOCTYPE_NONE
                if word == "PUBLIC":
                    self.handler = "doctype2"
                    return _ROLE_DOCTYPE_NONE
            return self._common(tok)
        if h == "doctype2":
            if tok == _TOK_PROLOG_S:
                return _ROLE_DOCTYPE_NONE
            if tok == _TOK_LITERAL:
                self.handler = "doctype3"
                return _ROLE_DOCTYPE_PUBLIC_ID
            return self._common(tok)
        if h == "doctype3":
            if tok == _TOK_PROLOG_S:
                return _ROLE_DOCTYPE_NONE
            if tok == _TOK_LITERAL:
                self.handler = "doctype4"
                return _ROLE_DOCTYPE_SYSTEM_ID
            return self._common(tok)
        if h == "doctype4":
            if tok == _TOK_PROLOG_S:
                return _ROLE_DOCTYPE_NONE
            if tok == _TOK_OPEN_BRACKET:
                self.handler = "internalSubset"
                return _ROLE_DOCTYPE_INTERNAL_SUBSET
            if tok == _TOK_DECL_CLOSE:
                self.handler = "prolog2"
                return _ROLE_DOCTYPE_CLOSE
            return self._common(tok)
        if h == "doctype5":
            if tok == _TOK_PROLOG_S:
                return _ROLE_DOCTYPE_NONE
            if tok == _TOK_DECL_CLOSE:
                self.handler = "prolog2"
                return _ROLE_DOCTYPE_CLOSE
            return self._common(tok)
        if h == "internalSubset":
            return self._internal_subset(tok, word)
        if h == "externalSubset1":
            if tok == _TOK_COND_SECT_OPEN:
                self.handler = "condSect0"
                return _ROLE_NONE
            if tok == _TOK_COND_SECT_CLOSE:
                if self.include_level == 0:
                    return self._common(tok)
                self.include_level -= 1
                return _ROLE_NONE
            if tok == _TOK_PROLOG_S:
                return _ROLE_NONE
            if tok == _TOK_CLOSE_BRACKET:
                return self._common(tok)
            if tok == _TOK_NONE:
                if self.include_level:
                    return self._common(tok)
                return _ROLE_NONE
            return self._internal_subset(tok, word)
        if h.startswith("entity"):
            return self._entity(int(h[6:]), tok, word)
        if h.startswith("notation"):
            return self._notation(int(h[8:]), tok, word)
        if h.startswith("attlist"):
            return self._attlist(int(h[7:]), tok, word)
        if h.startswith("element"):
            return self._element(int(h[7:]), tok, word)
        if h == "condSect0":
            if tok == _TOK_PROLOG_S:
                return _ROLE_NONE
            if tok == _TOK_NAME:
                if word == "INCLUDE":
                    self.handler = "condSect1"
                    return _ROLE_NONE
                if word == "IGNORE":
                    self.handler = "condSect2"
                    return _ROLE_NONE
            return self._common(tok)
        if h == "condSect1" or h == "condSect2":
            if tok == _TOK_PROLOG_S:
                return _ROLE_NONE
            if tok == _TOK_OPEN_BRACKET:
                self.handler = "externalSubset1"
                if h == "condSect1":
                    self.include_level += 1
                    return _ROLE_NONE
                return _ROLE_IGNORE_SECT
            return self._common(tok)
        if h == "declClose":
            if tok == _TOK_PROLOG_S:
                return self.role_none
            if tok == _TOK_DECL_CLOSE:
                self._top()
                return self.role_none
            return self._common(tok)
        # (error: the processor has already switched; nothing is asked of it here)
        return _ROLE_NONE

    def _internal_subset(self, tok, word):
        if tok == _TOK_PROLOG_S:
            return _ROLE_NONE
        if tok == _TOK_DECL_OPEN:
            kw = word[2:]
            if kw == "ENTITY":
                self.handler = "entity0"
                return _ROLE_ENTITY_NONE
            if kw == "ATTLIST":
                self.handler = "attlist0"
                return _ROLE_ATTLIST_NONE
            if kw == "ELEMENT":
                self.handler = "element0"
                return _ROLE_ELEMENT_NONE
            if kw == "NOTATION":
                self.handler = "notation0"
                return _ROLE_NOTATION_NONE
            return self._common(tok)
        if tok == _TOK_PI:
            return _ROLE_PI
        if tok == _TOK_COMMENT:
            return _ROLE_COMMENT
        if tok == _TOK_PARAM_ENTITY_REF:
            return _ROLE_PARAM_ENTITY_REF
        if tok == _TOK_CLOSE_BRACKET:
            self.handler = "doctype5"
            return _ROLE_DOCTYPE_NONE
        if tok == _TOK_NONE:
            return _ROLE_NONE
        return self._common(tok)

    def _entity(self, n, tok, word):
        if tok == _TOK_PROLOG_S:
            return _ROLE_ENTITY_NONE
        if n == 0:
            if tok == _TOK_PERCENT:
                self.handler = "entity1"
                return _ROLE_ENTITY_NONE
            if tok == _TOK_NAME:
                self.handler = "entity2"
                return _ROLE_GENERAL_ENTITY_NAME
        elif n == 1:
            if tok == _TOK_NAME:
                self.handler = "entity7"
                return _ROLE_PARAM_ENTITY_NAME
        elif n == 2 or n == 7:
            if tok == _TOK_NAME:
                if word == "SYSTEM":
                    self.handler = "entity4" if n == 2 else "entity9"
                    return _ROLE_ENTITY_NONE
                if word == "PUBLIC":
                    self.handler = "entity3" if n == 2 else "entity8"
                    return _ROLE_ENTITY_NONE
            elif tok == _TOK_LITERAL:
                self.handler = "declClose"
                self.role_none = _ROLE_ENTITY_NONE
                return _ROLE_ENTITY_VALUE
        elif n == 3 or n == 8:
            if tok == _TOK_LITERAL:
                self.handler = "entity4" if n == 3 else "entity9"
                return _ROLE_ENTITY_PUBLIC_ID
        elif n == 4 or n == 9:
            if tok == _TOK_LITERAL:
                self.handler = "entity5" if n == 4 else "entity10"
                return _ROLE_ENTITY_SYSTEM_ID
        elif n == 5:
            if tok == _TOK_DECL_CLOSE:
                self._top()
                return _ROLE_ENTITY_COMPLETE
            if tok == _TOK_NAME and word == "NDATA":
                self.handler = "entity6"
                return _ROLE_ENTITY_NONE
        elif n == 6:
            if tok == _TOK_NAME:
                self.handler = "declClose"
                self.role_none = _ROLE_ENTITY_NONE
                return _ROLE_ENTITY_NOTATION_NAME
        elif n == 10:
            if tok == _TOK_DECL_CLOSE:
                self._top()
                return _ROLE_ENTITY_COMPLETE
        return self._common(tok)

    def _notation(self, n, tok, word):
        if tok == _TOK_PROLOG_S:
            return _ROLE_NOTATION_NONE
        if n == 0:
            if tok == _TOK_NAME:
                self.handler = "notation1"
                return _ROLE_NOTATION_NAME
        elif n == 1:
            if tok == _TOK_NAME:
                if word == "SYSTEM":
                    self.handler = "notation3"
                    return _ROLE_NOTATION_NONE
                if word == "PUBLIC":
                    self.handler = "notation2"
                    return _ROLE_NOTATION_NONE
        elif n == 2:
            if tok == _TOK_LITERAL:
                self.handler = "notation4"
                return _ROLE_NOTATION_PUBLIC_ID
        elif n == 3:
            if tok == _TOK_LITERAL:
                self.handler = "declClose"
                self.role_none = _ROLE_NOTATION_NONE
                return _ROLE_NOTATION_SYSTEM_ID
        elif n == 4:
            if tok == _TOK_LITERAL:
                self.handler = "declClose"
                self.role_none = _ROLE_NOTATION_NONE
                return _ROLE_NOTATION_SYSTEM_ID
            if tok == _TOK_DECL_CLOSE:
                self._top()
                return _ROLE_NOTATION_NO_SYSTEM_ID
        return self._common(tok)

    def _attlist(self, n, tok, word):
        if tok == _TOK_PROLOG_S:
            return _ROLE_ATTLIST_NONE
        if n == 0:
            if tok == _TOK_NAME or tok == _TOK_PREFIXED_NAME:
                self.handler = "attlist1"
                return _ROLE_ATTLIST_ELEMENT_NAME
        elif n == 1:
            if tok == _TOK_DECL_CLOSE:
                self._top()
                return _ROLE_ATTLIST_NONE
            if tok == _TOK_NAME or tok == _TOK_PREFIXED_NAME:
                self.handler = "attlist2"
                return _ROLE_ATTRIBUTE_NAME
        elif n == 2:
            if tok == _TOK_NAME:
                if word in _ATT_TYPES:
                    self.handler = "attlist8"
                    return _ROLE_ATTRIBUTE_TYPE_CDATA + _ATT_TYPES.index(word)
                if word == "NOTATION":
                    self.handler = "attlist5"
                    return _ROLE_ATTLIST_NONE
            elif tok == _TOK_OPEN_PAREN:
                self.handler = "attlist3"
                return _ROLE_ATTLIST_NONE
        elif n == 3:
            if tok in (_TOK_NMTOKEN, _TOK_NAME, _TOK_PREFIXED_NAME):
                self.handler = "attlist4"
                return _ROLE_ATTRIBUTE_ENUM_VALUE
        elif n == 4 or n == 7:
            if tok == _TOK_CLOSE_PAREN:
                self.handler = "attlist8"
                return _ROLE_ATTLIST_NONE
            if tok == _TOK_OR:
                self.handler = "attlist3" if n == 4 else "attlist6"
                return _ROLE_ATTLIST_NONE
        elif n == 5:
            if tok == _TOK_OPEN_PAREN:
                self.handler = "attlist6"
                return _ROLE_ATTLIST_NONE
        elif n == 6:
            if tok == _TOK_NAME:
                self.handler = "attlist7"
                return _ROLE_ATTRIBUTE_NOTATION_VALUE
        elif n == 8:
            if tok == _TOK_POUND_NAME:
                kw = word[1:]
                if kw == "IMPLIED":
                    self.handler = "attlist1"
                    return _ROLE_IMPLIED_ATTRIBUTE_VALUE
                if kw == "REQUIRED":
                    self.handler = "attlist1"
                    return _ROLE_REQUIRED_ATTRIBUTE_VALUE
                if kw == "FIXED":
                    self.handler = "attlist9"
                    return _ROLE_ATTLIST_NONE
            elif tok == _TOK_LITERAL:
                self.handler = "attlist1"
                return _ROLE_DEFAULT_ATTRIBUTE_VALUE
        elif n == 9:
            if tok == _TOK_LITERAL:
                self.handler = "attlist1"
                return _ROLE_FIXED_ATTRIBUTE_VALUE
        return self._common(tok)

    def _element(self, n, tok, word):
        if tok == _TOK_PROLOG_S:
            return _ROLE_ELEMENT_NONE
        if n == 0:
            if tok == _TOK_NAME or tok == _TOK_PREFIXED_NAME:
                self.handler = "element1"
                return _ROLE_ELEMENT_NAME
        elif n == 1:
            if tok == _TOK_NAME:
                if word == "EMPTY" or word == "ANY":
                    self.handler = "declClose"
                    self.role_none = _ROLE_ELEMENT_NONE
                    return _ROLE_CONTENT_EMPTY if word == "EMPTY" else _ROLE_CONTENT_ANY
            elif tok == _TOK_OPEN_PAREN:
                self.handler = "element2"
                self.level = 1
                return _ROLE_GROUP_OPEN
        elif n == 2 or n == 6:
            if n == 2 and tok == _TOK_POUND_NAME:
                if word[1:] == "PCDATA":
                    self.handler = "element3"
                    return _ROLE_CONTENT_PCDATA
                return self._common(tok)
            if tok == _TOK_OPEN_PAREN:
                if n == 2:
                    self.level = 2
                    self.handler = "element6"
                else:
                    self.level += 1
                return _ROLE_GROUP_OPEN
            if tok == _TOK_NAME or tok == _TOK_PREFIXED_NAME:
                self.handler = "element7"
                return _ROLE_CONTENT_ELEMENT
            if tok == _TOK_NAME_QUESTION:
                self.handler = "element7"
                return _ROLE_CONTENT_ELEMENT_OPT
            if tok == _TOK_NAME_ASTERISK:
                self.handler = "element7"
                return _ROLE_CONTENT_ELEMENT_REP
            if tok == _TOK_NAME_PLUS:
                self.handler = "element7"
                return _ROLE_CONTENT_ELEMENT_PLUS
        elif n == 3:
            if tok == _TOK_CLOSE_PAREN or tok == _TOK_CLOSE_PAREN_ASTERISK:
                self.handler = "declClose"
                self.role_none = _ROLE_ELEMENT_NONE
                return _ROLE_GROUP_CLOSE if tok == _TOK_CLOSE_PAREN else _ROLE_GROUP_CLOSE_REP
            if tok == _TOK_OR:
                self.handler = "element4"
                return _ROLE_ELEMENT_NONE
        elif n == 4:
            if tok == _TOK_NAME or tok == _TOK_PREFIXED_NAME:
                self.handler = "element5"
                return _ROLE_CONTENT_ELEMENT
        elif n == 5:
            if tok == _TOK_CLOSE_PAREN_ASTERISK:
                self.handler = "declClose"
                self.role_none = _ROLE_ELEMENT_NONE
                return _ROLE_GROUP_CLOSE_REP
            if tok == _TOK_OR:
                self.handler = "element4"
                return _ROLE_ELEMENT_NONE
        elif n == 7:
            close = {_TOK_CLOSE_PAREN: _ROLE_GROUP_CLOSE, _TOK_CLOSE_PAREN_ASTERISK: _ROLE_GROUP_CLOSE_REP,
                     _TOK_CLOSE_PAREN_QUESTION: _ROLE_GROUP_CLOSE_OPT, _TOK_CLOSE_PAREN_PLUS: _ROLE_GROUP_CLOSE_PLUS}
            if tok in close:
                self.level -= 1
                if self.level == 0:
                    self.handler = "declClose"
                    self.role_none = _ROLE_ELEMENT_NONE
                return close[tok]
            if tok == _TOK_COMMA:
                self.handler = "element6"
                return _ROLE_GROUP_SEQUENCE
            if tok == _TOK_OR:
                self.handler = "element6"
                return _ROLE_GROUP_CHOICE
        return self._common(tok)


class _IncDecoder:
    """The input's incremental decoding (bytes it can't decode become lone surrogates, surrogateescape): it holds back
    the bytes of a character not yet complete, even at the end, where they are expat's partial character."""

    __slots__ = ("enc", "pending")

    def __init__(self, enc):
        self.enc = enc
        self.pending = b""

    @property
    def held(self):
        return len(self.pending)

    @property
    def partial_char(self):
        """Do the held bytes begin a character (expat's partial character), or only truncate UTF-16 (odd)?"""
        return len(self.pending) >= (2 if self.enc in ("utf-16-le", "utf-16-be") else 1)

    def _tail(self, b):
        """How many bytes at the end of b to hold: from the first lead byte whose character needs more bytes than
        remain, whatever those are (expat's XML_TOK_PARTIAL_CHAR comes before its validity check); in UTF-16, an odd
        byte too"""
        n = len(b)
        if self.enc == "utf-8":
            for k in (3, 2, 1):
                if n >= k:
                    lead = b[n - k]
                    need = 2 if 0xC0 <= lead <= 0xDF else 3 if 0xE0 <= lead <= 0xEF else 4 if 0xF0 <= lead <= 0xF4 else 0
                    if need > k:
                        return k
            return 0
        if self.enc in ("utf-16-le", "utf-16-be"):
            odd = n & 1
            if n - odd >= 2:
                unit = b[n - odd - 2:n - odd]
                hi = unit[1] if self.enc == "utf-16-le" else unit[0]
                if 0xD8 <= hi <= 0xDB:
                    return odd + 2
            return odd
        return 0

    def decode(self, data, final=False):
        b = self.pending + data if self.pending else data
        k = self._tail(b)
        self.pending = b[len(b) - k:] if k else b""
        if k:
            b = b[:len(b) - k]
        return b.decode(self.enc, "surrogateescape")


# ---------------------------------------------------------------------------- the DTD's tables (xmlparse.c)
class _Entity:
    __slots__ = ("name", "text", "system_id", "public_id", "base", "notation", "is_param", "is_internal", "open")

    def __init__(self, name):
        self.name = name
        self.text = None
        self.system_id = None
        self.public_id = None
        self.base = None
        self.notation = None
        self.is_param = False
        self.is_internal = True
        self.open = False


class _Prefix:
    __slots__ = ("name", "binding")

    def __init__(self, name):
        self.name = name
        self.binding = None


class _AttId:
    __slots__ = ("name", "prefix", "xmlns", "maybe_tokenized")

    def __init__(self, name):
        self.name = name
        self.prefix = None
        self.xmlns = False
        self.maybe_tokenized = False


class _ElementType:
    __slots__ = ("name", "prefix", "default_atts", "default_for_name", "id_att")

    def __init__(self, name):
        self.name = name
        self.prefix = None
        self.default_atts = []          # [att id, value or None, is CDATA]
        self.default_for_name = {}      # attribute name -> index in default_atts
        self.id_att = None


class _Binding:
    __slots__ = ("prefix", "att_id", "uri", "prev")

    def __init__(self, prefix, att_id, uri, prev):
        self.prefix = prefix
        self.att_id = att_id
        self.uri = uri
        self.prev = prev


class _Dtd:
    __slots__ = ("general", "param", "element_types", "attribute_ids", "prefixes", "default_prefix", "keep_processing",
                 "has_param_entity_refs", "standalone", "param_entity_read")

    def __init__(self):
        self.general = {}
        self.param = {}
        self.element_types = {}
        self.attribute_ids = {}
        self.prefixes = {}
        self.default_prefix = _Prefix(None)
        self.keep_processing = True
        self.has_param_entity_refs = False
        self.standalone = False
        self.param_entity_read = False


class _Error(Exception):
    """An expat error inside the processors: its code, and the event index (in the document text) it is reported at,
    when that differs from the current event."""

    def __init__(self, code, at=None):
        self.code = code
        self.at = at


_XML_NS = "http://www.w3.org/XML/1998/namespace"
_XMLNS_NS = "http://www.w3.org/2000/xmlns/"
_URI_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789%-._~:/?#[]@!$&'()*+,;=")
_KNOWN_ENCODINGS = {"ISO-8859-1": "latin-1", "US-ASCII": "ascii", "UTF-8": "utf-8", "UTF-16": "utf-16",
                    "UTF-16BE": "utf-16-be", "UTF-16LE": "utf-16-le"}
_MAX_CHUNK_SIZE = 1 << 20      # (pyexpat feeds expat at most this much a call)
_CONTEXT_BYTES = 1024          # (XML_CONTEXT_BYTES: what expat's buffer keeps of what it parsed)
_INIT_BUFFER_SIZE = 1024
_BUFFER_SIZE = 8192            # (pyexpat's character data buffer)

# the parser's own memory accounting (design note r3 section 4.3): a held string costs 2 l + 64 bytes, a container
# entry 96, an element-stack or entity-stack frame 256; charged before what it pays for is built
_STR_COST = 64
_ENTRY_COST = 96
_FRAME_COST = 256


def _str_cost(n):
    return 2 * n + _STR_COST


_HANDLER_NAMES = (
    "StartElementHandler", "EndElementHandler", "ProcessingInstructionHandler", "CharacterDataHandler",
    "UnparsedEntityDeclHandler", "NotationDeclHandler", "StartNamespaceDeclHandler", "EndNamespaceDeclHandler",
    "CommentHandler", "StartCdataSectionHandler", "EndCdataSectionHandler", "DefaultHandler", "DefaultHandlerExpand",
    "NotStandaloneHandler", "ExternalEntityRefHandler", "StartDoctypeDeclHandler", "EndDoctypeDeclHandler",
    "EntityDeclHandler", "XmlDeclHandler", "ElementDeclHandler", "AttlistDeclHandler", "SkippedEntityHandler",
)
# (handlers this slice doesn't implement: reading external entities is outside it (no resolver, no I/O), and so is the
# content-model tree of an element declaration; setting one to anything but None says so, before any parsing)
_UNSUPPORTED_HANDLERS = frozenset(("ExternalEntityRefHandler", "ElementDeclHandler"))
_CREATE = object()


class xmlparser:
    """XML parser"""

    def __init__(self, *args, **kwargs):
        if not args or args[0] is not _CREATE:
            raise TypeError("cannot create 'pyexpat.xmlparser' instances")
        _, encoding, sep, intern = args
        for name in _HANDLER_NAMES:
            object.__setattr__(self, name, None)
        self._ns = sep is not None
        self._sep = sep if sep is not None else ""
        self._chars = _Chars(self._ns)
        self._intern = intern
        self._buffer_text = False
        self._buffer_size = _BUFFER_SIZE
        self._buffer = []
        self._buffer_used = 0
        self.ordered_attributes = False
        self.specified_attributes = False
        self._ns_triplets = False
        self._in_callback = False
        self._dtd = _Dtd()
        self._prolog = _Prolog()
        self._processor = "init"
        self._status = "initialized"
        self._final = False
        self._protocol_enc = encoding
        self._enc = None          # the Python codec of the input, once known
        self._unit = 1            # bytes of its smallest character (2 for UTF-16)
        self._decoder = None
        self._raw = b""           # bytes not yet decoded: before the encoding is known, or while one waits
        self._raw_parts = []      # bytes fed and not yet looked at (the reparse deferral waits), joined at an attempt
        self._raw_pending = 0
        self._work = [0, 0, 0, 0]
        self._text = ""           # the decoded document not yet consumed (and the context expat keeps)
        self._pc = -1             # the index of a partial character at the final end, or -1
        self._posidx = 0          # the text index up to which (line, col) is known
        self._line = 0
        self._col = 0
        # (state written per token, in lists: [event index (expat's eventPtr), its end], [direct bytes,
        # indirect bytes, the parser's own memory]; a list's item, unlike an attribute, isn't set through
        # __setattr__)
        self._ev = [0, 0]
        self._acc = [0, 0, 0]
        self._bytes_fed = 0
        self._held = 0            # undecoded bytes held by the decoder (an incomplete character)
        self._buf_cap = 0         # expat's buffer, in bytes: capacity, parse position, end (for reparse deferral)
        self._buf_ptr = 0
        self._buf_end = 0
        self._last_request = 0
        self._partial_before = 0
        self._deferral = True
        self._error_code = 0
        self._error_line = 0
        self._error_col = 0
        self._error_byte = -1
        self._tag_stack = []
        self._tag_level = 0
        self._open = []           # open internal entities (content): [entity, text, index, start tag level]
        self._amp_max = 100.0
        self._amp_act = 8388608
        self._at_max = 100.0
        self._at_act = 67108864
        self._doctype = None      # [name, system id, public id] while a DOCTYPE is reported
        self._decl = None         # the declaration being read: entity, element type, attribute id, type, ...
        self._group = []
        self._started = False
        self._finished = False
        self._base = None
        self._param_parsing = XML_PARAM_ENTITY_PARSING_NEVER
        self._default_expand = True
        self._last_error_at = None
        self._scan = None
        self._default_kind = None
        self._decl_entity = None
        self._decl_element = None
        self._decl_att = None
        self._decl_att_cdata = False
        self._decl_att_type = None
        self._decl_att_id = False
        self._decl_notation = None
        self._decl_notation_pubid = None
        self._doctype_sysid = None
        self._decl_phase = False
        self._await_decl = False
        self._odd = False
        self._error_span = None
        self._error_pos = (0, 0)
        self._end_at = None
        self._unknown_map = None
        self._cdata_resume = 0
        self._bom_pending = True
        if self._ns:
            # (the implicit context of a namespace-processing parser: the xml prefix bound to its namespace)
            xml = self._prefix("xml")
            xml.binding = _Binding(xml, None, _XML_NS + self._sep, None)

    def __repr__(self):
        return f"<pyexpat.xmlparser object at {id(self):#x}>"

    # ------------------------------------------------------------------ attributes
    def __setattr__(self, name, value):
        if name[:1] == "_":
            object.__setattr__(self, name, value)
            return
        if name in _HANDLER_NAMES:
            if name in _UNSUPPORTED_HANDLERS and value is not None:
                raise NotImplementedError(f"pyexpat.xmlparser.{name} is not supported in Sagebrush: the parser "
                                          "reads no external entity, and builds no element content model")
            if name != "CharacterDataHandler":
                pass
            elif self._buffer_used:
                self._flush()
            if name == "DefaultHandler" or name == "DefaultHandlerExpand":
                # (expat has one default handler: XML_SetDefaultHandler(Expand), the expansion flag set either way)
                object.__setattr__(self, "_default_expand", name == "DefaultHandlerExpand")
                object.__setattr__(self, "_default_kind", name if value is not None else None)
            object.__setattr__(self, name, value)
            return
        if name == "buffer_text":
            value = bool(value) if isinstance(value, int) else _truth(value)
            if not value and self._buffer_used:
                self._flush()
            object.__setattr__(self, "_buffer_text", value)
            return
        if name == "buffer_size":
            if not isinstance(value, int):
                raise TypeError("buffer_size must be an integer")
            if value <= 0:
                raise ValueError("buffer_size must be greater than zero")
            if value > 2147483647:
                raise ValueError(f"buffer_size must not be greater than {2147483647}")
            if self._buffer_used:
                self._flush()
            object.__setattr__(self, "_buffer_size", value)
            return
        if name == "namespace_prefixes":
            object.__setattr__(self, "_ns_triplets", _truth(value))
            return
        if name in ("ordered_attributes", "specified_attributes"):
            object.__setattr__(self, name, _truth(value))
            return
        if name == "intern":
            raise AttributeError("readonly attribute")
        if name in ("buffer_used", "ErrorCode", "ErrorLineNumber", "ErrorColumnNumber", "ErrorByteIndex",
                    "CurrentLineNumber", "CurrentColumnNumber", "CurrentByteIndex"):
            raise AttributeError(f"attribute '{name}' of 'pyexpat.xmlparser' objects is not writable")
        raise AttributeError(f"'pyexpat.xmlparser' object has no attribute '{name}' and no __dict__ for setting "
                             "new attributes")

    @property
    def buffer_text(self):
        return self._buffer_text

    @property
    def buffer_size(self):
        return self._buffer_size

    @property
    def buffer_used(self):
        return self._buffer_used

    @property
    def namespace_prefixes(self):
        return self._ns_triplets

    @property
    def intern(self):
        return self._intern

    @property
    def ErrorCode(self):
        return self._error_code

    @property
    def ErrorLineNumber(self):
        return self._current()[0]

    @property
    def ErrorColumnNumber(self):
        return self._current()[1]

    @property
    def ErrorByteIndex(self):
        return self._current()[2]

    CurrentLineNumber = ErrorLineNumber
    CurrentColumnNumber = ErrorColumnNumber
    CurrentByteIndex = ErrorByteIndex

    def _current(self):
        """(line, column, byte index) of the current event, as XML_GetCurrentLineNumber and its siblings give them"""
        if self._last_error_at is not None:
            return self._last_error_at
        if not self._started:
            return (1, 0, -1)
        line, col = self._pos_at(self._ev[0])
        return (line + 1, col, self._byte_index(self._ev[0]))

    # ------------------------------------------------------------------ methods
    def Parse(self, *args, **kwargs):
        """Parse XML data."""
        if kwargs:
            raise TypeError("Parse() takes no keyword arguments")
        if not args:
            raise TypeError("Parse() takes at least 1 positional argument (0 given)")
        if len(args) > 2:
            raise TypeError(f"Parse() takes at most 2 arguments ({len(args)} given)")
        data = args[0]
        isfinal = args[1] if len(args) > 1 else False
        if self._in_callback:
            raise RuntimeError("cannot call Parse() from within a handler")
        if isinstance(data, str):
            raw = data.encode("utf-8")
            if not self._started:
                self._protocol_enc = "utf-8"
        else:
            try:
                raw = bytes(memoryview(data))
            except TypeError:
                raise TypeError(f"a bytes-like object is required, not '{type(data).__name__}'") from None
        final = _truth(isfinal)
        while len(raw) > _MAX_CHUNK_SIZE:
            if not self._xml_parse(raw[:_MAX_CHUNK_SIZE], False):
                return self._fail()
            raw = raw[_MAX_CHUNK_SIZE:]
        if not self._xml_parse(raw, final):
            return self._fail()
        self._flush()
        return 1

    def ParseFile(self, file, /):
        """Parse XML data from file-like object."""
        read = getattr(file, "read", None)
        if read is None:
            raise TypeError("argument must have 'read' attribute")
        while True:
            data = read(2048)
            if not isinstance(data, (bytes, bytearray, str)):
                raise TypeError(f"read() did not return a bytes object (type={type(data).__name__})")
            if not self._xml_parse(data.encode("utf-8") if isinstance(data, str) else bytes(data), len(data) == 0):
                return self._fail()
            if len(data) == 0:
                break
        self._flush()
        return 1

    def SetBase(self, base, /):
        """Set the base URL for the parser."""
        if not isinstance(base, str):
            raise TypeError(f"SetBase() argument must be str, not {type(base).__name__}")
        self._base = base

    def GetBase(self):
        """Return base URL string for the parser."""
        return self._base

    def GetInputContext(self):
        """Return the untranslated text of the input that caused the current event."""
        if not self._in_callback:
            return None
        rest = self._text[self._ev[0]:]
        data = rest.encode(self._enc_name(), "surrogateescape") if self._unknown_map is None else bytes(
            _unmap(self._unknown_map, rest))
        return data + (self._decoder.pending if self._decoder is not None else b"") + self._raw + b"".join(
            self._raw_parts)

    def SetParamEntityParsing(self, flag, /):
        """Controls parsing of parameter entities (including the external DTD subset)."""
        if not isinstance(flag, int):
            raise TypeError(f"'{type(flag).__name__}' object cannot be interpreted as an integer")
        if flag != XML_PARAM_ENTITY_PARSING_NEVER:
            raise NotImplementedError("parameter entity parsing is not supported in Sagebrush: the parser reads no "
                                      "external DTD or parameter entity")
        return 1

    def UseForeignDTD(self, flag=True, /):
        """Allows the application to provide an artificial external subset if one is not specified as part of the
        document instance."""
        raise NotImplementedError("UseForeignDTD is not supported in Sagebrush: the parser reads no external DTD")

    def ExternalEntityParserCreate(self, context, encoding=None, /):
        """Create a parser for parsing an external entity based on the information passed to the
        ExternalEntityRefHandler."""
        raise NotImplementedError("external entity parsers are not supported in Sagebrush: the parser reads no "
                                  "external entity")

    def GetReparseDeferralEnabled(self):
        """Retrieve reparse deferral enabled status; always returns false with Expat <2.6.0."""
        return self._deferral

    def SetReparseDeferralEnabled(self, enabled, /):
        """Enable/Disable reparse deferral; enabled by default with Expat >=2.6.0."""
        self._deferral = _truth(enabled)

    def _set_factor(self, attr, value):
        if not isinstance(value, (int, float)):
            raise TypeError(f"must be real number, not {type(value).__name__}")
        v = float(value)
        if not v >= 1.0:
            raise ExpatError("'max_factor' must be at least 1.0")
        object.__setattr__(self, attr, v)

    def _set_threshold(self, attr, value):
        if not isinstance(value, int):
            raise TypeError(f"'{type(value).__name__}' object cannot be interpreted as an integer")
        if value < 0:
            raise ValueError("Cannot convert negative int")
        if value >= 1 << 64:
            raise OverflowError("Python int too large for C unsigned long long")
        object.__setattr__(self, attr, value)

    def SetBillionLaughsAttackProtectionActivationThreshold(self, threshold, /):
        """Sets the number of output bytes needed to activate protection against billion laughs attacks."""
        self._set_threshold("_amp_act", threshold)

    def SetBillionLaughsAttackProtectionMaximumAmplification(self, max_factor, /):
        """Sets the maximum tolerated amplification factor for protection against billion laughs attacks."""
        self._set_factor("_amp_max", max_factor)

    def SetAllocTrackerActivationThreshold(self, threshold, /):
        """Sets the number of allocated bytes of dynamic memory needed to activate protection against disproportionate
        use of RAM."""
        self._set_threshold("_at_act", threshold)

    def SetAllocTrackerMaximumAmplification(self, max_factor, /):
        """Sets the maximum amplification factor between direct input and bytes of dynamic memory allocated."""
        self._set_factor("_at_max", max_factor)

    # ------------------------------------------------------------------ errors
    def _fail(self):
        code = self._error_code
        line, col, byte = self._last_error_at
        err = ExpatError(f"{errors.messages[code]}: line {line}, column {col}")
        err.code = code
        err.lineno = line
        err.offset = col
        raise err

    # ------------------------------------------------------------------ handlers (pyexpat's wrappers)
    def _flush(self):
        if not self._buffer_used:
            return
        data = "".join(self._buffer)
        self._release(_str_cost(self._buffer_used))
        self._buffer = []
        self._buffer_used = 0
        h = self.CharacterDataHandler
        if h is not None:
            self._call(h, (data,))

    def _call(self, h, args):
        self._in_callback = True
        try:
            return h(*args)
        finally:
            self._in_callback = False

    def _report(self, name, *args):
        """A handler other than character data: the buffered text first, then it, if set."""
        h = getattr(self, name)
        if h is None:
            return None
        self._flush()
        h = getattr(self, name)
        if h is None:
            return None
        return self._call(h, args)

    def _data(self, s):
        """CharacterDataHandler, through pyexpat's buffer when buffer_text is on."""
        if self.CharacterDataHandler is None:
            return
        n = len(s)
        if self._buffer_text:
            if n > self._buffer_size - self._buffer_used:
                self._flush()
                if self.CharacterDataHandler is None:
                    return
            if n <= self._buffer_size - self._buffer_used:
                self._charge(_str_cost(n))
                self._buffer.append(s)
                self._buffer_used += n
                return
        self._call(self.CharacterDataHandler, (s,))

    def _name(self, s):
        d = self._intern
        if d is None:
            return s
        r = d.get(s)
        if r is None:
            d[s] = s
            return s
        return r

    # ------------------------------------------------------------------ positions and bytes
    def _pos_at(self, idx):
        """(line, column), both from 0, of text index idx; positions only move forward, as expat's do"""
        if idx < self._posidx:
            return (self._line, self._col)
        t = self._text
        seg = t[self._posidx:idx]
        if seg:
            nl = seg.count("\n") + seg.count("\r") - seg.count("\r\n")
            if nl:
                k = max(seg.rfind("\n"), seg.rfind("\r"))
                self._line += nl
                self._col = len(seg) - k - 1
            else:
                self._col += len(seg)
        self._posidx = idx
        return (self._line, self._col)

    def _blen(self, seg):
        """Bytes of a document segment in the input's encoding"""
        if seg.isascii() or self._unknown_map is not None:
            return len(seg) * self._unit
        return len(seg.encode(self._enc_name(), "surrogateescape"))

    def _enc_name(self):
        enc = self._enc or "utf-8"
        if enc == "utf-16":
            enc = "utf-16-le"
        return enc

    def _byte_index(self, idx):
        if not self._started:
            return -1
        return self._bytes_fed - self._held - len(self._raw) - self._raw_pending - self._blen(self._text[idx:])

    # ------------------------------------------------------------------ accounting
    def _account(self, nbytes, direct):
        """accountingDiffTolerated: the bytes a token adds; error 43 once the output is at the activation threshold
        and its amplification over the direct input exceeds the maximum"""
        if direct:
            self._acc[0] += nbytes
        else:
            self._acc[1] += nbytes
        out = self._acc[0] + self._acc[1]
        if out < self._amp_act:
            return
        if self._acc[0]:
            factor = out / self._acc[0]
        else:
            factor = (22 + self._acc[1]) / 22
        if factor > self._amp_max:
            raise _Error(43)

    def _charge(self, n):
        """The parser's own memory (design note r3 section 4.3): charged before what it pays for is built; past the
        activation threshold, more than the maximum amplification over the direct input is expat's out of memory"""
        total = self._acc[2] + n
        if total >= self._at_act:
            if self._acc[0] == 0 or total / self._acc[0] > self._at_max:
                raise _Error(1)
        self._acc[2] = total

    def _release(self, n):
        self._acc[2] = max(0, self._acc[2] - n)

    # ------------------------------------------------------------------ the driver (XML_Parse, callProcessor)
    def _set_error(self, code, at):
        """Record expat's error: at is the text index of the event it is reported at."""
        self._error_code = code
        self._processor = "error"
        if at is None:
            at = self._ev[0]
        start = self._posidx
        line, col = self._pos_at(at) if at >= self._posidx else (self._line, self._col)
        self._last_error_at = (line + 1, col, self._byte_index(at) if self._started else -1)
        # (what a later Parse reports again: expat counts the span from its buffer's start once more)
        self._error_pos = (line, col)
        self._error_span = self._text[:at] if at >= start else None
        self._drop(False)

    def _drop(self, keep_text):
        """The end of the parse (an error, the final Parse, or an exception in a handler): what the parser holds is
        released, its memory accounting with it (design note r3 section 4.3)"""
        self._acc[2] = 0
        self._dtd = _Dtd()
        self._tag_stack = []
        self._open = []
        self._raw = b""
        self._raw_parts = []
        self._raw_pending = 0
        if not keep_text:
            self._text = ""
            self._posidx = 0
            self._ev[0] = self._ev[1] = 0
    def _after_end(self):
        """Parse after the final one, or after an exception in a handler: parsing finished (36)"""
        self._error_code = 36
        if self._end_at is None:
            line, col = self._pos_at(len(self._text))
            self._end_at = (line + 1, col, self._byte_index(len(self._text)))
        self._last_error_at = self._end_at
        return False

    def _xml_parse(self, raw, final):
        if self._processor == "error":
            if self._finished:
                return self._after_end()
            self._bytes_fed += len(raw)
            if self._error_span is not None:
                line, col = _advance(self._error_pos, self._error_span)
                self._error_pos = (line, col)
                self._last_error_at = (line + 1, col, self._last_error_at[2])
            return False
        if self._finished:
            return self._after_end()
        self._started = True
        self._last_error_at = None
        n = len(raw)
        # (XML_GetBuffer: expat's buffer, in bytes, for the reparse deferral's second trigger)
        self._last_request = n
        if n > self._buf_cap - self._buf_end or self._buf_cap == 0:
            needed = n + (self._buf_end - self._buf_ptr)
            keep = min(self._buf_ptr, _CONTEXT_BYTES)
            needed += keep
            if self._buf_cap and needed <= self._buf_cap:
                if keep < self._buf_ptr:
                    off = self._buf_ptr - keep
                    self._buf_end -= off
                    self._buf_ptr -= off
            else:
                size = self._buf_cap or _INIT_BUFFER_SIZE
                size *= 2
                while size < needed:
                    size *= 2
                pending = self._buf_end - self._buf_ptr
                self._buf_cap = size
                self._buf_ptr = keep if self._buf_end else 0
                self._buf_end = self._buf_ptr + pending
        # (XML_ParseBuffer)
        self._buf_end += n
        self._bytes_fed += n
        self._final = final
        try:
            self._charge(2 * n)
            self._raw_parts.append(raw)
            self._raw_pending += n
            have_now = self._buf_end - self._buf_ptr
            if self._deferral and not final:
                had = self._partial_before
                avail = (self._buf_ptr - min(self._buf_ptr, _CONTEXT_BYTES)) + (self._buf_cap - self._buf_end)
                if not (have_now >= 2 * had or self._last_request > avail):
                    return True
            consumed = self._process(final)
        except _Error as e:
            self._set_error(e.code, e.at)
            return False
        except BaseException:
            # (an exception in a handler: pyexpat stops the parser (XML_StopParser), and the exception goes on; the
            # parse is finished at the end of the event's token, as expat's abort leaves it)
            self._error_code = 35
            self._finished = True
            self._processor = "error"
            line, col = self._pos_at(self._ev[1]) if self._ev[1] >= self._posidx else (self._line, self._col)
            self._end_at = (line + 1, col, self._byte_index(self._ev[1]))
            self._drop(False)
            raise
        self._partial_before = have_now if not consumed else 0
        if final and self._processor != "error":
            self._finished = True
            line, col = self._pos_at(len(self._text))
            self._end_at = (line + 1, col, self._byte_index(len(self._text)))
            self._drop(True)
        return True

    def _decode_pending(self, final):
        """Decode the bytes fed so far, once the encoding is known; returns False while it isn't."""
        if self._enc is None:
            if not self._init_encoding(final):
                return False
        if self._await_decl and not self._detect_decl(final):
            return True
        if self._raw and not self._decl_phase:
            raw = self._raw
            self._raw = b""
            if self._decoder is None:
                s = raw.decode("latin-1").translate(self._unknown_map)
            else:
                s = self._decoder.decode(raw, final)
            self._work[3] += len(raw)
            self._text += s
            self._work[2] += len(self._text)
        if self._decoder is not None:
            self._held = self._decoder.held
        if final and self._held:
            if self._decoder.partial_char:
                self._pc = len(self._text)
            else:
                self._odd = True
        return True

    def _process(self, final):
        """callProcessor: run the processors over what is buffered; True if anything was consumed."""
        work = self._work
        work[1] += 1
        if self._raw_parts:
            joined = b"".join(self._raw_parts)
            self._raw = self._raw + joined if self._raw else joined
            work[2] += len(self._raw)
            self._raw_parts = []
            self._raw_pending = 0
        if not self._decode_pending(final):
            if final:
                # (too little to tell the encoding: what a well-formed document can't be)
                self._enc = "utf-8"
                self._unit = 1
                self._decoder = _IncDecoder("utf-8")
                self._decode_pending(final)
            else:
                return False
        work[0] += len(self._text)
        k = self._run(final)
        # (expat's buffer position: what is left unparsed, in bytes)
        rest = self._blen(self._text[k:]) + self._held + len(self._raw)
        consumed = (self._buf_end - rest) != self._buf_ptr
        self._buf_ptr = self._buf_end - rest
        # (positions up to what is consumed, then the consumed text dropped)
        self._pos_at(k)
        if k:
            self._release(2 * k)
            self._text = self._text[k:]
            work[2] += len(self._text)
            self._posidx -= k
            self._ev[0] = max(0, self._ev[0] - k)
            if self._pc >= 0:
                self._pc -= k
        return consumed

    def _work_counts(self):
        """The work done so far (design note r3 section 4a): characters the processors could examine (the text at
        each attempt), attempts, characters and bytes copied or joined, bytes decoded; and the parser's own memory
        as its accounting has it now (section 4.3)"""
        scanned, attempts, copied, decoded = self._work
        return {"scanned": scanned, "attempts": attempts, "copied": copied, "decoded": decoded, "owned": self._acc[2]}

    def _run(self, final):
        """The processors in turn, as expat's re-entering callProcessor loop runs them; returns the text index
        consumed to."""
        have_more = not final
        i = 0
        while True:
            p = self._processor
            self._scan = _Tok(self._text, len(self._text), self._pc, self._chars, self._odd)
            if p == "init" or p == "prolog":
                i, again = self._do_prolog(i, have_more)
            elif p == "content":
                i, again = self._do_content(i, have_more)
            elif p == "cdata":
                i, again = self._do_cdata(i, have_more)
            elif p == "epilog":
                i, again = self._do_epilog(i, have_more)
            elif p == "entity":
                i, again = self._do_entity(i, have_more)
            else:
                return i
            if not again:
                return i

    def _init_encoding(self, final):
        """initScan: decide how the bytes decode before any is decoded. In the 8-bit family, an XML declaration is read
        first (it is ASCII) and the bytes after it wait for the encoding it names (the declaration phase)."""
        raw = self._raw
        proto = self._protocol_enc
        if proto is not None:
            key = proto.upper()
            if key in _KNOWN_ENCODINGS:
                enc = _KNOWN_ENCODINGS[key]
                if enc == "utf-16":
                    if len(raw) < 2 and not final:
                        return False
                    enc = "utf-16-le" if raw[:2] in (b"\xff\xfe", b"<\x00") else "utf-16-be"
                self._set_codec(enc)
            else:
                self._set_unknown(proto)
            return True
        if len(raw) < 2 and not final:
            return False
        b2 = raw[:2]
        if b2 == b"\xfe\xff" or (len(raw) >= 2 and raw[0] == 0):
            self._set_codec("utf-16-be")
            return True
        if b2 == b"\xff\xfe" or b2 == b"<\x00":
            self._set_codec("utf-16-le")
            return True
        self._set_codec("utf-8")
        if b2 == b"\xef\xbb":
            if len(raw) < 3 and not final:
                self._enc = None
                return False
            if raw[2:3] == b"\xbf":
                # (the BOM is a token of its own, consumed at once, as expat's)
                self._text += self._decoder.decode(raw[:3], False)
                self._raw = raw[3:]
        self._await_decl = True
        return True

    def _detect_decl(self, final):
        """Stage two: whether an XML declaration comes first; False while that can't be told yet. A declaration is
        decoded on its own, and the bytes after it wait for the encoding it names (the declaration phase)."""
        body = self._raw
        if len(body) < 6 and b"<?xml"[:len(body)] == body[:5] and not final:
            return False
        self._await_decl = False
        if body.startswith(b"<?xml") and body[5:6] in (b" ", b"\t", b"\r", b"\n", b"?"):
            close = body.find(b"?>", 5)
            if close < 0:
                if not final:
                    self._await_decl = True
                    return False
            else:
                cut = close + 2
                self._text += self._decoder.decode(body[:cut], False)
                self._raw = body[cut:]
                self._decl_phase = True
        return True

    def _set_codec(self, enc):
        self._enc = enc
        self._unit = 2 if enc.startswith("utf-16") else 1
        self._decoder = _IncDecoder(enc)

    def _set_unknown(self, name):
        """pyexpat's unknown encoding handler: a single-byte codec of Python's, byte by byte; a byte it can't
        decode is invalid"""
        u = bytes(range(256)).decode(name, "replace")
        if len(u) != 256:
            raise ValueError("multi-byte encodings are not supported")
        table = {}
        for b, ch in enumerate(u):
            table[b] = chr(0xDC00 + b) if ch == "\ufffd" else ch
        self._unknown_map = table
        self._enc = name
        self._unit = 1
        self._decoder = None

    # ------------------------------------------------------------------ the prolog (doProlog)
    def _tok_bytes(self, a, b):
        return self._blen(self._text[a:b])

    def _do_prolog(self, s, have_more):
        """doProlog over the document: returns (next index, run again?)"""
        sc = self._scan
        text = self._text
        end = sc.end_of(len(text))
        dtd = self._dtd
        while True:
            self._ev[0] = s
            if self._bom_pending and s == 0 and text[:1] == "\ufeff":
                tok, nxt = _TOK_BOM, 1
            else:
                tok, nxt = sc.prolog_tok(s, end)
            self._ev[1] = nxt
            if tok > 0:
                self._bom_pending = False
            if self._processor == "init":
                self._processor = "prolog"
            if tok <= 0:
                if have_more and tok != _TOK_INVALID:
                    return (s, False)
                if tok == _TOK_INVALID:
                    raise _Error(4, nxt)
                if tok == _TOK_PARTIAL:
                    raise _Error(5)
                if tok == _TOK_PARTIAL_CHAR:
                    raise _Error(6)
                if tok == -_TOK_PROLOG_S:
                    tok = _TOK_PROLOG_S
                elif tok == _TOK_NONE:
                    raise _Error(3)
                else:
                    tok = -tok
                    nxt = end if self._pc < 0 else len(text)
            role = self._prolog.role(tok, text, s, nxt)
            if role not in (_ROLE_INSTANCE_START, _ROLE_XML_DECL, _ROLE_TEXT_DECL):
                self._account(self._tok_bytes(s, nxt), True)
            handle_default = True
            if role == _ROLE_XML_DECL:
                if self._process_xml_decl(s, nxt):
                    # (the encoding changed: the rest is decoded now, and the scan restarts on the longer text)
                    return (nxt, True)
                handle_default = False
            elif role == _ROLE_DOCTYPE_NAME:
                if self.StartDoctypeDeclHandler is not None:
                    self._doctype = [self._name(text[s:nxt]), None, None]
                    handle_default = False
                self._doctype_sysid = None
            elif role == _ROLE_DOCTYPE_INTERNAL_SUBSET:
                if self.StartDoctypeDeclHandler is not None and self._doctype is not None:
                    name, sysid, pubid = self._doctype
                    self._report("StartDoctypeDeclHandler", name, sysid, pubid, 1)
                    self._doctype = None
                    handle_default = False
            elif role == _ROLE_DOCTYPE_PUBLIC_ID:
                dtd.has_param_entity_refs = True
                ok, bad = sc.is_public_id(s, nxt)
                if not ok:
                    raise _Error(32, bad)
                if self.StartDoctypeDeclHandler is not None and self._doctype is not None:
                    self._doctype[2] = _normalize_public_id(text[s + 1:nxt - 1])
                    handle_default = False
                self._decl_entity = self._dtd.param.setdefault("#", _Entity("#"))
            elif role == _ROLE_ENTITY_PUBLIC_ID:
                ok, bad = sc.is_public_id(s, nxt)
                if not ok:
                    raise _Error(32, bad)
                ent = self._decl_entity
                if dtd.keep_processing and ent is not None:
                    ent.public_id = _normalize_public_id(text[s + 1:nxt - 1])
                    if self.EntityDeclHandler is not None:
                        handle_default = False
            elif role == _ROLE_DOCTYPE_CLOSE:
                if self._doctype is not None:
                    name, sysid, pubid = self._doctype
                    self._report("StartDoctypeDeclHandler", name, sysid, pubid, 0)
                    self._doctype = None
                    handle_default = False
                if self._doctype_sysid is not None:
                    dtd.has_param_entity_refs = True
                if self.EndDoctypeDeclHandler is not None:
                    self._report("EndDoctypeDeclHandler")
                    handle_default = False
            elif role == _ROLE_INSTANCE_START:
                self._processor = "content"
                return (s, True)
            elif role == _ROLE_ATTLIST_ELEMENT_NAME:
                self._decl_element = self._element_type(text[s:nxt])
                if dtd.keep_processing and self.AttlistDeclHandler is not None:
                    handle_default = False
            elif role == _ROLE_ATTRIBUTE_NAME:
                self._decl_att = self._attribute_id(text[s:nxt])
                self._decl_att_cdata = False
                self._decl_att_type = None
                self._decl_att_id = False
                if dtd.keep_processing and self.AttlistDeclHandler is not None:
                    handle_default = False
            elif _ROLE_ATTRIBUTE_TYPE_CDATA <= role <= _ROLE_ATTRIBUTE_TYPE_NMTOKENS:
                k = role - _ROLE_ATTRIBUTE_TYPE_CDATA
                self._decl_att_cdata = (k == 0)
                self._decl_att_id = (k == 1)
                self._decl_att_type = _ATT_TYPES[k]
                if dtd.keep_processing and self.AttlistDeclHandler is not None:
                    handle_default = False
            elif role == _ROLE_ATTRIBUTE_ENUM_VALUE or role == _ROLE_ATTRIBUTE_NOTATION_VALUE:
                if dtd.keep_processing and self.AttlistDeclHandler is not None:
                    if self._decl_att_type is not None:
                        prefix = "|"
                    else:
                        prefix = "NOTATION(" if role == _ROLE_ATTRIBUTE_NOTATION_VALUE else "("
                    self._decl_att_type = (self._decl_att_type or "") + prefix + text[s:nxt]
                    handle_default = False
            elif role == _ROLE_IMPLIED_ATTRIBUTE_VALUE or role == _ROLE_REQUIRED_ATTRIBUTE_VALUE:
                if dtd.keep_processing:
                    self._define_attribute(self._decl_element, self._decl_att, self._decl_att_cdata,
                                           self._decl_att_id, None)
                    if self.AttlistDeclHandler is not None and self._decl_att_type is not None:
                        typ = self._decl_att_type
                        if typ[:1] == "(" or typ[:2] == "NO":
                            typ += ")"
                        self._report("AttlistDeclHandler", self._decl_element.name, self._decl_att.name, typ, None,
                                     1 if role == _ROLE_REQUIRED_ATTRIBUTE_VALUE else 0)
                        handle_default = False
            elif role == _ROLE_DEFAULT_ATTRIBUTE_VALUE or role == _ROLE_FIXED_ATTRIBUTE_VALUE:
                if dtd.keep_processing:
                    value = self._store_attribute_value(self._decl_att_cdata, text, s + 1, nxt - 1, None, True)
                    self._define_attribute(self._decl_element, self._decl_att, self._decl_att_cdata, False, value)
                    if self.AttlistDeclHandler is not None and self._decl_att_type is not None:
                        typ = self._decl_att_type
                        if typ[:1] == "(" or typ[:2] == "NO":
                            typ += ")"
                        self._report("AttlistDeclHandler", self._decl_element.name, self._decl_att.name, typ, value,
                                     1 if role == _ROLE_FIXED_ATTRIBUTE_VALUE else 0)
                        handle_default = False
            elif role == _ROLE_ENTITY_VALUE:
                if dtd.keep_processing:
                    value = self._store_entity_value(text, s + 1, nxt - 1)
                    ent = self._decl_entity
                    if ent is not None:
                        self._charge(_str_cost(len(value)) + _ENTRY_COST)
                        ent.text = value
                        if self.EntityDeclHandler is not None:
                            self._report("EntityDeclHandler", ent.name, 1 if ent.is_param else 0, value, self._base,
                                         None, None, None)
                            handle_default = False
            elif role == _ROLE_DOCTYPE_SYSTEM_ID:
                dtd.has_param_entity_refs = True
                if self.StartDoctypeDeclHandler is not None and self._doctype is not None:
                    self._doctype[1] = text[s + 1:nxt - 1]
                    self._doctype_sysid = self._doctype[1]
                    handle_default = False
                else:
                    self._doctype_sysid = "#"
                if not dtd.standalone and self.NotStandaloneHandler is not None:
                    if not self._report("NotStandaloneHandler"):
                        raise _Error(22)
                if self._decl_entity is None:
                    self._decl_entity = self._dtd.param.setdefault("#", _Entity("#"))
                    self._decl_entity.public_id = None
                ent = self._decl_entity
                if dtd.keep_processing and ent is not None:
                    ent.system_id = text[s + 1:nxt - 1]
                    ent.base = self._base
            elif role == _ROLE_ENTITY_SYSTEM_ID:
                ent = self._decl_entity
                if dtd.keep_processing and ent is not None:
                    ent.system_id = text[s + 1:nxt - 1]
                    ent.base = self._base
                    if self.EntityDeclHandler is not None:
                        handle_default = False
            elif role == _ROLE_ENTITY_COMPLETE:
                ent = self._decl_entity
                if dtd.keep_processing and ent is not None and self.EntityDeclHandler is not None:
                    self._report("EntityDeclHandler", ent.name, 1 if ent.is_param else 0, None, ent.base,
                                 ent.system_id, ent.public_id, None)
                    handle_default = False
            elif role == _ROLE_ENTITY_NOTATION_NAME:
                ent = self._decl_entity
                if dtd.keep_processing and ent is not None:
                    ent.notation = text[s:nxt]
                    if self.UnparsedEntityDeclHandler is not None:
                        self._report("UnparsedEntityDeclHandler", ent.name, ent.base, ent.system_id, ent.public_id,
                                     ent.notation)
                        handle_default = False
                    elif self.EntityDeclHandler is not None:
                        self._report("EntityDeclHandler", ent.name, 0, None, ent.base, ent.system_id, ent.public_id,
                                     ent.notation)
                        handle_default = False
            elif role == _ROLE_GENERAL_ENTITY_NAME or role == _ROLE_PARAM_ENTITY_NAME:
                name = text[s:nxt]
                is_param = role == _ROLE_PARAM_ENTITY_NAME
                if not is_param and name in ("lt", "gt", "amp", "quot", "apos"):
                    self._decl_entity = None
                elif dtd.keep_processing:
                    table = dtd.param if is_param else dtd.general
                    if name in table:
                        self._decl_entity = None
                    else:
                        self._charge(_str_cost(len(name)) + _ENTRY_COST)
                        ent = _Entity(name)
                        ent.is_param = is_param
                        ent.is_internal = not self._open
                        table[name] = ent
                        self._decl_entity = ent
                        if self.EntityDeclHandler is not None:
                            handle_default = False
                else:
                    self._decl_entity = None
            elif role == _ROLE_NOTATION_NAME:
                self._decl_notation = None
                self._decl_notation_pubid = None
                if self.NotationDeclHandler is not None:
                    self._decl_notation = text[s:nxt]
                    handle_default = False
            elif role == _ROLE_NOTATION_PUBLIC_ID:
                ok, bad = sc.is_public_id(s, nxt)
                if not ok:
                    raise _Error(32, bad)
                if self._decl_notation is not None:
                    self._decl_notation_pubid = _normalize_public_id(text[s + 1:nxt - 1])
                    handle_default = False
            elif role == _ROLE_NOTATION_SYSTEM_ID:
                if self._decl_notation is not None and self.NotationDeclHandler is not None:
                    self._report("NotationDeclHandler", self._decl_notation, self._base, text[s + 1:nxt - 1],
                                 self._decl_notation_pubid)
                    handle_default = False
            elif role == _ROLE_NOTATION_NO_SYSTEM_ID:
                if self._decl_notation_pubid is not None and self.NotationDeclHandler is not None:
                    self._report("NotationDeclHandler", self._decl_notation, self._base, None,
                                 self._decl_notation_pubid)
                    handle_default = False
            elif role == _ROLE_ERROR:
                if tok == _TOK_PARAM_ENTITY_REF:
                    raise _Error(10)
                if tok == _TOK_XML_DECL:
                    raise _Error(17)
                raise _Error(2)
            elif role == _ROLE_IGNORE_SECT:
                self._default(s, nxt)
                handle_default = False
                tok2, nxt = sc.ignore_section_tok(nxt, end)
                if tok2 != _TOK_IGNORE_SECT:
                    raise _Error(4 if tok2 == _TOK_INVALID else 2)
            elif role == _ROLE_GROUP_OPEN:
                self._group.append("")
            elif role == _ROLE_GROUP_SEQUENCE:
                if self._group and self._group[-1] == "|":
                    raise _Error(2)
                if self._group:
                    self._group[-1] = ","
            elif role == _ROLE_GROUP_CHOICE:
                if self._group and self._group[-1] == ",":
                    raise _Error(2)
                if self._group:
                    self._group[-1] = "|"
            elif role in (_ROLE_GROUP_CLOSE, _ROLE_GROUP_CLOSE_REP, _ROLE_GROUP_CLOSE_OPT, _ROLE_GROUP_CLOSE_PLUS):
                if self._group:
                    self._group.pop()
            elif role == _ROLE_PARAM_ENTITY_REF or role == _ROLE_INNER_PARAM_ENTITY_REF:
                dtd.has_param_entity_refs = True
                dtd.keep_processing = dtd.standalone
                if not dtd.standalone and self.NotStandaloneHandler is not None:
                    if not self._report("NotStandaloneHandler"):
                        raise _Error(22)
            elif role == _ROLE_PI:
                self._report_pi(s, nxt)
                handle_default = False
            elif role == _ROLE_COMMENT:
                self._report_comment(s, nxt)
                handle_default = False
            elif role == _ROLE_NONE:
                if tok == _TOK_BOM:
                    handle_default = False
            elif role == _ROLE_DOCTYPE_NONE:
                if self.StartDoctypeDeclHandler is not None:
                    handle_default = False
            elif role == _ROLE_ENTITY_NONE:
                if dtd.keep_processing and self.EntityDeclHandler is not None:
                    handle_default = False
            elif role == _ROLE_NOTATION_NONE:
                if self.NotationDeclHandler is not None:
                    handle_default = False
            elif role == _ROLE_ATTLIST_NONE:
                if dtd.keep_processing and self.AttlistDeclHandler is not None:
                    handle_default = False
            if handle_default:
                self._default(s, nxt)
            s = nxt

    def _default(self, a, b):
        """reportDefault: the document's text [a, b) to the default handler"""
        if self._default_kind is not None:
            self._report(self._default_kind, self._text[a:b])

    def _process_xml_decl(self, s, nxt):
        """processXmlDecl: True if the input's encoding changed (the rest is then decoded)"""
        self._account(self._tok_bytes(s, nxt), True)
        text = self._text
        version, encname, standalone, bad = _parse_xml_decl(text, s, nxt)
        if bad is not None:
            raise _Error(30, bad)
        if standalone == 1:
            self._dtd.standalone = True
        if self.XmlDeclHandler is not None:
            self._report("XmlDeclHandler", version, encname[0] if encname else None, standalone)
        else:
            self._default(s, nxt)
        if self._protocol_enc is not None or encname is None:
            return self._end_decl_phase("utf-8" if self._enc is None else None)
        name, at = encname
        key = name.upper()
        if key in _KNOWN_ENCODINGS:
            enc = _KNOWN_ENCODINGS[key]
            unit = 2 if enc.startswith("utf-16") else 1
            if unit != self._unit or (unit == 2 and enc != "utf-16" and enc != self._enc):
                raise _Error(19, at)
            return self._end_decl_phase(enc if unit == 1 else None)
        # (pyexpat's unknown encoding handler, through Python's codecs: LookupError for a name it doesn't know)
        self._flush()
        self._set_unknown(name)
        return self._end_decl_phase(False)

    def _end_decl_phase(self, enc):
        """After the XML declaration: the codec it decided (a name, None for the one already set, False for an
        unknown encoding already set); the bytes after the declaration are decoded now. True if the text grew."""
        if not self._decl_phase:
            return False
        self._decl_phase = False
        if isinstance(enc, str):
            self._set_codec(enc)
        elif enc is None and self._decoder is None and self._unknown_map is None:
            self._set_codec("utf-8")
        raw = self._raw
        self._raw = b""
        if raw:
            if self._decoder is None:
                s = raw.decode("latin-1").translate(self._unknown_map)
            else:
                s = self._decoder.decode(raw, self._final)
                self._held = self._decoder.held
            self._charge(2 * len(s))
            self._text += s
            if self._final and self._held:
                if self._decoder.partial_char:
                    self._pc = len(self._text)
                else:
                    self._odd = True
        return True

    # ------------------------------------------------------------------ the DTD's tables
    def _element_type(self, name):
        et = self._dtd.element_types.get(name)
        if et is None:
            self._charge(_str_cost(len(name)) + _ENTRY_COST)
            et = _ElementType(name)
            self._dtd.element_types[name] = et
            if self._ns:
                k = name.find(":")
                if k >= 0:
                    et.prefix = self._prefix(name[:k])
        return et

    def _prefix(self, name):
        p = self._dtd.prefixes.get(name)
        if p is None:
            self._charge(_str_cost(len(name)) + _ENTRY_COST)
            p = _Prefix(name)
            self._dtd.prefixes[name] = p
        return p

    def _attribute_id(self, name):
        """getAttributeId"""
        a = self._dtd.attribute_ids.get(name)
        if a is not None:
            return a
        self._charge(_str_cost(len(name)) + _ENTRY_COST)
        a = _AttId(name)
        self._dtd.attribute_ids[name] = a
        if self._ns:
            if name[:5] == "xmlns" and (len(name) == 5 or name[5] == ":"):
                a.prefix = self._dtd.default_prefix if len(name) == 5 else self._prefix(name[6:])
                a.xmlns = True
            else:
                k = name.find(":")
                if k >= 0:
                    a.prefix = self._prefix(name[:k])
        return a

    def _define_attribute(self, et, att, is_cdata, is_id, value):
        if value is not None or is_id:
            if att.name in et.default_for_name:
                return
            if is_id and et.id_att is None and not att.xmlns:
                et.id_att = att
        self._charge(_ENTRY_COST + (_str_cost(len(value)) if value is not None else 0))
        et.default_for_name[att.name] = len(et.default_atts)
        et.default_atts.append([att, value, is_cdata])
        if not is_cdata:
            att.maybe_tokenized = True

    # ------------------------------------------------------------------ values
    def _store_attribute_value(self, is_cdata, text, a, b, direct, in_prolog):
        """storeAttributeValue and appendAttributeValue: the value text[a:b] normalized, entities expanded (an
        explicit stack of open entities, never recursion)"""
        out = []
        stack = [[None, text, a, b, _Tok(text, b, -1, self._chars) if text is not self._text else self._scan, direct]]
        doc = text is self._text
        dtd = self._dtd
        while stack:
            frame = stack[-1]
            ent, t, i, e, sc, acc = frame
            if i >= e:
                stack.pop()
                if ent is not None:
                    ent.open = False
                    self._release(_FRAME_COST)
                continue
            tok, nxt = sc.attribute_value_tok(i, e)
            if tok not in (_TOK_INVALID, _TOK_PARTIAL, _TOK_PARTIAL_CHAR, _TOK_NONE) and acc is not None:
                self._account(self._blen(t[i:nxt]) if ent is None else len(t[i:nxt].encode("utf-8", "surrogatepass")),
                              acc)
            if tok == _TOK_INVALID:
                raise _Error(4, nxt if (ent is None and doc) else None)
            if tok == _TOK_PARTIAL:
                raise _Error(4, i if (ent is None and doc) else None)
            if tok == _TOK_CHAR_REF:
                n = _char_ref_number(t, i)
                if n < 0:
                    raise _Error(14, i if (ent is None and doc) else None)
                if not is_cdata and n == 0x20 and (not out or out[-1][-1:] == " "):
                    frame[2] = nxt
                    continue
                out.append(chr(n))
            elif tok == _TOK_DATA_CHARS:
                out.append(t[i:nxt])
            elif tok in (_TOK_TRAILING_CR, _TOK_ATTRIBUTE_VALUE_S, _TOK_DATA_NEWLINE):
                if tok == _TOK_TRAILING_CR:
                    nxt = i + 1
                if not is_cdata and (not out or out[-1][-1:] == " "):
                    frame[2] = nxt
                    continue
                out.append(" ")
            elif tok == _TOK_ENTITY_REF:
                name = t[i + 1:nxt - 1]
                ch = _PREDEFINED.get(name)
                if ch is not None:
                    self._acc[1] += 1
                    out.append(ch)
                    frame[2] = nxt
                    continue
                entity = dtd.general.get(name)
                if in_prolog:
                    check = self._prolog.document_entity and (not self._open if dtd.standalone
                                                              else not dtd.has_param_entity_refs)
                else:
                    check = not dtd.has_param_entity_refs or dtd.standalone
                if check:
                    if entity is None:
                        raise _Error(11)
                    if not entity.is_internal:
                        raise _Error(24)
                elif entity is None:
                    frame[2] = nxt
                    continue
                if entity.open:
                    raise _Error(12, i if (ent is None and doc) else None)
                if entity.notation is not None:
                    raise _Error(15, i if (ent is None and doc) else None)
                if entity.text is None:
                    raise _Error(16, i if (ent is None and doc) else None)
                frame[2] = nxt
                self._charge(_FRAME_COST)
                entity.open = True
                etext = entity.text
                stack.append([entity, etext, 0, len(etext), _Tok(etext, len(etext), -1, self._chars), False])
                continue
            elif tok == _TOK_NONE:
                frame[2] = e
                continue
            else:
                raise _Error(23)
            frame[2] = nxt
        value = "".join(out)
        if not is_cdata and value[-1:] == " ":
            value = value[:-1]
        return value

    def _store_entity_value(self, text, a, b):
        """storeEntityValue, for the internal subset: references to general entities kept as they are, character
        references resolved, line ends normalized; a parameter entity reference is an error here"""
        sc = self._scan
        out = []
        i = a
        while i < b:
            tok, nxt = sc.entity_value_tok(i, b)
            if tok == _TOK_PARAM_ENTITY_REF:
                raise _Error(10, i)
            if tok == _TOK_NONE:
                break
            if tok == _TOK_ENTITY_REF or tok == _TOK_DATA_CHARS:
                out.append(text[i:nxt])
            elif tok == _TOK_TRAILING_CR or tok == _TOK_DATA_NEWLINE:
                if tok == _TOK_TRAILING_CR:
                    nxt = i + 1
                out.append("\n")
            elif tok == _TOK_CHAR_REF:
                n = _char_ref_number(text, i)
                if n < 0:
                    raise _Error(14, i)
                out.append(chr(n))
            elif tok == _TOK_PARTIAL:
                raise _Error(4, i)
            elif tok == _TOK_INVALID:
                raise _Error(4, nxt)
            else:
                raise _Error(23, i)
            i = nxt
        return "".join(out)

    # ------------------------------------------------------------------ comments and processing instructions
    def _report_pi(self, s, nxt, t=None):
        t = self._text if t is None else t
        if self.ProcessingInstructionHandler is None:
            self._default_text(t, s, nxt)
            return
        a = s + 2
        b = a + _name_length(t, a, self._chars)
        target = t[a:b]
        k = b
        while k < nxt - 2 and t[k] in " \t\r\n":
            k += 1
        data = _normalize_lines(t[k:nxt - 2])
        self._report("ProcessingInstructionHandler", self._name(target), data)

    def _report_comment(self, s, nxt, t=None):
        t = self._text if t is None else t
        if self.CommentHandler is None:
            self._default_text(t, s, nxt)
            return
        self._report("CommentHandler", _normalize_lines(t[s + 4:nxt - 3]))

    def _default_text(self, t, a, b):
        if self._default_kind is not None:
            self._report(self._default_kind, t[a:b])

    # ------------------------------------------------------------------ content (doContent)
    def _do_content(self, s, have_more):
        """The document's content: returns (next index, run again?)"""
        nxt, status = self._content(self._scan, self._text, s, self._scan.end_of(len(self._text)), 0, have_more, True)
        if status == "more":
            return (nxt, False)
        return (nxt, True)

    def _do_entity(self, i, have_more):
        """internalEntityProcessor: the innermost open entity's text, then it is closed"""
        frame = self._open[-1]
        entity, etext, pos, level, sc, has_more = frame
        if has_more:
            nxt, status = self._content(sc, etext, pos, len(etext), level, False, False)
            if status == "reenter":
                frame[2] = nxt
                return (i, True)
            frame[5] = False
            if level != self._tag_level:
                raise _Error(13)
            return (i, True)
        self._open.pop()
        entity.open = False
        self._release(_FRAME_COST)
        if not self._open:
            self._processor = "content"
        return (i, True)

    def _content(self, sc, t, s, end, start_level, have_more, doc):
        """doContent over t from s: returns (next, status) with status "more" (wait for input), "reenter" (an
        entity was opened, or the processor changed), or "done" (an entity's text is complete)"""
        dtd = self._dtd
        while True:
            if doc:
                self._ev[0] = s
            tok, nxt = sc.content_tok(s, end)
            if doc:
                self._ev[1] = nxt
            if tok not in (_TOK_INVALID, _TOK_PARTIAL, _TOK_PARTIAL_CHAR, _TOK_NONE):
                after = nxt
                if tok == _TOK_TRAILING_RSQB or tok == _TOK_TRAILING_CR:
                    after = s if have_more else (end if self._pc < 0 or not doc else len(t))
                self._account(self._blen(t[s:after]) if doc else len(t[s:after].encode("utf-8", "surrogatepass")),
                              doc)
            if tok == _TOK_TRAILING_CR:
                if have_more:
                    return (s, "more")
                self._data("\n") if self.CharacterDataHandler is not None else self._default_text(t, s, len(t))
                if start_level == 0:
                    raise _Error(3)
                if self._tag_level != start_level:
                    raise _Error(13)
                return (len(t), "done")
            if tok == _TOK_NONE:
                if have_more:
                    return (s, "more")
                if start_level > 0:
                    if self._tag_level != start_level:
                        raise _Error(13)
                    return (s, "done")
                raise _Error(3)
            if tok == _TOK_INVALID:
                raise _Error(4, nxt if doc else None)
            if tok == _TOK_PARTIAL:
                if have_more:
                    return (s, "more")
                raise _Error(5)
            if tok == _TOK_PARTIAL_CHAR:
                if have_more:
                    return (s, "more")
                raise _Error(6)
            if tok == _TOK_ENTITY_REF:
                name = t[s + 1:nxt - 1]
                ch = _PREDEFINED.get(name)
                if ch is not None:
                    self._acc[1] += 1
                    if self.CharacterDataHandler is not None:
                        self._data(ch)
                    else:
                        self._default_text(t, s, nxt)
                    s = nxt
                    continue
                entity = dtd.general.get(name)
                if not dtd.has_param_entity_refs or dtd.standalone:
                    if entity is None:
                        raise _Error(11)
                    if not entity.is_internal:
                        raise _Error(24)
                elif entity is None:
                    if self.SkippedEntityHandler is not None:
                        self._report("SkippedEntityHandler", name, 0)
                    else:
                        self._default_text(t, s, nxt)
                    s = nxt
                    continue
                if entity.open:
                    raise _Error(12)
                if entity.notation is not None:
                    raise _Error(15)
                if entity.text is not None:
                    if not self._default_expand:
                        if self.SkippedEntityHandler is not None:
                            self._report("SkippedEntityHandler", entity.name, 0)
                        else:
                            self._default_text(t, s, nxt)
                        s = nxt
                        continue
                    self._charge(_FRAME_COST)
                    entity.open = True
                    etext = entity.text
                    self._open.append([entity, etext, 0, self._tag_level, _Tok(etext, len(etext), -1, self._chars),
                                       True])
                    self._processor = "entity"
                    return (nxt, "reenter")
                self._default_text(t, s, nxt)
                s = nxt
                continue
            if tok == _TOK_START_TAG_NO_ATTS or tok == _TOK_START_TAG_WITH_ATTS:
                raw_end = s + 1 + _name_length(t, s + 1, self._chars)
                raw = t[s + 1:raw_end]
                self._charge(_FRAME_COST + _str_cost(len(raw)))
                tag = [raw, None, []]
                self._tag_stack.append(tag)
                self._tag_level += 1
                name, atts = self._store_atts(sc, t, s, nxt, raw, tag[2], doc, doc)
                tag[1] = name
                if self.StartElementHandler is not None:
                    self._report("StartElementHandler", name, atts)
                else:
                    self._default_text(t, s, nxt)
                s = nxt
                continue
            if tok == _TOK_EMPTY_ELEMENT_NO_ATTS or tok == _TOK_EMPTY_ELEMENT_WITH_ATTS:
                raw = t[s + 1:s + 1 + _name_length(t, s + 1, self._chars)]
                bindings = []
                try:
                    name, atts = self._store_atts(sc, t, s, nxt, raw, bindings, None, doc)
                except _Error:
                    self._free_bindings(bindings)
                    raise
                handled = False
                if self.StartElementHandler is not None:
                    self._report("StartElementHandler", name, atts)
                    handled = True
                if self.EndElementHandler is not None:
                    if handled and doc:
                        self._ev[0] = nxt
                    self._report("EndElementHandler", name)
                    handled = True
                if not handled:
                    self._default_text(t, s, nxt)
                self._free_bindings(bindings)
                if self._tag_level == 0:
                    self._processor = "epilog"
                    return (nxt, "reenter")
                s = nxt
                continue
            if tok == _TOK_END_TAG:
                if self._tag_level == start_level:
                    raise _Error(13)
                tag = self._tag_stack[-1]
                a = s + 2
                raw = t[a:a + _name_length(t, a, self._chars)]
                if raw != tag[0]:
                    raise _Error(7, a if doc else None)
                self._tag_stack.pop()
                self._tag_level -= 1
                self._release(_FRAME_COST + _str_cost(len(tag[0])))
                if self.EndElementHandler is not None:
                    self._report("EndElementHandler", tag[1])
                else:
                    self._default_text(t, s, nxt)
                self._free_bindings(tag[2])
                if self._tag_level == 0:
                    self._processor = "epilog"
                    return (nxt, "reenter")
                s = nxt
                continue
            if tok == _TOK_CHAR_REF:
                n = _char_ref_number(t, s)
                if n < 0:
                    raise _Error(14)
                if self.CharacterDataHandler is not None:
                    self._data(chr(n))
                else:
                    self._default_text(t, s, nxt)
                s = nxt
                continue
            if tok == _TOK_XML_DECL:
                raise _Error(17)
            if tok == _TOK_DATA_NEWLINE:
                if self.CharacterDataHandler is not None:
                    self._data("\n")
                else:
                    self._default_text(t, s, nxt)
                s = nxt
                continue
            if tok == _TOK_CDATA_SECT_OPEN:
                if self.StartCdataSectionHandler is not None:
                    self._report("StartCdataSectionHandler")
                else:
                    self._default_text(t, s, nxt)
                k = self._cdata(sc, t, nxt, end, have_more, doc)
                if k is None:
                    self._processor = "cdata"
                    return (self._cdata_resume, "more")
                s = k
                continue
            if tok == _TOK_TRAILING_RSQB:
                if have_more:
                    return (s, "more")
                stop = len(t)
                if self.CharacterDataHandler is not None:
                    self._data(t[s:stop])
                else:
                    self._default_text(t, s, stop)
                if start_level == 0:
                    if doc:
                        self._ev[0] = stop
                    raise _Error(3)
                if self._tag_level != start_level:
                    if doc:
                        self._ev[0] = stop
                    raise _Error(13)
                return (stop, "done")
            if tok == _TOK_DATA_CHARS:
                if self.CharacterDataHandler is not None:
                    self._data(t[s:nxt])
                else:
                    self._default_text(t, s, nxt)
                s = nxt
                continue
            if tok == _TOK_PI:
                self._report_pi(s, nxt, t)
                s = nxt
                continue
            if tok == _TOK_COMMENT:
                self._report_comment(s, nxt, t)
                s = nxt
                continue
            self._default_text(t, s, nxt)
            s = nxt

    def _do_cdata(self, s, have_more):
        sc = self._scan
        k = self._cdata(sc, self._text, s, sc.end_of(len(self._text)), have_more, True)
        if k is None:
            # (the section is still open: wait, with what is left)
            return (self._cdata_resume, False)
        self._processor = "content"
        return (k, True)

    def _cdata(self, sc, t, s, end, have_more, doc):
        """doCdataSection from s: the index after its close, or None (still open; _cdata_resume set)"""
        while True:
            if doc:
                self._ev[0] = s
            tok, nxt = sc.cdata_section_tok(s, end)
            if doc:
                self._ev[1] = nxt
            if tok not in (_TOK_INVALID, _TOK_PARTIAL, _TOK_PARTIAL_CHAR, _TOK_NONE):
                self._account(self._blen(t[s:nxt]) if doc else len(t[s:nxt].encode("utf-8", "surrogatepass")), doc)
            if tok == _TOK_CDATA_SECT_CLOSE:
                if self.EndCdataSectionHandler is not None:
                    self._report("EndCdataSectionHandler")
                else:
                    self._default_text(t, s, nxt)
                return nxt
            if tok == _TOK_DATA_NEWLINE:
                if self.CharacterDataHandler is not None:
                    self._data("\n")
                else:
                    self._default_text(t, s, nxt)
            elif tok == _TOK_DATA_CHARS:
                if self.CharacterDataHandler is not None:
                    self._data(t[s:nxt])
                else:
                    self._default_text(t, s, nxt)
            elif tok == _TOK_INVALID:
                raise _Error(4, nxt if doc else None)
            elif tok == _TOK_PARTIAL_CHAR:
                if have_more:
                    self._cdata_resume = s
                    return None
                raise _Error(6)
            elif tok == _TOK_PARTIAL or tok == _TOK_NONE:
                if have_more:
                    self._cdata_resume = s
                    return None
                raise _Error(20)
            else:
                raise _Error(23, nxt)
            s = nxt

    def _do_epilog(self, s, have_more):
        """epilogProcessor: after the document element, only white space, comments and PIs"""
        sc = self._scan
        t = self._text
        end = sc.end_of(len(t))
        while True:
            self._ev[0] = s
            tok, nxt = sc.prolog_tok(s, end)
            self._ev[1] = nxt
            if tok not in (_TOK_INVALID, _TOK_PARTIAL, _TOK_PARTIAL_CHAR, _TOK_NONE):
                self._account(self._blen(t[s:nxt]), True)
            if tok == -_TOK_PROLOG_S:
                self._default_text(t, s, nxt)
                return (nxt, False)
            if tok == _TOK_NONE:
                return (s, False)
            if tok == _TOK_PROLOG_S:
                self._default_text(t, s, nxt)
            elif tok == _TOK_PI:
                self._report_pi(s, nxt)
            elif tok == _TOK_COMMENT:
                self._report_comment(s, nxt)
            elif tok == _TOK_INVALID:
                raise _Error(4, nxt)
            elif tok == _TOK_PARTIAL:
                if not self._final:
                    return (s, False)
                raise _Error(5)
            elif tok == _TOK_PARTIAL_CHAR:
                if not self._final:
                    return (s, False)
                raise _Error(6)
            else:
                raise _Error(9)
            s = nxt

    # ------------------------------------------------------------------ attributes and namespaces (storeAtts)
    def _store_atts(self, sc, t, s, nxt, raw_name, bindings, account_direct, doc):
        """storeAtts: the element's name (expanded) and its attributes, as the start handler gets them"""
        dtd = self._dtd
        et = self._element_type(raw_name)
        atts = sc.atts if sc.atts is not None and sc.s is t else _get_atts(t, s + 1 + len(raw_name), self._chars)
        sc.atts = None
        cost = 0
        for na, nb, va, vb, normalized in atts:
            cost += _str_cost(nb - na) + _str_cost(vb - va) + _ENTRY_COST
        self._charge(cost)
        try:
            seen = {}
            app = []
            n_prefixes = 0
            for na, nb, va, vb, normalized in atts:
                att = self._attribute_id(t[na:nb])
                if att in seen:
                    raise _Error(8, na if doc else None)
                seen[att] = 1
                if not normalized:
                    is_cdata = True
                    if att.maybe_tokenized:
                        k = et.default_for_name.get(att.name)
                        if k is not None:
                            is_cdata = et.default_atts[k][2]
                    value = self._store_attribute_value(is_cdata, t, va, vb, account_direct, False)
                else:
                    value = t[va:vb]
                if att.prefix is not None:
                    if att.xmlns:
                        self._add_binding(att.prefix, att, value, bindings)
                        continue
                    n_prefixes += 1
                    seen[att] = 2
                app.append([att, value])
            n_specified = len(app)
            for att, value, is_cdata in et.default_atts:
                if att not in seen and value is not None:
                    if att.prefix is not None:
                        if att.xmlns:
                            self._add_binding(att.prefix, att, value, bindings)
                            continue
                        seen[att] = 2
                        n_prefixes += 1
                    else:
                        seen[att] = 1
                    app.append([att, value])
            names = []
            expanded = set()
            for att, value in app:
                if n_prefixes and seen.get(att) == 2:
                    b = att.prefix.binding
                    if b is None:
                        raise _Error(27)
                    uname = b.uri + att.name[att.name.index(":") + 1:]
                    if uname in expanded:
                        raise _Error(8)
                    expanded.add(uname)
                    if self._ns_triplets:
                        uname += self._sep + b.prefix.name
                    names.append(uname)
                else:
                    names.append(att.name)
            # (the element's name)
            ename = raw_name
            if self._ns:
                if et.prefix is not None:
                    b = et.prefix.binding
                    if b is None:
                        raise _Error(27)
                    local = raw_name[raw_name.index(":") + 1:]
                elif dtd.default_prefix.binding is not None:
                    b = dtd.default_prefix.binding
                    local = raw_name
                else:
                    b = None
                if b is not None:
                    ename = b.uri + local
                    if self._ns_triplets and b.prefix.name:
                        ename += self._sep + b.prefix.name
            if self.specified_attributes:
                del app[n_specified:]
                del names[n_specified:]
            name = self._name(ename)
            if self.ordered_attributes:
                out = []
                for k, (att, value) in enumerate(app):
                    out.append(self._name(names[k]))
                    out.append(value)
            else:
                out = {}
                for k, (att, value) in enumerate(app):
                    out[self._name(names[k])] = value
            return name, out
        finally:
            self._release(cost)

    def _add_binding(self, prefix, att, uri, bindings):
        """addBinding: a namespace declaration, checked, and its start reported"""
        if uri == "" and prefix.name is not None:
            raise _Error(28)
        must_be_xml = False
        if prefix.name is not None and prefix.name[:3] == "xml":
            if prefix.name == "xmlns":
                raise _Error(39)
            if prefix.name == "xml":
                must_be_xml = True
        if self._ns and self._sep and self._sep in uri and self._sep not in _URI_CHARS:
            raise _Error(2)
        is_xml = uri == _XML_NS
        if must_be_xml != is_xml:
            raise _Error(38 if must_be_xml else 40)
        if not must_be_xml and uri == _XMLNS_NS:
            raise _Error(40)
        self._charge(_ENTRY_COST + _str_cost(len(uri)))
        b = _Binding(prefix, att, uri + self._sep, prefix.binding)
        if uri == "" and prefix is self._dtd.default_prefix:
            prefix.binding = None
        else:
            prefix.binding = b
        bindings.insert(0, b)
        if att is not None:
            self._report("StartNamespaceDeclHandler", prefix.name, uri if prefix.binding is not None else None)

    def _free_bindings(self, bindings):
        for b in bindings:
            self._report("EndNamespaceDeclHandler", b.prefix.name)
            b.prefix.binding = b.prev
            self._release(_ENTRY_COST + _str_cost(len(b.uri)))
        del bindings[:]


# ---------------------------------------------------------------------------- helpers
_PREDEFINED = {"lt": "<", "gt": ">", "amp": "&", "quot": '"', "apos": "'"}
_NAME_CLASS_RE = {}


def _truth(v):
    return bool(v)


def _name_length(t, a, chars):
    """XmlNameLength: name characters, colons included"""
    r = _NAME_CLASS_RE.get(chars.ns)
    if r is None:
        r = _re.compile("[A-Z_a-z0-9.\\-:" + _NAME_NONASCII + "]*")
        _NAME_CLASS_RE[chars.ns] = r
    i = a
    n = len(t)
    while True:
        lim = min(n, i + _WINDOW)
        j = r.match(t, i, lim).end()
        if j < lim or j >= n:
            return j - a
        i = j


_ATT_EXTRACT = _re.compile("[\\t\\n\\r ]+([^\\t\\n\\r =]+)[\\t\\n\\r ]*=[\\t\\n\\r ]*(?:\"([^\"]*)\"|'([^']*)')")
_NOT_NORMAL = _re.compile("[&\\t\\r\\n]|  ")


def _get_atts(t, i, chars):
    """getAtts over a well-formed start tag from just after its element name: [name start, name end, value start,
    value end, normalized] for each attribute; a value is normalized if it has no reference, line end or tab, no
    leading or trailing space, and no two spaces in a row"""
    atts = []
    while True:
        m = _ATT_EXTRACT.match(t, i)
        if m is None:
            return atts
        g = 2 if m.group(2) is not None else 3
        vs, ve = m.start(g), m.end(g)
        normalized = not (vs < ve and (t[vs] == " " or t[ve - 1] == " " or _NOT_NORMAL.search(t, vs, ve)))
        atts.append([m.start(1), m.end(1), vs, ve, normalized])
        i = m.end()


def _char_ref_number(t, s):
    """XmlCharRefNumber of "&#...;" at s: the code point, or -1 for one XML forbids"""
    k = s + 2
    result = 0
    if t[k] == "x":
        k += 1
        while t[k] != ";":
            result = (result << 4) | int(t[k], 16)
            if result >= 0x110000:
                return -1
            k += 1
    else:
        while t[k] != ";":
            result = result * 10 + (ord(t[k]) - 48)
            if result >= 0x110000:
                return -1
            k += 1
    hi = result >> 8
    if 0xD8 <= hi <= 0xDF:
        return -1
    if hi == 0 and result < 0x20 and result not in (0x9, 0xA, 0xD):
        return -1
    if result == 0xFFFE or result == 0xFFFF:
        return -1
    return result


def _normalize_lines(s):
    if "\r" not in s:
        return s
    return s.replace("\r\n", "\n").replace("\r", "\n")


def _normalize_public_id(s):
    out = []
    for ch in s:
        if ch in " \r\n":
            if out and out[-1] != " ":
                out.append(" ")
        else:
            out.append(ch)
    if out and out[-1] == " ":
        out.pop()
    return "".join(out)


_DECL_SPACE = " \r\n\t"


def _pseudo_attribute(t, i, end):
    """parsePseudoAttribute: (ok, name start, name end, value start, next) with name start None at the end"""
    if i == end:
        return (True, None, None, None, i)
    if t[i] not in _DECL_SPACE:
        return (False, None, None, None, i)
    while i < end and t[i] in _DECL_SPACE:
        i += 1
    if i == end:
        return (True, None, None, None, i)
    name = i
    while True:
        if i >= end or ord(t[i]) >= 0x80:
            return (False, None, None, None, i)
        c = t[i]
        if c == "=":
            name_end = i
            break
        if c in _DECL_SPACE:
            name_end = i
            while True:
                i += 1
                if i >= end or t[i] not in _DECL_SPACE:
                    break
            if i >= end or t[i] != "=":
                return (False, None, None, None, i)
            break
        i += 1
    if i == name:
        return (False, None, None, None, i)
    i += 1
    while i < end and t[i] in _DECL_SPACE:
        i += 1
    if i >= end or t[i] not in "\"'":
        return (False, None, None, None, i)
    opn = t[i]
    i += 1
    val = i
    while True:
        if i >= end:
            return (False, None, None, None, i)
        c = t[i]
        if c == opn:
            break
        if not (("a" <= c <= "z") or ("A" <= c <= "Z") or ("0" <= c <= "9") or c in ".-_"):
            return (False, None, None, None, i)
        i += 1
    return (True, name, name_end, val, i + 1)


def _parse_xml_decl(t, s, nxt):
    """doParseXmlDecl over the declaration t[s:nxt]: (version, (encoding, index) or None, standalone, bad index or
    None)"""
    i = s + 5
    end = nxt - 2
    ok, na, nb, va, i2 = _pseudo_attribute(t, i, end)
    if not ok or na is None:
        return (None, None, -1, i2)
    version = None
    encname = None
    standalone = -1
    if t[na:nb] != "version":
        return (None, None, -1, na)
    vend = i2 - 1
    if va == vend:
        return (None, None, -1, va)
    v = t[va:vend]
    if not (len(v) >= 3 and v[:2] == "1." and v[2:].isdigit() and v[2:].isascii()):
        return (None, None, -1, va)
    version = v
    i = i2
    ok, na, nb, va, i2 = _pseudo_attribute(t, i, end)
    if not ok:
        return (None, None, -1, i2)
    if na is None:
        return (version, None, -1, None)
    if t[na:nb] == "encoding":
        c = t[va] if va < end else ""
        if not (("a" <= c <= "z") or ("A" <= c <= "Z")):
            return (None, None, -1, va)
        encname = (t[va:i2 - 1], va)
        i = i2
        ok, na, nb, va, i2 = _pseudo_attribute(t, i, end)
        if not ok:
            return (None, None, -1, i2)
        if na is None:
            return (version, encname, -1, None)
    if t[na:nb] != "standalone":
        return (None, None, -1, na)
    sv = t[va:i2 - 1]
    if sv == "yes":
        standalone = 1
    elif sv == "no":
        standalone = 0
    else:
        return (None, None, -1, va)
    i = i2
    while i < end and t[i] in _DECL_SPACE:
        i += 1
    if i != end:
        return (None, None, -1, i)
    return (version, encname, standalone, None)


_MISSING = object()


def ParserCreate(*args, **kwargs):
    """Return a new XML parser object."""
    if len(args) > 3:
        raise TypeError(f"ParserCreate() takes at most 3 arguments ({len(args)} given)")
    names = ("encoding", "namespace_separator", "intern")
    values = dict(zip(names, args))
    for k, v in kwargs.items():
        if k not in names:
            raise TypeError(f"ParserCreate() got an unexpected keyword argument '{k}'")
        if k in values:
            raise TypeError(f"argument for ParserCreate() given by name ('{k}') and position ({names.index(k) + 1})")
        values[k] = v
    encoding = values.get("encoding")
    namespace_separator = values.get("namespace_separator")
    intern = values.get("intern", _MISSING)
    if encoding is not None and not isinstance(encoding, str):
        raise TypeError(f"ParserCreate() argument 'encoding' must be str or None, not {type(encoding).__name__}")
    if namespace_separator is not None and not isinstance(namespace_separator, str):
        raise TypeError("ParserCreate() argument 'namespace_separator' must be str or None, not "
                        f"{type(namespace_separator).__name__}")
    if namespace_separator is not None and len(namespace_separator) > 1:
        raise ValueError("namespace_separator must be at most one character, omitted, or None")
    if intern is _MISSING:
        intern = {}
    elif intern is not None and not isinstance(intern, dict):
        raise TypeError("intern must be a dictionary")
    return XMLParserType(_CREATE, encoding, namespace_separator, intern)


def _advance(pos, seg):
    """(line, column) after seg from pos, as expat's XmlUpdatePosition counts: CR LF, CR and LF each one line"""
    line, col = pos
    nl = seg.count("\n") + seg.count("\r") - seg.count("\r\n")
    if nl:
        k = max(seg.rfind("\n"), seg.rfind("\r"))
        return (line + nl, len(seg) - k - 1)
    return (line, col + len(seg))


def _unmap(table, text):
    """The bytes of text in an unknown single-byte encoding (its decoding table inverted)"""
    inverse = {ch: b for b, ch in table.items()}
    return [inverse.get(ch, 0x3F) for ch in text]


# (the type is pyexpat.XMLParserType; CPython's module has no name xmlparser)
XMLParserType = xmlparser
xmlparser.__module__ = "pyexpat"
del xmlparser
