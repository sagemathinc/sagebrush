//! Explicit choices for the general number-field search.

// Even when the GRH generating bound is tiny, unit relations benefit from
// additional primes. This is the existing empirical search floor, not a theorem.
const DEFAULT_FACTOR_BASE_MINIMUM: f64 = 50.0;

/// Optional observations; none changes an acceptance condition.
#[derive(Clone, Copy, Debug, Default)]
pub struct BnfDiagnostics {
    pub progress: bool,
    pub unit_lattice: bool,
    pub unit_norms: bool,
    pub certificate_vectors: bool,
}

/// Search choices for `bnfinit_configured`. Defaults reproduce the ordinary
/// general number-field algorithm. A search option is not a proof flag:
/// disabling the analytic certificate produces an explicitly uncertified result.
#[derive(Clone, Debug)]
pub struct BnfConfig {
    /// Use the uniform GRH bound instead of the field-specific search.
    pub uniform_factor_base: bool,
    /// The factor-base bound is ceil(max(GRH bound, this value)), at least 2.
    pub minimum_factor_base_bound: f64,
    /// Attempt the GRH analytic certificate after the heuristic stopping test.
    pub analytic_certificate: bool,
    /// Half-width of random log weights; None derives it from the h R estimate.
    pub log_weight_spread: Option<f64>,
    pub diagnostics: BnfDiagnostics,
}

impl Default for BnfConfig {
    fn default() -> Self {
        Self {
            uniform_factor_base: false,
            minimum_factor_base_bound: DEFAULT_FACTOR_BASE_MINIMUM,
            analytic_certificate: true,
            log_weight_spread: None,
            diagnostics: BnfDiagnostics::default(),
        }
    }
}

impl BnfConfig {
    /// Explicit legacy diagnostic adapter, available only in debug builds.
    /// No ordinary entry point calls this method. Pass its returned config to
    /// `bnfinit_configured` when investigating the search.
    ///
    /// Presence switches: QCL_UNIFORM selects the uniform bound; QCL_NOCERT
    /// skips the analytic certificate; QCL_DEBUG prints progress; QCL_UL prints
    /// unit-lattice identification; QCL_CHECK prints unit log-sum residuals;
    /// QCL_CERTDBG prints rejected certificate vectors. QCL_FBMIN and QCL_T
    /// parse f64 values for the minimum bound and log-weight spread, with the
    /// original default fallback on absent or unparseable values.
    #[cfg(debug_assertions)]
    pub fn from_debug_env() -> Self {
        let present = |name| std::env::var(name).is_ok();
        let number = |name| std::env::var(name).ok().and_then(|value| value.parse().ok());
        Self {
            uniform_factor_base: present("QCL_UNIFORM"),
            minimum_factor_base_bound: number("QCL_FBMIN").unwrap_or(DEFAULT_FACTOR_BASE_MINIMUM),
            analytic_certificate: !present("QCL_NOCERT"),
            log_weight_spread: number("QCL_T"),
            diagnostics: BnfDiagnostics {
                progress: present("QCL_DEBUG"),
                unit_lattice: present("QCL_UL"),
                unit_norms: present("QCL_CHECK"),
                certificate_vectors: present("QCL_CERTDBG"),
            },
        }
    }
}
