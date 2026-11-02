---
jupytext:
  formats: ipynb,md:myst,sage:percent
  text_representation:
    extension: .md
    format_name: myst
    format_version: 0.13
    jupytext_version: 1.17.3
kernelspec:
  name: sage-10.7
  display_name: SageMath 10.7
  language: sage
---

# The Chinese Remainder Theorem and Generalized Bezout's Lemma

+++

In this chapter we introduce two mathematical tools to help speed up the computation of discrete logs when the order of the base is not prime: the *Chinese Remainder Theorem* and the *Generalized Extended Euclidean Algorithm*.

+++

(sec-crt)=
## The Chinese Remainder Theorem

In some cases we have algorithms even faster than Shank's Baby-Step/Giant-Step in computing discrete logs.  These depend on $N$ (the order of $g$) *not being prime*, which is one of the reasons we should always use elements of prime order with Diffie-Hellman key exchange and ElGamal cryptosystem.  Here is, roughly, how these methods work: we compute the prime factorization
```{math}
N = p_1^{r_1} p_2^{r_2} \cdots p_k^{r_k}
```
solving discrete logs with elements of order $p_i^{r_i}$, which being a smaller modulus usually are considerably faster, and then "patching" these discrete logs for $i=1, 2, \ldots, k$ into the original discrete log $\log_g(h)$ (in $\mathbb{Z}/N\mathbb{Z}$).

This last step of patching the discrete logs modulo $p_i^{r_i}$ is done by using the following important result:

:::{prf:theorem} Chinese Remainder Theorem (CRT)
:label: th-crt


Let $m_1, m_2, \ldots, m_k$ be pairwise relatively prime moduli (i.e., $\gcd(m_i, m_j) = 1$ if $i \neq j$) and $a_1, a_2, \ldots, a_k$ be integers.  Then the system
```{math}
:name: eq-crt

\begin{align*}
  x &\equiv a_1 \pmod{m_1}, \\
  x &\equiv a_2 \pmod{m_2}, \\
  &\;\; \vdots \\
  x &\equiv a_k \pmod{m_k},
\end{align*}
```

has a *unique* solution modulo $m = m_1 m_2 \cdots m_k$, meaning that there is an integer $x=x_0$ simultaneously satisfying all these congruences, and that $x_1$ is also a common solution if and only if $x_1 \equiv x_0 \pmod{m}$.
:::

Let's see why it is true and how we can find a solution.

:::{prf:proof} Proof of the CRT.

We start with the case when $k = 2$.  So, we want to find $x$ such that
```{math}
:label: eq-crt-2

\begin{align*}
  x &\equiv a_1 \pmod{m_1}, \\
  x &\equiv a_2 \pmod{m_2}.
\end{align*}
```

Using the {prf:ref}`Extended Euclidean Algorithm <al-eea>` we find $u$ and $v$ integers such that $1 = \gcd(m_1, m_2) = um_1 + vm_2$.  Note that this means that:
```{math}
\begin{align*}
vm_2 &= 1 - um_1 \equiv 1 - u \cdot 0 = 1 \pmod{m_1}, \\
um_1 &= 1 - vm_2 \equiv 1 - v \cdot 0 = 1 \pmod{m_2},
\end{align*}
```
i.e.,
```{math}
\begin{align*}
vm_2 &\equiv 1 \pmod{m_1}, \\
um_1 &\equiv 1\pmod{m_2},
\end{align*}
```


