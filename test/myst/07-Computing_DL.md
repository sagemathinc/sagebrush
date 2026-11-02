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

# Computing Discrete Logs

+++

Since the security of the Diffie-Hellman key exchange and the ElGamal public-key cryptosystem can be broken by efficiently computing the discrete log, here we discuss a more efficient method for this computation.  (In later sections, we describe [methods that are even more efficient in *special cases*](#sec-index-calc).)

In this chapter we then shall use the following notation:

* $p$ is a large prime number;
* $g \in \mathbb{F}_p^{\times}$ and element of large order, say $N$ (and so $N \mid (p-1)$ by Euler's Theorem);
* $h \in \mathbb{F}_p^{\times}$ such that $g^x = h$ for some $x$ (which can be taken in $\mathbb{Z}/N\mathbb{Z}$).

Hence, we have that the discrete log $\log_g(h)$ exists and is equal to $x$.  Here we deal with the question of how we can find this exponent $x$.

+++

## Brute Force Computation

The most immediate way to compute this discrete log is by "brute force": we start computing $g^0$, $g^1$, $g^2$, etc., until some power is equal to $h$.  In the worst case scenario, we might have to compute $N-1$ products, as the set
```{math}
\left\{ 1, g, g^2, g^3, \ldots, g^{N-1} \right\}
```
has $N$ distinct elements, since $g$ has order $N$.

When $N$ is very large, this can take a considerable amount of time.  If $N$ is a $2047$-bit integer, meaning that $2^{2046} \leq N < 2^{2047}$, as recommended for Diffie-Hellman and ElGamal, and (arbitrarily) assuming each product takes one *billionth* of a second, we can compute how many *millennia* it would take to perform $N-1$ products:

```{code-cell} ipython3
prod_time = 10^(-9)

seconds = 2^2046 * prod_time
millennia = seconds / (60 * 60 * 24 * 365.25 * 1000)

millennia
```

That is more than $2$ followed by $596$ zeros!  It is certainly not feasible.

:::{admonition} Homework
:class: note

You will write an implementation of the brute force method in your [homework](#sec-hw4).
:::

+++

(sec-bsgs)=
## Shank's Baby-Step/Giant-Step Algorithm

In 1971, [Daniel Shanks](https://en.wikipedia.org/wiki/Daniel_Shanks) devised a *collision* (or *meet-in-the-middle*) algorithm to compute discrete logs, usually called [Baby-Step/Giant-Step](https://en.wikipedia.org/wiki/Baby-step_giant-step), that is a lot more efficient than the brute force method.

:::{prf:algorithm} Shank's Baby-Step/Giant-Step
:label: al-bs_gs


If $g$ is an element of order $N \geq 2$ in $\mathbb{F}_p^{\times}$ for some prime $p$ and $h \in \mathbb{F}_p^{\times}$.  Then, to compute $\log_g(h)$ (i.e., to try to find $x$ such that $h = g^x$), we do:

1) Let $n = \lfloor \sqrt{N} \rfloor + 1$ (so $n > \sqrt{N}$).
2) Compute the list of elements of $\mathbb{F}_p^{\times}$: $\{1, g, g^2, g^3, \ldots ,  g^n\}$ (the *baby-steps*).
3) Compute the inverse $g^{-n}$ of $g^n$ (computed in the previous step).
4) In a loop, start computing $h, h \cdot g^{-n}, h \cdot g^{-2n}, h \cdot g^{-3n}, \ldots, h \cdot g^{-n^2}$ (the *giant-steps*) until one these elements has a match in the list above.
5) If we get to the last element $h \cdot g^{-n^2}$ and still found no match, then $\log_g(h)$ does not exist.  If we find a match, say $g^i = h \cdot g^{-jn}$, then $\log_g(h) = i + jn$ (in $\mathbb{Z}/m\mathbb{Z}$), i.e., we have that $g^{i+jn} = h$.
:::

+++

### Why Does It Work?

Let's see why the algorithm works!

First, why do we find a match when $h = g^x$ for some $x$?  With $n = \lfloor \sqrt{N} \rfloor + 1$, whatever $x$ might be, we can perform the long division of $x$ by $n$, getting a quotient $q$ and remainder $r$, i.e., we get
```{math}
x = nq + r, \quad \text{with $0 \leq r < n$.}
```

