//! Field normalization, factor-base construction and analytic bounds.
use super::*;

pub(super) struct PreparedField {
    pub field: Field,
    pub discriminant: BigInt,
    pub bound: u64,
    pub w: u32,
    pub w_proven: bool,
    pub assumed_primes: Vec<BigInt>,
    pub class_number_regulator_estimate: f64,
    pub log_hr_lower_bound: Option<sagebrush_ball::Ball>,
}

pub(super) fn prepare_field(f: &[BigInt], extra: &[u64], config: &BnfConfig, t0: &crate::clock::Instant) -> Result<PreparedField, String> {
    let debug = config.diagnostics.progress;
    let (order, _, assumed_primes) = crate::nf::order::maximal_order_assuming(f)?;
    // a T2-reduced basis: the f64 work below needs a well-scaled one
    let order = crate::nf::embed::reduce_order(&order)?;
    let n = order.n;
    let discriminant = order.disc();
    let index = num_integer::Roots::sqrt(&(Order::equation_order(f).disc() / &discriminant).abs());
    let embeddings = Embeddings::new(&order)?;
    let (r1, r2) = (embeddings.r1, embeddings.r2);
    // roots of unity: certified (api::roots_of_unity: candidates verified
    // exactly, completeness from residue fields), else a lower bound, and
    // the result records this separately; the analytic lower bound uses w
    let (w, w_proven) = crate::api::roots_of_unity(&order, &embeddings);
    // factor base: the prime ideals of norm < T, with T from Grenie and
    // Molteni's algorithm (nf/grh.rs), at most the uniform 4 log^2 |d_K|
    let log_discriminant = discriminant.to_f64().unwrap().abs().ln();
    // (rounded up: the uniform theorem holds at or above its value)
    let uniform_bound = crate::nf::grh::uniform_bound(&discriminant);
    let residue_window = ((4.0 * log_discriminant * log_discriminant) as u64).clamp(RESIDUE_WINDOW_MIN, RESIDUE_WINDOW_MAX);
    let split = splitting(&order, &discriminant, &index, (uniform_bound as u64).max(2 * residue_window));
    let norms = prime_norms(&split, uniform_bound);
    let generator_bound = if config.uniform_factor_base { uniform_bound } else { crate::nf::grh::class_group_bound_certified(n, r1, &discriminant, &norms, uniform_bound) };
    // the factor base itself may be larger than the proven bound needs (and
    // relations, for the units, need some primes)
    let fb_min = config.minimum_factor_base_bound;
    let bound = (generator_bound.max(fb_min).ceil() as u64).max(2);
    let FactorBase { ideals: factor_base, prime_indices, generator_count } =
        build_factor_base(&order, &discriminant, bound, extra)?;
    let factor_base_size = generator_count;
    // h R estimate
    let res = residue_estimate(&split, residue_window);
    let class_number_regulator_estimate = res * w as f64 * discriminant.to_f64().unwrap().abs().sqrt() / (2f64.powi(r1 as i32) * (2.0 * std::f64::consts::PI).powi(r2 as i32));
    // the certificate's proven lower bound for log h R (GRH; nf/certify.rs)
    let log_hr_lower_bound = if !config.analytic_certificate { None } else {
        crate::nf::certify::choose_x(n, log_discriminant).map(|bx| {
            let more;
            let sp: &[(u64, Vec<(u32, u32)>)] = if bx <= (uniform_bound as u64).max(2 * residue_window) { &split } else { more = splitting(&order, &discriminant, &index, bx); &more };
            crate::nf::certify::log_hr_lower_ball(sp, bx, n, r1, r2, w, &discriminant, CERTIFICATE_BITS)
        }).flatten()
    };
    if debug {
        eprintln!("  log hR >= {:?} (estimate {:.6}) at {:.1} ms", log_hr_lower_bound.as_ref().map(lower_f64), class_number_regulator_estimate.ln(), t0.elapsed().as_secs_f64() * 1e3);
    }
    let primorial: BigInt = prime_indices.keys().map(|&p| BigInt::from(p)).product();
    let field = Field { order, primorial, log_bound: (bound as f64).ln(), embeddings, factor_base, prime_indices, generator_count, diagnostics: config.diagnostics };
    if debug {
        eprintln!("n {} r1 {} r2 {} d {} w {} fb {} (bound {}, GRH {:.0}, uniform {:.0}) hR est {:.6e} setup {:.1} ms", n, r1, r2, discriminant, w, factor_base_size, bound, generator_bound, uniform_bound, class_number_regulator_estimate, t0.elapsed().as_secs_f64() * 1e3);
    }
    Ok(PreparedField { field, discriminant, bound, w, w_proven,
        assumed_primes, class_number_regulator_estimate, log_hr_lower_bound })
}

/// Generating ideals are the prefix; the rest support factoring norms only.
struct FactorBase {
    ideals: Vec<PrimeIdeal>,
    prime_indices: HashMap<u64, Vec<usize>>,
    generator_count: usize,
}

fn build_factor_base(order: &Order, discriminant: &BigInt, bound: u64, extra: &[u64]) -> Result<FactorBase, String> {
    // all primes above each p < bound (for factoring norms), those of norm
    // < bound (which generate the class group) first: only they are columns
    let mut above = vec![];
    for p in crate::arith::primes_up_to(bound - 1) {
        above.push((p, decompose(order, discriminant, p)?));
    }
    // every prime above an extra p is a column (also those of norm >= bound
    // above a small p)
    let mut extra: Vec<u64> = extra.to_vec();
    extra.sort();
    extra.dedup();
    for &p in extra.iter().filter(|&&p| p >= bound) {
        above.push((p, decompose(order, discriminant, p)?));
    }
    let small = |q: &PrimeIdeal| q.norm() < BigInt::from(bound) || extra.binary_search(&q.p).is_ok();
    let mut factor_base = vec![];
    let mut prime_indices: HashMap<u64, Vec<usize>> = HashMap::new();
    for pass in [true, false] {
        for (p, ps) in &above {
            for q in ps.iter().filter(|q| small(q) == pass) {
                prime_indices.entry(*p).or_default().push(factor_base.len());
                factor_base.push(q.clone());
            }
        }
    }
    let generator_count = factor_base.iter().filter(|q| small(q)).count();
    Ok(FactorBase { ideals: factor_base, prime_indices, generator_count })
}
