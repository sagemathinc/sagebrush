//! Relation collection in its original order: seed, cover, then random pairs.
use super::*;

pub(super) struct RelationSearch {
    pub relations: Vec<Relation>,
    pub elements: Vec<Vec<BigInt>>,
    seen: HashSet<Relation>,
    rng: u64,
    pub deficient_columns: HashSet<usize>,
}

impl RelationSearch {
    pub fn new() -> Self {
        Self { relations: vec![], elements: vec![], seen: HashSet::new(),
            rng: RELATION_RANDOM_SEED, deficient_columns: HashSet::new() }
    }

    pub fn collect_round(&mut self, field: &Field, log_weight_spread: f64, want: usize, round: usize) {
        let n = field.order.n;
        let one: ZMat = (0..n).map(|i| (0..n).map(|j| BigInt::from((i == j) as i32)).collect()).collect();
        if round == 0 {
            self.seed_relations(field, &one, log_weight_spread);
        }
        self.cover_deficient_columns(field, log_weight_spread);
        self.deficient_columns.clear();
        self.collect_random_pairs(field, log_weight_spread, want);
    }

    fn seed_relations(&mut self, field: &Field, one: &ZMat, log_weight_spread: f64) {
        let n = field.order.n;
        let (r1, r2) = (field.embeddings.r1, field.embeddings.r2);
        let factor_base_size = field.generator_count;
        for (&p, idx) in field.prime_indices.iter() {
            let rel: Relation = idx.iter().map(|&i| (i, field.factor_base[i].e as i64)).collect();
            let mut rel = rel;
            rel.sort();
            if rel.iter().all(|&(i, _)| i < field.generator_count) && self.seen.insert(rel.clone()) {
                self.relations.push(rel);
                self.elements.push(field.order.one().into_iter().map(|c| c * p).collect());
            }
        }
        relations_from(field, one, 4 * n + 40, &mut self.seen, &mut self.relations, &mut self.elements, &mut self.rng);
        for i in 0..factor_base_size {
            sagebrush_interrupt::check();
            let s_log = random_weights(r1 + r2, log_weight_spread, &mut self.rng);
            relations_weighted(field, &field.factor_base[i].basis.clone(), n + 2, &s_log, &mut self.seen, &mut self.relations, &mut self.elements, &mut self.rng);
        }
    }

    fn cover_deficient_columns(&mut self, field: &Field, log_weight_spread: f64) {
        let n = field.order.n;
        let (r1, r2) = (field.embeddings.r1, field.embeddings.r2);
        let factor_base_size = field.generator_count;
        let mut counts = vec![0u32; factor_base_size];
        for rel in &self.relations {
            for &(i, _) in rel {
                counts[i] += 1;
            }
        }
        // uncovered or rank-deficient primes: search until a new relation
        // contains them (P times random small primes, random weights)
        for i in (0..factor_base_size).filter(|&i| counts[i] == 0 || self.deficient_columns.contains(&i)).collect::<Vec<_>>() {
            let nsmall = factor_base_size.min(40);
            for attempt in 0..200 {
                sagebrush_interrupt::check();
                let before = self.relations.len();
                let ib = if attempt == 0 {
                    field.factor_base[i].basis.clone()
                } else {
                    self.rng ^= self.rng << 13;
                    self.rng ^= self.rng >> 7;
                    self.rng ^= self.rng << 17;
                    ideal_mul(&field.order, &field.factor_base[i].basis, &field.factor_base[(self.rng % nsmall as u64) as usize].basis)
                };
                let s_log = random_weights(r1 + r2, log_weight_spread, &mut self.rng);
                relations_weighted(field, &ib, 2 * n + 4, &s_log, &mut self.seen, &mut self.relations, &mut self.elements, &mut self.rng);
                if self.relations[before..].iter().any(|rel| rel.iter().any(|&(j, _)| j == i)) {
                    break;
                }
            }
        }
    }

    fn collect_random_pairs(&mut self, field: &Field, log_weight_spread: f64, want: usize) {
        let n = field.order.n;
        let (r1, r2) = (field.embeddings.r1, field.embeddings.r2);
        let factor_base_size = field.generator_count;
        let mut passes = 0;
        while self.relations.len() < want && passes < 50 * factor_base_size.max(10) {
            sagebrush_interrupt::check();
            passes += 1;
            self.rng ^= self.rng << 13;
            self.rng ^= self.rng >> 7;
            self.rng ^= self.rng << 17;
            let a = (self.rng % factor_base_size as u64) as usize;
            let b = ((self.rng >> 32) % factor_base_size as u64) as usize;
            let ib = ideal_mul(&field.order, &field.factor_base[a].basis, &field.factor_base[b].basis);
            // random log-weights in [-T, T]: skewed elements give large units
            let s_log = random_weights(r1 + r2, log_weight_spread, &mut self.rng);
            relations_weighted(field, &ib, 2 * n + 4, &s_log, &mut self.seen, &mut self.relations, &mut self.elements, &mut self.rng);
        }
    }
}
