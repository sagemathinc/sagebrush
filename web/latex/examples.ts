// The LaTeX editor's examples ("From an example"; William, Oct 29: "10 examples (similar to what we have for notebooks).
// ... templates, but also good tests to illustrate the breadth of editor support"). Each is a folder of files: the main
// .tex first, then its assets (an image as base64). A note at the top of each says, in the document itself, what this
// preview can't do yet and what a full LaTeX run does instead. test-latex-units.mjs renders all of them.
// (String.raw: the LaTeX as written; none contains a backtick or a dollar sign before a brace)

export type Example = { id: string; title: string; about: string; files: [name: string, text: string, base64?: true][] };

const PLOT_PNG = "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAACXElEQVR42u3dsU7EMAyA4TwGKzNvdQO8C2+CxMRLMJ6YmW+GLRMSA9KpapvUie3UPf4o413SfqqqNHbdlHP++Xz/61/Pp2l/u3vw67O5rseQJ+3j8n3tTy/nab9/fNX32ZjT6a7HkI4CNDMyB5rNdXggvVHl8gGoF2hmNAxoegAANQC53qcld+hjA2mMlkP1APkZlW5AdSAro7oOQP8MqImp9Pd+IA+j5RRyII2RUGcDyNuorrMEajJaYm3+sq4jBbIyWh3ZA0jezYD0RqVhO4BMmErDbgN5GAl1VoE8jIQ6RaCKUZNUfZDVeXOhlU6pSao+yOq8RaBNI2UvTdoHtErW+pdmID+jyoy52lrPWUMjAvIwqk+Xt9pIHRGQlZRwlixuri49QHI1zYBZ0fQc9kDmPQdrAAGkB6IdDCjUFQ0QQDsCeaw7oq3LkgmH4co12so+ebt0SIV6NkzRnp6j7S6kaPsv0fanOoH8dvCi7XCmaHvA0fbIU7QoQrQoiwhoZBwqWpzOBsgwkhkt0puixcKj5QqkaNkU0bJNmoG883EAuiGgXXICo+VMNgCNySoNDRQhLxmgBqAImf8AGQENe7vmMEB7vZ/FFcQ9iJs0QKyDWEl7APEsxtM8QAOA2FFkT/pEVEMR1SAuRmRVHVklNk92hzq7g/wgMszUGWbkKJLlSp704DxpMu0BAug2gHjjkFcyAQKI9+bbgai8QO2OdiCqv1A/qLd+EBWoakDUMKsBUQWvB4g6ilTilAFRy5VqwGfqSVNPOggQNe0zX0U4NhBfZuHTNQDd/NehfgGY3TViyrhJmgAAAABJRU5ErkJggg==";

const article = String.raw`\documentclass{article}
\usepackage{amsmath,amssymb,amsthm}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\theoremstyle{definition}
\newtheorem{definition}[theorem]{Definition}

\title{Sums of Squares}
\author{A. Student}
\date{October 2026}

\begin{document}
\maketitle
\begin{abstract}
A short article: sections, numbered equations, theorems with proofs, and cross-references.
\end{abstract}
\tableofcontents

\section{Introduction}\label{sec:intro}
Which integers are sums of two squares? We collect the classical answer; see Theorem~\ref{thm:fermat}
and Section~\ref{sec:proof}.

\section{Statement}
\begin{definition}
An integer $n \ge 0$ is a \emph{sum of two squares} if $n = a^2 + b^2$ for some $a, b \in \mathbb{Z}$.
\end{definition}

\begin{lemma}\label{lem:product}
Products of sums of two squares are sums of two squares:
\begin{equation}\label{eq:brahmagupta}
(a^2+b^2)(c^2+d^2) = (ac-bd)^2 + (ad+bc)^2 .
\end{equation}
\end{lemma}

\begin{theorem}[Fermat]\label{thm:fermat}
An odd prime $p$ is a sum of two squares if and only if $p \equiv 1 \pmod 4$.
\end{theorem}

\section{Proof sketch}\label{sec:proof}
\begin{proof}
If $p = a^2 + b^2$, then $p \equiv 1 \pmod 4$, since squares are $0$ or $1$ modulo $4$. Conversely,
choose $x$ with $x^2 \equiv -1 \pmod p$ and apply Thue's lemma; by \eqref{eq:brahmagupta} the rest follows.
\end{proof}

\begin{align}
  \sum_{n=1}^{\infty} \frac{1}{n^2} &= \frac{\pi^2}{6}, &
  \int_0^1 x^n \, dx &= \frac{1}{n+1}.
\end{align}
\end{document}
`;