Since $1 \leq x < N$, we have that
```{math}
\begin{align*}
q &= \frac{x-r}{n} \\[2ex]
&\leq \frac{x}{n} && \text{(since $r \geq 0$)} \\[2ex]
&< \frac{N}{n} && \text{(since $N > x$)}\\[2ex]
&< \frac{n^2}{n} && \text{(since $n > \sqrt{N}$, so $n^2 > N$)} \\[2ex]
&= n,
\end{align*}
```
i.e., we have that $q<n$.  Now
```{math}
h = g^x = g^{nq + r} = g^{nq} \cdot g^r \qquad \Longrightarrow \qquad h \cdot g^{-qn} = g^r, \quad \text{with $0 \leq r, q <n$.}
```
Hence, the left-side is one of the elements we compute in our loop and the right-side is our list of powers of $g$.  Even though we do not know $q$ and $r$ (since we do not know $x$), we *do* know that we must get a match!

Now, when we do find a match $g^i = h \cdot g^{-jn}$, we can solve for $h$ and get $g^{i + jn} = h$, so we know that $i + jn$ (reduced modulo $N$) is $\log_g(h)$.

+++

(sec-bsgs_n_op)=
### Number of Operations

How many multiplications does the Baby-Step/Giant-Step Algorithm need?  To compute our list, we need $n$ multiplications by $g$:
```{math}
\begin{align*}
  g &= 1 \cdot g \\
  g^2 &= g \cdot g \\
  g^3 &= g^2 \cdot g \\
  & \;\;\vdots\\
  g^n &= g^{n-1} \cdot g
\end{align*}
```

Computing the inverse $g^{-n}$ of $g^n$ is fast, since we can use the *Extended Euclidean Algorithm*.

In our loop, we have *at most* another $n$ multiplications by this $g^{-n}$:
```{math}
\begin{align*}
  h \cdot g^{-n} &= h \cdot g^{-n} \\
  h \cdot g^{-2n} &= h \cdot g^{-n} \cdot g^{-n} \\
  h \cdot g^{-3n} &= h \cdot g^{-2n} \cdot g^{-n} \\
  & \;\;\vdots\\
  h \cdot g^{-n^2} &= g^{-(n-1)n} \cdot g^{-n}
\end{align*}
```

So, we've computed at most $2n$ multiplications (and inverted $g^n$).  Another crucial step is finding, in our loop, if some $h \cdot g^{-jn}$ is in the list $\{1, g, g^2, \ldots, g^{n}\}$.  This process involves at most $n$ comparisons for each iteration of our loop, so we would need at most $n^2 \approx N$ comparisons in total.  On the other hand, there are better algorithms for finding matches by sorting the list, which would gives us about $n \cdot \log_2(n)$ comparisons at most.

Therefore, in total, we would need $2n \approx 2\sqrt{N}$ multiplications and $n \log_2(n) \approx \sqrt{N} \log_2(\sqrt{N}) = (\sqrt{N}/2) \log_2(N)$ comparisons.

So, how does the number of steps compare?  We go from $N$ multiplications to about $2 \sqrt{N}$ multiplications and $(\sqrt{N}/2) \log_2(N)$ comparisons.  Since both $\sqrt{N}$ and $\log_2(N)$ are relatively much smaller than $N$ for large $N$, these are great gains!  For instance, if $N =1{,}000{,}000$, then $2\sqrt{N} = 2{,}000$ and $(\sqrt{N}/2) \log_2(N) \approx 9{,}965$, so a huge gain!

On the other hand, in the case where $N$ is a $2047$-bit integer, these would still take over $2 \cdot 10^{293}$ millennia, so still not feasible!

:::{important}  Computing Powers

