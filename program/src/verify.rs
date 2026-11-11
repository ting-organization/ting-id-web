//! ECDSA P-256 verification, by the rules of policy-p256 (Ting wiki:
//! programs/policies): an uncompressed key, both scalars from 1 to n − 1, and
//! a low S. Everything here is public, so it runs in variable time.
//!
//! The field and point arithmetic, the scalar arithmetic and the decoding of
//! the key are RustCrypto's p256. This module only combines them, as ECDSA's
//! verification equation, `x(u1·G + u2·Q) mod n == r`. It uses nothing of the
//! program's and is also compiled natively by the tests, which compare it with
//! p256's own ECDSA verification.
use p256::elliptic_curve::group::Group;
use p256::elliptic_curve::ops::{Invert, Reduce};
use p256::elliptic_curve::point::AffineCoordinates;
use p256::elliptic_curve::scalar::IsHigh;
use p256::elliptic_curve::sec1::FromEncodedPoint;
use p256::elliptic_curve::{Field, PrimeField};
use p256::{AffinePoint, EncodedPoint, FieldBytes, ProjectivePoint, Scalar, U256};

/// Whether `r ‖ s` is a valid low-S signature by `key`, `04 ‖ x ‖ y`, over the
/// 32-byte hash `e`.
pub fn verify(key: &[u8], e: &[u8; 32], r: &[u8; 32], s: &[u8; 32]) -> bool {
    check(key, e, r, s).is_some()
}

fn check(key: &[u8], e: &[u8; 32], r: &[u8; 32], s: &[u8; 32]) -> Option<()> {
    if key.len() != 65 || key[0] != 0x04 {
        return None;
    }
    let r = nonzero_scalar(r)?;
    let s = nonzero_scalar(s)?;
    if bool::from(s.is_high()) {
        return None;
    }
    // A point on the curve, both coordinates below p.
    let point = EncodedPoint::from_bytes(key).ok()?;
    let q = Option::<AffinePoint>::from(AffinePoint::from_encoded_point(&point))?;

    let z = <Scalar as Reduce<U256>>::reduce_bytes(&FieldBytes::from(*e));
    let w = Option::<Scalar>::from(s.invert_vartime())?;
    let x = lincomb(&(z * w), &(r * w), &ProjectivePoint::from(q))
        .to_affine()
        .x();
    // The point at infinity has x = 0 here, which no r equals.
    (<Scalar as Reduce<U256>>::reduce_bytes(&x) == r).then_some(())
}

/// A scalar from 1 to n − 1, big-endian.
fn nonzero_scalar(bytes: &[u8; 32]) -> Option<Scalar> {
    let k = Option::<Scalar>::from(Scalar::from_repr(FieldBytes::from(*bytes)))?;
    (!bool::from(k.is_zero())).then_some(k)
}

/// `a·G + b·Q`, both products at once: four bits of each scalar at a time,
/// most significant first, adding multiples from two tables of 16. p256's
/// addition formulas are complete, so a sum of equal or opposite points, or
/// with the identity, needs no special case.
fn lincomb(a: &Scalar, b: &Scalar, q: &ProjectivePoint) -> ProjectivePoint {
    let multiples = |p: ProjectivePoint| {
        let mut table = [ProjectivePoint::IDENTITY; 16];
        for i in 1..16 {
            table[i] = table[i - 1] + p;
        }
        table
    };
    let (g_table, q_table) = (multiples(ProjectivePoint::GENERATOR), multiples(*q));
    let mut sum = ProjectivePoint::IDENTITY;
    for (x, y) in a.to_repr().iter().zip(b.to_repr().iter()) {
        for shift in [4, 0] {
            sum = sum.double().double().double().double();
            let (i, j) = ((x >> shift & 15) as usize, (y >> shift & 15) as usize);
            if i != 0 {
                sum += g_table[i];
            }
            if j != 0 {
                sum += q_table[j];
            }
        }
    }
    sum
}
