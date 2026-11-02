---
jupytext:
  formats: ipynb,sage:percent,md:myst
  text_representation:
    extension: .md
    format_name: myst
    format_version: 0.13
    jupytext_version: 1.17.3
kernelspec:
  display_name: SageMath 10.7
  language: sage
  name: sage-10.7
---

(ch:improve_dl)=
# Improvements on Computations of Discrete Logs

+++

In this chapter we introduce methods that can improve on Shank's Baby-Step/Giant-Step algorithm when the order of the base is not prime.

+++

## Solving the Discrete Log for Powers of Prime Orders

Suppose that $g \in \mathbb{F}_p^{\times}$ such that $g$ has order $q^e$, where $q$ is some prime and $e$ is an integer greater than one.  Of course, we can use {prf:ref}`Shank's Baby-Step/Giant-Step algorithm <al-bs_gs>`.  But there is a more efficient way in this case!

+++

### Algorithm

:::{prf:algorithm} Discrete Log for Power of Prime Order
:label: al-dl-power


Let $g, h \in \mathbb{F}_p^{\times}$ such that $|g| = q^e$, where $q$ is some prime and $e \geq 2$.  To compute $\log_g(h)$:

1) Initialize $N_0 = |g| = q^e$, $N = N_0$, $x = 0$.
2) While $N > 1$:
   1) Compute $y = \log_{g^{N/q}}\left( h^{N/q}\right)$ using {prf:ref}`Shank's Baby-Step/Giant-Step algorithm <al-bs_gs>`.
   2) Let $x \leftarrow x + y N_0/N$, $h \leftarrow g^{-y}h$, $g \leftarrow g^q$, and $N \leftarrow N/q$.
3) Return $x$.
:::

(Remember that the $\leftarrow$ denotes {prf:ref}`assignment <not-assignment>`.)

Note that in the loop, every iteration divides $N$ by $q$, so it takes a total of $e$ iterations to get to $N=1$ and the loop to stop.

+++

### Why Does It Work

Let's try to justify why the algorithm above indeed gives us the discrete log $\log_g(h)$.

Before we get into it, let's remind ourselves of a couple of results we've seen in [chapter about powers](#ch-powers):

:::{prf:proposition} Properties of Powers
:label: prop-powers


If $a$ is a unit in $\mathbb{Z}/n\mathbb{Z}$ of order $m$, then:

1) For any integer $k$ we have:
```{math}
|a^k| = \frac{|a|}{\gcd(|a|, k)} = \frac{m}{\gcd(m, k)}.
```
2) We have:
```{math}
a^k = a^l \quad \text{ if and only if } \quad k \equiv l \pmod{|a|}.
```
:::

So, suppose that $g \in \mathbb{F}_p^{\times}$ with $|g| = q^e$ for some prime $q$ and $e \geq 2$, and that $h = g^{x}$, for some $x \in \{0, 1, 2, \ldots , q^e - 1\}$.  (Note that we do not know the value of $x$, as it is what we are trying to compute.  But we are assuming that it *exists*.).  We then can write $x$ in base $q$ as
```{math}
x = d_0 + d_1 q + d_2 q^2 + \cdots + d_{e-1} q^{e-1}, \quad d_i \in \{ 0, 1, \ldots, q-1 \} .
```

Let's find the first digit $d_0$.  Since $g^x = h$, we start by raising both sides to the power $q^{e-1}$:
```{math}
:label: eq-dl1

\left( g^x \right)^{q^{e-1}} = h^{q^{e-1}} \quad \Longrightarrow \quad \left( g^{q^{e-1}} \right)^x = h^{q^{e-1}}.
```

Now, by the first part of {prf:ref}`prop-powers`, note that
```{math}
\left| g^{q^{e-1}} \right| = \frac{|g|}{\gcd(|g|, q^{e-1})} = \frac{q^e}{\gcd(q^e, q^{e-1})} = \frac{q^e}{q^{e-1}} = q,
```
i.e., $\left| g^{q^{e-1}} \right| = q$.