Then, let $x_0 = a_1vm_2 + a_2um_1$.  Then we have:
```{math}
\begin{align*}
  x_0 = a_1vm_2 + a_2um_1 \equiv a_1 \cdot 1 + a_2 \cdot 0 = a_1 \pmod{m_1}, \\
  x_0 = a_1vm_2 + a_2um_1 \equiv a_1 \cdot 0 + a_2 \cdot 1 = a_2 \pmod{m_2},
\end{align*}
```
i.e.,
```{math}
\begin{align*}
  x_0 \equiv a_1 \pmod{m_1}, \\
  x_0 \equiv a_2 \pmod{m_2},
\end{align*}
```
and so $x_0$ is a solution to the system [](#eq-crt-2).

Also, clearly, if $x_1 \equiv x_0 \pmod{m}$, where $m = m_1m_2$, i.e., $x_1 = x_0 + tm$ for some integer $t$, then
```{math}
\begin{align*}
  x_1 \equiv x_0 + tm_1m_2 \equiv x_0 + 0 = x_0 \equiv a_1\pmod{m_1}, \\
  x_1 \equiv x_0 + tm_1m_2 \equiv x_0 + 0 = x_0 \equiv a_2\pmod{m_2},
\end{align*}
```
so $x_1$ is also a solution.  Hence, any $x_1 \equiv x_0 \pmod{m}$ is also a solution of [](#eq-crt-2).

Now, suppose that $x_2$ is some other solution of [](#eq-crt-2).  (We need to show that $x_2 \equiv x_0 \pmod{m}$, i.e., that the solutions above are not missing any particular one.)  Then, since both $x_0$ and $x_2$ satisfy the system we have
```{math}
\begin{align*}
  x_2 - x_0 \equiv a_1 - a_1 = 0 \pmod{m_1}, \\
  x_2 - x_0 \equiv a_2 - a_2 = 0 \pmod{m_2}.
\end{align*}
```

This means that $m_1$ and $m_2$ both divide $x_2 - x_0$.  *Since $m_1$ and $m_2$ are relatively prime*, this means that $m_1m_2 = m$ also divides $x_2 - x_0$, i.e., that $x_2 \equiv x_0 \pmod{m}$.

So, note that this gives us that the two congruences of system [](#eq-crt-2) is equivalent to the single congruence
```{math}
:label: eq-crt-2-sol

x \equiv x_0 \pmod{m_1m_2},
```
meaning that $x$ is a solution of [](#eq-crt-2) if and only if $x$ is a solution of [](#eq-crt-2-sol).

So, when we have $k$ congruences, as in [](#eq-crt), we can reduce the number of equations by one by replacing the first two by [](#eq-crt-2-sol):
```{math}
:name: eq-crt-1

\begin{align*}
  x &\equiv x_0 \pmod{m_1m_2}, \\
  x &\equiv a_3 \pmod{m_3}, \\
  &\;\; \vdots \\
  x &\equiv a_k \pmod{m_k},
\end{align*}
```

Then, we proceed: finding the solution modulo $m_1m_2m_3$ for the first two congruences of this new system, say $x \equiv x_1 \pmod{m_1m_2m_3}$, we can reduce again the number of congruences by one, by replacing these congruences by the solution:

```{math}
\begin{align*}
  x &\equiv x_1 \pmod{m_1m_2m_3}, \\
  x &\equiv a_4 \pmod{m_4}, \\
  &\;\; \vdots \\
  x &\equiv a_k \pmod{m_k},
\end{align*}
```

Proceeding this way, we eventually get the single solution we needed:
```{math}
x \equiv x_{k-2} \pmod{m_1m_2 \cdots m_k}.
```
:::

+++

(crt-alg)=
### Algorithm

To summarize the process given in the proof of the CRT, we have two main steps that we repeat: solve a pair of congruences, and then replace the two congruences in the system by the congruence from the solution.

#### Solution for a Pair of Congruences

To solve

```{math}
\begin{align*}
  x &\equiv {\color{blue} a_1} \pmod{{\color{blue} m_1}},\\
  x &\equiv {\color{red} a_2} \pmod{{\color{red} m_2}},
\end{align*}
```
when $\gcd(m_1, m_2) = 1$, we first find $u$ and $v$ such that
```{math}
1 = {\color{blue} u \cdot m_1} + {\color{red} v \cdot m_2},
```
(we can use `xgcd` for that!) and then the solution is
```{math}
x \equiv {\color{red} a_2} \cdot {\color{blue} u} \cdot {\color{blue} m_1} + {\color{blue} a_1} \cdot {\color{red} v} \cdot {\color{red} m_2} \pmod{{\color{blue} m_1} {\color{red} m_2}}.
```

:::{warning}

"Bookkeeping" is very important here!  Careful to not get these variables mixed!
:::

Note that the solution requires the use of the Extended Euclidean Algorithm, which uses about $2 \log_2(m) + 2$ long divisions, where $m = \min(m_1, m_2)$.

+++

#### Reducing Number of Congruences

We use the previous step to reduce the number of congruences, in each step reducing the first two to a single one by finding a solution:
```{math}
\begin{align*}
  x &\equiv a_1 \pmod{m_1} \\
  x &\equiv a_2 \pmod{m_2} & x &\equiv x_0 \pmod{m_1m_2}\\
  x &\equiv a_3 \pmod{m_3} & x &\equiv a_3 \pmod{m_3} & x &\equiv x_1 \pmod{m_1m_2m_3} \\
  x &\equiv a_4 \pmod{m_4}  \longrightarrow & x &\equiv a_4 \pmod{m_4} \quad \longrightarrow & x &\equiv a_4 \pmod{m_4}  \qquad \longrightarrow \cdots\\
  &\;\; \vdots & &\;\; \vdots & &\;\; \vdots  \\
  x &\equiv a_k \pmod{m_k} & x &\equiv a_k \pmod{m_k} & x &\equiv a_k \pmod{m_k}
\end{align*}
```
until we get a single solution
```{math}
x \equiv x_{k-2} \pmod{m_1m_2 \cdots m_k}.
```

+++

### Number of Operations

We perform $k-1$ instances of the Extended Euclidean Algorithm.  The argument of the log that appears in the number of long divisions of each depends on the minimum between the two moduli, but *roughly* we can assume that these will be $m_2$, $m_3$, $m_4$. etc.  So, we need about
```{math}
\begin{align*}
(2 \log_2(m_2) + 2) &+ (2 \log_2(m_3) + 2) + \cdot + (2 \log_2(m_k) + 2) \\
&= 2 (\log_2(m_2) + \log_2(m_3) + \cdots \log_2(m_k)) + 2(k-1) \\
&= 2 \log_2(m_2 m_3 \cdot m_k) + 2(k-1) \\
&\approx 2 \log_2(m_1 m_2 \cdots m_k) + 2(k-1)
\end{align*}
```
long divisions.

+++

### Example

Let's solve the system:

```{math}
\begin{align*}
  x &\equiv 1 \pmod{2}, \\
  x &\equiv 0 \pmod{3}, \\
  x &\equiv 3 \pmod{5}, \\
  x &\equiv 1 \pmod{7}.
\end{align*}
```

(Note that the moduli are distinct primes, so certainly pairwise relatively prime, as required.)   We first deal with the first two congruences:

```{math}
\begin{align*}
  x &\equiv 1 \pmod{2}, \\
  x &\equiv 0 \pmod{3}.
\end{align*}
```

We find $u$ and $v$ such that $2u + 3v = 1$.  We can use Sage's `xgcd` for that:

```{code-cell} ipython3
_, u, v = xgcd(2, 3)
```

Then, our solution is $a_2 u m_1 + a_1 v m_2$:

```{code-cell} ipython3
sol = 0 * u * 2 + 1 * v * 3
sol
```

Let's check:

```{code-cell} ipython3
(Mod(sol, 2), Mod(sol, 3)) == (Mod(1, 2), Mod(0, 3))
```

Now we replace the first two congruences with $x \equiv 3 \pmod{6}$, and solve

```{math}
\begin{align*}
  x &\equiv 3 \pmod{6}, \\
  x &\equiv 3 \pmod{5}, \\
  x &\equiv 1 \pmod{7}.
\end{align*}
```


Again, we focus on the (new) first pair of congruences:

```{math}
\begin{align*}
  x &\equiv 3 \pmod{6}, \\
  x &\equiv 3 \pmod{5}.
\end{align*}
```

We repeat the same procedure:

```{code-cell} ipython3
_, u, v = xgcd(6, 5)
sol = 3 * u * 6 + 3 * v * 5
sol
```

Let's check again:

```{code-cell} ipython3
(Mod(sol, 6), Mod(sol, 5)) == (Mod(3, 6), Mod(3, 5))
```

Repeating, we replace the first two congruences (of the *new* system) by $x \equiv 3 \pmod{30}$:

```{math}
\begin{align*}
  x &\equiv 3 \pmod{30}, \\
  x &\equiv 1 \pmod{7}.
\end{align*}
```

We now have only two left and we solve as before:

```{code-cell} ipython3
_, u, v = xgcd(30, 7)
sol = 1 * u * 30 + 3 * v * 7
sol
```

This solution, namely $x \equiv 183 \pmod{210}$, now should satisfy the original four congruences:

```{code-cell} ipython3
(Mod(sol, 2), Mod(sol, 3), Mod(sol, 5), Mod(sol, 7)) == (Mod(1,  2), Mod(0, 3), Mod(3, 5), Mod(1, 7))
```

:::{admonition} Homework
:class: note

You will implement this [algorithm to find solutions in the CRT](#crt-alg) as an exercise in your [homework](#sec-hw5).
:::

But, of course, Sage can solve the system of congruences in the CRT using the function `crt`.  We give it a list of the left-sides of the congruences (i.e., $a_1, a_2, \ldots, a_k$) and a list of the moduli (i.e., $m_1, m_2, \ldots, m_k$).  So, our previous example can be done with:

```{code-cell} ipython3
crt([1, 0, 3, 1], [2, 3, 5, 7])
```

## Python/Sage Detour: Scope and Mutable Objects

In the implementation of the CRT in your homework, as with Sage's `crt`, we will pass two lists to the function: a list `a` of the left-sides of the congruences (i.e., $a_1, a_2, \ldots, a_k$) and a list `m` of the moduli (i.e., $m_1, m_2, \ldots, m_k$).

In the implementation we need to deal with two congruences at a time.  We can do that by "popping" elements out the lists with [pop](https://docs.python.org/3/tutorial/datastructures.html), applying the CRT for two congruences and appending the new left-side and modulus back to the respective lists.

+++

### "Popping Elements"

If we have a list, the `.pop` method takes (by default) the last element of the list, thus modifying the original list, and *return* this previous last element:

```{code-cell} ipython3
my_list = [1, 2, 3, 4]

# returns last element and REMOVE it from the list
last_element = my_list.pop()

last_element, my_list
```

### Mutable Objects

List and dictionaries in Python/Sage are [mutable objects](https://docs.python.org/3/library/stdtypes.html#mutable-sequence-types).  Let's illustrate what this means with an example:

```{code-cell} ipython3
a = 2
b = a
a = 3
print(f"We have that {a = }, and {b = }.")
```

We started setting `a` as $2$, used `b` to store the same value as `a`, and then changed the value of `a`.  At the end `b` has the old value of `a`.  Now, let's look at an example with lists:

```{code-cell} ipython3
list_a = [1, 2, 3]
list_b = list_a
list_a.pop()  # remove last element of list_a
print(f"We have that {list_a = }, and {list_b = }.")
```

So, you might have been expecting that `list_b` would have the old/original value of `list_a`, but both lists are the *same*!

The reason for that is, basically, that line 2 makes the names `list_a` and `list_b` "point" to the same object, the list `[1, 2, 3]`.  (The same is true for line 2 in the previous example: `a` and `b` point to the same object, the integer `2`.)  But, while line 3 of the previous example *redefines* `a`, making it to point somewhere else (the integer `3`), in the last example line 3 *changed* (or *mutated*) the object to which both lists were pointing!

If we were to also *redefine* (instead of changing) `list_a`, then this problem would not happen:

```{code-cell} ipython3
list_a = [1, 2, 3]
list_b = list_a
list_a = [1, 2]
print(f"We have that {list_a = }, and {list_b = }.")
```

The statement `list_a = [1, 2]` makes `list_a` point somewhere else, i.e., it *defines* `list_a`, while `list_a.pop()` simply *changes* the object to which it was pointing (by removing the last element).

But you might want to have `list_b` be the same as the old `list_a`, and not be affected by any changes to `list_a`, meaning, you might want `list_b` to be a *copy* of `list_a` at its *current state*, and not be affected to any other changes made to it.

To do that, we can use the list method `.copy()`:

```{code-cell} ipython3
list_a = [1, 2, 3]
list_b = list_a.copy()  # NOTE THE .copy()
list_a.pop()  # remove last element of list_a
print(f"We have that {list_a = }, and {list_b = }.")
```

Objects that can be changed, like lists, are called *mutable objects*.  Dictionaries are also mutable:

```{code-cell} ipython3
my_dict = {"A": 1, "B": 2, "C": 3}
# remove  key/value for key B, returning the value
# the dictionary is changed by this operation
poped_value = my_dict.pop("B")

poped_value, my_dict
```

Sets are also mutable.  On the other hand [tuples](https://docs.python.org/3/tutorial/datastructures.html#tuples-and-sequences) (which use parentheses instead of the square brackets used for lists) are *not* mutable.  There is no method that changes a tuple (since it cannot be changed).

:::{warning}

Forgetting to use `.copy` when making a copy of a list or dictionary is a common source of bugs!  Try to not forget to use it when you want to save the current value of the list or dictionary in a new variable.
:::

+++

### Scope of Variables

Here we briefly discuss the notion of [scope of variables](https://docs.python.org/3/tutorial/classes.html#python-scopes-and-namespaces).  But again, let's do it with examples.

Here we have a variable `a` defined outside a function, and another also named `a` defined inside a function:

```{code-cell} ipython3
a = 1

def my_function(x):
    a = x + 1
    return x^2 + a

my_function(2)
```

(The function here is "silly", but it is a simple example to illustrate the point.)

Let's see if the value of `a` was changed also outside the function.  (If it were, it should have value `3 = 2 + 1` now.)

```{code-cell} ipython3
a
```

As you can see, it is not!    Variables defined inside a function are *local*, meaning, they only have meaning inside the function.  This includes the input variables as well.

But let's look at this example:

```{code-cell} ipython3
def find_list_minimum(input_list):
    input_list.sort()  # sort list
    return input_list[0]  # return first element
```

(Again, this is a very silly example.  We can simply use Python/Sage's `min` function for this.)

Let's test it:

```{code-cell} ipython3
my_list = [5, 3, 1, 2, 4]
find_list_minimum(my_list)
```

It seems it worked!  But:

```{code-cell} ipython3
my_list
```

The original `my_list` was changed.  That's because inside the function we *changed* `input_list` with `.sort`.  This might be surprising, since the change occurred inside the function, but that is the default behavior.  This might be good, as we might want to create a function with the specific purpose of modifying the given list.  But the original list might contain information that the user wants to keep.  For instance, in this example the order of the entries in the list might correspond to some order in real life, like the first five months of the years.  If we change the order, we might not now the value for a given month.

We can try to create a new list inside, and change that list instead:

```{code-cell} ipython3
def find_list_minimum(input_list):
    new_list = input_list
    new_list.sort()  # sort list
    return new_list[0]  # return first element
```

```{code-cell} ipython3
my_list = [5, 3, 1, 2, 4]
find_list_minimum(my_list)
```

```{code-cell} ipython3
my_list
```

As you can see, we again changed the original `my_list`.  Even though `new_list` was defined *inside the function*, it is still pointing to the same object as `my_list`, and changing one of them also changes the other.

So, again, we need `.copy()`:

```{code-cell} ipython3
def find_list_minimum(input_list):
    new_list = input_list.copy()  # note the .copy()!
    new_list.sort()  # sort list
    return new_list[0]  # return first element
```

```{code-cell} ipython3
my_list = [5, 3, 1, 2, 4]
find_list_minimum(my_list)
```

Now the original remains intact:

```{code-cell} ipython3
my_list
```

What would happen if the user passes a [tuple](https://docs.python.org/3/tutorial/datastructures.html#tuples-and-sequences), like `(5, 3, 1, 2, 4)`, instead of a list?  Since tuples do not have the `.copy` method (since they cannot be changed, and hence this `copy` method is not needed), we would get an error:

```
AttributeError: 'tuple' object has no attribute 'copy'
```

There is a trick that works as `copy` and converts all data types that can be converted to lists to a list before continuing: instead of

```python
    new_list = input_list.copy()
```

we use

```python
    new_list = list(input_list)
```

This will copy the list, if `input_list` is already a list, and convert the object to a list if not:

```{code-cell} ipython3
def find_list_minimum(input_list):
    new_list = list(input_list)  # note the "list"!
    new_list.sort()  # sort list
    return new_list[0]  # return first element
```

```{code-cell} ipython3
my_list = [5, 3, 1, 2, 4]
find_list_minimum(my_list)
```

```{code-cell} ipython3
my_list
```

```{code-cell} ipython3
my_tuple = (5, 3, 1, 2, 4)  # a tuple!
find_list_minimum(my_tuple)
```

```{code-cell} ipython3
my_tuple
```

This might come hand when getting lists are inputs for functions, like in your homework, when coding the CRT function.

```{important}

The bottom line is that if you have a function that takes a list, say `my_list`, as an argument, and you do not want to change the original when performing the actions of your function, create a copy of the list using something like `local_list = list(my_list)`, and use `local_list` instead of `my_list` inside your function.
```

+++

## Generalized Bezout's Lemma

The following result is also used in improvements in computations of the discrete log (in specific cases):

:::{prf:lemma} Generalized Bezout's Lemma
:label: lm-gen_bezout


Let $a_1, a_2, \ldots, a_k$ be integers and $d = \gcd(a_1, a_2, \ldots, a_k)$.  Then, there integers are $r_1, r_2, \ldots, r_k$ such that
```{math}
d = r_1a_1 + r_2a_2 + \cdots + r_ka_k.
```
:::

:::{prf:proof} Proof of the Generalized Bezout's Lemma

The idea is to reduce the number of integers inside the GCD until we get only two and can use the Extended Euclidean Algorithm.  The key result is that
```{math}
\gcd(a_1, a_2, \ldots, a_n) = \gcd( a_{1}, a_{2}, \ldots , a_{n-2}, \gcd(a_{n-1}, a_n)),
```
which has $n-1$ integers inside the GCD, instead of $n$.  This result is not too hard to prove, and we leave it as an exercise for the more mathematically inclined readers.

We will illustrate the proof with $n=4$, to make it more concrete, but the logic on how to expand for all $n$ should be clear.  So, we want to find $ r_{1}, r_{2}, r_3 , r_{4}$ such that
```{math}
d = r_1 a_1 + r_2 a_2 + r_3 a_3 + r_4 a_4.
```
Let $d_3 = \gcd(a_3, a_4)$.  By Bezout's Lemma we have that there are integers $u_3$ and $v_3$ such that
```{math}
\color{red} d_3 = u_3 a_3 + v_3 a_4.
```
So, we have that $d = \gcd(a_1, a_2, d_3)$, and repeating the argument, we have that $d = \gcd(a_1, \gcd(a_2, d_3))$.  Letting $d_2 = \gcd(a_2, d_3)$, we can use Bezout's Lemma again to find integers $u_2$ $v_2$ such that
```{math}
\begin{align*}
{\color{blue} d_2} &= u_2 a_2 + v_2 {\color{red} d_3} \\
&= u_2 a_2 + v_2 ({\color{red} u_3 a_3 + v_3 a_4}) \\
&= {\color{blue} u_2 a_2 + (v_2u_3) a_3 + (v_2 v_3) a_4}.
\end{align*}
```

We can now use Bezout's Lemma one last time and get integers $u_1$ and $v_1$ such that
```{math}
\begin{align*}
d &= u_1 a_1 + v_1 {\color{blue} d_2} \\
&= u_1 a_1 + v_1 ({\color{blue} u_2 a_2 + (v_2u_3) a_3 + (v_2 v_3) a_4}) \\
&= u_1 a_1 + (v_1 u_2) a_2 + (v_1v_2u_3) a_3 + (v_1 v_2 v_3) a_4.
\end{align*}
```

So, we can take $r_1 = u_1$, $r_2 = v_1v_2$, $r_3 = v_1v_2u_3$, and $r_4 = v_1 v_2 v_3$.

 Hopefully, now one can see how we can repeat this process to get the result for five, six, or any number of integers.
:::

+++

### Algorithm

To actually compute the $r_1$, $r_2$, etc., above, one can follow the idea of the proof.  The key part is to keep track of the list of coefficients we get in each step.

In the first step, we get a list of coefficients $(u_3, v_3)$.  In the second, the list becomes $(u_2, v_2u_3, v_2v_3)$.  Then, in the third and final step, it becomes, $(u_1, v_1 v_2, v_1v_2u_3, v_1v_2v_3)$.  So, in each step, when we use Bezou't Lemma, we get a pair of integers $(u, v)$ and change the list we had before by adding $u$ to the *beginning* of the new list, and by multiplying all elements of the old list by $v$.  We repeat the process until we run out of integers.

Before we describe the algorithm, we need some standard notation:

:::{prf:definition} Assignment Notation
:label: not-assignment


We will use $\leftarrow$, as is customary, to denote *assignment* to a variable.  So, we may write, for instance,
```{math}
a \leftarrow a^2
```
to say that we assign to the variable $a$ the square of its *previous value*.  In Sage this is done simply with `a = a^2`, but in algebra we cannot use the equal sign, since it has a different meaning.  (If we have $a = a^2$, then that means that $a$ must be either $0$ or $1$.)
:::

With this notation in hand, we can describe the algorithm in more detail:

:::{prf:algorithm} Generalized Extended Euclidean Algorithm
:label: al-geea


Given a list $v = (a_1, a_2, \ldots, a_n)$ of integers, to find $w = ( r_{1}, r_{2}, \ldots , r_{n})$ such that
```{math}
\gcd( a_{1}, a_{2}, \ldots , a_{n}) = r_1 a_1 + r_2 a_3 + \cdots + r_n a_n,
```
we do:

1) Initialize $b \leftarrow a_n$ (the last element of $v$), $w \leftarrow (1)$ (a list with only $1$ in it), and remove the last element of $v$.
2) While $v$ is not empty:
   1) Remove the last element of $v$ and save it in the variable $a$.
   2) Use Bezout's Lemma to find $r$ and $s$ such that $\gcd(a, b) = ra + sb$.
   3) Replace $w$ to start with $r$, followed by the previous elements of $w$ multiplied by $s$.
   4) Set $b \leftarrow \gcd(a, b)$ (computed earlier).
3) Return the final value of $b$, which has $\gcd( a_{1}, a_{2}, \ldots , a_{n})$, and the list $w$, which has the desired coefficients $( r_{1}, r_{2}, \ldots , r_{n})$.
:::

+++

### Example

As an example, let's find $\gcd(123, 573, 942, 3105)$ and $r_1$, $r_2$, $r_3$, $r_4$ such that
```{math}
\gcd(123, 573, 942, 3105) = r_1 123 + r_2 573 + r_3 942 + r_4 3105.
```

So, our input is:

```{code-cell} ipython3
v = [123, 573, 942, 3105]
```

Since we need to change this list in the process, let's use a *copy* of the original:

```{code-cell} ipython3
v_copy = list(v)  # or use v.copy()
```

Then, we initialize `b` and `w`, and remove last element of `v`:

```{code-cell} ipython3
b = v_copy.pop()  # remove last element of v and save it in b
w = [1]
```

We now start the loop, which runs as long as `v` is not empty.  So, let's check it:

```{code-cell} ipython3
v_copy
```

Since `v_copy` is not empty, we run the body of the loop.  First, remove the last element of `v_copy` and save it in `a`:

```{code-cell} ipython3
a = v_copy.pop()  # remove last element of v and save it in a
```

Then, we use the Extended Euclidean Algorithm, using Sage's own `xgcd`:

```{code-cell} ipython3
d, r, s = xgcd(a, b)  # so d = gcd(a, b)
```

Then, we need to update `w`.  Here is one way of doing, using list comprehension:

```{code-cell} ipython3
w = [r] + [s * x for x in w]
```

And we save the old GCD (saved in `d` above) as `b`.

```{code-cell} ipython3
b = d
```

The body of the loop is over, so we check if `v_copy` is empty:

```{code-cell} ipython3
v_copy
```

It is not, so we repeat the body of the loop (all at once now):

```{code-cell} ipython3
a = v_copy.pop()
d, r, s = xgcd(a, b)
w = [r] + [s * x for x in w]
b = d
```

Check `v_copy` again:

```{code-cell} ipython3
v_copy
```

Since it is not empty, we run the body of the loop:

```{code-cell} ipython3
a = v_copy.pop()
d, r, s = xgcd(a, b)
w = [r] + [s * x for x in w]
b = d
```

Check `v_copy` again:

```{code-cell} ipython3
v_copy
```

Since `v_copy` is now empty, we are done.  The variable `b` (or `d`) should have our GCD:

```{code-cell} ipython3
b
```

Let's check it with Sage's `gcd`:

```{code-cell} ipython3
gcd(v)
```

So, it worked!

And `w` should have the coefficients:

```{code-cell} ipython3
w
```

Let's test it:

```{code-cell} ipython3
sum(x * y for (x, y) in zip(v, w))
```

It worked!

Note that we can also use Sage's `xgcd`:

```{code-cell} ipython3
xgcd(v)
```

The first element is the GCD, matching our result.  But the coefficients are different.  Of course, they also work:

```{code-cell} ipython3
w_sage = list(xgcd(v))[1:]  # convert result to list, and slice the first element off
w_sage
```

Checking:

```{code-cell} ipython3
sum(x * y for (x, y) in zip(v, w_sage))
```

### Number of Operations

Remember that the Euclidean Algorithm, and therefore the Extended Euclidean Algorithm, requires about $2 \log_2(b) + 2$ long divisions, where $b$ is the smallest of the two numbers.  So, in this case we need to use the Extended Euclidean Algorithm $n-1$ times.  *If our list is sorted in decreasing order*, this means we perform about $2(n-1) \log_2(b) + 2(n-1)$ long divisions, where $b$ now is the least element in the list.

+++

:::{admonition} Homework
:class: note

You will implement this {prf:ref}`Generalized Extended Euclidean Algorithm <al-geea>` in your [homework](#sec-hw5).
:::