const beamer = String.raw`\documentclass{beamer}
\usetheme{Madrid}
\title{A Short Talk}
\subtitle{Slides with beamer}
\author{A. Speaker}
\date{October 2026}

\begin{document}
\begin{frame}
  \titlepage
\end{frame}

\begin{frame}{In this preview}
  The preview shows each frame as a section of the page, with its content. It doesn't draw the theme or
  page through overlays: every \texttt{\textbackslash pause} and \texttt{<2->} step is shown at once. A
  full LaTeX run makes the PDF slides.
\end{frame}

\begin{frame}{Overlays}
  \begin{itemize}
    \item<1-> First, the question.
    \item<2-> Then, an idea.
    \item<3-> Finally, the answer.
  \end{itemize}
  \pause
  Revealed last.
\end{frame}

\begin{frame}{Two columns}
  \begin{columns}
    \begin{column}{0.5\textwidth}
      Left: words.
    \end{column}
    \begin{column}{0.5\textwidth}
      Right: $e^{i\pi} + 1 = 0$.
    \end{column}
  \end{columns}
\end{frame}

\begin{frame}{A math slide}
  \begin{block}{Theorem}
    For every $n \ge 1$, $\displaystyle \sum_{k=1}^{n} k = \frac{n(n+1)}{2}$.
  \end{block}
  \[ \det\begin{pmatrix} a & b \\ c & d \end{pmatrix} = ad - bc \]
\end{frame}
\end{document}
`;

const sagetex = String.raw`\documentclass{article}
\usepackage{sagetex}
\begin{document}
\section*{SageTeX}

\emph{In this preview:} SageTeX code is found and listed, but not run yet: running it needs the Sage
compute backend, which is not connected. Each \texttt{\textbackslash sage\{...\}} shows as a placeholder.
A full LaTeX run (latex, then sage, then latex again) fills in the results.

\begin{sagesilent}
f(x) = x^3 - 2*x + 1
g = f.diff(x)
\end{sagesilent}

The derivative of $f(x) = x^3 - 2x + 1$ is $f'(x) = \sage{g(x)}$, and
$\int_0^1 f(x)\,dx = \sage{integral(f(x), x, 0, 1)}$.

The 10th prime is $\sage{nth_prime(10)}$, and $2^{100} = \sage{2^100}$.

\sageplot[width=0.5\textwidth]{plot(sin(x), (x, 0, 2*pi))}
\end{document}
`;

const pythontex = String.raw`\documentclass{article}
\usepackage{pythontex}
\begin{document}
\section*{PythonTeX}

\emph{In this preview:} PythonTeX code is not run yet, so its results are missing; the code is shown as
written. A full run (latex, then pythontex, then latex again) runs the Python and puts the results in.

\begin{pycode}
from math import comb, factorial
rows = [[comb(n, k) for k in range(n + 1)] for n in range(6)]
\end{pycode}

Ten factorial is \py{factorial(10)}, and $\binom{10}{3}$ is \py{comb(10, 3)}.

The sixth row of Pascal's triangle: \py{rows[5]}.

\begin{pyverbatim}
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
\end{pyverbatim}
\end{document}
`;

