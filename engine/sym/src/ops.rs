//! Operations by name, for the corpus check and the text interface:
//! diff(f, x[, n]), expand(f), factor(f), taylor(f, x, a, n), limit(f, x=a),
//! solve(eq, x), simplify(f), and the method forms (f).degree(x), ...

use crate::err::{catch, value_error};
use crate::expr::*;
use crate::parse::parse;
use crate::print::to_string;

fn var_name(e: &Expr) -> String {
    match e.as_sym() {
        Some(s) => s.to_string(),
        None => value_error(format!("{} is not a variable", to_string(e))),
    }
}

/// An operation applied to parsed arguments, or None if `name` is not one.
pub fn apply(name: &str, a: &[Expr]) -> Option<String> {
    Some(match name {
        "diff" | "derivative" => {
            let x = if a.len() > 1 { var_name(&a[1]) } else { free_symbols(&a[0]).into_iter().next().unwrap_or("x".into()) };
            let n = a.get(2).and_then(|e| e.as_i64()).unwrap_or(1) as usize;
            to_string(&crate::diff::diff_n(&a[0], &x, n))
        }
        "expand" => to_string(&crate::expand::expand(&a[0])),
        "factor" => to_string(&crate::simplify::factor(&a[0])),
        "simplify" => to_string(&a[0]),
        _ => return None,
    })
}

/// A whole line: an operation call with textual arguments (keyword
/// arguments such as x=0 are allowed), a method call, or an expression.
pub fn run_line(line: &str) -> Result<String, String> {
    if let Some(m) = method_line(line) {
        return m;
    }
    if let Some(open) = line.find('(') {
        let name = &line[..open];
        // the call's parenthesis must close at the end of the line
        let mut depth = 0;
        let mut close = None;
        for (i, c) in line.char_indices().skip(open) {
            match c {
                '(' | '[' => depth += 1,
                ')' | ']' => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(i);
                        break;
                    }
                }
                _ => {}
            }
        }
        if !name.is_empty() && close == Some(line.len() - 1) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            let args = split_args(&line[open + 1..line.len() - 1]);
            if let Some(r) = catch(|| call_text(name, &args)).map_err(|e| e.to_string()).transpose() {
                return r;
            }
        }
    }
    catch(|| to_string(&parse(line))).map_err(|e| e.to_string())
}

fn list_str(v: &[Expr]) -> String {
    format!("[{}]", v.iter().map(to_string).collect::<Vec<_>>().join(", "))
}

/// An operation by name with textual arguments, or None if not one.
pub fn call_text(name: &str, args: &[String]) -> Option<String> {
    let p = |s: &str| parse(s);
    let kw = |a: &String| a.split_once('=').filter(|(k, v)| !v.starts_with('=') && !k.ends_with(['<', '>', '!', '='])).map(|(k, v)| (k.trim().to_string(), v.trim().to_string()));
    Some(match name {
        "latex" => crate::print::to_latex(&p(&args[0])),
        "taylor" => {
            let e = p(&args[0]);
            let x = var_name(&p(&args[1]));
            let a = p(&args[2]);
            let n = p(&args[3]).as_i64().unwrap_or(5);
            to_string(&crate::series::taylor(&e, &x, &a, n))
        }
        "limit" | "lim" => {
            let e = p(&args[0]);
            let mut dir = crate::limit::Dir::Both;
            let mut point = None;
            for a in &args[1..] {
                if let Some((k, v)) = kw(a) {
                    if k == "dir" {
                        dir = if v.contains('+') || v.contains("right") || v.contains("plus") { crate::limit::Dir::Plus } else { crate::limit::Dir::Minus };
                    } else {
                        point = Some((k, p(&v)));
                    }
                }
            }
            let (x, a) = point.unwrap_or_else(|| value_error("limit needs x=point"));
            to_string(&crate::limit::limit(&e, &x, &a, dir))
        }
        "solve" => {
            let first = &args[0];
            let eqs: Vec<Expr> = if first.starts_with('[') {
                split_args(&first[1..first.len() - 1]).iter().map(|s| p(s)).collect()
            } else {
                vec![p(first)]
            };
            let vars: Vec<String> = args[1..].iter().map(|a| var_name(&p(a))).collect();
            let sol = crate::solve::solve(&eqs, &vars);
            if eqs.len() == 1 && vars.len() == 1 {
                list_str(&sol.into_iter().flatten().collect::<Vec<_>>())
            } else {
                format!("[{}]", sol.iter().map(|s| list_str(s)).collect::<Vec<_>>().join(", "))
            }
        }
        _ => {
            let parsed: Vec<Expr> = args.iter().map(|a| p(a)).collect();
            return apply(name, &parsed);
        }
    })
}

