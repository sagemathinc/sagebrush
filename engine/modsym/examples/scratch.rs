//! A scratch pad for trying the Rust API directly; edit and run with
//!   cd ~/sagebrush/engine
//!   CARGO_TARGET_DIR=/tmp/engtarget cargo run --release --example scratch
use sagebrush_modsym::dims::{dim_cusp_forms, dim_eisenstein};
use sagebrush_modsym::general::{Character, GeneralSpace};
use sagebrush_modsym::general_exact::exact_charpoly;
use sagebrush_modsym::newspace::newspace_orbits;
use sagebrush_modsym::traces::orbit_traces;

fn main() -> Result<(), String> {
    // chi mod 13 of order 6 with chi(2) = zeta_6 (LMFDB 13.2.e).
    let chi = Character::from_generators(13, 6, &[2], &[1])?;
    println!("order {}, conductor {}, even {}", chi.order, chi.conductor(), chi.is_even());
    println!("dim S_2 = {}, dim E_2 = {} (over Q(chi))", dim_cusp_forms(&chi, 2), dim_eisenstein(&chi, 2));

    // Modular symbols mod ell: dimension and T_2 for sign 0.
    let sp = GeneralSpace::new(13, 2, &chi, 0)?;
    println!("M_2(13, chi): dim {} over F_{} (zeta_6 = {}), T_2 charpoly {:?}", sp.dimension(), sp.p, sp.zeta, sp.hecke_charpoly(2)?);

    // The same charpoly exactly, over Z[zeta_6].
    let e = exact_charpoly(13, 2, &chi, 0, 2)?;
    println!("exact: {:?} ({})", e.coeffs, e.status);

    // Newform orbits and trace forms (FLINT factors over Z).
    let factor = |f: &[sagebrush_bigint::BigInt]| sagebrush_flint::factor(f).1;
    let r = newspace_orbits(13, 2, &chi, &factor)?;
    let tr = orbit_traces(13, 2, &chi, &r, 10)?;
    println!("orbits {:?}, trace forms {:?}", r.dims, tr);
    Ok(())
}