const matlab = String.raw`\documentclass{article}
\usepackage{listings}
\lstset{language=Matlab, basicstyle=\ttfamily\small, frame=single}
\begin{document}
\section*{MATLAB in LaTeX}

A MATLAB listing, typeset with \texttt{listings} (the \texttt{matlab-prettifier} package gives a closer MATLAB look
in a full LaTeX run).

\emph{In this preview:} the code is shown, not run. To compute with it, open a notebook in MATLAB mode (File,
New, Notebook, then choose MATLAB) and paste it there; then copy the results back.

\begin{lstlisting}
% the eigenvalues of a symmetric matrix
A = [2 -1 0; -1 2 -1; 0 -1 2];
[V, D] = eig(A);
lambda = diag(D)'
x = linspace(0, 2*pi, 100);
plot(x, sin(x)), grid on
\end{lstlisting}

For this $A$, the eigenvalues are $2 - \sqrt{2}$, $2$ and $2 + \sqrt{2}$:
\[
  A = \begin{pmatrix} 2 & -1 & 0 \\ -1 & 2 & -1 \\ 0 & -1 & 2 \end{pmatrix},
  \qquad \lambda \in \{\, 2-\sqrt{2},\ 2,\ 2+\sqrt{2} \,\}.
\]
\end{document}
`;

const figure = String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
\section*{A figure with an image}

Figure~\ref{fig:plot} shows $\sin x \cos y$ on $[0, 2\pi]^2$ as colour bands. The image,
\texttt{plot.png}, is a file in this folder: the preview reads it from there.

\begin{figure}[ht]
  \centering
  \includegraphics[width=0.4\textwidth]{plot.png}
  \caption{The function $\sin x \cos y$: blue below zero, red above.}
  \label{fig:plot}
\end{figure}

As Figure~\ref{fig:plot} shows, the zero set is a grid of lines.
\end{document}
`;

const cv = String.raw`\documentclass[11pt]{article}
\usepackage[margin=2cm]{geometry}
\usepackage{hyperref}
\pagestyle{empty}
\begin{document}