Now, since $g^{q^{e-1}}$ has order $q$ (prime), we use Shank's Baby-Step/Giant-Step to find a solution, say $y$.  This means that
```{math}
 \left( g^{q^{e-1}} \right)^{y} = h^{q^{e-1}} = \left( g^{q^{e-1}} \right)^x,
```
and by the second item of {prf:ref}`prop-powers`, we have that
```{math}
y \equiv x \equiv d_0 \pmod{q}.
```

This means that when we solved [](#eq-dl1), we found $d_0$!

We now find $d_1$ in a similar way.  Observe that
```{math}
h = g^x = g^{ d_0 + d_1 q + d_2 q^2 + \cdots + d_{e-1} q^{e-1}} = g^{d_0} \cdot \left( g^q \right)^{d_1 + d_2 q + d^3 q^2 + \cdots + d_{e-1}q^{e-2}}.
```

Letting $g' = g^q$, $h' = g^{-d_0}h$, and $x' = d_1 + d_2 q + \cdots + d_{e-1}q^{e-2}$, and multiplying both sides of the equation above by $g^{-d_0}$, we get:
```{math}
h' = g^{-d_0} g^x = \left( g^q \right)^{d_1 + d_2 q + d^3 q^2 + \cdots + d_{e-1}q^{e-2}} = (g')^{x'},
```
i.e.,
```{math}
h' = (g')^{x'}.
```
Note that, again by the first part of {prf:ref}`prop-powers`, we have that $|g'| = q^{e-1}$, so the order went down by a factor of $q$.

So, to find $d_1$ we repeat the process to find $d_0$ above, and repeat until we find all digits $d_i$ (in $e$ iterations of the process).

+++

### Example

Let's now illustrate the method with an example.

We will take $p = 2{,}116{,}179{,}719$ and $q = 1{,}019$, both primes:

```{code-cell} ipython3
p = 2116179719
q = 1019
is_prime(p), is_prime(q)
```

We then have $p = 2q^3 + 1$:

```{code-cell} ipython3
p == 2 * q^3 + 1
```

We will take $g = 2$, and indeed, $|g| = q^3$:

```{code-cell} ipython3
g = Mod(2, p)
g.multiplicative_order() == q^3
```

Finally, let $h = 805{,}343{,}147$.

```{code-cell} ipython3
h = Mod(805343147, p)
```

We need to find $\log_g(h)$, i.e., we need $x$ such that $g^x = h$.  We follow {prf:ref}`al-dl-power`.

Since the algorithm changes the original values of `g` and `h`, let's store the original values in different variables:

```{code-cell} ipython3
g_original = g
h_original = h
```

(Note that if the algorithm is in the body of a function, this is not necessary, as the variable outside the function will not be changed!)

First, we can initialize our values:

```{code-cell} ipython3
x = 0
N0 = N = g.multiplicative_order()
```

Then, we solve a discrete log with a base of order $q$ (prime).  We will use Sage's own `discrete_log` function for this computation:

```{code-cell} ipython3
power = N // q  # compute it only once!
y = discrete_log(h^power, g^power)
y
```

Now, we update the values:

```{code-cell} ipython3
x += y * (N0 // N)
h *= g^(-y)
g = g^q
N = N // q
```

Then, if the value of `N` is not one, we will repeat:

```{code-cell} ipython3
N
```

So, repeat: first we compute a new discrete log (with base of order $q$):

```{code-cell} ipython3
power = N // q
y = discrete_log(h^power, g^power)
y
```

And update the variables:

```{code-cell} ipython3
x += y * (N0 // N)
h *= g^(-y)
g = g^q
N = N // q
```

Check `N`:

```{code-cell} ipython3
N
```

It's not one, so we repeat again:

```{code-cell} ipython3
power = N // q
y = discrete_log(h^power, g^power)
y
```

Update the variables:

```{code-cell} ipython3
x += y * (N0 // N)
h *= g^(-y)
g = g^q
N = N // q
```

Check `N` again:

```{code-cell} ipython3
N
```

Since it *is* one now, we are done and `x` has our discrete log:

```{code-cell} ipython3
x
```

Let's check:

```{code-cell} ipython3
g_original^x == h_original
```

It worked!

+++

### Number of Operations

In this situation where $|g| = q^e$ and we compute $\log_g(h)$, if we use {prf:ref}`Shank's Baby-Step/Giant-Step <al-bs_gs>` algorithm, as seen in [the number of operations for Shank's algorithm](#sec-bsgs_n_op), we need about
```{math}
\frac{\sqrt{q^e}}{2}  \cdot \log_2(q^e) = \frac{q^{e/2}}{2} \cdot e \cdot \log_2(q)
```
multiplications.

How many multiplications do we perform using the method above?  In that case we compute $e$ discrete logs with a base of order $q$ using Shank's algorithm, so we perform about
```{math}
\boxed{e \cdot \frac{q^{1/2}}{2} \cdot \log_2(q)}
```
multiplications in total.

Thus, the ratio between the number of multiplications is
```{math}
\frac{q^{1/2}}{q^{e/2}} = \frac{1}{q^{(e-1)/2}} .
```

Therefore, a straight use of Shank's algorithm in our example above would use $q = 1{,}019$ *times the number of multiplications of our new method*.  In practice, for larger primes $q$ and/or larger powers $e$, the gains are even higher!

+++

:::{admonition} Homework
:class: note

You will implement this algorithm in your [homework](#sec-hw5).
:::

+++

(sec-pohlig-hellman)=
## The Pohlig-Hellman Algorithm

Now suppose that $g \in \mathbb{F}_p^{\times}$ and we have $|g| = N$, with the prime factorization:
```{math}
N = q_1^{e_1} q_2^{e_2} \cdots q_k^{e_k}.
```
We then have the following algorithm:

:::{prf:algorithm} Pohlig-Hellman Algorithm
:label: al-ph


Let $g, h \in \mathbb{F}_p^{\times}$ and suppose that $|g| = N =  q_1^{e_1} q_2^{e_2} \cdots q_k^{e_k}$, with $q_i$'s distinct prime, and $e_i \geq 1$ for $i = 1, 2, \ldots, k$.  To compute $\log_g(h)$:

1) For each $i \in \{ 1, 2, \ldots, k \}$ let $N_i = N/q_i^{e_i}$, $g_i = g^{N_i}$ and $h_i = h^{N_i}$ and find $y_i = \log_{g_i} \left( h_i \right)$ using {prf:ref}`al-dl-power`.

2) Use the {prf:ref}`Chinese Remainder Theorem <th-crt>` to find $x$ such that
```{math}
\begin{align*}
x &\equiv y_1 \pmod{q_1^{e_1}},\\
x &\equiv y_2 \pmod{q_2^{e_2}},\\
& \;\; \vdots \\
x &\equiv y_k \pmod{q_k^{e_k}}.
\end{align*}
```

Then, $\log_g(h) = x$.
:::

+++

### Why Does It Work?


Since we have that $g_i = g^{N_i}$, we have that
```{math}
|g_i| = \frac{|g|}{\gcd(|g|, N_i)} = \frac{N}{\gcd(N, N/q_i^{e_i})} = \frac{N}{N/q_i^{e_i}} = q_i^{e_i}.
```
So, if $x$ satisfies the congruences above, we have that $x \equiv y_i \pmod{q_i^{e_i}}$, and hence $g_i^x = g_i^{y_i} = h_i$ in $\mathbb{F}_p^{\times}$, for all $i \in \{1, 2, \ldots, k\}$.

Note that $\gcd(N_1, N_2, \ldots, N_k) = \gcd(N/q_1^{e_1}, N/q_2^{e_2}, \ldots , N/q_k^{e_k}) = 1$, since $q_i$ does not divide $N/q_i^{e_i}$.  Then, using the {prf:ref}`Generalized Extended Euclidean Algorithm <al-geea>`, we can find integers $r_1, r_2, \ldots , r_k$ such that
```{math}
r_1 \cdot N_1 + r_2 \cdot N_2 + \cdots + r_k \cdot N_k = 1.
```

Then:
```{math}
\begin{align*}
g^x &= \left( g^1 \right)^x \\[1.7ex]
&= \left( g^{r_1 \cdot N_1 + \cdots + r_k \cdot N_k} \right)^x \\[1.7ex]
&= g^{r_1 \cdot N_1 x + \cdots + r_k \cdot N_kx} \\[1.7ex]
&= \left( g^{r_1 N_1 x} \right)  \cdots \left( g^{r_n N_k x} \right)  \\[1.7ex]
&= \left( \left( g^{N_1} \right)^x  \right)^{r_1} \cdots \left( \left( g^{N_k} \right)^x  \right)^{r_k} \\[1.7ex]
&= \left( g_1^x \right)^{r_1} \cdots \left( g_k^x \right)^{r_k} \\[1.7ex]
&= \left( g_1^{y_1} \right)^{r_1} \cdots \left( g_k^{y_k} \right)^{r_k} \\[1.7ex]
&= \left( h_1 \right)^{r_1} \cdots \left( h_k \right)^{r_k} \\[1.7ex]
&= \left( h^{N_1} \right)^{r_1} \cdots \left( h^{N_k} \right)^{r_k} \\[1.7ex]
&= h^{r_1 \cdot N_1 + \cdots + r_k \cdot N_k} \\[1.7ex]
&= h^1 = h.
\end{align*}
```

+++

### Number of Operations

In the algorithm we compute $2k$ powers, which we can do using [Fast Powering](#fast_powering).  The number of products that this takes is at most:
```{math}
\begin{align*}
(2 \log_2(N_1) + 2) &+ (2 \log_2(N_2) + 2) + \cdots + (2 \log_2(N_k) + 2) \\[1.7ex]
&= 2 \left( \log_2(N_1) + \log_2(N_2) + \cdots + \log_2(N_k)\right) + 2k \\[1.7ex]
&= 2 \log_2 \left( N_1 N_2 \cdots N_k \right) + 2k \\[1.7ex]
&= 2 \log_2 \left( \frac{N}{q_1^{e_1}} \frac{N}{q_2^{e_2}} \cdots \frac{N}{q_k^{e_k}} \right) + 2k \\[1.7ex]
&= 2 \log_2 \left( \frac{N^k}{N}  \right) + 2k \\[1.7ex]
&= 2 \log_2 \left( N^{k-1} \right) + 2k \\[1.7ex]
&= \boxed{2(k-1) \log_2(N) +  2k}.
\end{align*}
```

Then, solving the discrete logs (with bases having order powers of primes) takes about
```{math}
\boxed{e_1 \frac{q_1^{1/2}}{2} \log_2(q_1) + e_2 \frac{q_2^{1/2}}{2} \log_2(q_2) + \cdots + e_k \frac{q_k^{1/2}}{2} \log_2(q_k)}
```
more multiplications.

Finally, we can solve the system of congruences with about $\boxed{2 \log_2(N) + 2(k-1)}$ long divisions.

If we were using the straight Shank's Baby-Step/Giant-Step Algorithm, we would need about $2\sqrt{N}$ multiplications and $n \log_2(n) \approx \sqrt{N} \log_2(\sqrt{N}) = (\sqrt{N}/2) \log_2(N)$ comparisons.  When $N$ factors, the process above is a lot more efficient.

For instance, let's take $N$ (the order of $g$) to be a very large number:

```{code-cell} ipython3
N = 275478590580404620961069223105530214854517114273998667300885664883160258239634122227989362418355423134437149221136296365217903294873136621174602837803
```

But, it factors:

```{code-cell} ipython3
N_factorization = factor(N)
N_factorization
```

If we were to use Shank's Baby-Step/Giant-Step directly, the number of multiplications would be:

```{code-cell} ipython3
floor(sqrt(N)/2 * log(N, base=2))
```

On the other hand, using {prf:ref}`al-ph`, the number of multiplications would be:

```{code-cell} ipython3
k = len(N_factorization)  # number of prime factors

# multiplications from powers + multiplications from discrete logs
floor(2 * (k - 1) * log(N, base=2) + 2 * k) + floor(sum(e * sqrt(q)/2 * log(q, base=2) for (q, e) in N_factorization))
```

And we also need some long divisions, more precisely, the total number of long divisions is at most:

```{code-cell} ipython3
k = len(N_factorization)
floor(2 * log(N, 2) + 2 * (k - 1))
```

This is *considerably* better than the straight use of Shank's algorithm.

:::{note}

Note that using Pohlig-Hellman's algorithm, we still use Shank's Baby-Step/Giant-Step algorithm to compute some discrete logs, but only for bases of prime order.
:::

+++

:::{admonition} Homework
:class: note

You will implement Pohlig-Hellman's algorithm in your [homework](#sec-hw5).
:::

+++

:::{important}

The Pohlig-Hellman algorithm show how important it is that we choose $g$ of *prime* order in the Diffie-Hellman key exchange and ElGamal cryptosystem.  If not, Eve has more efficient methods to solve the discrete log problem.
:::

+++

### Example

Let's illustrate Pohlig-Hellman's algorithm with an example.  We will take:

```{code-cell} ipython3
N = 22974332779312916308087541215025543130953873335484909873
p = 2 * N + 1
```

Indeed, $p$ is prime:

```{code-cell} ipython3
is_prime(p)
```

First we need to factor this large $N$.

```{code-cell} ipython3
N_factorization = factor(N)
N_factorization
```

:::{important}

We did not take this step into account when counting the number of operations for this algorithm.  As we soon shall see, factoring a large number $N$ can be quite difficult and time consuming.  If that is the case, the prime factors will be large as well, and Pohlig-Hellman might not be the best choice.
:::


In this case, we have that $3$ has order $N$ in $\mathbb{F}_p^{\times}$:

```{code-cell} ipython3
g = Mod(3, p)
g.multiplicative_order() == N
```

Now, let's take some $h \in \mathbb{F}_p^{\times}$:

```{code-cell} ipython3
h = Mod(117619616680834488747814058359345855076997576088312309, p)
```

Now, we need to find $x$ such that $g^x = h$, following the algorithm.  First, let's initialize a lists to have the solutions for the discrete logs corresponding to each power of a prime and the corresponding moduli:

```{code-cell} ipython3
y = []
m = []
```

Now, we select the first prime and corresponding power:

```{code-cell} ipython3
q, e = N_factorization[0]
q, e
```

We define the elements for each we will solve the discrete log:

```{code-cell} ipython3
NN = N // q^e  # power for g and h (compute it only once!)
gg = g^NN
hh = h^NN
```

Now, we solve a discrete log (with a base that has order `q^e`), using {prf:ref}`al-dl-power`.  In here (as in your homework!) we can use Sage's `discrete_log`, which internally does exactly that:

```{code-cell} ipython3
y.append(discrete_log(hh, gg))  # add discrete log to the list
m.append(q^e)  # add the modulus to the list
y, m
```

Then, we move to the next prime and power:

```{code-cell} ipython3
q, e = N_factorization[1]
q, e
```

And follow the same steps:

```{code-cell} ipython3
NN = N // q^e
gg = g^NN
hh = h^NN
y.append(discrete_log(hh, gg))
m.append(q^e)
y, m
```

And, last prime (and power):

```{code-cell} ipython3
q, e = N_factorization[2]
q, e
```

Repeat the steps:

```{code-cell} ipython3
NN = N // q^e
gg = g^NN
hh = h^NN
y.append(discrete_log(hh, gg))
m.append(q^e)
y, m
```

Now we are done, since we ran out of primes.  So, `y` contains the left-sides of the congruences for the CRT, and `m` contains the corresponding moduli.  We solve it using Sage's CRT function:

```{code-cell} ipython3
x = crt(y, m)
x
```

Now `x` should be our discrete log.  Indeed:

```{code-cell} ipython3
g^x == h
```

It worked!

+++

## Further Improvements?

There is a method for solving the DLP that is even more efficient, called [index calculus](#sec-index-calc), which we will learn later.
