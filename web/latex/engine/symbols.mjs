// Text-mode symbols (LaTeX kernel, textcomp, textgreek, gensymb, amssymb text forms) -> Unicode.
export const TEXT_SYMBOLS = {
  // kernel
  "&": "&", "%": "%", "$": "$", "#": "#", "_": "_", "{": "{", "}": "}", " ": " ", "@": "", "/": "", "-": "­",
  textbackslash: "\\", textasciitilde: "~", textasciicircum: "^", textunderscore: "_", textbar: "|", textless: "<", textgreater: ">",
  textbraceleft: "{", textbraceright: "}", textdollar: "$", textquotedbl: "\"", textquotesingle: "'", textasciigrave: "`",
  textquoteleft: "‘", textquoteright: "’", textquotedblleft: "“", textquotedblright: "”", quotedblbase: "„", quotesinglbase: "‚",
  guillemotleft: "«", guillemotright: "»", guilsinglleft: "‹", guilsinglright: "›", flqq: "«", frqq: "»",
  textendash: "–", textemdash: "—", textellipsis: "…", ldots: "…", dots: "…", textbullet: "•", textperiodcentered: "·",
  textvisiblespace: "␣", textexclamdown: "¡", textquestiondown: "¿", S: "§", P: "¶", dag: "†", ddag: "‡",
  textsection: "§", textparagraph: "¶", textdagger: "†", textdaggerdbl: "‡", copyright: "©", textcopyright: "©",
  textregistered: "®", texttrademark: "™", textservicemark: "℠", pounds: "£", textsterling: "£",
  ss: "ß", SS: "SS", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", o: "ø", O: "Ø", aa: "å", AA: "Å",
  l: "ł", L: "Ł", i: "ı", j: "ȷ", IJ: "Ĳ", ij: "ĳ", TH: "Þ", th: "þ", DH: "Ð", dh: "ð",
  DJ: "Đ", dj: "đ", NG: "Ŋ", ng: "ŋ",
  // textcomp
  textdegree: "°", textcelsius: "℃", degree: "°", celsius: "℃", textohm: "Ω", ohm: "Ω", textmu: "µ", micro: "µ",
  texteuro: "€", euro: "€", textcent: "¢", textyen: "¥", textbaht: "฿", textcolonmonetary: "₡", textcurrency: "¤",
  textdong: "₫", textflorin: "ƒ", textlira: "₤", textnaira: "₦", textpeso: "₱", textwon: "₩", textguarani: "₲",
  textperthousand: "‰", perthousand: "‰", textpertenthousand: "‱", textonehalf: "½", textthreequarters: "¾", textonequarter: "¼",
  textfractionsolidus: "⁄", textdiv: "÷", texttimes: "×", textminus: "−", textpm: "±", textsurd: "√", textlnot: "¬",
  textasteriskcentered: "∗", textonesuperior: "¹", texttwosuperior: "²", textthreesuperior: "³",
  textleftarrow: "←", textuparrow: "↑", textrightarrow: "→", textdownarrow: "↓",
  checkmark: "✓", textreferencemark: "※", textordfeminine: "ª", textordmasculine: "º", textmarried: "⚭", textdivorced: "⚮",
  textbardbl: "‖", textbrokenbar: "¦", textbigcircle: "◯", textcircledP: "℗", textnumero: "№", textrecipe: "℞",
  textestimated: "℮", textmusicalnote: "♪", textdiscount: "⁒", textinterrobang: "‽", textlangle: "〈", textrangle: "〉",
  textzerooldstyle: "0", textoneoldstyle: "1", texttwooldstyle: "2", textthreeoldstyle: "3", textfouroldstyle: "4", textfiveoldstyle: "5",
  textsixoldstyle: "6", textsevenoldstyle: "7", texteightoldstyle: "8", textnineoldstyle: "9",
  // textgreek
  textalpha: "α", textbeta: "β", textgamma: "γ", textdelta: "δ", textepsilon: "ε", textzeta: "ζ", texteta: "η",
  texttheta: "θ", textiota: "ι", textkappa: "κ", textlambda: "λ", textnu: "ν", textxi: "ξ", textomikron: "ο",
  textpi: "π", textrho: "ρ", textsigma: "σ", texttau: "τ", textupsilon: "υ", textphi: "φ", textchi: "χ",
  textpsi: "ψ", textomega: "ω", textAlpha: "Α", textBeta: "Β", textGamma: "Γ", textDelta: "Δ", textEpsilon: "Ε",
  textZeta: "Ζ", textEta: "Η", textTheta: "Θ", textIota: "Ι", textKappa: "Κ", textLambda: "Λ", textMu: "Μ",
  textNu: "Ν", textXi: "Ξ", textOmikron: "Ο", textPi: "Π", textRho: "Ρ", textSigma: "Σ", textTau: "Τ",
  textUpsilon: "Υ", textPhi: "Φ", textChi: "Χ", textPsi: "Ψ", textOmega: "Ω", textfinalsigma: "ς",
  // misc text forms
  textless: "<", textgreater: ">", dots: "…", ldots: "…", cdots: "⋯", textcircled: "", lq: "‘", rq: "’",
  slash: "/", nobreakspace: " ", textnbsp: " ", enspace: " ", quad: " ", qquad: "  ", thinspace: " ", ",": " ",
  ";": " ", ":": " ", ">": " ", "!": "", negthinspace: "", enskip: " ", dotfill: " … ", hfill: " ", hfil: " ", hss: "",
  textbackslash: "\\", backslash: "\\",
};

// accents (text mode): \' \` \^ \" \~ \= \. \u \v \H \c \d \b \r \t \k -> combining marks
export const ACCENTS = {
  "'": "́", "`": "̀", "^": "̂", "\"": "̈", "~": "̃", "=": "̄", ".": "̇", u: "̆", v: "̌",
  H: "̋", c: "̧", d: "̣", b: "̱", r: "̊", t: "͡", k: "̨",
};

// font size declarations -> CSS class
export const SIZES = { tiny: "sz-tiny", scriptsize: "sz-script", footnotesize: "sz-foot", small: "sz-small", normalsize: "", large: "sz-large",
  Large: "sz-Large", LARGE: "sz-LARGE", huge: "sz-huge", Huge: "sz-Huge" };

// colors: a fixed allowlist of names (xcolor base) -> CSS; \definecolor values are validated numbers
export const COLORS = { black: "#000", white: "#fff", red: "#d00", green: "#080", blue: "#00c", cyan: "#0aa", magenta: "#c0c", yellow: "#cc0",
  gray: "#808080", grey: "#808080", darkgray: "#404040", lightgray: "#bfbfbf", brown: "#963", lime: "#bf0", olive: "#880", orange: "#f80",
  pink: "#fbb", purple: "#a0a", teal: "#088", violet: "#808" };