\begin{center}
  {\LARGE\textbf{Ada Example}}\\[4pt]
  Mathematician \quad\textbullet\quad ada@example.org \quad\textbullet\quad \url{https://example.org}
\end{center}

\section*{Education}
\begin{tabular}{@{}p{3cm}l@{}}
  2020--2025 & Ph.D. in Mathematics, Example University \\
  2016--2020 & B.Sc. in Mathematics and Physics, Sample College \\
\end{tabular}

\section*{Experience}
\begin{tabular}{@{}p{3cm}l@{}}
  2025-- & Postdoctoral fellow, Institute of Examples \\
  2022--2024 & Teaching assistant: Linear Algebra, Number Theory \\
\end{tabular}

\section*{Publications}
\begin{enumerate}
  \item A. Example, \emph{On sums of two squares}, Journal of Examples \textbf{12} (2024), 1--20.
  \item A. Example and B. Sample, \emph{Modular forms in practice}, preprint (2025).
\end{enumerate}

\section*{Skills}
\begin{itemize}
  \item Python, SageMath, MATLAB, \LaTeX
  \item Languages: English, French
\end{itemize}

\end{document}
`;

const tikz = String.raw`\documentclass{article}
\usepackage{tikz}
\usepackage{pgfplots}
\pgfplotsset{compat=1.18}
\begin{document}
\section*{TikZ and pgfplots}

\emph{In this preview:} TikZ and pgfplots pictures are not drawn yet; each shows as a placeholder with its
source. A full LaTeX run draws them.

\begin{center}
\begin{tikzpicture}
  \begin{axis}[xlabel={$x$}, ylabel={$y$}, domain=-2:2, samples=50, legend pos=north west]
    \addplot[blue, thick] {x^2};
    \addlegendentry{$x^2$}
    \addplot[red, dashed] {x^3};
    \addlegendentry{$x^3$}
  \end{axis}
\end{tikzpicture}
\end{center}

\begin{center}
\begin{tikzpicture}
  \draw[->] (-0.2,0) -- (3,0) node[right] {$x$};
  \draw[->] (0,-0.2) -- (0,2) node[above] {$y$};
  \draw[thick, blue] (0,0) circle (1cm);
  \fill[red] (1,1) circle (2pt) node[above right] {$(1,1)$};
\end{tikzpicture}
\end{center}
\end{document}
`;

const bib = String.raw`\documentclass{article}
\begin{document}
\section*{A bibliography}

Modular forms are treated in \cite{diamond-shurman}; for the history of the subject see \cite{hardy}
and \cite{serre}. Several at once: \cite{serre, hardy}.

\emph{In this preview:} citations are resolved from the \texttt{thebibliography} list below. The file
\texttt{refs.bib} in this folder holds the same entries for BibTeX or biblatex: with a full LaTeX run,
replace the list with \texttt{\textbackslash bibliographystyle\{plain\}} and
\texttt{\textbackslash bibliography\{refs\}}.

\begin{thebibliography}{9}
\bibitem{diamond-shurman} F. Diamond and J. Shurman, \emph{A First Course in Modular Forms}, Springer, 2005.
\bibitem{hardy} G. H. Hardy, \emph{Ramanujan: Twelve Lectures}, Cambridge University Press, 1940.
\bibitem{serre} J.-P. Serre, \emph{A Course in Arithmetic}, Springer, 1973.
\end{thebibliography}
\end{document}
`;

const refsBib = String.raw`@book{diamond-shurman,
  author    = {Fred Diamond and Jerry Shurman},
  title     = {A First Course in Modular Forms},
  publisher = {Springer},
  year      = {2005}
}
@book{hardy,
  author    = {G. H. Hardy},
  title     = {Ramanujan: Twelve Lectures on Subjects Suggested by His Life and Work},
  publisher = {Cambridge University Press},
  year      = {1940}
}
@book{serre,
  author    = {Jean-Pierre Serre},
  title     = {A Course in Arithmetic},
  publisher = {Springer},
  year      = {1973}
}
`;

const exam = String.raw`\documentclass{article}
\usepackage{amsmath}
\newcommand{\points}[1]{\hfill\textbf{(#1 points)}}
\begin{document}
\begin{center}
  {\Large\textbf{Math 101: Homework 3}}\\
  Due Friday. Total: 30 points.
\end{center}

\noindent Name: \underline{\hspace{6cm}}

\begin{enumerate}
  \item Compute $\displaystyle \int_0^{\pi} \sin x \, dx$. \points{5}
  \item Solve the system \points{10}
    \[ \begin{aligned} x + y &= 3, \\ 2x - y &= 0. \end{aligned} \]
  \item Prove that $\sqrt{2}$ is irrational. \points{10}
  \item True or false? Give a reason. \points{5}
    \begin{enumerate}
      \item Every continuous function is differentiable.
      \item $\sum_{n \ge 1} 1/n$ converges.
    \end{enumerate}
\end{enumerate}
\end{document}
`;

export const EXAMPLES: Example[] = [
  { id: "article", title: "Article", about: "Sections, equations, theorems and proofs, cross-references, a table of contents", files: [["article.tex", article]] },
  { id: "beamer", title: "Beamer talk", about: "Slides: overlays, columns, a math slide", files: [["talk.tex", beamer]] },
  { id: "sagetex", title: "SageTeX", about: "Sage computations in the document (\\sage, sagesilent, \\sageplot)", files: [["sagetex.tex", sagetex]] },
  { id: "pythontex", title: "PythonTeX", about: "Python in the document (pycode, \\py)", files: [["pythontex.tex", pythontex]] },
  { id: "matlab", title: "MATLAB code", about: "A MATLAB listing, with the math it computes", files: [["matlab.tex", matlab]] },
  { id: "figure", title: "Figure with an image", about: "graphicx, a caption and a reference to the figure", files: [["figure.tex", figure], ["plot.png", PLOT_PNG, true]] },
  { id: "cv", title: "CV", about: "A one-page curriculum vitae", files: [["cv.tex", cv]] },
  { id: "tikz", title: "TikZ and pgfplots", about: "A plot and a drawing", files: [["tikz.tex", tikz]] },
  { id: "bibliography", title: "Bibliography", about: "Citations and a reference list (and a .bib file)", files: [["bibliography.tex", bib], ["refs.bib", refsBib]] },
  { id: "homework", title: "Homework or exam", about: "Numbered problems with points", files: [["homework.tex", exam]] },
];