/// Split "a, b, c" at top-level commas.
pub fn split_args(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut depth = 0;
    let mut cur = String::new();
    for c in s.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            ',' if depth == 0 => {
                out.push(cur.trim().to_string());
                cur.clear();
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// "(expr).method(args)" evaluated, or None if the line is not of that form.
pub fn method_line(line: &str) -> Option<Result<String, String>> {
    // the last top-level ".name(" splits the expression from the method
    let b = line.as_bytes();
    let mut depth = 0i32;
    let mut split = None;
    for (i, &c) in b.iter().enumerate() {
        match c {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            b'.' if depth == 0 && i > 0 && b[i - 1] == b')' && b.get(i + 1).map_or(false, |c| c.is_ascii_alphabetic()) => split = Some(i),
            _ => {}
        }
    }
    let split = split?;
    let inner = &line[..split];
    let rest = &line[split + 1..];
    let open = rest.find('(')?;
    let method = &rest[..open];
    let args_s = rest[open + 1..].strip_suffix(')')?;
    Some(
        catch(|| {
            let e = parse(inner);
            let args = split_args(args_s);
            method_call(&e, method, &args)
        })
        .map_err(|e| e.to_string()),
    )
}

/// A method call on an expression with textual arguments (keyword
/// arguments like x=2 for subs).
pub fn method_call(e: &Expr, method: &str, args: &[String]) -> String {
    let p = |s: &str| parse(s);
    match method {
        "expand" => to_string(&crate::expand::expand(e)),
        "diff" | "derivative" => apply("diff", &[vec![e.clone()], args.iter().map(|a| p(a)).collect()].concat()).unwrap(),
        "subs" | "substitute" => {
            let rules: Vec<(Expr, Expr)> = args
                .iter()
                .map(|a| {
                    let (k, v) = a.split_once('=').unwrap_or_else(|| value_error("subs expects x=value"));
                    (p(k.trim()), p(v.trim()))
                })
                .collect();
            to_string(&subs(e, &rules))
        }
        "n" | "N" | "numerical_approx" => to_string(&crate::eval::n(e)),
        "variables" => {
            let v = free_symbols(e);
            if v.len() == 1 {
                format!("({},)", v[0])
            } else {
                format!("({})", v.join(", "))
            }
        }
        "degree" => {
            let x = args.first().map(|a| a.clone()).unwrap_or_else(|| free_symbols(e).into_iter().next().unwrap_or("x".into()));
            crate::poly::degree(e, &x).to_string()
        }
        "coefficient" => {
            let n = args.get(1).map(|a| a.parse::<i64>().unwrap_or(1)).unwrap_or(1);
            to_string(&crate::poly::coefficient(e, &args[0], n))
        }
        "factor" => to_string(&crate::simplify::factor(e)),
        "simplify" => to_string(e),
        "simplify_rational" => to_string(&crate::simplify::simplify_rational(e)),
        "simplify_trig" | "trig_simplify" => to_string(&crate::simplify::simplify_trig(e)),
        "simplify_full" | "full_simplify" => to_string(&crate::simplify::simplify_full(e)),
        "numerator" => to_string(&numer_denom(e).0),
        "denominator" => to_string(&numer_denom(e).1),
        _ => value_error(format!("no method {}", method)),
    }
}