As observed in the section [Computing Successive Powers](#successive_powers), it is *crucial* that we do not compute the list of powers above using `^`.  We *should not* do something like
```python
powers = []
for i in range(n + 1):
    powers.append(g^i)
```
or, using list comprehension, with
```python
powers = [g^i for i in range(n + 1)]
```

Instead, we do something like (but see discussion below for a better suited way for this particular problem):
```python
powers = [Mod(1, p)]
for _ in range(1, n + 1):
    powers.append(g * powers[-1])
```
:::

+++

### Example

Let's compare the brute force and baby-step/giant-step methods in a concrete example.

First, here is some information about the computer being used:

```{code-cell} ipython3
!inxi --system --cpu --memory
```

Now, let's first find $p$ and $g$: let's take $p=2{,}819$, $N = (p-1) /2 = 1{,}409$ (also prime), and $g = 798$ (in $\mathbb{F}_p^{\times}$).

```{code-cell} ipython3
p = 2819
N = (p - 1) // 2
g = Mod(798, p)
```

Let's verify that these work (we should get `True, True`):

```{code-cell} ipython3
is_prime(p), g.multiplicative_order() == N
```

Now, take $h = 1{,}945$ (in $\mathbb{F}_p^{\times}$) and let's try to compute $\log_g(h)$.

```{code-cell} ipython3
h = 1945
```

#### Brute Force

First by brute force:

```{code-cell} ipython3
%%time
power_of_g = 1  # first element
for x in range(N):
    if power_of_g == h:
        print(f"Found: {x = }.")
        break
    else:
        power_of_g *= g
else:
    print("No power found!  The log does not exist.")
```

Let's check:

```{code-cell} ipython3
h == g^x
```

#### Baby-Step/Giant-Step

Now, we use Shank's algorithm.  First, we define $n$:

```{code-cell} ipython3
n = floor(sqrt(N)) + 1
```

Now, let's think about how we create the list of powers of $g$.  In principle, we could just do something like:
```python
powers = [Mod(1, p)]
for _ in range(1, n + 1):
    powers.append(g * powers[-1])
```
We then can find if something is in the list with `in`:
```python
if x in powers:
    ...  # do something
```
But searching in lists is relatively slow.  Searching in a [set](https://docs.python.org/3/tutorial/datastructures.html#sets) is *much* faster, since they are [hashed](https://en.wikipedia.org/wiki/Hash_table).  In this case, though, a set is not ideal, since we also need the *exponent* that gives us the resulting power, i.e., the $i$ in $g^i$.

An alternative to keep track of both the exponent and the resulting power is to use a [dictionary](https://docs.python.org/3/tutorial/datastructures.html#dictionaries) as in
```python
powers = {0: Mod(1, p)}
for i in range(1, n + 1):
    powers[i] = g * powers[i-1]
```
But this way, we still have a problem when searching if $g^i$ is in the dictionary, as we have to search for it among the *values*, and not the keys!  Dictionaries are optimized for searching the *keys*, so we need to turn things around a bit, swapping the key/value pairs above:

```{code-cell} ipython3
powers = {Mod(1, p): 0}
current_power = Mod(1, p)
for i in range(1, n + 1):
    current_power *= g
    powers[current_power] = i
```

So, now `powers` have key/value pairs of the form `g^i: i` and `current_power` has $g^n$.

Our next step is to invert $g^n$:

```{code-cell} ipython3
factor = current_power^(-1)
```

Finally we start computing $h, h \cdot g^{-n}, h \cdot g^{-2n}, \ldots$ until we find a matching power or get to $h \cdot g^{-n^2}$.  Note that we can check if an element is a *key* in the dictionary with `in`:

```{code-cell} ipython3
current_value = h
for j in range(n + 1):
    if current_value in powers:
        i = powers[current_value]
        x = (i + j * n) % N
        print(f"Found {x = }.")
        break
    current_value *= factor
else:
    print("The log does not exist.")
```

Let's double check that it worked:

```{code-cell} ipython3
h == g^x
```

Now, let's see how long the whole process takes:

```{code-cell} ipython3
%%time
N = g.multiplicative_order()
n = floor(sqrt(N)) + 1

powers = {Mod(1, p): 0}
current_power = Mod(1, p)
for i in range(1, n + 1):
    current_power *= g
    powers[current_power] = i

factor = current_power^(-1)
current_value = h

for j in range(n + 1):
    if current_value in powers:
        i = powers[current_value]
        x = (i + j * n) % N
        print(f"Found {x = }.")
        break
    current_value *= factor
else:
    print("The log does not exist.")
```

:::{admonition} Homework
:class: note

In your [homework](#sec-hw4) you will write a discrete log function that takes some $g$ and $h$ as arguments and finds $x$ such that $h = g^x$, if it exists, and returns $-1$ if it doesn't.  Most of the work is actually done above, you just have to adapt it to a function.
:::
